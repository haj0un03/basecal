// 데이터 계층. 화면 코드는 가상 데이터를 직접 읽지 않고 이 파일의 함수만 쓴다.
// Phase 5에서 이 파일 안쪽만 Supabase로 바꿔 끼운다.
import { mockDb, mockAuth } from './mock-data.js';

const MAX_FAILURES = 5;
const LOCK_MINUTES = 10;

// 들어온 상태와 실패 횟수는 이 기기의 브라우저에 남겨 둔다 (같은 휴대폰에서 들어온 상태 유지).
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
// { 이름: { count: 연속 실패 횟수, lockedUntil: 잠금이 풀리는 시각(밀리초) } }
const failures = readStore(FAILURES_KEY, {});

// ── 개인 코드 ──────────────────────────────────────────────
// 영문·숫자 6자리. 헷갈리는 0, O, 1, I, L은 쓰지 않는다. 대소문자와 띄어쓰기는 무시한다.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

export function normalizeCode(input) {
  return String(input).toUpperCase().replace(/[\s-]/g, '');
}

function randomCode() {
  const values = crypto.getRandomValues(new Uint32Array(CODE_LENGTH));
  return Array.from(values, (v) => CODE_ALPHABET[v % CODE_ALPHABET.length]).join('');
}

function newUniqueCode() {
  let code;
  do {
    code = randomCode();
  } while (mockAuth.some((a) => a.code === code));
  return code;
}

// ── 들어오기 ──────────────────────────────────────────────

export function getCurrentUser() {
  const profile = mockDb.profiles.find((p) => p.id === sessionUserId && p.is_active);
  return profile ? { ...profile } : null;
}

// 결과: { ok: true, user } 또는 { ok: false, reason: 'format' | 'invalid' | 'locked' | 'inactive', ... }
export function signIn(name, codeInput, now = Date.now()) {
  const key = name.trim();
  const code = normalizeCode(codeInput);
  if (!CODE_PATTERN.test(code)) {
    return { ok: false, reason: 'format' };
  }

  let record = failures[key] ?? { count: 0, lockedUntil: 0 };
  if (record.lockedUntil > now) {
    return { ok: false, reason: 'locked', lockedUntil: record.lockedUntil };
  }
  if (record.lockedUntil) {
    // 잠금 시간이 지나면 실패 횟수를 처음부터 센다.
    record = { count: 0, lockedUntil: 0 };
  }

  // 이름이 같은 사람이 있어도 코드는 사람마다 다르므로 한 명만 맞는다.
  const auth = mockAuth.find((a) => a.code === code);
  const profile = auth && mockDb.profiles.find((p) => p.id === auth.user_id && p.name === key);

  if (!profile) {
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

// 연습용 가상 인원과 코드 (들어오기 화면 안내용, Phase 0~4 전용. Phase 5에서 지운다)
export function getDemoAccounts() {
  return mockDb.profiles
    .filter((p) => p.is_active)
    .map((p) => ({
      name: p.name,
      position: p.position,
      role: p.role,
      code: mockAuth.find((a) => a.user_id === p.id)?.code ?? '',
    }));
}

// ── 달력 일정 ──────────────────────────────────────────────
// 내 달력에는 부대 일정(모두 같은 한 건을 함께 본다)과 내가 쓴 일정이 보인다.

// 개인 일정의 종류: 근무(duty), 생일(personal + 매년 반복), 기타(personal)
// 생일은 항상 매년 반복한다 (가정, current_status.md 참고).
const PERSONAL_KINDS = ['duty', 'birthday', 'other'];
const MAX_TITLE_LENGTH = 30;
const MAX_MEMO_LENGTH = 200;

function kindOf(event) {
  if (event.type === 'duty') return 'duty';
  if (event.type === 'personal') return event.repeat_yearly ? 'birthday' : 'other';
  return null;
}

function toCalendarEvent(event, user, occurrence = null) {
  const isTraining = event.type === 'unit' && event.unit_category === 'training';
  return {
    id: event.id,
    type: event.type,
    kind: kindOf(event),
    // 훈련은 제목과 설명 없이 "훈련"으로만 보여 준다.
    title: isTraining ? '훈련' : event.title,
    memo: isTraining ? '' : event.memo,
    start_date: occurrence ?? event.start_date,
    end_date: occurrence ?? event.end_date,
    time: event.time,
    unit_category: event.unit_category,
    repeat_yearly: event.repeat_yearly,
    // 원래 등록한 날짜 (매년 반복 일정을 고칠 때 쓴다)
    original_start_date: event.start_date,
    // 부대 일정은 간부가, 개인 일정은 쓴 사람이 고칠 수 있다.
    editable: event.type === 'unit' ? user.role === 'officer' : kindOf(event) !== null && event.author_id === user.id,
  };
}

// 매년 반복 일정이 start~end 사이에 오는 날짜들. 2월 29일은 윤년이 아니면 2월 28일에 보여 준다.
function yearlyOccurrences(event, start, end) {
  const [firstYear, month, day] = event.start_date.split('-').map(Number);
  const dates = [];
  for (let year = Number(start.slice(0, 4)); year <= Number(end.slice(0, 4)); year += 1) {
    if (year < firstYear) continue;
    const lastDay = new Date(year, month, 0).getDate();
    const iso = `${year}-${String(month).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
    if (iso >= start && iso <= end) dates.push(iso);
  }
  return dates;
}

// start, end: 'YYYY-MM-DD'. 그 기간에 하루라도 걸치는 일정을 돌려준다.
// 부대 일정은 모두에게, 개인 일정(근무·생일·기타)은 쓴 사람에게만 보인다.
export function getCalendarEvents(start, end) {
  const user = getCurrentUser();
  if (!user) return [];
  const result = [];
  mockDb.events
    .filter((e) => e.type === 'unit' || e.author_id === user.id)
    .forEach((e) => {
      if (e.repeat_yearly) {
        yearlyOccurrences(e, start, end).forEach((date) => result.push(toCalendarEvent(e, user, date)));
      } else if (e.start_date <= end && e.end_date >= start) {
        result.push(toCalendarEvent(e, user));
      }
    });
  return result.sort(
    (a, b) =>
      a.start_date.localeCompare(b.start_date) ||
      (a.time ?? '').localeCompare(b.time ?? '') ||
      a.id.localeCompare(b.id),
  );
}

function validatePersonalEvent(input) {
  const kind = input.kind;
  const title = String(input.title ?? '').trim();
  const memo = String(input.memo ?? '').trim();
  const time = String(input.time ?? '').trim();
  const startDate = input.start_date;
  // 생일은 하루짜리다.
  const endDate = kind === 'birthday' ? startDate : input.end_date || startDate;
  const errors = {};

  if (!PERSONAL_KINDS.includes(kind)) errors.kind = '종류를 고르세요.';
  if (!title) {
    errors.title = '제목을 입력하세요.';
  } else if (title.length > MAX_TITLE_LENGTH) {
    errors.title = `제목은 ${MAX_TITLE_LENGTH}자 이하로 입력하세요.`;
  }
  if (!isDate(startDate)) {
    errors.start_date = '날짜를 입력하세요.';
  } else if (!isDate(endDate)) {
    errors.end_date = '끝나는 날짜를 확인하세요.';
  } else if (endDate < startDate) {
    errors.end_date = '끝나는 날짜는 시작 날짜와 같거나 뒤여야 합니다.';
  }
  if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) errors.time = '시간을 확인하세요.';
  if (memo.length > MAX_MEMO_LENGTH) errors.memo = `메모는 ${MAX_MEMO_LENGTH}자 이하로 입력하세요.`;

  const fields = {
    type: kind === 'duty' ? 'duty' : 'personal',
    title,
    start_date: startDate,
    end_date: endDate,
    time: time || null,
    memo,
    repeat_yearly: kind === 'birthday',
  };
  return { errors, fields };
}

function findOwnPersonalEvent(id, user) {
  return mockDb.events.find((e) => e.id === id && kindOf(e) !== null && e.author_id === user.id);
}

// 결과: { ok: true, event } 또는 { ok: false, reason: 'forbidden' | 'invalid' | 'not_found', errors }
export function addPersonalEvent(input) {
  const user = getCurrentUser();
  if (!user) return { ok: false, reason: 'forbidden' };
  const { errors, fields } = validatePersonalEvent(input);
  if (Object.keys(errors).length > 0) return { ok: false, reason: 'invalid', errors };

  const event = { id: nextId('e', mockDb.events), ...fields, author_id: user.id, unit_category: null };
  mockDb.events.push(event);
  return { ok: true, event: toCalendarEvent(event, user) };
}

// 본인이 쓴 개인 일정만 고칠 수 있다.
export function updatePersonalEvent(id, input) {
  const user = getCurrentUser();
  if (!user) return { ok: false, reason: 'forbidden' };
  const event = findOwnPersonalEvent(id, user);
  if (!event) return { ok: false, reason: 'not_found' };
  const { errors, fields } = validatePersonalEvent(input);
  if (Object.keys(errors).length > 0) return { ok: false, reason: 'invalid', errors };

  Object.assign(event, fields);
  return { ok: true, event: toCalendarEvent(event, user) };
}

// 본인이 쓴 개인 일정만 지울 수 있다.
export function deletePersonalEvent(id) {
  const user = getCurrentUser();
  if (!user) return { ok: false, reason: 'forbidden' };
  const event = findOwnPersonalEvent(id, user);
  if (!event) return { ok: false, reason: 'not_found' };
  mockDb.events.splice(mockDb.events.indexOf(event), 1);
  return { ok: true };
}

// ── 간부: 부대 일정 추가·수정·삭제 ───────────────────────────
// 부대 일정은 events에 한 번만 저장하고, 모든 사람의 달력이 그것을 함께 본다.
// 추가·수정·삭제는 누가 언제 했는지 audit_logs에 남긴다.

const UNIT_CATEGORIES = ['event', 'inspection', 'training', 'other'];

function validateUnitEvent(input) {
  const category = input.unit_category;
  const isTraining = category === 'training';
  const title = String(input.title ?? '').trim();
  const memo = String(input.memo ?? '').trim();
  const startDate = input.start_date;
  const endDate = input.end_date || startDate;
  const errors = {};

  if (!UNIT_CATEGORIES.includes(category)) errors.unit_category = '분류를 고르세요.';
  // 훈련은 제목과 설명을 받지 않는다.
  if (!isTraining) {
    if (!title) {
      errors.title = '제목을 입력하세요.';
    } else if (title.length > MAX_TITLE_LENGTH) {
      errors.title = `제목은 ${MAX_TITLE_LENGTH}자 이하로 입력하세요.`;
    }
    if (memo.length > MAX_MEMO_LENGTH) errors.memo = `설명은 ${MAX_MEMO_LENGTH}자 이하로 입력하세요.`;
  }
  if (!isDate(startDate)) {
    errors.start_date = '날짜를 입력하세요.';
  } else if (!isDate(endDate)) {
    errors.end_date = '끝나는 날짜를 확인하세요.';
  } else if (endDate < startDate) {
    errors.end_date = '끝나는 날짜는 시작 날짜와 같거나 뒤여야 합니다.';
  }

  const fields = {
    type: 'unit',
    unit_category: category,
    title: isTraining ? null : title,
    memo: isTraining ? '' : memo,
    start_date: startDate,
    end_date: endDate,
    time: null,
    repeat_yearly: false,
  };
  return { errors, fields };
}

// 간부만. 결과: { ok: true, event } 또는 { ok: false, reason: 'forbidden' | 'invalid' | 'not_found', errors }
export function addUnitEvent(input, now = Date.now()) {
  const officer = requireOfficer();
  if (!officer) return { ok: false, reason: 'forbidden' };
  const { errors, fields } = validateUnitEvent(input);
  if (Object.keys(errors).length > 0) return { ok: false, reason: 'invalid', errors };

  const event = { id: nextId('e', mockDb.events), ...fields, author_id: officer.id };
  mockDb.events.push(event);
  writeAuditLog(officer, 'create_unit_event', 'events', event.id, now);
  return { ok: true, event: toCalendarEvent(event, officer) };
}

export function updateUnitEvent(id, input, now = Date.now()) {
  const officer = requireOfficer();
  if (!officer) return { ok: false, reason: 'forbidden' };
  const event = mockDb.events.find((e) => e.id === id && e.type === 'unit');
  if (!event) return { ok: false, reason: 'not_found' };
  const { errors, fields } = validateUnitEvent(input);
  if (Object.keys(errors).length > 0) return { ok: false, reason: 'invalid', errors };

  Object.assign(event, fields);
  writeAuditLog(officer, 'update_unit_event', 'events', event.id, now);
  return { ok: true, event: toCalendarEvent(event, officer) };
}

export function deleteUnitEvent(id, now = Date.now()) {
  const officer = requireOfficer();
  if (!officer) return { ok: false, reason: 'forbidden' };
  const event = mockDb.events.find((e) => e.id === id && e.type === 'unit');
  if (!event) return { ok: false, reason: 'not_found' };
  mockDb.events.splice(mockDb.events.indexOf(event), 1);
  writeAuditLog(officer, 'delete_unit_event', 'events', event.id, now);
  return { ok: true };
}

// ── 간부: 인원 추가와 코드 발급 ─────────────────────────────
// 추가한 인원과 새 코드는 가상 데이터라서 새로고침하면 사라진다 (Phase 5에서 저장).

const ROLES = ['soldier', 'officer'];
const MAX_NAME_LENGTH = 20;
const MAX_POSITION_LENGTH = 20;

function nextId(prefix, rows) {
  const numbers = rows
    .map((row) => row.id)
    .filter((id) => id.startsWith(prefix))
    .map((id) => Number(id.slice(prefix.length)))
    .filter(Number.isFinite);
  return prefix + String(Math.max(0, ...numbers) + 1).padStart(2, '0');
}

function isDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

function requireOfficer() {
  const user = getCurrentUser();
  return user && user.role === 'officer' ? user : null;
}

function writeAuditLog(actor, action, targetTable, targetId, now) {
  mockDb.audit_logs.push({
    id: nextId('a', mockDb.audit_logs),
    actor_id: actor.id,
    action,
    target_table: targetTable,
    target_id: targetId,
    created_at: new Date(now).toISOString(),
  });
}

// 지금 쓰이는 보직 목록. 입력할 때 추천으로 보여 줘서 "운전병"과 "운전 병"처럼 표기가 갈리는 것을 줄인다.
export function getPositions() {
  const positions = new Set(mockDb.profiles.filter((p) => p.is_active).map((p) => p.position));
  return [...positions].sort((a, b) => a.localeCompare(b, 'ko'));
}

// 코드 다시 발급 대상 목록 (간부만)
export function getMembers() {
  if (!requireOfficer()) return [];
  return mockDb.profiles
    .filter((p) => p.is_active)
    .map((p) => ({ id: p.id, name: p.name, position: p.position, role: p.role }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ko') || a.position.localeCompare(b.position, 'ko'));
}

// 결과: { ok: true, user, code } 또는 { ok: false, reason: 'forbidden' | 'invalid', errors }
export function addMember(input, now = Date.now()) {
  const officer = requireOfficer();
  if (!officer) return { ok: false, reason: 'forbidden' };

  const name = input.name.trim();
  const position = input.position.trim().replace(/\s+/g, ' ');
  const errors = {};
  if (!name) {
    errors.name = '이름을 입력하세요.';
  } else if (name.length > MAX_NAME_LENGTH) {
    errors.name = `이름은 ${MAX_NAME_LENGTH}자 이하로 입력하세요.`;
  }
  if (!ROLES.includes(input.role)) {
    errors.role = '역할을 고르세요.';
  }
  if (!position) {
    errors.position = '보직을 입력하세요.';
  } else if (position.length > MAX_POSITION_LENGTH) {
    errors.position = `보직은 ${MAX_POSITION_LENGTH}자 이하로 입력하세요.`;
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
    id: nextId(input.role === 'officer' ? 'o' : 'u', mockDb.profiles),
    name,
    role: input.role,
    position,
    enlist_date: input.enlist_date,
    discharge_date: input.discharge_date,
    is_active: true,
  };
  const code = newUniqueCode();
  mockDb.profiles.push(profile);
  mockAuth.push({ user_id: profile.id, code });
  writeAuditLog(officer, 'issue_code', 'profiles', profile.id, now);
  return { ok: true, user: { ...profile }, code };
}

// 이전 코드는 바로 쓸 수 없게 된다. 결과: { ok: true, user, code } 또는 { ok: false, reason }
export function reissueCode(userId, now = Date.now()) {
  const officer = requireOfficer();
  if (!officer) return { ok: false, reason: 'forbidden' };

  const profile = mockDb.profiles.find((p) => p.id === userId && p.is_active);
  const auth = profile && mockAuth.find((a) => a.user_id === profile.id);
  if (!auth) return { ok: false, reason: 'not_found' };

  auth.code = newUniqueCode();
  writeAuditLog(officer, 'reissue_code', 'profiles', profile.id, now);
  return { ok: true, user: { ...profile }, code: auth.code };
}
