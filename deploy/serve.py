#!/usr/bin/env python3
"""appdata boring backend — stdlib static file server.

Serves the built site (vite dist/) from its document root. Nginx strips the
/boring prefix before proxying, so this serves from /.
Loopback-only by design: nginx (appdata) is the only reachable front.
"""
from __future__ import annotations

import functools
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "3004"))
ROOT = os.environ.get("ROOT", "/var/www/boring")


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".wasm": "application/wasm",
        ".ply": "application/octet-stream",
        ".spz": "application/octet-stream",
        ".task": "application/octet-stream",
    }

    def log_message(self, *args):
        pass  # journald stays quiet; appdata health probes instead


if __name__ == "__main__":
    handler = functools.partial(Handler, directory=ROOT)
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    srv.serve_forever()
