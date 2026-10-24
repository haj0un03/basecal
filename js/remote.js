// Supabase 연결 (Phase 5).
// js/config.js(.env에서 만든다: python tools/make_config.py)가 있으면 Supabase에 저장하고,
// 없으면 지금까지처럼 코드 안의 가상 데이터로 동작한다.
// 앱은 공개용(publishable) 키만 쓰고, 표가 아니라 서버 함수(supabase/*.sql)만 부른다.

const config = await import('./config.js').then(
  (m) => m.default,
  () => null,
);

export const REMOTE = Boolean(config?.SUPABASE_URL && config?.SUPABASE_ANON_KEY);

// 서버 함수 부르기. 연결이 안 되면 { ok: false, reason: 'network' }
export async function rpc(name, args) {
  try {
    const res = await fetch(`${config.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { apikey: config.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!res.ok) return { ok: false, reason: 'network', status: res.status };
    return await res.json();
  } catch {
    return { ok: false, reason: 'network' };
  }
}
