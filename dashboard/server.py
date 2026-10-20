"""Read-only live dashboard: http://localhost:8080

One poller thread owns the (read-only) database connection, keeps the latest snapshot and the
recent feed in memory, and pushes changes to every browser over Server-Sent Events. HTTP handlers
never touch the database. Only GET is served; there is no endpoint that changes anything.

Usage: python dashboard/server.py [--host 127.0.0.1] [--port 8080]
"""
from __future__ import annotations

import argparse
import json
import queue
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import data  # noqa: E402

STATIC = Path(__file__).resolve().parent / "static"
FILES = {"/": ("index.html", "text/html; charset=utf-8"), "/app.js": ("app.js", "text/javascript; charset=utf-8"),
         "/style.css": ("style.css", "text/css; charset=utf-8")}
FEED_EVERY_S, SNAPSHOT_EVERY_S, SYSTEMD_EVERY_S = 1.0, 2.0, 5.0


def log(msg: str) -> None:
    print(time.strftime("%Y-%m-%dT%H:%M:%S"), msg, flush=True)


class Hub:
    """Latest state + subscriber queues. The poller writes, request threads read."""

    def __init__(self):
        self.lock = threading.Lock()
        self.clients: set[queue.Queue] = set()
        self.snapshot: dict | None = None
        self.snapshot_json = ""
        self.feed = None  # data.Feed, once the database is reachable
        self.error: str | None = None

    def state(self) -> str:
        with self.lock:
            return json.dumps({"snapshot": self.snapshot, "feed": self.feed.all() if self.feed else [], "error": self.error})

    def subscribe(self) -> tuple[queue.Queue, str]:
        q: queue.Queue = queue.Queue(maxsize=500)
        with self.lock:
            self.clients.add(q)
        return q, self.state()

    def unsubscribe(self, q: queue.Queue) -> None:
        with self.lock:
            self.clients.discard(q)

    def publish(self, event: str, payload: str) -> None:
        with self.lock:
            for q in list(self.clients):
                try:
                    q.put_nowait((event, payload))
                except queue.Full:  # a stalled tab: drop it, it reconnects and re-syncs
                    self.clients.discard(q)


def poller(hub: Hub, stop: threading.Event) -> None:
    conn = snap = None
    svc: dict = {}
    t_snap = t_sd = 0.0
    while not stop.is_set():
        try:
            if conn is None:
                path = data.db_path()
                if not path.exists():
                    raise FileNotFoundError(f"no database at {path} (has the collector ever run?)")
                conn = data.connect_ro(path)
                snap = data.Snapshot(conn, path)
                feed = data.Feed(conn)
                feed.seed()
                svc = data.systemd_status()
                feed.systemd_events(svc)
                with hub.lock:
                    hub.feed, hub.error = feed, None
                log(f"reading {path}")
            mono = time.monotonic()
            if mono - t_sd >= SYSTEMD_EVERY_S:
                svc = data.systemd_status()  # outside the lock: it shells out
            with hub.lock:  # subscribe() reads the feed buffers
                new = hub.feed.poll()
                if mono - t_sd >= SYSTEMD_EVERY_S:
                    new += hub.feed.systemd_events(svc)
                    t_sd = mono
            if new:
                hub.publish("feed", json.dumps(new))
            if mono - t_snap >= SNAPSHOT_EVERY_S:
                s = snap.build(svc)
                body = json.dumps({**s, "now": None})  # compare without the clock
                if body != hub.snapshot_json:
                    with hub.lock:
                        hub.snapshot, hub.snapshot_json = s, body
                    hub.publish("snapshot", json.dumps(s))
                t_snap = mono
            if hub.error:
                hub.error = None
        except Exception as e:  # keep serving; show the problem on the page
            msg = f"{type(e).__name__}: {e}"
            if msg != hub.error:
                log("poll failed: " + traceback.format_exc())
                hub.error = msg
                hub.publish("problem", json.dumps(msg))
            if conn is not None and not isinstance(e, (KeyError, TypeError, ValueError)):
                conn.close()
                conn = None
            stop.wait(5)
        stop.wait(FEED_EVERY_S)


def make_handler(hub: Hub):
    class Handler(BaseHTTPRequestHandler):
        server_version = "trading-dashboard"

        def log_message(self, fmt, *args):  # quiet: one line per SSE connection is plenty
            pass

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path == "/events":
                return self.events()
            if path == "/healthz":
                return self.send(200, b"ok\n" if not hub.error else f"degraded: {hub.error}\n".encode(), "text/plain")
            if path == "/":  # first paint without waiting for the stream: current state as an inert JSON block
                state = hub.state().replace("<", "\\u003c")  # can't close the script element
                html = (STATIC / "index.html").read_text().replace("<!--STATE-->", f'<script id="state" type="application/json">{state}</script>')
                return self.send(200, html.encode(), FILES["/"][1])
            if path in FILES:
                name, ctype = FILES[path]
                return self.send(200, (STATIC / name).read_bytes(), ctype)
            self.send(404, b"not found\n", "text/plain")

        def do_HEAD(self):
            self.send(405, b"", "text/plain")

        # Read-only: refuse every method that could carry a change.
        do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD

        def send(self, code: int, body: bytes, ctype: str):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:")
            if code == 405:
                self.send_header("Allow", "GET")
            self.end_headers()
            self.wfile.write(body)

        def events(self):
            q, init = hub.subscribe()
            try:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Accel-Buffering", "no")
                self.end_headers()
                self.wfile.write(f"retry: 3000\nevent: init\ndata: {init}\n\n".encode())
                self.wfile.flush()
                while True:
                    try:
                        event, payload = q.get(timeout=15)
                        self.wfile.write(f"event: {event}\ndata: {payload}\n\n".encode())
                    except queue.Empty:  # lets the page tell "quiet" from "disconnected"
                        self.wfile.write(b"event: ping\ndata: {}\n\n")
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            finally:
                hub.unsubscribe(q)

    return Handler


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8080)
    a = ap.parse_args()
    if a.host not in ("127.0.0.1", "localhost", "::1"):
        print("refusing to listen on a non-loopback address: the dashboard has no authentication", file=sys.stderr)
        return 2
    hub, stop = Hub(), threading.Event()
    threading.Thread(target=poller, args=(hub, stop), daemon=True, name="poller").start()
    srv = ThreadingHTTPServer((a.host, a.port), make_handler(hub))
    srv.daemon_threads = True
    log(f"dashboard on http://localhost:{a.port}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        srv.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
