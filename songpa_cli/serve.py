"""HTML 한 장을 127.0.0.1에서 잠깐 보여 주는 서버 (Termux 전용).

안드로이드 브라우저는 Termux 파일(content://com.termux.files/...)을 열지 못해서
폰 안에서만 닿는 주소로 띄운다. 같은 폰의 다른 앱도 127.0.0.1에 접속할 수 있으므로
- 폴더가 아니라 메모리에 읽어 둔 HTML 한 장만 내보내고,
- 추측할 수 없는 경로(/<token>.html) 외에는 모두 404로 답하며,
- 정해진 시간이 지나면 스스로 끝난다.

사용: python -m songpa_cli.serve <html 파일> <초>
포트와 경로를 표준출력 첫 줄("<port> <path>")로 알린 뒤 표준출력을 닫는다.
"""

from __future__ import annotations

import os
import secrets
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def make_server(body: bytes, token: str) -> ThreadingHTTPServer:
    path = f"/{token}.html"

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path.split("?", 1)[0] != path:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.page_path = path
    return server


def main() -> None:
    html_path, seconds = sys.argv[1], float(sys.argv[2])
    with open(html_path, "rb") as fh:
        body = fh.read()
    server = make_server(body, secrets.token_urlsafe(16))
    print(f"{server.server_address[1]} {server.page_path}", flush=True)
    # 부모가 읽고 나면 파이프가 닫힌다. 이후 출력이 있어도 죽지 않게 /dev/null로 돌린다.
    devnull = os.open(os.devnull, os.O_WRONLY)
    os.dup2(devnull, sys.stdout.fileno())
    os.dup2(devnull, sys.stderr.fileno())
    threading.Timer(seconds, server.shutdown).start()
    server.serve_forever()


if __name__ == "__main__":
    main()
