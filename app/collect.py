#!/usr/bin/env python3
"""Build the direct-connection graph between the cities of cities.json.

For each station of each city and each day of one week, ask Transitous (MOTIS) for every departure with the
stops that follow (`/api/v1/stoptimes?fetchStops=true`). A departure that later stops in another city of the
list is a direct link. The week is a normal week to come, so a train that runs one day a week shows up.

Stdlib only. Usage: collect.py [--week YYYY-MM-DD] [--reuse] [--only city,city]
  --week   Monday of the week to scan (default: the first Monday at least 3 days ahead)
  --force  write links.json even when it has far fewer trains than the one it replaces
  --reuse  reuse the raw answers already in data/raw (no network) when they exist
Writes data/links.json (read by the page) and keeps the raw answers gzipped in data/raw/<week>/.
"""
import argparse, datetime as dt, gzip, json, math, os, sys, time, urllib.parse, urllib.request
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("TRAINS_DATA", os.path.join(HERE, "..", "data"))
API = "https://api.transitous.org/api/v1/stoptimes"
UA = "tchoutchoumap/1.0 (+https://github.com/Pierregvx/tchoutchoumap; one request at a time)"
MODES_ALL = "HIGHSPEED_RAIL,LONG_DISTANCE,NIGHT_RAIL,COACH,FERRY"
HS_BRANDS = {"AVE", "AVLO", "Avlo", "TGV", "OUIGO", "ICE", "FR", "FA", "Frecciarossa", "Italo", "ITA", "EST", "Eurostar", "Iryo", "IRYO",
             "Lyria", "RJX", "X2000"}
MATCH_M = 1500          # a stop within this distance of a city's station belongs to that city
NIGHT_PREFIX = ("ICN", "NJ", "EN", "ES ", "ICN ", "IC Notte", "Nightjet", "Intercités de nuit", "SN ", "Snälltåget")

def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)

def dist_m(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    x = (lo2 - lo1) * math.cos((la1 + la2) / 2)
    return 6371000 * math.hypot(x, la2 - la1)

def fetch(params, tries=4):
    url = API + "?" + urllib.parse.urlencode(params)
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Encoding": "gzip"})
            with urllib.request.urlopen(req, timeout=120) as r:
                raw = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
                return json.loads(raw)
        except Exception as e:  # noqa: BLE001 - network: retry, then give up on this one
            log("  retry", i + 1, type(e).__name__, str(e)[:120])
            time.sleep(5 * (i + 1))
    return None

def mode_code(st, name):
    m = st.get("mode")
    if m == "NIGHT_RAIL" or name.startswith(NIGHT_PREFIX):
        return "N"
    # some feeds file high-speed trains as regional (Renfe's AVE to Lyon and Marseille, 2026-11-23): the brand decides
    if m in ("REGIONAL_RAIL", "LONG_DISTANCE", "REGIONAL_FAST_RAIL") and name.split(" ")[0] in HS_BRANDS:
        return "H"
    return {"HIGHSPEED_RAIL": "H", "LONG_DISTANCE": "L", "REGIONAL_RAIL": "R", "REGIONAL_FAST_RAIL": "R",
            "COACH": "C", "FERRY": "F"}.get(m, "L")

def train_name(st):
    n = (st.get("displayName") or "").strip()
    if not n or n == st.get("routeShortName", "") and not any(c.isdigit() for c in n):
        n = " ".join(x for x in (st.get("routeShortName"), st.get("tripShortName")) if x).strip() or n
    return n or (st.get("routeLongName") or "").strip()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--week")
    ap.add_argument("--reuse", action="store_true")
    ap.add_argument("--only")
    ap.add_argument("--sleep", type=float, default=0.7)
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()

    cities = json.load(open(os.path.join(HERE, "cities.json"), encoding="utf-8"))
    if a.week:
        monday = dt.date.fromisoformat(a.week)
    else:
        # the first Monday at least 3 days ahead: some feeds publish only two or three weeks ahead
        t = dt.date.today() + dt.timedelta(days=3)
        monday = t + dt.timedelta(days=(7 - t.weekday()) % 7)
    days = [monday + dt.timedelta(days=i) for i in range(7)]
    rawdir = os.path.join(DATA, "raw", monday.isoformat())
    os.makedirs(rawdir, exist_ok=True)
    only = set(a.only.split(",")) if a.only else None

    stations = [(c, s) for c in cities for s in c["st"]]

    def city_of(lat, lon):
        best = None
        for c, s in stations:
            d = dist_m((lat, lon), s)
            if d <= MATCH_M and (best is None or d < best[0]):
                best = (d, c["id"])
        return best[1] if best else None

    # per (trip, o, d): the shortest ride (a train can call at two stations of the same city)
    rides = {}
    ops = {}
    stats = {"requests": 0, "failed": 0, "departures": 0}
    for c in cities:
        if only and c["id"] not in only:
            continue
        modes = MODES_ALL + (",REGIONAL_RAIL" if c.get("reg", True) else "")
        for si, s in enumerate(c["st"]):
            for day in days:
                fn = os.path.join(rawdir, f"{c['id']}-{si}-{day.isoformat()}.json.gz")
                data = None
                if a.reuse and os.path.exists(fn):
                    with gzip.open(fn, "rt", encoding="utf-8") as f:
                        data = json.load(f)
                else:
                    tz = ZoneInfo("Europe/London" if c["cc"] in ("GB", "PT") else "Europe/Paris")
                    start = dt.datetime.combine(day, dt.time(0, 0), tz).astimezone(dt.timezone.utc)
                    data = fetch({"center": f"{s[0]},{s[1]}", "radius": 500, "time": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
                                  "window": 86400, "n": 1, "mode": modes, "fetchStops": "true", "withAlerts": "false"})
                    stats["requests"] += 1
                    if data is None:
                        stats["failed"] += 1
                        log("FAILED", c["id"], s[2], day)
                        continue
                    with gzip.open(fn, "wt", encoding="utf-8") as f:
                        json.dump(data, f)
                    time.sleep(a.sleep)
                sts = data.get("stopTimes", [])
                stats["departures"] += len(sts)
                for st in sts:
                    p = st["place"]
                    if p.get("pickupType") == "NOT_ALLOWED" or p.get("cancelled") or st.get("tripCancelled"):
                        continue
                    if city_of(p["lat"], p["lon"]) != c["id"]:
                        continue
                    dep = p.get("scheduledDeparture") or p.get("departure")
                    if not dep:
                        continue
                    depu = dt.datetime.fromisoformat(dep.replace("Z", "+00:00"))
                    deploc = depu.astimezone(ZoneInfo(p.get("tz") or "Europe/Paris"))
                    if deploc.date() != day:
                        continue  # each local day is read once, from its own query
                    name = train_name(st)
                    mc = mode_code(st, name)
                    op = (st.get("agencyName") or "").strip()
                    if op and st.get("agencyUrl"):
                        ops.setdefault(op, st["agencyUrl"])
                    path = [(round(p["lat"], 3), round(p["lon"], 3))]
                    seen_dest = set()
                    for nx in st.get("nextStops") or []:
                        path.append((round(nx["lat"], 3), round(nx["lon"], 3)))
                        if nx.get("cancelled") or nx.get("dropoffType") == "NOT_ALLOWED":
                            continue
                        d = city_of(nx["lat"], nx["lon"])
                        if not d or d == c["id"] or d in seen_dest:
                            continue
                        arr = nx.get("scheduledArrival") or nx.get("arrival")
                        if not arr:
                            continue
                        seen_dest.add(d)  # first stop in that city = earliest arrival there
                        arru = dt.datetime.fromisoformat(arr.replace("Z", "+00:00"))
                        dur = int((arru - depu).total_seconds() // 60)
                        if dur <= 0 or dur > 60 * 48:
                            continue
                        arrloc = arru.astimezone(ZoneInfo(nx.get("tz") or "Europe/Paris"))
                        key = (st["tripId"], c["id"], d)
                        r = rides.get(key)
                        if r is None or dur < r["dur"]:
                            rides[key] = {"o": c["id"], "d": d, "depu": depu, "dur": dur, "dep": deploc.strftime("%H:%M"),
                                          "arr": arrloc.strftime("%H:%M"), "plus": (arrloc.date() - deploc.date()).days,
                                          "wd": deploc.weekday(), "mode": mc, "name": name, "op": op,
                                          "from": p["name"], "to": nx["name"], "path": list(path)}
                log(f"{c['id']:<11} {s[2]:<18} {day} {len(sts):>5} departures, rides so far {len(rides)}")

    # merge the same service seen in several feeds (same o, d, departure and arrival time) and the same daily
    # service over the week (same o, d, local times, name) into one row with its days of the week
    rank = {"H": 0, "N": 1, "L": 2, "R": 3, "C": 4, "F": 5}
    by_instant = {}
    for r in rides.values():
        k = (r["o"], r["d"], r["depu"], r["dur"])
        old = by_instant.get(k)
        if old is None or (len(r["name"]) > len(old["name"]) and any(ch.isdigit() for ch in r["name"])) \
                or rank[r["mode"]] < rank[old["mode"]]:
            if old is not None and not r["op"]:
                r["op"] = old["op"]
            by_instant[k] = r
    services = {}
    for r in by_instant.values():
        k = (r["o"], r["d"], r["dep"], r["arr"], r["plus"], r["name"], r["mode"])
        sv = services.get(k)
        if sv is None:
            sv = services[k] = dict(r, mask=0)
        sv["mask"] |= 1 << r["wd"]
        sv["dur"] = min(sv["dur"], r["dur"])

    links = {}
    for sv in services.values():
        L = links.setdefault((sv["o"], sv["d"]), {"o": sv["o"], "d": sv["d"], "s": [], "best": None})
        L["s"].append(sv)
        if L["best"] is None or sv["dur"] < L["best"]["dur"] or (sv["dur"] == L["best"]["dur"] and len(sv["path"]) > len(L["best"]["path"])):
            L["best"] = sv
    out_links = []
    for L in sorted(links.values(), key=lambda x: (x["o"], x["d"])):
        L["s"].sort(key=lambda x: (x["dep"], x["dur"]))
        out_links.append({
            "o": L["o"], "d": L["d"],
            # [departure, arrival, days after departure, minutes, weekday mask (bit 0 = Monday), mode, name, operator, from, to]
            "s": [[x["dep"], x["arr"], x["plus"], x["dur"], x["mask"], x["mode"], x["name"], x["op"], x["from"], x["to"]] for x in L["s"]],
            "p": L["best"]["path"],
        })
    out = {
        "generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "week": [d.isoformat() for d in days],
        "source": "Transitous (transitous.org), open timetable data of the operators",
        "stats": stats,
        "cities": [{"id": c["id"], "name": c["name"], **({"fr": c["fr"]} if c.get("fr") else {}), "cc": c["cc"], "lat": c["st"][0][0], "lon": c["st"][0][1],
                    "st": [x[2] for x in c["st"]]} for c in cities],
        "ops": ops,
        "links": out_links,
    }
    # a week read badly (a feed missing that day, the service down) must not replace a good one: under 70 % of the trains, keep the old
    final = os.path.join(DATA, "links.json")
    if not a.force and not a.only and os.path.exists(final):
        try:
            with open(final, encoding="utf-8") as f:
                old = sum(len(x["s"]) for x in json.load(f)["links"])
        except (OSError, ValueError, KeyError):
            old = 0
        new = sum(len(x["s"]) for x in out_links)
        if old and new < 0.7 * old:
            log(f"NOT written: {new} trains against {old} in the current links.json (use --force to write it anyway)")
            return 1
    tmp = os.path.join(DATA, "links.json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, final)
    log(f"done: {len(out_links)} links, {sum(len(x['s']) for x in out_links)} services, {stats}")
    return 0 if stats["failed"] < max(5, stats["requests"] // 10) else 1

if __name__ == "__main__":
    sys.exit(main())
