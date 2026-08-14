#!/usr/bin/env python3
"""Serve the local configurator and proxy its VRX bridge on one origin."""

from __future__ import annotations

import argparse
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


BRIDGE = os.environ.get("GHOST_VRX_BRIDGE", "http://127.0.0.1:48182").rstrip("/")


class Handler(SimpleHTTPRequestHandler):
    def proxy(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length else None
        headers = {}
        if content_type := self.headers.get("Content-Type"):
            headers["Content-Type"] = content_type
        request = Request(BRIDGE + self.path, data=body, headers=headers,
                          method=self.command)
        try:
            with urlopen(request, timeout=5) as response:
                payload = response.read()
                self.send_response(response.status)
                self.send_header("Content-Type",
                                 response.headers.get("Content-Type", "application/json"))
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
        except HTTPError as error:
            payload = error.read()
            self.send_response(error.code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except URLError as error:
            payload = ('{"error":"VRX proxy bridge unavailable: %s"}' %
                       str(error.reason).replace('"', "'")).encode()
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    def do_GET(self) -> None:
        if self.path.startswith("/ghost-dp/"):
            self.proxy()
        else:
            super().do_GET()

    def do_PUT(self) -> None:
        if self.path.startswith("/ghost-dp/"):
            self.proxy()
        else:
            self.send_error(404)

    def do_POST(self) -> None:
        if self.path.startswith("/ghost-dp/"):
            self.proxy()
        else:
            self.send_error(404)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    os.chdir(Path(__file__).resolve().parent)
    server = ThreadingHTTPServer((args.bind, args.port), Handler)
    print(f"GHOST Configurator: http://localhost:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
