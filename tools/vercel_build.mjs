// Vercel이 배포할 때 실행하는 준비 단계 (vercel.json의 buildCommand). 이 PC에서는 쓰지 않는다.
// - 앱 파일(index.html, css, js)만 public/ 폴더에 복사한다. 작업 문서·점검·SQL은 배포 주소에 올라가지 않는다
// - Vercel 설정의 환경 변수 SUPABASE_URL, SUPABASE_ANON_KEY가 있으면 js/config.js를 만들어 서버 모드로 띄운다
//   (tools/make_config.py와 같은 규칙: 주소 끝의 /rest/v1/은 떼고, 비밀 키는 거부한다)
// - 환경 변수가 없으면 지금처럼 가상 데이터 모드로 배포한다
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

const out = 'public';
rmSync(out, { recursive: true, force: true });
mkdirSync(out);
cpSync('index.html', `${out}/index.html`);
cpSync('css', `${out}/css`, { recursive: true });
cpSync('js', `${out}/js`, { recursive: true });
rmSync(`${out}/js/config.js`, { force: true });

const url = (process.env.SUPABASE_URL ?? '').trim().replace(/(\/rest\/v1)?\/*$/, '');
const key = (process.env.SUPABASE_ANON_KEY ?? '').trim();
if (key.startsWith('sb_secret_') || key.includes('service_role')) {
  console.error('SUPABASE_ANON_KEY가 비밀(secret/service_role) 키입니다. 공개용(publishable) 키를 넣으세요.');
  process.exit(1);
}
if (url && key) {
  writeFileSync(
    `${out}/js/config.js`,
    '// Vercel 배포 때 환경 변수로 만든 파일 (tools/vercel_build.mjs)\n' +
      `export default ${JSON.stringify({ SUPABASE_URL: url, SUPABASE_ANON_KEY: key }, null, 2)};\n`,
  );
  console.log('서버 모드로 배포합니다 (js/config.js를 만들었습니다).');
} else {
  console.log('환경 변수가 없어 가상 데이터 모드로 배포합니다.');
}
