# 자동 점검 실행기. 화면 없는 Edge(또는 Chrome)로 tests/의 점검 페이지를 열어 결과를 모아 보여 준다.
# 사용법 (프로젝트 폴더에서):
#   python tools/run_tests.py              → 모든 점검
#   python tools/run_tests.py t_leave full/t_swap   → 고른 점검만
#
# 점검은 앱을 임시 폴더에 복사해서 가상 데이터 모드로 돌린다 (js/config.js는 빼므로 서버에 쓰지 않는다).
# - tests/*.html     : 가상 근무지를 비운 복사본에서 (근무가 달력·출타 점검에 끼어들지 않게)
# - tests/full/*.html: 가상 데이터 그대로인 복사본에서 (근무·시설 점검)
# - tests/remote/*.html: 서버 모드 흉내. 가짜 js/config.js를 넣은 복사본에서, tests/remote/fake-server.js가
#   Supabase 대신 답한다 (병사가 받는 데이터를 서버와 같은 규칙으로 걸러 준다)
# 결과: 점검마다 "통과 N / 실패 M"과 실패한 항목. 하나라도 실패하면 끝에 실패로 알려 준다.
import functools
import html
import http.server
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
tests_dir = os.path.join(root, 'tests')

BROWSERS = [
    os.environ.get('BASECAL_BROWSER', ''),
    r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    r'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
    r'C:\Program Files\Google\Chrome\Application\chrome.exe',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]


def find_browser():
    for path in BROWSERS:
        if path and os.path.exists(path):
            return path
    sys.exit('Edge나 Chrome을 찾지 못했습니다. BASECAL_BROWSER 환경 변수에 브라우저 경로를 넣어 주세요.')


def prepare(site):
    """앱을 site(근무지 비움), site/full(그대로), site/remote(서버 모드 흉내)에 복사하고 점검 페이지를 넣는다."""
    for target in (site, os.path.join(site, 'full'), os.path.join(site, 'remote')):
        os.makedirs(target, exist_ok=True)
        shutil.copy(os.path.join(root, 'index.html'), target)
        for folder in ('css', 'js'):
            shutil.copytree(os.path.join(root, folder), os.path.join(target, folder), dirs_exist_ok=True)
        config = os.path.join(target, 'js', 'config.js')
        if os.path.exists(config):
            os.remove(config)
    mock = os.path.join(site, 'js', 'mock-data.js')
    text = open(mock, encoding='utf-8').read()
    emptied = re.sub(r'"duty_posts": \[.*?\n  \],', '"duty_posts": [],', text, count=1, flags=re.S)
    if emptied == text:
        sys.exit('js/mock-data.js에서 duty_posts를 찾지 못했습니다.')
    open(mock, 'w', encoding='utf-8').write(emptied)
    for sub in ('', 'full', 'remote'):
        src = os.path.join(tests_dir, sub)
        for name in os.listdir(src):
            if name.startswith('t_') and name.endswith('.html'):
                shutil.copy(os.path.join(src, name), os.path.join(site, sub, name))
    # 서버 모드 흉내: 가짜 서버 주소의 config.js, 앱보다 먼저 가짜 서버를 불러온다
    remote = os.path.join(site, 'remote')
    with open(os.path.join(remote, 'js', 'config.js'), 'w', encoding='utf-8') as f:
        f.write('export default { "SUPABASE_URL": "https://fake.basecal.test", "SUPABASE_ANON_KEY": "sb_publishable_fake" };\n')
    shutil.copy(os.path.join(tests_dir, 'remote', 'fake-server.js'), remote)
    index = os.path.join(remote, 'index.html')
    page = open(index, encoding='utf-8').read()
    tag = '<script type="module" src="js/app.js"></script>'
    if tag not in page:
        sys.exit('index.html에서 앱 스크립트 줄을 찾지 못했습니다.')
    open(index, 'w', encoding='utf-8').write(page.replace(tag, '<script src="fake-server.js"></script>\n  ' + tag))


def all_tests():
    names = []
    for sub in ('', 'full', 'remote'):
        src = os.path.join(tests_dir, sub)
        names += sorted((sub + '/' if sub else '') + n[:-5] for n in os.listdir(src) if n.startswith('t_') and n.endswith('.html'))
    return names


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, *args):
        pass


def run_one(browser, port, name, work):
    profile = tempfile.mkdtemp(prefix='prof_', dir=work)
    cmd = [browser, '--headless=new', '--disable-gpu', f'--user-data-dir={profile}', '--virtual-time-budget=60000',
           '--dump-dom', f'http://localhost:{port}/{name}.html']
    try:
        out = subprocess.run(cmd, capture_output=True, timeout=180).stdout.decode('utf-8', errors='replace')
    except subprocess.TimeoutExpired:
        return None, ['시간 초과 (창이 열린 채 멈췄을 수 있습니다: confirm/alert 확인)']
    m = re.search(r'<pre id="result">(.*?)</pre>', out, re.S)
    if not m:
        return None, ['결과 없음']
    lines = html.unescape(m.group(1)).split('\n')
    return lines[0], [line for line in lines[1:] if not line.startswith('PASS') and line.strip()]


def main():
    names = sys.argv[1:] or all_tests()
    browser = find_browser()
    work = tempfile.mkdtemp(prefix='basecal-tests-')
    site = os.path.join(work, 'site')
    prepare(site)
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=site))
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()

    total_pass = total_fail = 0
    broken = []
    try:
        for name in names:
            summary, problems = run_one(browser, port, name, work)
            print(f'=== {name}: {summary or "실행 실패"}')
            for line in problems:
                print('   ', line)
            numbers = re.findall(r'\d+', summary or '')
            if len(numbers) == 2:
                total_pass += int(numbers[0])
                total_fail += int(numbers[1])
            if not summary or (len(numbers) == 2 and int(numbers[1]) > 0):
                broken.append(name)
    finally:
        server.shutdown()
        shutil.rmtree(work, ignore_errors=True)
    print(f'\n모두 합쳐 통과 {total_pass} / 실패 {total_fail}')
    if broken:
        print('실패한 점검:', ', '.join(broken))
        sys.exit(1)
    print('모든 점검을 통과했습니다.')


if __name__ == '__main__':
    main()
