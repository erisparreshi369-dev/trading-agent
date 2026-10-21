#!/usr/bin/python3
"""The dashboard as its own desktop window (no browser).

A small GTK window around the page that trading-dashboard already serves on
http://localhost:8080. It uses the system Python's GTK and WebKit (no installs, not the venv).
If the dashboard isn't running yet, the window says so and keeps retrying.
Links that leave the dashboard open in the normal browser.

Usage: /usr/bin/python3 dashboard/app.py [--port 8080]   (or: make app)
"""
from __future__ import annotations

import argparse
import sys
import urllib.request

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import GLib, Gtk, WebKit2  # noqa: E402

TITLE = "Trading Dashboard"
WAITING = """<html><body style="font:16px system-ui;background:#111;color:#ddd;display:grid;place-items:center;height:90vh">
<div style="text-align:center"><h2>The dashboard isn't running yet</h2>
<p>Trying again every few seconds. To start it, type: <code>make restart</code></p></div></body></html>"""


def reachable(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=2) as r:
            return r.status == 200
    except OSError:
        return False


class App(Gtk.Window):
    def __init__(self, url: str):
        super().__init__(title=TITLE)
        self.url = url
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
        if reachable(self.url):
            self.view.load_uri(self.url)
        else:
            self.wait()
        return False

    def wait(self) -> None:
        self.view.load_html(WAITING, "about:blank")
        GLib.timeout_add_seconds(3, self.load)

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
    ap.add_argument("--port", type=int, default=8080)
    a = ap.parse_args()
    GLib.set_prgname("trading-dashboard")  # matches StartupWMClass in the launcher
    App(f"http://localhost:{a.port}/").show_all()
    Gtk.main()
    return 0


if __name__ == "__main__":
    sys.exit(main())
