# tchoutchoumap

A map of the **direct trains between big European cities**, and a trip planner over it. Tap a city: the map shows every city you can
reach without changing, how long the fastest train takes and **how many run a day** (or a week, with their days, for a train that does
not run daily). Build a trip stop by stop: each new stop shows where you can go next. No account, no prices, no tracking.

It favours the simple answer over the clever one: how often and how fast, from a typical week of real timetables, rather than one
"best" connection that hides the others.

## How it works

- **Data**: [Transitous](https://transitous.org), the community routing service over the open (GTFS) timetables of European operators
  (SNCF, Trenitalia, Renfe, DB, ÖBB, SBB, NS, Eurostar, night trains, FlixBus…). No key needed.
- **Collection** (`app/collect.py`, Python 3 standard library only): for every station of every city in `app/cities.json` and every day
  of a coming week, one `stoptimes` query with the stops each departure makes next (`fetchStops=true`). A departure that later stops in
  another city of the list is a **direct link**. One request at a time with a pause (it is a volunteer service): about 900 requests,
  15 minutes. Output: `data/links.json` (cities, links, each link's trains of the week, and the drawn path of its fastest train).
  Raw answers are kept gzipped in `data/raw/<monday>/`; `collect.py --reuse` rebuilds without the network.
- **Server** (`app/serve.py`, standard library): serves `web/` and the (gzipped) `links.json`, and runs the collection again every week.
- **Page** (`web/`, no build step, [Leaflet](https://leafletjs.com) vendored, OpenStreetMap tiles): everything is computed in the
  browser. Shortest way between two stops with no direct train: Dijkstra over the links (fastest train + a change penalty). "Times on a
  given day" asks Transitous live for the real journeys of a date. English and French (`web/i18n.js`; the browser's language, or
  `?lang=en|fr`).

## Run it

```sh
python3 app/collect.py          # builds data/links.json (about 15 minutes)
python3 app/serve.py            # http://localhost:8791 (PORT, WEB, TRAINS_DATA to change)
```

Or with Docker: `docker compose up -d` (see `docker-compose.yml`).

To add a city, add a line to `app/cities.json` (its stations with their coordinates; `"reg": false` for a metropolis whose suburban
trains would make the answers huge, as Paris and London), then run the collection again.

## Known limits

- Operators publish timetables a few months ahead and change them in mid-December: for a date far off, the page shows a typical week.
- Only what operators publish as open data: some links are missing (Paris–Vienna, Madrid–Lisbon, Copenhagen–Stockholm on 2026-11-23).
- Buses are found only near the cities' stations (a city's coach station may be elsewhere). No ferries found yet.
- No prices: there is no open source for them.

## License and credits

Code: [MIT](LICENSE). Bundled: [Leaflet](https://leafletjs.com) 1.9.4 (BSD-2-Clause, `web/vendor/LEAFLET-LICENSE`).
Timetables: [Transitous](https://transitous.org) and the operators' open data it aggregates (each feed under its own licence; the
collected `data/` is not part of this repository). Map tiles: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.
Please keep the collection gentle: Transitous is run by volunteers.
