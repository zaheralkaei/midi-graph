#!/usr/bin/env python3
"""Local dev server with no-cache headers so source code changes are picked
up immediately. Same directory listing + MIME behavior as SimpleHTTPServer."""

import http.server
import socketserver

PORT = 8765

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

with socketserver.TCPServer(("", PORT), NoCacheHandler) as httpd:
    print(f"Serving at http://localhost:{PORT} (no-cache)")
    httpd.serve_forever()