from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from functools import partial
from pathlib import Path

if __name__ == '__main__':
    root = Path(__file__).resolve().parent
    print('Frontend preview: http://127.0.0.1:8766', flush=True)
    ThreadingHTTPServer(('127.0.0.1', 8766), partial(SimpleHTTPRequestHandler, directory=str(root))).serve_forever()
