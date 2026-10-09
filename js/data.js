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

// ── 일회용 보안코드 ──────────────────────────────────────────
// 발급한 코드와 새로 등록한 계정은 가상 데이터라서 새로고침하면 사라진다 (Phase 5에서 저장).

const CODE_VALID_MINUTES = 10;
const ROLES = ['soldier', 'officer'];
const USERNAME_PATTERN = /^[a-z0-9]{4,20}$/;
const MIN_PASSWORD_LENGTH = 8;
const MAX_NAME_LENGTH = 20;

function nextId(prefix, rows) {
  const numbers = rows
    .map((row) => row.id)
    .filter((id) => id.startsWith(prefix))
    .map((id) => Number(id.slice(prefix.length)))
    .filter(Number.isFinite);
  return prefix + String(Math.max(0, ...numbers) + 1).padStart(2, '0');
}

function randomCode() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
  return String(n).padStart(6, '0');
}

function isDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

// 소속 목록 (활성 사용자의 소속에서 모은다)
export function getCompanies() {
  const companies = new Set(mockDb.profiles.filter((p) => p.is_active).map((p) => p.company));
  return [...companies].sort((a, b) => a.localeCompare(b, 'ko'));
}

// 간부만 발급할 수 있다. 결과: { ok: true, code, role, company, expiresAt } 또는 { ok: false, reason }
export function issueInviteCode({ role, company }, now = Date.now()) {
  const user = getCurrentUser();
  if (!user || user.role !== 'officer') {
    return { ok: false, reason: 'forbidden' };
  }
  if (!ROLES.includes(role) || !getCompanies().includes(company)) {
    return { ok: false, reason: 'invalid' };
  }

  // 아직 쓸 수 있는 다른 코드와 겹치지 않게 만든다.
  let code;
  do {
    code = randomCode();
  } while (mockDb.invite_codes.some((c) => c.code === code && !c.used && Date.parse(c.expires_at) > now));

  const row = {
    id: nextId('c', mockDb.invite_codes),
    code,
    role,
    company,
    issued_by: user.id,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + CODE_VALID_MINUTES * 60 * 1000).toISOString(),
    used: false,
    used_by: null,
  };
  mockDb.invite_codes.push(row);
  return { ok: true, code, role, company, expiresAt: row.expires_at };
}

function findUsableCode(input, now) {
  const code = String(input).trim();
  if (!/^\d{6}$/.test(code)) return { reason: 'format' };
  // 같은 숫자가 예전에 발급된 적이 있으면 가장 최근 것을 본다.
  const row = mockDb.invite_codes.filter((c) => c.code === code).at(-1);
  if (!row) return { reason: 'not_found' };
  if (row.used) return { reason: 'used' };
  if (Date.parse(row.expires_at) <= now) return { reason: 'expired' };
  return { row };
}

// 결과: { ok: true, role, company } 또는 { ok: false, reason: 'format' | 'not_found' | 'used' | 'expired' }
export function checkInviteCode(input, now = Date.now()) {
  const { row, reason } = findUsableCode(input, now);
  if (!row) return { ok: false, reason };
  return { ok: true, role: row.role, company: row.company };
}

// 코드를 다시 확인한 뒤 계정을 만들고 바로 로그인시킨다.
// 결과: { ok: true, user } 또는 { ok: false, reason, errors: { 항목: 안내 문구 } }
export function registerWithCode(input, now = Date.now()) {
  const { row, reason } = findUsableCode(input.code, now);
  if (!row) return { ok: false, reason };

  const name = input.name.trim();
  const username = input.username.trim().toLowerCase();
  const errors = {};

  if (!name) {
    errors.name = '이름을 입력하세요.';
  } else if (name.length > MAX_NAME_LENGTH) {
    errors.name = `이름은 ${MAX_NAME_LENGTH}자 이하로 입력하세요.`;
  }

  if (!USERNAME_PATTERN.test(username)) {
    errors.username = '아이디는 영문 소문자와 숫자로 4~20자로 정하세요.';
  } else if (mockDb.profiles.some((p) => p.username === username)) {
    errors.username = '이미 쓰고 있는 아이디입니다.';
  }

  if (input.password.length < MIN_PASSWORD_LENGTH) {
    errors.password = `비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상으로 정하세요.`;
  } else if (input.password !== input.passwordConfirm) {
    errors.passwordConfirm = '비밀번호가 서로 다릅니다.';
  }

  if (!isDate(input.enlist_date)) {
    errors.enlist_date = '입대일을 입력하세요.';
  }
  if (!isDate(input.discharge_date)) {
    errors.discharge_date = '전역 예정일을 입력하세요.';
  } else if (isDate(input.enlist_date) && input.discharge_date <= input.enlist_date) {
    errors.discharge_date = '전역 예정일은 입대일보다 뒤여야 합니다.';
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, reason: 'invalid', errors };
  }

  const profile = {
    id: nextId(row.role === 'officer' ? 'o' : 'u', mockDb.profiles),
    name,
    username,
    role: row.role,
    company: row.company,
    enlist_date: input.enlist_date,
    discharge_date: input.discharge_date,
    is_active: true,
  };
  mockDb.profiles.push(profile);
  mockAuth.push({ user_id: profile.id, password: input.password });
  row.used = true;
  row.used_by = profile.id;

  sessionUserId = profile.id;
  writeStore(SESSION_KEY, sessionUserId);
  return { ok: true, user: { ...profile } };
}
