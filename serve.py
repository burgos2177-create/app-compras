# Mini servidor estático con Cache-Control: no-store, para que ningún archivo
# se cachee. Necesario en dev con módulos ES — el caché de módulos del navegador
# es persistente y dificulta ver cambios sin Ctrl+Shift+R.
#
# Uso:  python serve.py [puerto]
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8082
print(f"Sirviendo en http://localhost:{port}/  (Cache-Control: no-store)")
ThreadingHTTPServer(("", port), NoCacheHandler).serve_forever()
