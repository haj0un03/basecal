# .env의 Supabase 주소와 공개용 키로 js/config.js를 만든다.
# 브라우저는 .env를 직접 읽지 못해서, 앱이 읽을 수 있는 파일로 옮겨 준다.
# 사용법 (프로젝트 폴더에서): python tools/make_config.py
# js/config.js는 .gitignore에 들어 있어 저장소에 올라가지 않는다. 지우면 가상 데이터로 돌아간다.
import json
import os
import re
import sys

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
values = {}
try:
    with open(os.path.join(root, '.env'), encoding='utf-8-sig') as f:
        for line in f:
            m = re.match(r'\s*([A-Z_]+)\s*=\s*(.*?)\s*$', line)
            if m and not line.lstrip().startswith('#'):
                values[m.group(1)] = m.group(2).strip('"\'')
except FileNotFoundError:
    sys.exit('.env 파일이 없습니다. .env.example을 복사해 .env를 만들고 값을 채우세요.')

url = values.get('SUPABASE_URL', '')
key = values.get('SUPABASE_ANON_KEY', '')
if not url or not key:
    sys.exit('.env에 SUPABASE_URL과 SUPABASE_ANON_KEY를 모두 채우세요.')
if key.startswith('sb_secret_') or '"service_role"' in key:
    sys.exit('비밀(secret/service_role) 키입니다. 공개용(publishable/anon) 키를 넣으세요.')

with open(os.path.join(root, 'js', 'config.js'), 'w', encoding='utf-8', newline='\n') as f:
    f.write('// tools/make_config.py가 .env에서 만든 파일. 저장소에 올리지 않는다. 지우면 가상 데이터로 동작한다.\n')
    f.write('export default ' + json.dumps({'SUPABASE_URL': url, 'SUPABASE_ANON_KEY': key}, indent=2) + ';\n')
print('js/config.js를 만들었습니다. 이제 앱이 Supabase에 저장합니다.')
