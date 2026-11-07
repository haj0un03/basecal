# 개발용 앱 서버. python -m http.server와 같지만, 브라우저가 예전 파일을 기억하지 않게 한다.
# (코드를 고친 뒤 새로고침해도 예전 js 파일이 그대로 쓰이는 문제를 막는다)
# 사용법 (프로젝트 폴더에서): python tools/serve.py   → 브라우저에서 http://localhost:8000
import functools
import http.server
import os

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


if __name__ == '__main__':
    handler = functools.partial(NoCacheHandler, directory=root)
    with http.server.ThreadingHTTPServer(('', 8000), handler) as server:
        print('앱 서버를 켰습니다: http://localhost:8000  (끄려면 Ctrl + C)')
        server.serve_forever()
