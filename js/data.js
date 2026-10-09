// 데이터 계층. 화면 코드는 가상 데이터를 직접 읽지 않고 이 파일의 함수만 쓴다.
// Phase 5에서 이 파일 안쪽만 Supabase로 바꿔 끼운다.
import { mockDb, mockAuth } from './mock-data.js';

const MAX_FAILURES = 5;
const LOCK_MINUTES = 10;

// 로그인 상태와 실패 횟수는 이 기기의 브라우저에 남겨 둔다 (같은 휴대폰에서 로그인 유지).
// Phase 5에서는 Supabase 인증과 서버가 맡는다.
const SESSION_KEY = 'basecal.session';
const FAILURES_KEY = 'basecal.loginFailures';

function readStore(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeStore(key, value) {
  try {
    if (value === null) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify(value));
    }
  } catch {
    // 저장이 막힌 브라우저(사생활 보호 모드 등)에서는 이번 접속 동안만 유지된다.
  }
}

let sessionUserId = readStore(SESSION_KEY, null);
// { 아이디: { count: 연속 실패 횟수, lockedUntil: 잠금이 풀리는 시각(밀리초) } }
const failures = readStore(FAILURES_KEY, {});

export function getCurrentUser() {
  const profile = mockDb.profiles.find((p) => p.id === sessionUserId && p.is_active);
  return profile ? { ...profile } : null;
}

// 결과: { ok: true, user } 또는 { ok: false, reason: 'invalid' | 'locked' | 'inactive', ... }
export function signIn(username, password, now = Date.now()) {
  const key = username.trim().toLowerCase();
  let record = failures[key] ?? { count: 0, lockedUntil: 0 };

  if (record.lockedUntil > now) {
    return { ok: false, reason: 'locked', lockedUntil: record.lockedUntil };
  }
  if (record.lockedUntil) {
    // 잠금 시간이 지나면 실패 횟수를 처음부터 센다.
    record = { count: 0, lockedUntil: 0 };
  }

  const profile = mockDb.profiles.find((p) => p.username === key);
  const auth = profile && mockAuth.find((a) => a.user_id === profile.id);

  if (!auth || auth.password !== password) {
    record.count += 1;
    if (record.count >= MAX_FAILURES) {
      record.lockedUntil = now + LOCK_MINUTES * 60 * 1000;
    }
    failures[key] = record;
    writeStore(FAILURES_KEY, failures);
    if (record.lockedUntil) {
      return { ok: false, reason: 'locked', lockedUntil: record.lockedUntil };
    }
    return { ok: false, reason: 'invalid', remainingAttempts: MAX_FAILURES - record.count };
  }

  if (!profile.is_active) {
    return { ok: false, reason: 'inactive' };
  }

  delete failures[key];
  writeStore(FAILURES_KEY, failures);
  sessionUserId = profile.id;
  writeStore(SESSION_KEY, sessionUserId);
  return { ok: true, user: { ...profile } };
}

export function signOut() {
  sessionUserId = null;
  writeStore(SESSION_KEY, null);
}
