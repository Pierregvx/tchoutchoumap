"use strict";
// tchoutchoumap: a map of the direct links between big European cities (data/links.json, built by app/collect.py from a typical
// week of open timetables) and a trip planner over it. Each link says how long the fastest train takes and how many run a day; a trip is
// built stop by stop, the last stop showing where one can go next. Between two stops with no direct train, Dijkstra finds the shortest
// way (fastest train of each link + a change penalty). A given day can be checked live against Transitous (every operator, every
// connection). Words: i18n.js.

const MODES = {
  H: { label: "High speed (TGV, ICE, Frecciarossa…)", short: "HS", color: "#d1242f", on: true },
  L: { label: "Intercity (Intercités, EC, IC…)", short: "IC", color: "#0b6bcb", on: true },
  N: { label: "Night trains", short: "Night", color: "#6639ba", on: true },
  R: { label: "Regional trains (TER, Regionale…)", short: "Reg", color: "#1a7f37", on: true },
  C: { label: "Long-distance buses (FlixBus, BlaBlaCar Bus…)", short: "Bus", color: "#bc4c00", on: false },
  F: { label: "Ferries", short: "Ferry", color: "#0a7c86", on: false },
};
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
// the trip already chosen is one dark colour, solid; the trains one could take next are dashed, coloured by duration
const TRIP = "#14213d", HERE = "#e85d04";
// Leaflet, under another name: L is the usual name of a link in this file
const leaflet = window.L;
const LIVE_API = "https://api.transitous.org/api/v1/plan";

const S = {
  data: null, cities: {}, links: {}, adj: {},
  stops: [], modes: new Set(Object.keys(MODES).filter((k) => MODES[k].on)),
  transfer: 45, showNet: true, tab: "trip", exploreFrom: null,
};
let lastHash = "";
let map, netLayer, tripLayer;
const cityMarkers = {};

// ---------- helpers ----------
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const hm = (s) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
const fmtDur = (m) => { m = Math.round(m); const h = Math.floor(m / 60), r = m % 60; return h ? `${h} h ${String(r).padStart(2, "0")}` : `${r} min`; };
const popcount = (x) => { let n = 0; while (x) { n += x & 1; x >>= 1; } return n; };
const cname = (id) => { const c = S.cities[id]; return c ? (LANG === "fr" && c.fr) || c.name : id; };
const num = (x) => x.toLocaleString(LOCALE);

function fmtDays(mask) {
  if (mask === 127) return t("daily");
  if (mask === 31) return t("Mon → Fri");
  if (mask === 63) return t("Mon → Sat");
  if (mask === 96) return t("Sat, Sun");
  if (popcount(mask) === 6) return t("except {d}", { d: t(DAYS[[0, 1, 2, 3, 4, 5, 6].find((d) => !(mask & (1 << d)))]) });
  return DAYS.filter((_, d) => mask & (1 << d)).map((d) => t(d)).join(", ");
}
// how often a link runs, said simply: "12 / day", or "3 / week (Fri, Sat, Sun)" when it does not run every day
function linkDays(L) { let m = 0; for (const s of L.on) m |= s.mask; return m; }
function freqText(L, short = false) {
  const n = L.perWeek;
  if (n >= 7) {
    const d = n / 7;
    return t("{n} / day", { n: d >= 1.5 || Math.abs(d - Math.round(d)) < 0.05 ? Math.round(d) : d.toLocaleString(LOCALE, { maximumFractionDigits: 1 }) });
  }
  return short ? t("{n} / week", { n }) : t("{n} / week ({days})", { n, days: fmtDays(linkDays(L)) });
}
const modesOf = (L) => [...new Set(L.on.map((s) => s.mode))].sort((a, b) => "HNLRCF".indexOf(a) - "HNLRCF".indexOf(b));
const badge = (m) => `<span class="badge" style="background:${MODES[m]?.color || "#555"}">${t(MODES[m]?.short || m)}</span>`;
function durColor(m) { return m <= 120 ? "#1a7f37" : m <= 240 ? "#2f81f7" : m <= 360 ? "#bf8700" : m <= 540 ? "#d1242f" : "#6639ba"; }

// ---------- graph ----------
// a train of links.json: [departure, arrival, days after departure, minutes, weekday mask (bit 0 = Monday), mode, name, operator, from, to]
function svcObj(a) { return { dep: a[0], arr: a[1], plus: a[2], dur: a[3], mask: a[4], mode: a[5], name: a[6], op: a[7], from: a[8], to: a[9] }; }

// the links with the chosen kinds of transport: each gets its fastest time (best) and its trains a week (perWeek)
function buildGraph() {
  S.adj = {};
  for (const id in S.cities) S.adj[id] = [];
  for (const k in S.links) {
    const L = S.links[k];
    L.on = L.all.filter((s) => S.modes.has(s.mode));
    if (!L.on.length) { L.best = null; continue; }
    L.best = Math.min(...L.on.map((s) => s.dur));
    L.perWeek = L.on.reduce((n, s) => n + popcount(s.mask), 0);
    S.adj[L.o].push(L);
  }
}

// Dijkstra from src. Cost = ride time of the fastest train of each link + a penalty at each change.
function dijkstra(src, { banned = new Set() } = {}) {
  const dist = { [src]: 0 }, prev = {}, done = new Set();
  const pen = S.transfer + 15; // a change costs its waiting time, and a bit more for the hassle
  for (;;) {
    let u = null, best = Infinity;
    for (const k in dist) if (!done.has(k) && dist[k] < best) { best = dist[k]; u = k; }
    if (u === null) break;
    done.add(u);
    for (const L of S.adj[u] || []) {
      if (banned.has(L.o + ">" + L.d)) continue;
      const c = best + L.best + (u === src ? 0 : pen);
      if (c < (dist[L.d] ?? Infinity)) { dist[L.d] = c; prev[L.d] = u; }
    }
  }
  return { dist, prev };
}
function pathTo(dj, dst) {
  if (dj.dist[dst] === undefined) return null;
  const p = [dst];
  while (dj.prev[p[0]] !== undefined) p.unshift(dj.prev[p[0]]);
  return p;
}
function route(a, b) {
  const p = pathTo(dijkstra(a), b);
  return p && p.length > 1 ? p : null;
}
const rideOf = (p) => p.slice(0, -1).reduce((n, v, j) => n + S.links[v + ">" + p[j + 1]].best, 0);
// up to n other ways, each avoiding one link of the best one (a light Yen)
function alternatives(a, b, best, n = 2) {
  const seen = new Set([best.join()]), out = [];
  for (let i = 0; i < best.length - 1; i++) {
    const p = pathTo(dijkstra(a, { banned: new Set([best[i] + ">" + best[i + 1]]) }), b);
    if (p && !seen.has(p.join())) { seen.add(p.join()); out.push(p); }
  }
  return out.map((p) => ({ p, ride: rideOf(p) })).sort((x, y) => x.ride - y.ride).slice(0, n);
}

// ---------- map ----------
function initMap() {
  map = L.map("map", { preferCanvas: true, zoomControl: true, worldCopyJump: true }).setView([47.5, 9], 5);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 12, className: "tiles",
    attribution: `© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · ${t("timetables")} <a href="https://transitous.org">Transitous</a>`,
  }).addTo(map);
  // the trip over the possible trains, the cities over both (each pane its own canvas)
  map.createPane("trip").style.zIndex = 450;
  map.createPane("cities").style.zIndex = 460;
  S.tripR = L.canvas({ pane: "trip" });
  S.cityR = L.canvas({ pane: "cities" });
  netLayer = L.layerGroup().addTo(map);
  tripLayer = L.layerGroup().addTo(map);
  map.on("zoomend", () => styleMarkers());
  for (const id in S.cities) {
    const c = S.cities[id];
    cityMarkers[id] = L.circleMarker([c.lat, c.lon], { radius: 5, color: "#1d232b", weight: 1.5, fillColor: "#fff", fillOpacity: 1, pane: "cities", renderer: S.cityR })
      .bindTooltip(cname(id), { permanent: true, direction: "right", className: "city-label", offset: [4, 0] })
      .on("click", () => cityClicked(id))
      .addTo(map);
  }
}

const linkPath = (L) => (L.p && L.p.length > 1 ? L.p : [[S.cities[L.o].lat, S.cities[L.o].lon], [S.cities[L.d].lat, S.cities[L.d].lon]]);
const fitAround = (id) => fitTo([[S.cities[id].lat, S.cities[id].lon], ...(S.adj[id] || []).map((L) => [S.cities[L.d].lat, S.cities[L.d].lon])], 30);
// the map's size is measured again first: on a phone the panel settles after the map was made, and Leaflet kept the first size
function fitTo(pts, pad) { map.invalidateSize(false); map.fitBounds(pts, { padding: [pad, pad], maxZoom: 7 }); }

// the links: with a city in focus, its direct trains dashed and coloured by duration; otherwise the whole network, thin and grey
function drawNet() {
  netLayer.clearLayers();
  const focus = focusNow();
  if (!S.showNet && !focus) return;
  const drawn = new Set();
  for (const k in S.links) {
    const L = S.links[k];
    if (L.best == null) continue;
    if (focus && L.o !== focus) continue;
    const pair = [L.o, L.d].sort().join("|");
    if (!focus && drawn.has(pair)) continue;
    drawn.add(pair);
    leaflet.polyline(linkPath(L), { color: focus ? durColor(L.best) : "#8a96a3", weight: focus ? 3 : 1.2, opacity: focus ? 0.9 : 0.45, dashArray: focus ? "7 6" : null })
      .bindTooltip(t("{a} → {b}: {d} · {n} / week", { a: cname(L.o), b: cname(L.d), d: fmtDur(L.best), n: L.perWeek }), { sticky: true })
      .addTo(netLayer);
  }
}

// the city in focus: the one chosen on the Map tab, or the trip's last stop (where you are now)
function focusNow() {
  if (S.tab === "explore") return S.exploreFrom;
  if (S.tab === "trip" && S.stops.length) return S.stops[S.stops.length - 1];
  return null;
}
// a city touched on the map: during a trip it is the next stop; otherwise its direct trains are shown
function cityClicked(id) {
  if (S.tab === "trip" && S.stops.length) { addStop(id); return; }
  focusCity(id);
}
function focusCity(id) {
  S.exploreFrom = id; S.openDest = null;
  $("#explore-city").value = cname(id);
  switchTab("explore");
  fitAround(id);
}

function styleMarkers() {
  const focus = focusNow();
  for (const id in cityMarkers) {
    const m = cityMarkers[id];
    const L = focus && S.links[focus + ">" + id];
    const label = L && L.best != null ? `${cname(id)} · ${fmtDur(L.best)} · ${freqText(L, true)}` : cname(id);
    if (m.getTooltip().getContent() !== label) m.setTooltipContent(label);
    // with a city in focus, only it, its destinations and the trip are named; otherwise the hubs, and every city from zoom 6
    const hub = (S.adj[id] || []).length >= 20;
    const named = focus ? id === focus || (L && L.best != null) || S.stops.includes(id) : (map.getZoom() >= 6 || hub || S.stops.includes(id));
    const tt = m.getTooltip();
    if (named && !map.hasLayer(tt)) m.openTooltip(); else if (!named && map.hasLayer(tt)) m.closeTooltip();
    const i = S.stops.indexOf(id);
    if (id === focus) m.setStyle({ radius: 9, fillColor: HERE, color: "#fff", weight: 3 });
    else if (S.tab === "trip" && i >= 0) m.setStyle({ radius: 7, fillColor: TRIP, color: "#fff", weight: 2 });
    else m.setStyle({ radius: 5, fillColor: "#fff", color: "#1d232b", weight: 1.5 });
    if (i >= 0 || id === focus) m.bringToFront();
  }
}

// ---------- trip ----------
function addStop(id) {
  if (!S.cities[id] || S.stops[S.stops.length - 1] === id) return;
  S.stops.push(id);
  switchTab("trip");
  renderTrip(false);
  fitAround(id);
}

function cityByName(v) {
  v = v.trim().toLowerCase();
  if (!v) return null;
  const all = Object.keys(S.cities);
  const names = (id) => [cname(id), S.cities[id].name, S.cities[id].fr || "", id].map((x) => x.toLowerCase());
  return all.find((id) => names(id).includes(v)) || all.find((id) => names(id).some((x) => x.startsWith(v))) || null;
}

const destRow = (L, attr) => `<div class="ex-row" ${attr}="${L.d}"><span class="nm">${esc(cname(L.d))}
    <span class="via">${modesOf(L).map(badge).join("")}${freqText(L)}</span></span>
    <span class="tm" style="color:${durColor(L.best)}">${fmtDur(L.best)}</span></div>`;

// « Then, from Milan »: the direct destinations of the last stop; one touched is the next stop
function renderNext() {
  const el = $("#next");
  const last = S.stops[S.stops.length - 1];
  if (!last) { el.innerHTML = ""; return; }
  const direct = (S.adj[last] || []).filter((L) => !S.stops.includes(L.d) || L.d === S.stops[0]).sort((a, b) => a.best - b.best);
  const show = S.nextAll ? direct : direct.slice(0, 10);
  el.innerHTML = `<h3>${esc(t(S.stops.length === 1 ? "Starting from {c}: {n} cities direct" : "Then, from {c}: {n} cities direct", { c: cname(last), n: direct.length }))}</h3>
    <p class="hint">${esc(t("Tap a city (here or on the map) to add it. On the map: your trip in solid dark blue, where you are in orange, the trains you could take next dashed (green < 2 h, blue < 4 h, yellow < 6 h, red < 9 h, purple beyond)."))}</p>` +
    show.map((L) => destRow(L, "data-next")).join("") +
    (direct.length > show.length ? `<button class="more" id="next-all">${esc(t("See the {n} cities", { n: direct.length }))}</button>` : "");
  el.querySelectorAll("[data-next]").forEach((r) => r.onclick = () => addStop(r.dataset.next));
  const all = $("#next-all");
  if (all) all.onclick = () => { S.nextAll = true; renderNext(); };
}

function renderStops() {
  const ol = $("#stops");
  ol.innerHTML = S.stops.map((id, i) => `<li data-i="${i}">
    <span class="dot" style="background:${TRIP}">${i + 1}</span>
    <span class="nm">${esc(cname(id))}</span>
    <button data-a="up" title="${esc(t("Up"))}">↑</button><button data-a="down" title="${esc(t("Down"))}">↓</button><button data-a="del" title="${esc(t("Remove"))}">✕</button></li>`).join("");
  ol.querySelectorAll("button").forEach((b) => b.onclick = () => {
    const i = +b.closest("li").dataset.i, a = b.dataset.a;
    if (a === "del") S.stops.splice(i, 1);
    if (a === "up" && i > 0) [S.stops[i - 1], S.stops[i]] = [S.stops[i], S.stops[i - 1]];
    if (a === "down" && i < S.stops.length - 1) [S.stops[i + 1], S.stops[i]] = [S.stops[i], S.stops[i + 1]];
    renderTrip();
  });
  $("#trip-actions").style.display = S.stops.length >= 2 ? "" : "none";
  $("#optimize").style.display = S.stops.length >= 4 ? "" : "none";
  $("#trip-hint").style.display = S.stops.length >= 2 ? "none" : "";
}

function svcRow(s) {
  const url = S.data.ops[s.op];
  const op = url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(s.op)}</a>` : esc(s.op);
  return `<div class="svc"><div class="tm">${s.dep} → ${s.arr}${s.plus ? `<sup>+${s.plus}</sup>` : ""}</div>
    <div class="info">${badge(s.mode)}<b>${fmtDur(s.dur)}</b> · ${esc(s.name)}${op ? " · " + op : ""}</div>
    <div></div><div class="info days">${fmtDays(s.mask)} · ${esc(s.from)} → ${esc(s.to)}</div></div>`;
}

let hopSeq = 0;
// one link's trains of the week, the first six shown
function hopHtml(L) {
  const svcs = L.on.slice().sort((a, b) => hm(a.dep) - hm(b.dep));
  const id = "hop" + ++hopSeq;
  return `<div class="hop"><div class="hop-title">${esc(cname(L.o))} → ${esc(cname(L.d))}
      <span class="sub">${esc(t("{d} at the fastest", { d: fmtDur(L.best) }))} · ${freqText(L)}</span></div>
    <div>${svcs.slice(0, 6).map(svcRow).join("")}</div>
    ${svcs.length > 6 ? `<div id="${id}" hidden>${svcs.slice(6).map(svcRow).join("")}</div>
      <button class="more" data-toggle="${id}">${esc(t("See the {n} trains", { n: svcs.length }))}</button>` : ""}</div>`;
}
function wireToggles(el) {
  el.querySelectorAll("[data-toggle]").forEach((b) => b.onclick = (e) => {
    e.stopPropagation();
    const x = document.getElementById(b.dataset.toggle);
    x.hidden = !x.hidden;
    b.dataset.label = b.dataset.label || b.textContent;
    b.textContent = x.hidden ? b.dataset.label : t("Hide");
  });
}

// fit: whether the map frames the whole trip (not after a mode switch, nor after adding a stop: fitAround does it)
function renderTrip(fit = true) {
  renderStops();
  S.nextAll = false;
  renderNext();
  tripLayer.clearLayers();
  const legsEl = $("#legs");
  if (S.stops.length < 2) { legsEl.innerHTML = ""; $("#total").textContent = ""; finish(); return; }
  let total = 0, okAll = true, html = "";
  for (let i = 0; i < S.stops.length - 1; i++) {
    const a = S.stops[i], b = S.stops[i + 1];
    const p = a === b ? null : route(a, b);
    let body = "", head = "";
    if (a === b) {
      head = `<span class="d">—</span>`;
      body = `<div class="hint">${esc(t("The same city twice in a row: remove one of them."))}</div>`;
    } else if (!p) {
      okAll = false;
      head = `<span class="d none">${esc(t("no way"))}</span>`;
      body = `<div class="none">${esc(t("No way by train between these two cities with the chosen transport (Settings). The city may be poorly covered by the data."))}</div>`;
    } else {
      const direct = p.length === 2;
      const hops = p.slice(0, -1).map((v, j) => S.links[v + ">" + p[j + 1]]);
      const ride = rideOf(p);
      total += ride;
      head = `<span class="d">${fmtDur(ride)}${direct ? "" : ` · ${esc(t("{n} chg", { n: p.length - 2 }))}`}</span>`;
      body += direct ? `<div class="freq">${esc(t("Direct · {f}", { f: freqText(hops[0]) }))}</div>`
        : `<div class="freq">${t("No direct train: {hops}", { hops: hops.map((L) => `${esc(cname(L.o))} → ${esc(cname(L.d))} <b>${fmtDur(L.best)}</b>, ${esc(freqText(L))}`).join(esc(t(" · then "))) })}</div>`
          + `<div class="suggest">${esc(t("Make it a stop:"))} ${p.slice(1, -1).map((v) => `<button data-insert="${i + 1}" data-city="${v}">+ ${esc(cname(v))}</button>`).join("")}</div>`;
      // with a direct train, a way with a change only looks faster because the wait is not counted: not proposed
      const alts = direct ? [] : alternatives(a, b, p);
      if (alts.length) body += `<div class="suggest">${esc(t("Other ways:"))} ${alts.map((x) => `<button data-via="${i}" data-path="${x.p.join(",")}">${x.p.length > 2 ? esc(t("via {v}", { v: x.p.slice(1, -1).map(cname).join(", ") })) : esc(t("direct"))} · ${fmtDur(x.ride)}</button>`).join("")}</div>`;
      body += hops.map(hopHtml).join("") + liveHtml(a, b);
      for (const L of hops) {
        leaflet.polyline(linkPath(L), { color: "#fff", weight: 9, opacity: 0.9, pane: "trip", renderer: S.tripR }).addTo(tripLayer);
        leaflet.polyline(linkPath(L), { color: TRIP, weight: 5, opacity: 1, pane: "trip", renderer: S.tripR }).addTo(tripLayer);
      }
    }
    html += `<div class="leg"><div class="head"><span class="t" style="color:${TRIP}">${i + 1}. ${esc(cname(a))} → ${esc(cname(b))}</span>${head}</div><div class="body">${body}</div></div>`;
  }
  legsEl.innerHTML = html;
  const legs = S.stops.length - 1;
  $("#total").textContent = t(legs === 1 ? "In all: {d} on the train · 1 leg" : "In all: {d} on the train · {n} legs", { d: fmtDur(total), n: legs }) + (okAll ? "" : t(" (without the legs with no way)"));
  wireToggles(legsEl);
  legsEl.querySelectorAll("[data-insert]").forEach((b) => b.onclick = () => { S.stops.splice(+b.dataset.insert, 0, b.dataset.city); renderTrip(); });
  legsEl.querySelectorAll("[data-via]").forEach((b) => b.onclick = () => { S.stops.splice(+b.dataset.via + 1, 0, ...b.dataset.path.split(",").slice(1, -1)); renderTrip(); });
  legsEl.querySelectorAll(".live button").forEach((b) => b.onclick = () => liveSearch(b.closest(".live")));
  if (fit) fitTo(S.stops.map((id) => [S.cities[id].lat, S.cities[id].lon]), 50);
  finish();
}

function finish() { styleMarkers(); drawNet(); saveHash(); }

// The best order of the middle stops (the first and the last stay): exact for up to 8 middle stops, greedy beyond.
function optimize() {
  if (S.stops.length < 4) return;
  const first = S.stops[0], last = S.stops[S.stops.length - 1];
  // a city met twice in the middle, or the same as the start or the end, is kept once
  const mid = [...new Set(S.stops.slice(1, -1))].filter((v) => v !== first && v !== last);
  if (!mid.length) { S.stops = [first, last]; renderTrip(); return; }
  const nodes = [first, ...mid, last], cost = {};
  for (const a of nodes) { const dj = dijkstra(a); cost[a] = {}; for (const b of nodes) cost[a][b] = a === b ? 0 : (dj.dist[b] ?? 1e9); }
  let best = null, bestC = Infinity;
  const evalOrder = (o) => { let c = cost[first][o[0]]; for (let i = 0; i < o.length - 1; i++) c += cost[o[i]][o[i + 1]]; return c + cost[o[o.length - 1]][last]; };
  if (mid.length <= 8) {
    const perm = (arr, k) => {
      if (k === arr.length) { const c = evalOrder(arr); if (c < bestC) { bestC = c; best = arr.slice(); } return; }
      for (let i = k; i < arr.length; i++) { [arr[k], arr[i]] = [arr[i], arr[k]]; perm(arr, k + 1); [arr[k], arr[i]] = [arr[i], arr[k]]; }
    };
    perm(mid.slice(), 0);
  } else {
    const left = new Set(mid); best = []; let cur = first;
    while (left.size) { let nx = null; for (const v of left) if (!nx || cost[cur][v] < cost[cur][nx]) nx = v; best.push(nx); left.delete(nx); cur = nx; }
  }
  S.stops = [first, ...best, last];
  renderTrip();
}

// ---------- a given day, live (Transitous routing: every operator, with connections) ----------
function liveHtml(a, b) {
  return `<details class="live" data-a="${a}" data-b="${b}"><summary><b>${esc(t("Times on a given day"))}</b></summary> <span class="hint">${esc(t("(live, with every connection)"))}</span><br>
    <input type="date" value="${S.liveDate || ""}"> <select>${[6, 10, 14, 18].map((h) => `<option value="${h}">${esc(t("from {h}", { h: h + " h" }))}</option>`).join("")}</select>
    <button class="linkbtn">${esc(t("Search"))}</button><div class="res"></div></details>`;
}

async function liveSearch(box, cursor) {
  const a = box.dataset.a, b = box.dataset.b;
  const date = box.querySelector("input").value, hour = +box.querySelector("select").value;
  const res = box.querySelector(".res");
  if (!date) { res.innerHTML = `<div class="err">${esc(t("Pick a date."))}</div>`; return; }
  S.liveDate = date;
  const A = S.cities[a], B = S.cities[b];
  const local = new Date(`${date}T${String(hour).padStart(2, "0")}:00:00`); // in the browser's time zone, close enough
  const modes = ["HIGHSPEED_RAIL", "LONG_DISTANCE", "NIGHT_RAIL", "REGIONAL_RAIL", "SUBURBAN", "SUBWAY", "TRAM", "BUS",
    ...(S.modes.has("C") ? ["COACH"] : []), ...(S.modes.has("F") ? ["FERRY"] : [])];
  const q = new URLSearchParams({ fromPlace: `${A.lat},${A.lon}`, toPlace: `${B.lat},${B.lon}`, time: local.toISOString(),
    transitModes: modes.join(","), numItineraries: "8", maxPreTransitTime: "1800", maxPostTransitTime: "1800" });
  if (cursor) q.set("pageCursor", cursor);
  if (!cursor) res.innerHTML = `<div class="hint">${esc(t("Searching…"))}</div>`;
  try {
    const r = await fetch(`${LIVE_API}?${q}`);
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    const clock = (s, tz) => new Date(s).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit", timeZone: tz || "Europe/Paris" });
    const rows = (d.itineraries || []).filter((it) => it.legs.some((l) => l.mode !== "WALK")).map((it) => {
      // the trains and long buses; the walks, metros, trams and city buses in between are left out
      const legs = it.legs.filter((l) => (l.mode !== "WALK" && !["SUBWAY", "TRAM", "BUS"].includes(l.mode)) || (l.mode === "BUS" && (l.duration || 0) > 3600));
      const first = it.legs[0], lastLeg = it.legs[it.legs.length - 1];
      const day = new Date(it.startTime).toLocaleDateString(LOCALE, { weekday: "short", day: "numeric", month: "short", timeZone: first.from.tz || "Europe/Paris" });
      const changes = Math.max(0, legs.length - 1);
      return `<div class="itin"><span class="tm">${day} ${clock(it.startTime, first.from.tz)} → ${clock(it.endTime, lastLeg.to.tz)}</span>
        · <b>${fmtDur(it.duration / 60)}</b> · ${esc(changes ? t(changes === 1 ? "1 change" : "{n} changes", { n: changes }) : t("direct"))}
        <div class="lg">${legs.map((l) => `${clock(l.startTime, l.from.tz)} ${esc(l.from.name)} → ${clock(l.endTime, l.to.tz)} ${esc(l.to.name)} (${esc(l.displayName || l.routeShortName || l.mode)}${l.agencyName ? ", " + esc(l.agencyName) : ""})`).join("<br>")}</div></div>`;
    }).join("");
    const more = d.nextPageCursor ? `<button class="linkbtn" data-more>${esc(t("Later"))}</button>` : "";
    if (cursor) { res.querySelector("[data-more]")?.remove(); res.insertAdjacentHTML("beforeend", rows + more); }
    else res.innerHTML = (rows || `<div class="hint">${esc(t("No journey found that day (the timetable may not be published yet: operators publish a few months ahead)."))}</div>`) + more;
    const m = res.querySelector("[data-more]");
    if (m) m.onclick = () => liveSearch(box, d.nextPageCursor);
  } catch (e) {
    res.innerHTML = `<div class="err">${esc(t("The live search did not answer ({e}).", { e: e.message }))}</div>`;
  }
}

// ---------- the Map tab: one city's direct trains ----------
function renderExplore() {
  const el = $("#explore");
  const src = S.exploreFrom;
  if (!src) { el.innerHTML = `<p class="hint">${esc(t("Tap a city on the map: it shows where you can go by direct train, how long it takes, and how many trains a day."))}</p>`; finish(); return; }
  const direct = (S.adj[src] || []).slice().sort((a, b) => a.best - b.best);
  const dj = dijkstra(src);
  const others = Object.keys(S.cities).filter((id) => id !== src && !S.links[src + ">" + id]?.on?.length)
    .map((id) => ({ id, p: pathTo(dj, id), t: dj.dist[id] ?? Infinity })).sort((x, y) => x.t - y.t);
  el.innerHTML = `<div class="ex-head"><b>${esc(cname(src))}</b> · ${esc(t("{n} cities direct", { n: direct.length }))}
      <button class="linkbtn" data-add="${src}">${esc(t("+ Add to the trip"))}</button></div>
    <p class="hint">${esc(t("Colour: green < 2 h, blue < 4 h, yellow < 6 h, red < 9 h, purple beyond. Tap a line to see its trains."))}</p>` +
    direct.map((L) => destRow(L, "data-d") +
      (S.openDest === L.d ? `<div class="ex-trains">${hopHtml(L)}<button class="linkbtn" data-trip="${L.d}">${esc(t("Take this train in the trip"))}</button></div>` : "")).join("") +
    (others.length ? `<h3>${esc(t("With a change"))}</h3>` + others.map((r) => `<div class="ex-row" data-to="${r.id}"><span class="nm">${esc(cname(r.id))}
        <span class="via">${esc(r.p ? t("via {v}", { v: r.p.slice(1, -1).map(cname).join(", ") }) : t("no way"))}</span></span>
        <span class="tm" style="color:#6a737d">${r.p ? "≈ " + fmtDur(r.t) : "—"}</span></div>`).join("") : "");
  el.querySelectorAll("[data-d]").forEach((row) => row.onclick = () => { S.openDest = S.openDest === row.dataset.d ? null : row.dataset.d; renderExplore(); });
  el.querySelectorAll("[data-to]").forEach((row) => row.onclick = () => { S.stops = [src, row.dataset.to]; switchTab("trip"); renderTrip(); });
  el.querySelectorAll("[data-trip]").forEach((b) => b.onclick = () => { S.stops = [src, b.dataset.trip]; switchTab("trip"); renderTrip(); });
  el.querySelectorAll("[data-add]").forEach((b) => b.onclick = () => addStop(b.dataset.add));
  wireToggles(el);
  finish();
}

// ---------- tabs, transport, settings, address ----------
function switchTab(tab) {
  S.tab = tab;
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  for (const x of ["trip", "explore", "settings"]) $("#tab-" + x).hidden = x !== tab;
  if (tab === "explore") renderExplore(); else finish();
}
// the trip (v), the kinds of transport when not the default (m) and the change time (c) are in the address: a link keeps them
function saveHash() {
  const h = new URLSearchParams();
  if (S.stops.length) h.set("v", S.stops.join(","));
  const def = Object.keys(MODES).filter((k) => MODES[k].on).join("");
  const cur = Object.keys(MODES).filter((k) => S.modes.has(k)).join("");
  if (cur !== def) h.set("m", cur);
  if (S.transfer !== 45) h.set("c", S.transfer);
  lastHash = h.toString();
  history.replaceState(null, "", location.search + "#" + lastHash);
}
function loadHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  S.stops = (h.get("v") || "").split(",").filter((id) => S.cities[id]);
  S.modes = h.get("m") ? new Set(h.get("m").split("").filter((k) => MODES[k])) : new Set(Object.keys(MODES).filter((k) => MODES[k].on));
  S.transfer = +h.get("c") || 45;
}

// one switch for a kind of transport, from the map's buttons or Settings: the graph is rebuilt and the open view drawn again
function setMode(k, on) {
  if (on) S.modes.add(k); else S.modes.delete(k);
  buildGraph();
  renderTrip(false);
  if (S.tab === "explore") renderExplore();
  $("#modes").querySelectorAll("input").forEach((i) => { i.checked = S.modes.has(i.value); });
  renderChips();
}
// the buttons on the map: each kind of transport the data has, lit when shown
function renderChips() {
  const el = $("#chips");
  el.innerHTML = Object.entries(MODES).filter(([k]) => S.counts?.[k]).map(([k, m]) =>
    `<button data-m="${k}" class="${S.modes.has(k) ? "on" : ""}" style="--c:${m.color}" title="${esc(t(m.label))}">${esc(t(m.short))}</button>`).join("");
  el.querySelectorAll("button").forEach((b) => b.onclick = (e) => { e.stopPropagation(); setMode(b.dataset.m, !S.modes.has(b.dataset.m)); });
}

function renderSettings() {
  const counts = {};
  for (const k in S.links) for (const s of S.links[k].all) counts[s.mode] = (counts[s.mode] || 0) + popcount(s.mask);
  S.counts = counts;
  $("#modes").innerHTML = Object.entries(MODES).map(([k, m]) => `<label><input type="checkbox" value="${k}" ${S.modes.has(k) ? "checked" : ""}>
      ${badge(k)} ${esc(t(m.label))} <span class="hint">${esc(t("({n} / week)", { n: num(counts[k] || 0) }))}</span></label>`).join("");
  $("#modes").querySelectorAll("input").forEach((i) => i.onchange = () => setMode(i.value, i.checked));
  renderChips();
  $("#transfer").value = String(S.transfer);
  $("#transfer").onchange = (e) => { S.transfer = +e.target.value; renderTrip(false); };
  $("#show-net").onchange = (e) => { S.showNet = e.target.checked; drawNet(); };
  const d = S.data, w = d.week;
  const day = (s, year) => new Date(s).toLocaleDateString(LOCALE, { day: "numeric", month: "long", ...(year ? { year: "numeric" } : {}) });
  $("#about").innerHTML = esc(t("Typical week read: {from} to {to} (updated {at}). {c} cities, {l} direct links, {s} different trains. Source: {src}, the open timetables the operators publish. A train that runs one day a week is counted. Timetables change in mid-December and operators publish only a few months ahead: for a date far off this is a typical week; “Times on a given day” gives the real trains of a published day. Prices are not known.", {
    from: day(w[0]), to: day(w[6], true), at: new Date(d.generated).toLocaleDateString(LOCALE), c: Object.keys(S.cities).length,
    l: num(d.links.length), s: num(d.links.reduce((n, l) => n + l.s.length, 0)), src: "\u0000",
  })).replace("\u0000", `<a href="https://transitous.org" target="_blank" rel="noopener">Transitous</a>`);
}

async function init() {
  translateDom();
  document.title = "tchoutchoumap";
  const r = await fetch("data/links.json", { cache: "no-cache" });
  S.data = await r.json();
  for (const c of S.data.cities) S.cities[c.id] = c;
  for (const L of S.data.links) S.links[L.o + ">" + L.d] = { o: L.o, d: L.d, p: L.p, all: L.s.map(svcObj) };
  loadHash();
  buildGraph();
  initMap();
  $("#city-list").innerHTML = Object.keys(S.cities).map(cname).sort((a, b) => a.localeCompare(b, LOCALE)).map((n) => `<option value="${esc(n)}">`).join("");
  const add = $("#add-city");
  add.onchange = () => { const id = cityByName(add.value); if (id) { addStop(id); add.value = ""; } };
  add.onkeydown = (e) => { if (e.key === "Enter") add.onchange(); };
  const ex = $("#explore-city");
  ex.onchange = () => { const id = cityByName(ex.value); if (id) focusCity(id); };
  $("#optimize").onclick = optimize;
  $("#reverse").onclick = () => { S.stops.reverse(); renderTrip(); };
  $("#clear").onclick = () => { S.stops = []; renderTrip(); };
  document.querySelectorAll("nav button").forEach((b) => b.onclick = () => switchTab(b.dataset.tab));
  $("#grip").onclick = () => { $("#panel").classList.toggle("big"); document.body.classList.toggle("big"); setTimeout(() => map.invalidateSize(), 50); };
  renderSettings();
  renderTrip();
  if (!S.stops.length) switchTab("explore");
  // a link opened or pasted while the page is open
  window.addEventListener("hashchange", () => {
    if (location.hash === "#" + lastHash) return;
    loadHash(); buildGraph(); renderSettings(); renderTrip();
  });
}
init().catch((e) => { document.body.insertAdjacentHTML("beforeend", `<div class="err" style="position:fixed;top:10px;left:10px;background:#fff;padding:10px;z-index:9999">${esc(t("Error: {e}", { e: e.message }))}</div>`); });
