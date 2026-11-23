"use strict";
// The page's words. The source strings are English; FR holds their French. The language is the browser's (French if it starts with
// "fr"), or ?lang=en|fr in the address. t("{n} trains", {n: 3}) fills the {names}.
const LANG = (new URLSearchParams(location.search).get("lang") || navigator.language || "en").toLowerCase().startsWith("fr") ? "fr" : "en";
const LOCALE = LANG === "fr" ? "fr-FR" : "en-GB";

const FR = {
  // kinds of transport
  "High speed (TGV, ICE, Frecciarossa…)": "Grande vitesse (TGV, ICE, Frecciarossa…)",
  "Intercity (Intercités, EC, IC…)": "Grandes lignes (Intercités, EC, IC…)",
  "Night trains": "Trains de nuit",
  "Regional trains (TER, Regionale…)": "Trains régionaux (TER, Regionale…)",
  "Long-distance buses (FlixBus, BlaBlaCar Bus…)": "Bus longue distance (FlixBus, BlaBlaCar Bus…)",
  "Ferries": "Ferries",
  "HS": "TGV", "IC": "IC", "Night": "Nuit", "Reg": "TER", "Bus": "Bus", "Ferry": "Ferry",
  // days
  "Mon": "lun", "Tue": "mar", "Wed": "mer", "Thu": "jeu", "Fri": "ven", "Sat": "sam", "Sun": "dim",
  "daily": "tous les jours", "Mon → Fri": "lun → ven", "Mon → Sat": "lun → sam", "Sat, Sun": "sam, dim", "except {d}": "sauf {d}",
  "{n} / day": "{n} / jour", "{n} / week ({days})": "{n} / semaine ({days})", "{n} / week": "{n} / semaine",
  // page
  "Map": "Carte", "My trip": "Mon voyage", "Settings": "Réglages",
  "A city (or tap the map)": "Une ville (ou touche la carte)", "Add a city to the trip": "Ajouter une ville au voyage",
  "Best order": "Meilleur ordre", "Reverse": "Inverser", "Clear": "Vider",
  "Keeps the start and the end, and finds the fastest order for the cities in between": "Garde le départ et l'arrivée, cherche l'ordre le plus rapide pour les villes du milieu",
  "Add your starting city, then the ones you want to pass through (here, or from the Map). Between two cities: the direct train and how many a day, or the shortest way with its changes.":
    "Ajoute ta ville de départ, puis celles où tu veux passer (ici, ou depuis la Carte). Entre deux villes : le train direct et combien par jour, ou le chemin le plus court avec ses changements.",
  "Transport": "Transports", "Changes": "Changement", "Minimum time to change trains": "Temps minimum pour changer de train",
  "Show every direct link on the map": "Montrer toutes les liaisons directes sur la carte", "The data": "Les données",
  "Tap a city on the map: it shows where you can go by direct train, how long it takes, and how many trains a day.":
    "Touche une ville sur la carte : elle montre où aller en train direct, en combien de temps, et combien de trains par jour.",
  "{n} cities direct": "{n} villes en direct", "+ Add to the trip": "+ Ajouter au voyage",
  "Colour: green < 2 h, blue < 4 h, yellow < 6 h, red < 9 h, purple beyond. Tap a line to see its trains.":
    "Couleur : vert < 2 h, bleu < 4 h, jaune < 6 h, rouge < 9 h, violet au-delà. Touche une ligne pour voir les trains.",
  "Take this train in the trip": "Faire ce trajet dans le voyage", "With a change": "Avec changement", "via {v}": "via {v}", "no way": "pas de chemin",
  "Starting from {c}: {n} cities direct": "Départ de {c} : {n} villes en direct", "Then, from {c}: {n} cities direct": "Ensuite, depuis {c} : {n} villes en direct",
  "Tap a city (here or on the map) to add it. On the map: your trip in solid dark blue, where you are in orange, the trains you could take next dashed (green < 2 h, blue < 4 h, yellow < 6 h, red < 9 h, purple beyond).":
    "Touche une ville (ici ou sur la carte) pour l'ajouter. Sur la carte : ton voyage en trait plein bleu nuit, la ville où tu es en orange, les trains possibles ensuite en pointillés (vert < 2 h, bleu < 4 h, jaune < 6 h, rouge < 9 h, violet au-delà).",
  "See the {n} cities": "Voir les {n} villes", "Up": "Monter", "Down": "Descendre", "Remove": "Retirer",
  "{d} at the fastest": "{d} au plus vite", "See the {n} trains": "Voir les {n} trains", "Hide": "Masquer",
  "The same city twice in a row: remove one of them.": "Deux fois la même ville de suite : retire l'une des deux.",
  "no way": "pas de chemin",
  "No way by train between these two cities with the chosen transport (Settings). The city may be poorly covered by the data.":
    "Aucun chemin en train entre ces deux villes avec les transports choisis (Réglages). La ville est peut-être mal couverte par les données.",
  "{n} chg": "{n} chgt", "Direct · {f}": "Direct · {f}", "No direct train: {hops}": "Pas de direct : {hops}", " · then ": " · puis ",
  "Make it a stop:": "Fixer une étape :", "Other ways:": "Autres chemins :", "direct": "direct",
  "In all: {d} on the train · {n} legs": "En tout : {d} dans le train · {n} étapes", "In all: {d} on the train · 1 leg": "En tout : {d} dans le train · 1 étape",
  " (without the legs with no way)": " (sans les étapes sans chemin)",
  "Times on a given day": "Horaires d'un jour précis", "(live, with every connection)": "(en direct, avec toutes les correspondances)",
  "from {h}": "dès {h}", "Search": "Chercher", "Pick a date.": "Choisis une date.", "Searching…": "Recherche…",
  "{n} changes": "{n} changements", "1 change": "1 changement", "Later": "Plus tard",
  "No journey found that day (the timetable may not be published yet: operators publish a few months ahead).":
    "Aucun trajet trouvé ce jour-là (horaires peut-être pas encore publiés : les compagnies publient quelques mois à l'avance).",
  "The live search did not answer ({e}).": "La recherche en direct n'a pas répondu ({e}).",
  "{a} → {b}: {d} · {n} / week": "{a} → {b} : {d} · {n} / semaine", "({n} / week)": "({n} / sem.)",
  "Typical week read: {from} to {to} (updated {at}). {c} cities, {l} direct links, {s} different trains. Source: {src}, the open timetables the operators publish. A train that runs one day a week is counted. Timetables change in mid-December and operators publish only a few months ahead: for a date far off this is a typical week; “Times on a given day” gives the real trains of a published day. Prices are not known.":
    "Semaine type lue : du {from} au {to} (mise à jour le {at}). {c} villes, {l} liaisons directes, {s} trains différents. Source : {src}, les horaires ouverts publiés par les compagnies. Un train qui ne roule qu'un jour par semaine est compté. Les horaires changent mi-décembre et les compagnies ne publient que quelques mois à l'avance : pour une date lointaine, c'est une semaine type ; « Horaires d'un jour précis » donne les vrais trains d'un jour publié. Les prix ne sont pas connus.",
  "Error: {e}": "Erreur : {e}", "Bigger / smaller": "Agrandir / réduire", "Transport shown": "Transports montrés", "timetables": "horaires",
};

function t(s, vars) {
  let out = LANG === "fr" && FR[s] !== undefined ? FR[s] : s;
  if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
  return out;
}

// the static words of index.html: data-t="English" on an element sets its text; data-t-ph its placeholder; data-t-title its title
function translateDom() {
  document.documentElement.lang = LANG;
  for (const el of document.querySelectorAll("[data-t]")) el.textContent = t(el.dataset.t);
  for (const el of document.querySelectorAll("[data-t-ph]")) el.placeholder = t(el.dataset.tPh);
  for (const el of document.querySelectorAll("[data-t-title]")) el.title = t(el.dataset.tTitle);
}
