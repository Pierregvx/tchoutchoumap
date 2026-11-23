#!/usr/bin/env python3
"""Serve the planner (web/ and data/links.json) and rebuild the links once a week.

Static files only: the page does its routing itself. GET /health answers "ok". Gzip for links.json (a few MB).
The weekly rebuild runs collect.py in a child process on REFRESH_DAY (0 = Monday) after REFRESH_HOUR, or at start
when links.json is missing or older than 8 days.
"""
import datetime as dt, gzip, http.server, io, os, subprocess, sys, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.environ.get("WEB", os.path.join(HERE, "..", "web"))
DATA = os.environ.get("TRAINS_DATA", os.path.join(HERE, "..", "data"))
PORT = int(os.environ.get("PORT", "8791"))
REFRESH_DAY = int(os.environ.get("REFRESH_DAY", "1"))     # Tuesday
REFRESH_HOUR = int(os.environ.get("REFRESH_HOUR", "3"))
LINKS = os.path.join(DATA, "links.json")
TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
         ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml"}
_gz = {"mtime": None, "body": None}

def log(*a):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), *a, flush=True)

class H(http.server.BaseHTTPRequestHandler):
    server_version = "trains"
    def log_message(self, *a):
        pass

    def send(self, code, body, ctype, extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path = self.path.split("?", 1)[0].split("#", 1)[0]
        if path == "/health":
            return self.send(200, b"ok", "text/plain")
        if path == "/data/links.json":
            if not os.path.exists(LINKS):
                return self.send(503, b'{"error":"not built yet"}', "application/json")
            m = os.path.getmtime(LINKS)
            if _gz["mtime"] != m:
                with open(LINKS, "rb") as f:
                    _gz["body"] = gzip.compress(f.read(), 6)
                _gz["mtime"] = m
            if "gzip" in (self.headers.get("Accept-Encoding") or ""):
                return self.send(200, _gz["body"], "application/json", {"Content-Encoding": "gzip", "Cache-Control": "no-cache"})
            return self.send(200, gzip.decompress(_gz["body"]), "application/json", {"Cache-Control": "no-cache"})
        if path == "/":
            path = "/index.html"
        full = os.path.realpath(os.path.join(WEB, path.lstrip("/")))
        if not full.startswith(os.path.realpath(WEB) + os.sep) or not os.path.isfile(full):
            return self.send(404, b"not found", "text/plain")
        with open(full, "rb") as f:
            body = f.read()
        self.send(200, body, TYPES.get(os.path.splitext(full)[1], "application/octet-stream"), {"Cache-Control": "no-cache"})

def refresher():
    last_try = 0
    while True:
        try:
            age = time.time() - os.path.getmtime(LINKS) if os.path.exists(LINKS) else 1e9
            now = dt.datetime.now()
            due = age > 8 * 86400 or (now.weekday() == REFRESH_DAY and now.hour >= REFRESH_HOUR and age > 2 * 86400)
            if due and time.time() - last_try > 6 * 3600:
                last_try = time.time()
                log("rebuilding links")
                with open(os.path.join(DATA, "collect.log"), "w") as out:
                    r = subprocess.run([sys.executable, "-B", os.path.join(HERE, "collect.py")], stdout=out, stderr=subprocess.STDOUT)
                log("rebuild finished, code", r.returncode)
                prune_raw()
        except Exception as e:  # noqa: BLE001
            log("refresher error", e)
        time.sleep(600)

def prune_raw(keep=2):
    raw = os.path.join(DATA, "raw")
    if not os.path.isdir(raw):
        return
    weeks = sorted(os.listdir(raw))
    for w in weeks[:-keep]:
        d = os.path.join(raw, w)
        for f in os.listdir(d):
            os.remove(os.path.join(d, f))
        os.rmdir(d)
        log("removed old raw week", w)

if __name__ == "__main__":
    threading.Thread(target=refresher, daemon=True).start()
    srv = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), H)
    log("listening on", PORT)
    srv.serve_forever()
