#!/usr/bin/python3
"""The dashboard as its own desktop window (no browser, no website left running).

Opening the window starts the dashboard server (dashboard/server.py) on a free port of this
machine only, and closing it stops the server again: nothing of the dashboard runs while the
window is closed. If the app itself is killed, the server is stopped too (Linux parent-death signal).
The window uses the system Python's GTK and WebKit; the server runs with the project's venv.
Links that leave the dashboard open in the normal browser.

Usage: /usr/bin/python3 dashboard/app.py   (or: make app)
"""
from __future__ import annotations

import argparse
import ctypes
import signal
import socket
import subprocess
import sys
import urllib.request
from pathlib import Path

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import GLib, Gtk, WebKit2  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
TITLE = "Trading Dashboard"
PAGE = """<html><body style="font:16px system-ui;background:#111;color:#ddd;display:grid;place-items:center;height:90vh">
<div style="text-align:center">{}</div></body></html>"""
WAITING = PAGE.format("<h2>Starting the dashboard…</h2>")
FAILED = PAGE.format("<h2>The dashboard didn't start</h2><p>What went wrong is at the end of <code>logs/dashboard.log</code>.</p>"
                     "<p>Close this window and open it again to retry.</p>")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start_server(port: int) -> subprocess.Popen:
    """The dashboard server, for as long as this window lives (it gets SIGTERM if the app dies)."""
    venv = ROOT / ".venv/bin/python"
    log = open(ROOT / "logs/dashboard.log", "ab")
    die_with_us = lambda: ctypes.CDLL("libc.so.6").prctl(1, signal.SIGTERM)  # noqa: E731  PR_SET_PDEATHSIG
    return subprocess.Popen([str(venv if venv.exists() else sys.executable), "dashboard/server.py", "--host", "127.0.0.1", "--port", str(port)],
                            cwd=ROOT, stdin=subprocess.DEVNULL, stdout=log, stderr=log, preexec_fn=die_with_us)


def stop_server(p: subprocess.Popen) -> None:
    if p.poll() is None:
        p.terminate()
        try:
            p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            p.kill()


def reachable(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=2) as r:
            return r.status == 200
    except OSError:
        return False


class App(Gtk.Window):
    def __init__(self, url: str, server: subprocess.Popen | None = None):
        super().__init__(title=TITLE)
        self.url = url
        self.server = server
        self.set_default_size(1280, 760)
        self.maximize()
        self.set_icon_name("utilities-system-monitor")
        self.view = WebKit2.WebView()
        self.view.connect("decide-policy", self.on_policy)
        self.view.connect("load-failed", lambda *_: self.wait() or True)
        self.add(self.view)
        self.connect("destroy", Gtk.main_quit)
        self.connect("key-press-event", self.on_key)
        self.load()

    def load(self) -> bool:
        if self.server and self.server.poll() is not None:
            self.view.load_html(FAILED, "about:blank")
        elif reachable(self.url):
            self.view.load_uri(self.url)
        else:
            self.wait()
        return False

    def wait(self) -> None:
        self.view.load_html(WAITING, "about:blank")
        GLib.timeout_add(500, self.load)

    def on_policy(self, _view, decision, kind) -> bool:
        """Keep the dashboard in this window; anything else opens in the normal browser."""
        if kind in (WebKit2.PolicyDecisionType.NAVIGATION_ACTION, WebKit2.PolicyDecisionType.NEW_WINDOW_ACTION):
            uri = decision.get_navigation_action().get_request().get_uri()
            if not (uri.startswith(self.url) or uri == "about:blank"):
                decision.ignore()
                Gtk.show_uri_on_window(self, uri, Gtk.get_current_event_time())
                return True
        return False

    def on_key(self, _w, ev) -> bool:
        """F5 / Ctrl+R reload, Ctrl+Q quits."""
        ctrl = ev.state & 4  # Gdk.ModifierType.CONTROL_MASK
        name = Gtk.accelerator_name(ev.keyval, 0)
        if name == "F5" or (ctrl and name == "r"):
            self.load()
            return True
        if ctrl and name == "q":
            Gtk.main_quit()
            return True
        return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, help="show a dashboard that is already running on this port instead of starting one")
    a = ap.parse_args()
    GLib.set_prgname("trading-dashboard")  # matches StartupWMClass in the launcher
    server = None if a.port else start_server(port := free_port())
    try:
        App(f"http://localhost:{a.port or port}/", server).show_all()
        Gtk.main()
    finally:
        if server:
            stop_server(server)
    return 0


if __name__ == "__main__":
    sys.exit(main())
