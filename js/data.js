// 데이터 계층. 화면 코드는 가상 데이터를 직접 읽지 않고 이 파일의 함수만 쓴다.
// Phase 5: js/config.js가 있으면(REMOTE) Supabase 서버 함수로 저장하고, 없으면 가상 데이터로 동작한다.
// - 서버에서 받은 데이터를 mockDb의 같은 표 자리에 채워 쓴다 (읽기 함수는 그대로 바로 값을 돌려준다).
//   5-1: 인원(profiles)·들어오기·코드 발급 / 5-2: 달력 일정(개인·부대)
// - 아직 옮기지 않은 표(휴가 등)는 서버 모드에서도 가상 데이터다. 가상 인원 id(u01…)가 서버와 같아서 함께 쓸 수 있다.
// - 서버 모드에서 쓰기 함수는 Promise를 돌려준다. 화면은 await로 받는다 (가상 데이터 모드에서는 값을 바로 돌려준다).
import { mockDb, mockAuth } from './mock-data.js';
import { REMOTE, rpc } from './remote.js';

// 서버에 연결하지 못했을 때(reason: 'network') 화면에 보여 줄 안내
export const NETWORK_ERROR = '서버에 연결하지 못했습니다. 인터넷 연결을 확인하고 다시 시도하세요.';
import {
  MERIT_COSTS,
  MAX_POINTS_PER_ENTRY,
  OVERNIGHT_PER_QUARTER,
  WEEKEND_OUTING_PER_QUARTER,
  WEEKDAY_OUTING_PER_MONTH,
  WEEKEND_ABSENCE_PER_MONTH,
} from './settings.js';

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

let sessionUserId = REMOTE ? null : readStore(SESSION_KEY, null);
// 서버 모드의 접속 토큰 (들어오면 서버가 준다. 이 기기에 남겨 둔다)
const TOKEN_KEY = 'basecal.token';
let token = REMOTE ? readStore(TOKEN_KEY, null) : null;
// 서버가 세어 준 활성 병사 수 (병사에게는 다른 병사 명단을 주지 않으므로 숫자만 받는다)
let remoteSoldierCount = null;

// 서버에서 화면에 필요한 데이터를 다시 받는다. 앱을 열 때와 서버에 쓴 뒤에 부른다.
// 결과: true(받음) / false(접속이 끊김 → 나간 상태로)
async function loadState() {
  if (!token) return false;
  const state = await rpc('load_state', { p_token: token });
  if (!state.ok) {
    if (state.reason === 'session') {
      // 만료됐거나 코드가 다시 발급됨
      token = null;
      writeStore(TOKEN_KEY, null);
    }
    sessionUserId = null;
    return false;
  }
  mockDb.profiles.splice(0, mockDb.profiles.length, ...state.profiles);
  // 휴가·외박·외출 일정은 5-3에서 옮기므로 아직 이 기기의 가상 데이터를 그대로 둔다
  // (서버에 02_events.sql을 아직 실행하지 않았으면 state.events가 없다 → 가상 일정을 그대로 쓴다)
  if (state.events) {
    const localAbsence = mockDb.events.filter((e) => ['leave', 'overnight', 'outing'].includes(e.type));
    mockDb.events.splice(0, mockDb.events.length, ...localAbsence, ...state.events);
  }
  remoteSoldierCount = state.active_soldiers;
  sessionUserId = state.me.id;
  return true;
}

// 앱을 열 때 한 번 부른다 (가상 데이터 모드에서는 할 일이 없다)
export async function init() {
  if (REMOTE) await loadState();
}
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
// 서버 모드에서는 reason에 'network'(연결 안 됨)가 더 있다.
export function signIn(name, codeInput, now = Date.now()) {
  const key = name.trim();
  const code = normalizeCode(codeInput);
  if (!CODE_PATTERN.test(code)) {
    return { ok: false, reason: 'format' };
  }
  if (REMOTE) return remoteSignIn(key, code);

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

async function remoteSignIn(name, code) {
  const result = await rpc('sign_in', { p_name: name, p_code: code });
  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason,
      lockedUntil: result.locked_until,
      remainingAttempts: result.remaining_attempts,
    };
  }
  token = result.token;
  writeStore(TOKEN_KEY, token);
  if (!(await loadState())) return { ok: false, reason: 'network' };
  return { ok: true, user: getCurrentUser() };
}

export function signOut() {
  sessionUserId = null;
  writeStore(SESSION_KEY, null);
  if (REMOTE && token) {
    const old = token;
    token = null;
    writeStore(TOKEN_KEY, null);
    return rpc('sign_out', { p_token: old });
  }
}

// 연습용 가상 인원과 코드 (들어오기 화면 안내용, Phase 0~4 전용. Phase 5에서 지운다)
export function getDemoAccounts() {
  // 서버 모드에서는 코드를 화면에 보여 주지 않는다 (코드는 서버에 해시로만 있다)
  if (REMOTE) return [];
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

// 개인 일정의 종류: 기타(personal)만. 근무는 근무 순번 편성으로 정해진다 (Phase 3.5)
// 생일 종류는 2026-10-24 사용자 요청으로 뺐다. (매년 반복 일정을 보여 주는 코드는 남겨 둔다)
const PERSONAL_KINDS = ['other'];
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
// 부대 일정은 모두에게, 개인 일정(근무·기타)은 쓴 사람에게만 보인다.
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
  // 순번으로 정해진 내 근무 (고치거나 지울 수 없다)
  dutiesOf(user.id, start, end).forEach((d) => {
    result.push({
      id: `duty:${d.post_id}:${d.date}:${d.slot}`,
      type: 'duty',
      kind: 'duty',
      title: `${d.post_name} ${d.label}`,
      memo: '',
      start_date: d.date,
      end_date: d.date,
      time: null,
      unit_category: null,
      repeat_yearly: false,
      original_start_date: d.date,
      editable: false,
    });
  });
  return result.sort(
    (a, b) =>
      a.start_date.localeCompare(b.start_date) ||
      (a.time ?? '').localeCompare(b.time ?? '') ||
      a.id.localeCompare(b.id),
  );
}

function validatePersonalEvent(input) {
  const kind = input.kind ?? 'other';
  const title = String(input.title ?? '').trim();
  const memo = String(input.memo ?? '').trim();
  const time = String(input.time ?? '').trim();
  const startDate = input.start_date;
  const endDate = input.end_date || startDate;
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
    repeat_yearly: false,
  };
  return { errors, fields };
}

function findOwnPersonalEvent(id, user) {
  return mockDb.events.find((e) => e.id === id && kindOf(e) !== null && e.author_id === user.id);
}

// 서버에 일정을 쓰고, 돌려받은 일정을 화면용 모양으로 바꾼다
async function remoteEventWrite(name, args) {
  const result = await remoteWrite(name, { p_token: token, ...args });
  const user = getCurrentUser();
  if (result.ok && result.event && user) return { ok: true, event: toCalendarEvent(result.event, user) };
  return result;
}

function personalEventArgs(id, input, fields) {
  return {
    p_id: id,
    p_kind: input.kind ?? 'other',
    p_title: fields.title,
    p_start_date: fields.start_date,
    p_end_date: fields.end_date,
    p_time: fields.time,
    p_memo: fields.memo,
  };
}

// 결과: { ok: true, event } 또는 { ok: false, reason: 'forbidden' | 'invalid' | 'not_found' | 'network', errors }
export function addPersonalEvent(input) {
  const user = getCurrentUser();
  if (!user) return { ok: false, reason: 'forbidden' };
  const { errors, fields } = validatePersonalEvent(input);
  if (Object.keys(errors).length > 0) return { ok: false, reason: 'invalid', errors };
  if (REMOTE) return remoteEventWrite('save_personal_event', personalEventArgs(null, input, fields));

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
  if (REMOTE) return remoteEventWrite('save_personal_event', personalEventArgs(id, input, fields));

  Object.assign(event, fields);
  return { ok: true, event: toCalendarEvent(event, user) };
}

// 본인이 쓴 개인 일정만 지울 수 있다.
export function deletePersonalEvent(id) {
  const user = getCurrentUser();
  if (!user) return { ok: false, reason: 'forbidden' };
  const event = findOwnPersonalEvent(id, user);
  if (!event) return { ok: false, reason: 'not_found' };
  if (REMOTE) return remoteWrite('delete_personal_event', { p_token: token, p_id: id });
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

function unitEventArgs(id, fields) {
  return {
    p_id: id,
    p_category: fields.unit_category,
    p_title: fields.title,
    p_start_date: fields.start_date,
    p_end_date: fields.end_date,
    p_memo: fields.memo,
  };
}

// 간부만. 결과: { ok: true, event } 또는 { ok: false, reason: 'forbidden' | 'invalid' | 'not_found' | 'network', errors }
export function addUnitEvent(input, now = Date.now()) {
  const officer = requireOfficer();
  if (!officer) return { ok: false, reason: 'forbidden' };
  const { errors, fields } = validateUnitEvent(input);
  if (Object.keys(errors).length > 0) return { ok: false, reason: 'invalid', errors };
  if (REMOTE) return remoteEventWrite('save_unit_event', unitEventArgs(null, fields));

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
  if (REMOTE) return remoteEventWrite('save_unit_event', unitEventArgs(id, fields));

  Object.assign(event, fields);
  writeAuditLog(officer, 'update_unit_event', 'events', event.id, now);
  return { ok: true, event: toCalendarEvent(event, officer) };
}

export function deleteUnitEvent(id, now = Date.now()) {
  const officer = requireOfficer();
  if (!officer) return { ok: false, reason: 'forbidden' };
  const event = mockDb.events.find((e) => e.id === id && e.type === 'unit');
  if (!event) return { ok: false, reason: 'not_found' };
  if (REMOTE) return remoteWrite('delete_unit_event', { p_token: token, p_id: id });
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
  if (REMOTE) {
    // 서버가 권한과 입력을 한 번 더 확인하고, 코드는 해시로만 저장한다
    return remoteWrite('add_member', {
      p_token: token,
      p_name: name,
      p_role: input.role,
      p_position: position,
      p_enlist_date: input.enlist_date,
      p_discharge_date: input.discharge_date,
    });
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
  if (REMOTE) return remoteWrite('reissue_code', { p_token: token, p_user_id: userId });

  const profile = mockDb.profiles.find((p) => p.id === userId && p.is_active);
  const auth = profile && mockAuth.find((a) => a.user_id === profile.id);
  if (!auth) return { ok: false, reason: 'not_found' };

  auth.code = newUniqueCode();
  writeAuditLog(officer, 'reissue_code', 'profiles', profile.id, now);
  return { ok: true, user: { ...profile }, code: auth.code };
}

// 서버에 쓰고, 성공하면 화면용 데이터를 다시 받는다
async function remoteWrite(name, args) {
  const result = await rpc(name, args);
  if (result.ok) await loadState();
  return result;
}

// ── 휴가 일수 (Phase 3-1) ───────────────────────────────────
// 남은 일수는 저장하지 않고 매번 계산한다: 간부가 승인한 받은 일수 − 신청된 휴가의 사용 일수 합계.

export const LEAVE_TYPES = ['annual', 'reward', 'consolation'];
// 병사가 직접 요청할 수 있는 종류. 연가는 요청 대상이 아니다 (2026-10-23 사용자 결정).
const REQUESTABLE_LEAVE_TYPES = ['reward', 'consolation'];
const MAX_GRANT_DAYS = 30;
const MAX_REASON_LENGTH = 100;

// 종류별 쓴 일수: 취소하지 않은 휴가 신청의 사용 일수 합계 (휴가 신청은 3-2에서 만든다)
function usedDays(userId) {
  const used = Object.fromEntries(LEAVE_TYPES.map((t) => [t, 0]));
  const activeIds = new Set(
    mockDb.leave_requests
      .filter((r) => r.user_id === userId && r.kind === 'leave' && r.status === 'requested')
      .map((r) => r.id),
  );
  mockDb.leave_request_items
    .filter((item) => activeIds.has(item.request_id))
    .forEach((item) => {
      used[item.leave_type] += item.days;
    });
  return used;
}

// 병사만. 포상 외박·포상 외출 남은 횟수: [{ type, granted, used, remaining }]
// 쓴 횟수 = 포상으로 쓴 외박·외출 신청(3-4에서 reward_pass로 표시) 중 취소하지 않은 것
export function getMyPassSummary() {
  const user = getCurrentUser();
  if (!user || user.role !== 'soldier') return [];
  const kindOfPass = { overnight_pass: 'overnight', outing_pass: 'outing' };
  return PASS_TYPES.map((type) => {
    const granted = mockDb.leave_grants
      .filter((g) => g.user_id === user.id && g.leave_type === type && g.status === 'approved')
      .reduce((sum, g) => sum + g.days, 0);
    const used = mockDb.leave_requests.filter(
      (r) => r.user_id === user.id && r.kind === kindOfPass[type] && r.status === 'requested' && r.reward_pass,
    ).length;
    return { type, granted, used, remaining: granted - used };
  });
}

// 병사만. 결과: [{ leave_type, granted, used, remaining }] (연가·포상휴가·위로휴가 순)
export function getMyLeaveSummary() {
  const user = getCurrentUser();
  if (!user || user.role !== 'soldier') return [];
  const used = usedDays(user.id);
  return LEAVE_TYPES.map((type) => {
    const granted = mockDb.leave_grants
      .filter((g) => g.user_id === user.id && g.leave_type === type && g.status === 'approved')
      .reduce((sum, g) => sum + g.days, 0);
    return { leave_type: type, granted, used: used[type], remaining: granted - used[type] };
  });
}

// 내가 요청한 받은 일수 (최근 것부터)
export function getMyLeaveGrants() {
  const user = getCurrentUser();
  if (!user) return [];
  return mockDb.leave_grants
    .filter((g) => g.user_id === user.id)
    .map((g) => ({ ...g }))
    .sort((a, b) => b.requested_at.localeCompare(a.requested_at) || b.id.localeCompare(a.id));
}

// 병사가 받은 일수(포상휴가·위로휴가)를 요청한다. 간부가 승인하기 전에는 남은 일수에 들어가지 않는다.
// 결과: { ok: true, grant } 또는 { ok: false, reason: 'forbidden' | 'invalid', errors }
export function requestLeaveGrant(input, now = Date.now()) {
  const user = getCurrentUser();
  if (!user || user.role !== 'soldier') return { ok: false, reason: 'forbidden' };
  const days = Number(input.days);
  const reason = String(input.reason ?? '').trim();
  const errors = {};
  if (!REQUESTABLE_LEAVE_TYPES.includes(input.leave_type)) errors.leave_type = '포상휴가나 위로휴가를 고르세요.';
  if (!Number.isInteger(days) || days < 1 || days > MAX_GRANT_DAYS) {
    errors.days = `일수는 1~${MAX_GRANT_DAYS} 사이의 숫자로 입력하세요.`;
  }
  if (!reason) {
    errors.reason = '사유를 입력하세요.';
  } else if (reason.length > MAX_REASON_LENGTH) {
    errors.reason = `사유는 ${MAX_REASON_LENGTH}자 이하로 입력하세요.`;
  }
  if (Object.keys(errors).length > 0) return { ok: false, reason: 'invalid', errors };

  const grant = {
    id: nextId('g', mockDb.leave_grants),
    user_id: user.id,
    leave_type: input.leave_type,
    days,
    reason,
    status: 'pending',
    decided_by: null,
    requested_at: new Date(now).toISOString(),
    decided_at: null,
    source: 'request',
    merit_cost: 0,
  };
  mockDb.leave_grants.push(grant);
  return { ok: true, grant: { ...grant } };
}

// 간부만. 승인 대기 중인 요청 (먼저 요청한 것부터), 요청한 병사의 이름·보직 포함
export function getPendingLeaveGrants() {
  if (!requireOfficer()) return [];
  return mockDb.leave_grants
    .filter((g) => g.status === 'pending')
    .map((g) => {
      const p = mockDb.profiles.find((x) => x.id === g.user_id);
      return { ...g, name: p?.name ?? '(알 수 없음)', position: p?.position ?? '', merit_balance: meritBalance(g.user_id) };
    })
    .sort((a, b) => a.requested_at.localeCompare(b.requested_at) || a.id.localeCompare(b.id));
}

// 간부만. decision: 'approve' | 'reject'. 대기 중인 요청만 처리하고 변경 기록에 남긴다.
export function decideLeaveGrant(id, decision, now = Date.now()) {
  const officer = requireOfficer();
  if (!officer) return { ok: false, reason: 'forbidden' };
  if (decision !== 'approve' && decision !== 'reject') return { ok: false, reason: 'invalid' };
  const grant = mockDb.leave_grants.find((g) => g.id === id);
  if (!grant) return { ok: false, reason: 'not_found' };
  if (grant.status !== 'pending') return { ok: false, reason: 'already_decided' };

  // 상점 전환은 승인하는 순간 상점을 뺀다. 그사이 벌점 등으로 상점이 모자라면 승인할 수 없다.
  const isConversion = grant.source === 'merit';
  if (decision === 'approve' && isConversion && meritBalance(grant.user_id) < grant.merit_cost) {
    return { ok: false, reason: 'not_enough_merit', balance: meritBalance(grant.user_id) };
  }

  grant.status = decision === 'approve' ? 'approved' : 'rejected';
  if (decision === 'approve' && isConversion) {
    mockDb.merit_points.push({
      id: nextId('m', mockDb.merit_points),
      user_id: grant.user_id,
      kind: 'conversion',
      points: -grant.merit_cost,
      reason: `${GRANT_LABELS[grant.leave_type]} ${grant.days}${unitOf(grant.leave_type)}로 전환`,
      given_by: officer.id,
      grant_id: grant.id,
      created_at: new Date(now).toISOString(),
    });
  }
  grant.decided_by = officer.id;
  grant.decided_at = new Date(now).toISOString();
  writeAuditLog(officer, decision === 'approve' ? 'approve_leave_grant' : 'reject_leave_grant', 'leave_grants', grant.id, now);
  return { ok: true, grant: { ...grant } };
}

// ── 상점·벌점 ──────────────────────────────────────────────
// 간부가 병사를 골라 사유와 함께 상점(+) 또는 벌점(-)을 준다. 병사가 요청하지 않는다.
// 남은 상점은 저장하지 않고 merit_points의 합계로 매번 계산한다.
// 상점을 포상휴가·포상 외박·포상 외출로 바꾸려면 병사가 요청하고 간부가 승인한다. 승인할 때 상점이 빠진다.
// 바꾸는 점수는 js/settings.js의 MERIT_COSTS (100점 = 포상휴가 1일 또는 포상 외박 1회, 50점 = 포상 외출 1회).
// 벌점은 상점을 0점까지만 깎는다. 남는 벌점은 없어진다 (2026-10-24 사용자 확정).

// 상점으로 바꿀 수 있는 것. 포상 외박·외출은 횟수로 쌓였다가 외박·외출 신청 때(3-4) 1회씩 쓴다.
export const CONVERSION_TARGETS = ['reward', 'overnight_pass', 'outing_pass'];
export const PASS_TYPES = ['overnight_pass', 'outing_pass'];
const GRANT_LABELS = { annual: '연가', reward: '포상휴가', consolation: '위로휴가', overnight_pass: '포상 외박', outing_pass: '포상 외출' };

function unitOf(grantType) {
  return PASS_TYPES.includes(grantType) ? '회' : '일';
}

function meritBalance(userId) {
  return mockDb.merit_points.filter((m) => m.user_id === userId).reduce((sum, m) => sum + m.points, 0);
}

// 아직 처리되지 않은 전환 요청에 걸려 있는 상점 (같은 상점을 두 번 쓰지 못하게)
function pendingConversionCost(userId) {
  return mockDb.leave_grants
    .filter((g) => g.user_id === userId && g.source === 'merit' && g.status === 'pending')
    .reduce((sum, g) => sum + g.merit_cost, 0);
}

// 병사만. 결과: { balance, reserved, available, costs, history: [...] }
export function getMyMeritSummary() {
  const user = getCurrentUser();
  if (!user || user.role !== 'soldier') return null;
  const balance = meritBalance(user.id);
  const reserved = pendingConversionCost(user.id);
  const history = mockDb.merit_points
    .filter((m) => m.user_id === user.id)
    .map((m) => ({ ...m, given_by_name: mockDb.profiles.find((p) => p.id === m.given_by)?.name ?? '' }))
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
  return {
    balance,
    reserved,
    available: balance - reserved,
    costs: { ...MERIT_COSTS },
    history,
  };
}

// 간부가 상점·벌점을 줄 대상: 활성 병사 (이름 순)
export function getSoldiers() {
  if (!requireOfficer()) return [];
  return mockDb.profiles
    .filter((p) => p.is_active && p.role === 'soldier')
    .map((p) => ({ id: p.id, name: p.name, position: p.position, balance: meritBalance(p.id) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ko') || a.position.localeCompare(b.position, 'ko'));
}

// 간부만. input: { user_id, kind: 'merit' | 'demerit', points, reason }
// 결과: { ok: true, entry, balance } 또는 { ok: false, reason: 'forbidden' | 'invalid', errors }
export function givePoints(input, now = Date.now()) {
  const officer = requireOfficer();
  if (!officer) return { ok: false, reason: 'forbidden' };
  const target = mockDb.profiles.find((p) => p.id === input.user_id && p.is_active && p.role === 'soldier');
  const points = Number(input.points);
  const reason = String(input.reason ?? '').trim();
  const errors = {};
  if (!target) errors.user_id = '병사를 고르세요.';
  if (input.kind !== 'merit' && input.kind !== 'demerit') errors.kind = '상점인지 벌점인지 고르세요.';
  if (!Number.isInteger(points) || points < 1 || points > MAX_POINTS_PER_ENTRY) {
    errors.points = `점수는 1~${MAX_POINTS_PER_ENTRY} 사이의 숫자로 입력하세요.`;
  }
  if (!reason) {
    errors.reason = '사유를 입력하세요.';
  } else if (reason.length > MAX_REASON_LENGTH) {
    errors.reason = `사유는 ${MAX_REASON_LENGTH}자 이하로 입력하세요.`;
  }
  if (Object.keys(errors).length > 0) return { ok: false, reason: 'invalid', errors };

  // 벌점은 지금 상점까지만 깎는다 (0점 아래로 내려가지 않음). 처음 준 벌점 점수는 기록에 남긴다.
  const deducted = input.kind === 'merit' ? points : Math.min(points, Math.max(0, meritBalance(target.id)));
  const entry = {
    id: nextId('m', mockDb.merit_points),
    user_id: target.id,
    kind: input.kind,
    points: input.kind === 'merit' ? points : -deducted,
    given_points: points,
    reason,
    given_by: officer.id,
    grant_id: null,
    created_at: new Date(now).toISOString(),
  };
  mockDb.merit_points.push(entry);
  writeAuditLog(officer, input.kind === 'merit' ? 'give_merit' : 'give_demerit', 'merit_points', entry.id, now);
  return { ok: true, entry: { ...entry }, balance: meritBalance(target.id) };
}

// 병사만. 상점을 target(포상휴가·포상 외박·포상 외출)으로 count만큼 바꿔 달라고 요청한다 (간부 승인 대기).
// input: { target, count }  결과: { ok: true, grant } 또는 { ok: false, reason: 'forbidden' | 'invalid', errors }
export function requestMeritConversion(input, now = Date.now()) {
  const user = getCurrentUser();
  if (!user || user.role !== 'soldier') return { ok: false, reason: 'forbidden' };
  const target = input.target ?? 'reward';
  const count = Number(input.count ?? input.days);
  const errors = {};
  if (!CONVERSION_TARGETS.includes(target)) {
    errors.target = '무엇으로 바꿀지 고르세요.';
  } else {
    const unit = unitOf(target);
    const cost = count * MERIT_COSTS[target];
    const available = meritBalance(user.id) - pendingConversionCost(user.id);
    if (!Number.isInteger(count) || count < 1) {
      errors.count = `바꿀 ${unit === '회' ? '횟수' : '일수'}를 1 이상의 숫자로 입력하세요.`;
    } else if (cost > available) {
      errors.count = `상점이 모자랍니다. ${GRANT_LABELS[target]} ${count}${unit}에는 ${cost}점이 필요하고, 지금 쓸 수 있는 상점은 ${available}점입니다.`;
    }
  }
  if (Object.keys(errors).length > 0) return { ok: false, reason: 'invalid', errors };

  const cost = count * MERIT_COSTS[target];
  const grant = {
    id: nextId('g', mockDb.leave_grants),
    user_id: user.id,
    leave_type: target,
    days: count,
    reason: `상점 ${cost}점 전환`,
    status: 'pending',
    decided_by: null,
    requested_at: new Date(now).toISOString(),
    decided_at: null,
    source: 'merit',
    merit_cost: cost,
  };
  mockDb.leave_grants.push(grant);
  return { ok: true, grant: { ...grant } };
}

// ── 휴가 신청 (Phase 3-2) ───────────────────────────────────
// 신청은 간부 승인 없이 바로 등록되고, 그 순간 남은 일수에서 빠진다.
// 오늘부터 한 달 이내의 날짜만 신청할 수 있다. 휴가 일수는 출발일·복귀일을 모두 센다(주말 포함).
// 기간 안에 정원이 찬 날이 있으면 신청할 수 없다 (3-3, 아래 fullDatesIn).

function localISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function inclusiveDays(start, end) {
  const toUTC = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUTC(end) - toUTC(start)) / 86400000) + 1;
}

// 신청할 수 있는 기간: 오늘 ~ 한 달 뒤 같은 날 (다음 달에 그날이 없으면 그 달 마지막 날)
export function getApplyWindow(now = Date.now()) {
  const today = new Date(now);
  const lastDayNextMonth = new Date(today.getFullYear(), today.getMonth() + 2, 0).getDate();
  const end = new Date(today.getFullYear(), today.getMonth() + 1, Math.min(today.getDate(), lastDayNextMonth));
  return { start: localISO(today), end: localISO(end) };
}

function requestView(r) {
  const event = mockDb.events.find((e) => e.id === r.event_id);
  const items = mockDb.leave_request_items
    .filter((item) => item.request_id === r.id)
    .map((item) => ({ leave_type: item.leave_type, days: item.days }));
  return {
    ...r,
    start_date: r.start_date ?? event?.start_date,
    end_date: r.end_date ?? event?.end_date,
    days: items.reduce((sum, item) => sum + item.days, 0),
    items,
  };
}

// 내 출타 신청 (취소한 것 포함, 최근 출발일부터)
export function getMyLeaveRequests() {
  const user = getCurrentUser();
  if (!user) return [];
  return mockDb.leave_requests
    .filter((r) => r.user_id === user.id)
    .map(requestView)
    .sort((a, b) => (b.start_date ?? '').localeCompare(a.start_date ?? '') || b.id.localeCompare(a.id));
}

// 휴가·외박·외출 공통 날짜 확인. 문제가 있으면 안내 문구, 없으면 null.
// 오늘부터 한 달 이내, 내 다른 출타와 겹치지 않음, 기간 안에 정원이 찬 날이 없음.
function checkAbsenceDates(kind, start, end, now) {
  const { start: windowStart, end: windowEnd } = getApplyWindow(now);
  if (!isDate(start) || !isDate(end)) return '출발일과 복귀일을 고르세요.';
  if (end < start) return '복귀일은 출발일과 같거나 뒤여야 합니다.';
  if (start < windowStart || end > windowEnd) {
    return `오늘부터 한 달 이내(${windowStart} ~ ${windowEnd})의 날짜만 신청할 수 있습니다.`;
  }
  // 이미 신청한 내 출타(휴가·외박·외출)와 날짜가 겹치면 막는다 (가정, current_status.md 참고)
  const overlap = getMyLeaveRequests().find((r) => r.status === 'requested' && r.start_date <= end && r.end_date >= start);
  if (overlap) return `이미 신청한 출타(${overlap.start_date} ~ ${overlap.end_date})와 날짜가 겹칩니다.`;
  // 기간 안에 정원이 찬 날이 하루라도 있으면 신청할 수 없다 (3-3). 휴가는 휴가·총 출타, 외박·외출은 총 출타 정원.
  const full = fullDatesIn(kind, start, end);
  if (full.length) {
    return `마감된 날짜가 있어 신청할 수 없습니다: ${full.map((x) => `${Number(x.slice(5, 7))}/${Number(x.slice(8))}`).join(', ')}`;
  }
  return null;
}

// 병사만. input: { start_date, end_date, items: { annual, reward, consolation } }
// 결과: { ok: true, request } 또는 { ok: false, reason: 'forbidden' | 'invalid', errors }
export function applyLeave(input, now = Date.now()) {
  const user = getCurrentUser();
  if (!user || user.role !== 'soldier') return { ok: false, reason: 'forbidden' };
  const start = input.start_date;
  const end = input.end_date || start;
  const errors = {};
  const dateError = checkAbsenceDates('leave', start, end, now);
  if (dateError) errors.dates = dateError;

  const total = errors.dates ? 0 : inclusiveDays(start, end);
  const items = LEAVE_TYPES.map((type) => ({ leave_type: type, days: Number(input.items?.[type] ?? 0) }));
  if (items.some((item) => !Number.isInteger(item.days) || item.days < 0)) {
    errors.items = '종류별 일수는 0 이상의 숫자로 입력하세요.';
  } else if (!errors.dates) {
    const sum = items.reduce((s, item) => s + item.days, 0);
    if (sum !== total) {
      errors.items = `종류별 일수의 합(${sum}일)이 휴가 기간(${total}일)과 같아야 합니다.`;
    } else {
      const remaining = Object.fromEntries(getMyLeaveSummary().map((x) => [x.leave_type, x.remaining]));
      const short = items.filter((item) => item.days > remaining[item.leave_type]);
      if (short.length) {
        const names = { annual: '연가', reward: '포상휴가', consolation: '위로휴가' };
        errors.items = short
          .map((item) => `${names[item.leave_type]} ${item.days - remaining[item.leave_type]}일 부족 (남은 ${remaining[item.leave_type]}일)`)
          .join(', ');
      }
    }
  }
  if (Object.keys(errors).length > 0) return { ok: false, reason: 'invalid', errors };

  // 달력에 보일 일정(본인에게만 보임)과 신청 기록, 종류별 사용 일수를 함께 만든다.
  const event = {
    id: nextId('e', mockDb.events),
    type: 'leave',
    title: '휴가',
    start_date: start,
    end_date: end,
    time: null,
    author_id: user.id,
    memo: '',
    repeat_yearly: false,
    unit_category: null,
  };
  mockDb.events.push(event);
  const request = {
    id: nextId('r', mockDb.leave_requests),
    user_id: user.id,
    kind: 'leave',
    event_id: event.id,
    start_date: start,
    end_date: end,
    status: 'requested',
    requested_at: new Date(now).toISOString(),
    cancelled_at: null,
  };
  mockDb.leave_requests.push(request);
  items
    .filter((item) => item.days > 0)
    .forEach((item) => mockDb.leave_request_items.push({ request_id: request.id, leave_type: item.leave_type, days: item.days }));
  return { ok: true, request: requestView(request) };
}

// 본인만. 취소하면 달력에서 사라지고 일수가 되돌아온다.
export function cancelLeaveRequest(id, now = Date.now()) {
  const user = getCurrentUser();
  if (!user) return { ok: false, reason: 'forbidden' };
  const request = mockDb.leave_requests.find((r) => r.id === id && r.user_id === user.id);
  if (!request) return { ok: false, reason: 'not_found' };
  if (request.status !== 'requested') return { ok: false, reason: 'already_cancelled' };
  request.status = 'cancelled';
  request.cancelled_at = new Date(now).toISOString();
  const eventIndex = mockDb.events.findIndex((e) => e.id === request.event_id);
  if (eventIndex >= 0) mockDb.events.splice(eventIndex, 1);
  return { ok: true, request: requestView(request) };
}

// ── 출타율과 정원 (Phase 3-3) ───────────────────────────────
// 출타율은 두 가지다 (2026-10-24 사용자 결정).
// - total(총 출타): 휴가·외박·외출을 모두 합친 인원의 한도
// - leave(휴가): 휴가 인원의 한도. 휴가는 총 출타에도 포함된다
// 그래서 휴가는 휴가 정원과 총 출타 정원 모두에 자리가 있어야 하고, 외박·외출은 총 출타 정원만 본다.
// 하루 정원 = 부대 전체 활성 병사 수 × 출타율, 소수점 버림.
// 기간별 출타율이 있는 날짜는 기본 출타율 대신 그 값을 쓴다. 겹치면 더 낮은 값을 쓴다 (가정).
// 날짜별 남은 자리 = 정원 − 그 날짜에 걸친 신청 인원. 저장하지 않고 매번 계산한다.

export const RATE_KINDS = ['total', 'leave'];
const REQUEST_KINDS = ['leave', 'overnight', 'outing'];

function activeSoldierCount() {
  if (REMOTE && remoteSoldierCount !== null) return remoteSoldierCount;
  return mockDb.profiles.filter((p) => p.is_active && p.role === 'soldier').length;
}

function defaultRate(rateKind) {
  const rows = mockDb.leave_settings.filter((r) => r.kind === rateKind);
  return rows.length ? rows[rows.length - 1].rate : null;
}

function rateOn(rateKind, iso) {
  const periods = mockDb.leave_rate_periods.filter((p) => p.kind === rateKind && p.start_date <= iso && iso <= p.end_date);
  if (periods.length) return Math.min(...periods.map((p) => p.rate));
  return defaultRate(rateKind);
}

// 출타율이 정해지지 않았으면 정원 제한이 없다(null).
function capacityOn(rateKind, iso) {
  const rate = rateOn(rateKind, iso);
  return rate === null ? null : Math.floor((activeSoldierCount() * rate) / 100);
}

// 그 날짜에 걸친 신청. rateKind가 total이면 휴가·외박·외출 모두, leave면 휴가만.
function requestsOn(rateKind, iso) {
  return mockDb.leave_requests.filter(
    (r) =>
      (rateKind === 'total' ? REQUEST_KINDS.includes(r.kind) : r.kind === 'leave') &&
      r.status === 'requested' &&
      r.start_date <= iso &&
      iso <= r.end_date,
  );
}

function datesBetween(start, end) {
  const dates = [];
  const [y, m, d] = start.split('-').map(Number);
  for (let date = new Date(y, m - 1, d); localISO(date) <= end; date.setDate(date.getDate() + 1)) {
    dates.push(localISO(date));
  }
  return dates;
}

function limitOn(rateKind, iso) {
  const capacity = capacityOn(rateKind, iso);
  const count = requestsOn(rateKind, iso).length;
  return { capacity, count, remaining: capacity === null ? null : capacity - count };
}

// requestKind(leave·overnight·outing)로 그날 더 신청할 수 있는지.
// 휴가는 휴가·총 출타 두 한도 중 적은 쪽, 외박·외출은 총 출타 한도만 본다.
function slotOn(requestKind, iso) {
  const total = limitOn('total', iso);
  const leave = limitOn('leave', iso);
  const limits = requestKind === 'leave' ? [leave, total] : [total];
  const bounded = limits.filter((l) => l.remaining !== null);
  const remaining = bounded.length ? Math.min(...bounded.map((l) => l.remaining)) : null;
  return {
    date: iso,
    total,
    leave,
    remaining,
    full: remaining !== null && remaining <= 0,
    // 출타율을 낮춰 이미 정원을 넘긴 상태 (기존 신청은 그대로 두고 새 신청만 막는다)
    over: limits.some((l) => l.remaining !== null && l.remaining < 0),
  };
}

// 날짜별 자리. 결과: [{ date, remaining, full, over, total: {capacity, count, remaining}, leave: {...} }]
export function getDayAvailability(requestKind, start, end) {
  if (!getCurrentUser()) return [];
  return datesBetween(start, end).map((date) => slotOn(requestKind, date));
}

// 간부만. 날짜별 출타 인원과 명단.
// 결과: [{ date, total, leave, totalFull, leaveFull, over, people: [{ name, position, kind }] }]
export function getAbsenceRoster(start, end) {
  if (!requireOfficer()) return [];
  return datesBetween(start, end).map((date) => {
    const total = limitOn('total', date);
    const leave = limitOn('leave', date);
    return {
      date,
      total,
      leave,
      totalFull: total.remaining !== null && total.remaining <= 0,
      leaveFull: leave.remaining !== null && leave.remaining <= 0,
      over: [total, leave].some((l) => l.remaining !== null && l.remaining < 0),
      people: requestsOn('total', date)
        .map((r) => ({ request: r, profile: mockDb.profiles.find((p) => p.id === r.user_id) }))
        .filter((x) => x.profile)
        .map((x) => ({ name: x.profile.name, position: x.profile.position, kind: x.request.kind }))
        .sort((a, b) => REQUEST_KINDS.indexOf(a.kind) - REQUEST_KINDS.indexOf(b.kind) || a.name.localeCompare(b.name, 'ko')),
    };
  });
}

// 출타율 설정 보기 (간부 화면용). 결과: { soldiers, defaults: { total, leave }, periods: [...] }
export function getRateSettings() {
  if (!requireOfficer()) return null;
  return {
    soldiers: activeSoldierCount(),
    defaults: Object.fromEntries(RATE_KINDS.map((k) => [k, defaultRate(k)])),
    periods: mockDb.leave_rate_periods
      .map((p) => ({ ...p }))
      .sort((a, b) => a.start_date.localeCompare(b.start_date) || a.id.localeCompare(b.id)),
  };
}

function validRate(value) {
  // 빈칸은 0%로 보지 않는다 (실수로 지우고 저장하면 모든 날이 마감되므로).
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const rate = Number(value);
  return Number.isInteger(rate) && rate >= 0 && rate <= 100 ? rate : null;
}

// 간부만. 기본 출타율 두 가지를 한 번에 바꾼다. input: { total, leave }
// 휴가는 총 출타에 포함되므로 휴가 비율이 총 출타 비율보다 크면 저장하지 않는다.
// 결과: { ok: true, changed: [...] } 또는 { ok: false, reason, errors }
export function setDefaultRates(input, now = Date.now()) {
  const officer = requireOfficer();
  if (!officer) return { ok: false, reason: 'forbidden' };
  const next = {};
  const errors = {};
  RATE_KINDS.forEach((kind) => {
    const value = input[kind] === undefined ? defaultRate(kind) : input[kind];
    next[kind] = validRate(value);
    if (next[kind] === null) errors[kind] = '출타율은 0~100 사이의 정수로 입력하세요.';
  });
  if (!errors.total && !errors.leave && next.leave > next.total) {
    errors.leave = `휴가는 총 출타에 포함되므로 휴가 비율(${next.leave}%)이 총 출타 비율(${next.total}%)보다 클 수 없습니다.`;
  }
  if (Object.keys(errors).length > 0) return { ok: false, reason: 'invalid', errors };

  const changed = RATE_KINDS.filter((kind) => next[kind] !== defaultRate(kind));
  changed.forEach((kind) => {
    const row = { id: nextId('s', mockDb.leave_settings), kind, rate: next[kind], updated_by: officer.id, updated_at: new Date(now).toISOString() };
    mockDb.leave_settings.push(row);
    writeAuditLog(officer, 'set_leave_rate', 'leave_settings', row.id, now);
  });
  return { ok: true, changed };
}

// 간부만. 기간별 출타율 넣기. input: { kind: 'total' | 'leave', start_date, end_date, rate }
export function addRatePeriod(input, now = Date.now()) {
  const officer = requireOfficer();
  if (!officer) return { ok: false, reason: 'forbidden' };
  const end = input.end_date || input.start_date;
  const rate = validRate(input.rate);
  const errors = {};
  if (!RATE_KINDS.includes(input.kind)) errors.kind = '총 출타인지 휴가인지 고르세요.';
  if (!isDate(input.start_date)) errors.start_date = '시작 날짜를 입력하세요.';
  else if (!isDate(end) || end < input.start_date) errors.end_date = '끝나는 날짜는 시작 날짜와 같거나 뒤여야 합니다.';
  if (rate === null) errors.rate = '출타율은 0~100 사이의 정수로 입력하세요.';
  if (Object.keys(errors).length > 0) return { ok: false, reason: 'invalid', errors };
  const row = {
    id: nextId('p', mockDb.leave_rate_periods),
    kind: input.kind,
    start_date: input.start_date,
    end_date: end,
    rate,
    created_by: officer.id,
    created_at: new Date(now).toISOString(),
  };
  mockDb.leave_rate_periods.push(row);
  writeAuditLog(officer, 'add_rate_period', 'leave_rate_periods', row.id, now);
  return { ok: true, period: { ...row } };
}

export function deleteRatePeriod(id, now = Date.now()) {
  const officer = requireOfficer();
  if (!officer) return { ok: false, reason: 'forbidden' };
  const index = mockDb.leave_rate_periods.findIndex((p) => p.id === id);
  if (index < 0) return { ok: false, reason: 'not_found' };
  mockDb.leave_rate_periods.splice(index, 1);
  writeAuditLog(officer, 'delete_rate_period', 'leave_rate_periods', id, now);
  return { ok: true };
}

// 신청하려는 기간 중 더 신청할 수 없는 날짜 (applyLeave에서 쓴다)
function fullDatesIn(requestKind, start, end) {
  return datesBetween(start, end).filter((date) => slotOn(requestKind, date).full);
}

// ── 외박·외출 신청 (Phase 3-4) ──────────────────────────────
// 외박·외출은 휴가 일수를 쓰지 않고, 따로 출타율 없이 총 출타 정원 안에서만 나간다.
// 규칙 (2026-10-24 사용자 확정, 숫자는 js/settings.js):
// - 외출은 하루짜리. 토·일이면 주말 외출, 월~금이면 평일 외출
// - 외박은 토요일 출발 → 일요일 복귀(1박 2일)만
// - 한 분기(달력 기준 1~3월…)에 외박 1회, 주말 외출 2회. 단 한 달에는 외박·주말 외출 중 1개만 쓸 수 있다
//   (예: 10월 외박, 11월 주말 외출, 12월 주말 외출. 2026-10-24 사용자 정정)
// - 한 달(1일~말일)에 평일 외출 2회
// - 포상 외박·외출이 남아 있으면 "포상으로 쓰기"를 고를 수 있고, 그러면 포상 1회가 차감되고 위 횟수에는 들어가지 않는다

const ABSENCE_LABELS = { overnight: '외박', outing: '외출' };

function nextDay(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return localISO(new Date(y, m - 1, d + 1));
}

function weekdayOf(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}

function isWeekend(iso) {
  const day = weekdayOf(iso);
  return day === 0 || day === 6;
}

function quarterRange(iso) {
  const [y, m] = iso.split('-').map(Number);
  const q = Math.floor((m - 1) / 3);
  const first = q * 3 + 1;
  const lastDay = new Date(y, first + 2, 0).getDate();
  return {
    start: `${y}-${String(first).padStart(2, '0')}-01`,
    end: `${y}-${String(first + 2).padStart(2, '0')}-${lastDay}`,
    label: `${first}~${first + 2}월`,
  };
}

function monthRange(iso) {
  const [y, m] = iso.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  return { start: `${y}-${String(m).padStart(2, '0')}-01`, end: `${y}-${String(m).padStart(2, '0')}-${lastDay}`, label: `${m}월` };
}

// 그 날짜가 속한 분기·달에 내가 쓴 외박·외출 횟수 (포상으로 쓴 것과 취소한 것은 빼고 센다)
// 결과: { quarter: { label, overnight, weekendOuting }, month: { label, weekend, weekdayOuting }, limits: {...} }
export function getMyAbsenceQuota(iso) {
  const user = getCurrentUser();
  if (!user || user.role !== 'soldier') return null;
  const q = quarterRange(iso);
  const mo = monthRange(iso);
  const mine = mockDb.leave_requests.filter((r) => r.user_id === user.id && r.status === 'requested' && !r.reward_pass);
  const inRange = (r, range) => r.start_date >= range.start && r.start_date <= range.end;
  return {
    quarter: {
      label: q.label,
      overnight: mine.filter((r) => r.kind === 'overnight' && inRange(r, q)).length,
      weekendOuting: mine.filter((r) => r.kind === 'outing' && isWeekend(r.start_date) && inRange(r, q)).length,
    },
    month: {
      label: mo.label,
      // 그 달의 외박 + 주말 외출
      weekend: mine.filter((r) => (r.kind === 'overnight' || isWeekend(r.start_date)) && inRange(r, mo)).length,
      weekdayOuting: mine.filter((r) => r.kind === 'outing' && !isWeekend(r.start_date) && inRange(r, mo)).length,
    },
    limits: {
      overnight: OVERNIGHT_PER_QUARTER,
      weekendOuting: WEEKEND_OUTING_PER_QUARTER,
      weekend: WEEKEND_ABSENCE_PER_MONTH,
      weekdayOuting: WEEKDAY_OUTING_PER_MONTH,
    },
  };
}

// 횟수 규칙 확인. 문제가 있으면 안내 문구, 없으면 null. (포상으로 쓰면 확인하지 않는다)
function checkAbsenceQuota(kind, start) {
  const quota = getMyAbsenceQuota(start);
  const { quarter, month, limits } = quota;
  if (kind === 'overnight' || isWeekend(start)) {
    if (kind === 'overnight' && quarter.overnight >= limits.overnight) return `이번 분기(${quarter.label}) 외박 ${limits.overnight}회를 이미 썼습니다.`;
    if (kind === 'outing' && quarter.weekendOuting >= limits.weekendOuting) return `이번 분기(${quarter.label}) 주말 외출 ${limits.weekendOuting}회를 모두 썼습니다.`;
    if (month.weekend >= limits.weekend) {
      return `${month.label}에 이미 외박이나 주말 외출을 썼습니다. 외박·주말 외출은 한 달에 ${limits.weekend}개만 쓸 수 있습니다.`;
    }
    return null;
  }
  if (month.weekdayOuting >= limits.weekdayOuting) return `${month.label} 평일 외출 ${limits.weekdayOuting}회를 모두 썼습니다.`;
  return null;
}

// 병사만. input: { kind: 'overnight' | 'outing', start_date, end_date, use_pass }
// 결과: { ok: true, request } 또는 { ok: false, reason: 'forbidden' | 'invalid', errors }
export function applyAbsence(input, now = Date.now()) {
  const user = getCurrentUser();
  if (!user || user.role !== 'soldier') return { ok: false, reason: 'forbidden' };
  const kind = input.kind;
  const errors = {};
  if (!['overnight', 'outing'].includes(kind)) {
    return { ok: false, reason: 'invalid', errors: { kind: '외박인지 외출인지 고르세요.' } };
  }
  const start = input.start_date;
  // 외출은 하루, 외박은 토요일 출발 → 다음 날(일요일) 복귀로 정해진다.
  const end = kind === 'outing' || !isDate(start) ? start : nextDay(start);
  const usePass = Boolean(input.use_pass);
  if (kind === 'outing' && input.end_date && input.end_date !== start) {
    errors.dates = '외출은 하루만 신청할 수 있습니다.';
  } else if (kind === 'overnight' && (!isDate(start) || weekdayOf(start) !== 6 || (input.end_date && input.end_date !== end))) {
    errors.dates = '외박은 토요일 출발, 일요일 복귀(1박 2일)만 신청할 수 있습니다.';
  } else {
    const dateError = checkAbsenceDates(kind, start, end, now) ?? (usePass ? null : checkAbsenceQuota(kind, start));
    if (dateError) errors.dates = dateError;
  }
  if (usePass) {
    const passType = kind === 'overnight' ? 'overnight_pass' : 'outing_pass';
    const left = getMyPassSummary().find((x) => x.type === passType)?.remaining ?? 0;
    if (left < 1) errors.use_pass = `남은 포상 ${ABSENCE_LABELS[kind]}이 없습니다.`;
  }
  if (Object.keys(errors).length > 0) return { ok: false, reason: 'invalid', errors };

  const event = {
    id: nextId('e', mockDb.events),
    type: kind,
    title: ABSENCE_LABELS[kind],
    start_date: start,
    end_date: end,
    time: null,
    author_id: user.id,
    memo: '',
    repeat_yearly: false,
    unit_category: null,
  };
  mockDb.events.push(event);
  const request = {
    id: nextId('r', mockDb.leave_requests),
    user_id: user.id,
    kind,
    event_id: event.id,
    start_date: start,
    end_date: end,
    status: 'requested',
    requested_at: new Date(now).toISOString(),
    cancelled_at: null,
    reward_pass: usePass,
  };
  mockDb.leave_requests.push(request);
  return { ok: true, request: requestView(request) };
}

// ── 근무 순번 편성 (Phase 3.5) ─────────────────────────────
// 근무자는 저장하지 않고 매번 계산한다 (prd.md "추가. 근무 순번 편성").
// - 근무지의 순번 기준일(start_date)에 명단 1번이 첫 시간대, 2번이 둘째 시간대에 서고, 날마다 시간대 수만큼 순번이 넘어간다.
// - 그날 나가 있는(휴가·외박·외출) 사람이나 이미 그날 근무가 있는 사람은 건너뛰고, 그날 순번에 없는 다음 사람이 대신 선다.
//   다른 날의 순번은 밀리지 않는다.
// - 간부의 손 수정·근무 교대 결과(duty_overrides)가 있으면 그 사람이 선다.
// - 근무는 아직 가상 데이터다 (Supabase로는 휴가와 함께 옮긴다).

const MAX_POST_NAME_LENGTH = 20;
const MAX_SLOT_LABEL_LENGTH = 10;
const MAX_SLOTS = 8;
// 서버 모드에서 병사는 다른 병사의 명단을 받지 않는다. 근무를 서버로 옮기기 전까지는 가상 인원 이름으로 보여 준다.
const MOCK_NAMES = new Map(mockDb.profiles.map((p) => [p.id, p.name]));

function nameOf(userId) {
  return mockDb.profiles.find((p) => p.id === userId)?.name ?? MOCK_NAMES.get(userId) ?? '(알 수 없음)';
}

function daysFrom(start, iso) {
  const [a, b, c] = start.split('-').map(Number);
  const [x, y, z] = iso.split('-').map(Number);
  return Math.round((Date.UTC(x, y - 1, z) - Date.UTC(a, b - 1, c)) / 86400000);
}

function isAway(userId, iso) {
  return mockDb.leave_requests.some(
    (r) => r.user_id === userId && r.status === 'requested' && r.start_date <= iso && iso <= r.end_date,
  );
}

function rosterOf(postId) {
  return mockDb.duty_rosters
    .filter((r) => r.post_id === postId)
    .sort((a, b) => a.order - b.order)
    .map((r) => r.user_id);
}

function activePosts() {
  return mockDb.duty_posts.filter((p) => p.is_active).sort((a, b) => a.id.localeCompare(b.id));
}

// 한 근무지의 그날 근무. 결과: [{ slot, label, user_id(대신 설 사람이 없으면 null), source }]
// source: rotation(순번) | substitute(대신 섬) | manual(간부 손 수정) | swap(교대)
function postDay(post, iso) {
  const roster = rosterOf(post.id);
  const k = post.slots.length;
  const n = roster.length;
  if (iso < post.start_date || k === 0 || n < k) return [];
  const base = daysFrom(post.start_date, iso) * k;
  const natural = post.slots.map((_, s) => roster[(base + s) % n]);
  const overrides = mockDb.duty_overrides.filter((o) => o.post_id === post.id && o.date === iso);
  const taken = new Set(overrides.map((o) => o.user_id));
  return post.slots.map((label, s) => {
    const override = overrides.find((o) => o.slot === s);
    if (override) return { slot: s, label, user_id: override.user_id, source: override.source };
    let userId = natural[s];
    let source = 'rotation';
    if (taken.has(userId) || isAway(userId, iso)) {
      source = 'substitute';
      userId = null;
      for (let i = 1; i < n; i += 1) {
        const candidate = roster[(base + s + i) % n];
        if (!taken.has(candidate) && !natural.includes(candidate) && !isAway(candidate, iso)) {
          userId = candidate;
          break;
        }
      }
    }
    if (userId) taken.add(userId);
    return { slot: s, label, user_id: userId, source };
  });
}

// 내 근무 (start~end). 결과: [{ date, post_id, post_name, slot, label, source }]
function dutiesOf(userId, start, end) {
  const result = [];
  const posts = activePosts();
  for (let iso = start; iso <= end; iso = nextDay(iso)) {
    posts.forEach((post) => {
      postDay(post, iso)
        .filter((x) => x.user_id === userId)
        .forEach((x) => result.push({ date: iso, post_id: post.id, post_name: post.name, slot: x.slot, label: x.label, source: x.source }));
    });
  }
  return result;
}

export function getMyDuties(start, end) {
  const user = getCurrentUser();
  if (!user) return [];
  return dutiesOf(user.id, start, end);
}

// 근무표: 그날 근무지별 시간대와 근무자 (병사도 본다 — 교대할 상대를 고르기 위해)
export function getDutyBoard(iso) {
  if (!getCurrentUser() || !isDate(iso)) return [];
  return activePosts().map((post) => ({
    post_id: post.id,
    post_name: post.name,
    slots: postDay(post, iso).map((x) => ({ ...x, name: x.user_id ? nameOf(x.user_id) : null })),
  }));
}

// 근무지 목록과 순번 명단
export function getDutyPosts() {
  if (!getCurrentUser()) return [];
  return activePosts().map((post) => ({
    id: post.id,
    name: post.name,
    slots: [...post.slots],
    start_date: post.start_date,
    roster: rosterOf(post.id).map((id) => ({ user_id: id, name: nameOf(id) })),
  }));
}

function splitSlots(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[,\n]/);
  return list.map((x) => String(x).trim().replace(/\s+/g, ' ')).filter(Boolean);
}

// 간부만. input: { id(고칠 때), name, slots: ['1번초', …] 또는 '1번초, 2번초', roster: [병사 id 순서대로] }
// 시간대나 명단이 바뀌면 순번 기준일을 오늘로 잡아 새 명단 1번부터 다시 시작한다 (가정).
// 결과: { ok: true, post } 또는 { ok: false, reason: 'forbidden' | 'not_found' | 'invalid', errors }
export function saveDutyPost(input, now = Date.now()) {
  const officer = requireOfficer();
  if (!officer) return { ok: false, reason: 'forbidden' };
  const existing = input.id ? mockDb.duty_posts.find((p) => p.id === input.id && p.is_active) : null;
  if (input.id && !existing) return { ok: false, reason: 'not_found' };

  const name = String(input.name ?? '').trim().replace(/\s+/g, ' ');
  const slots = splitSlots(input.slots);
  const roster = Array.isArray(input.roster) ? input.roster : [];
  const errors = {};
  if (!name) {
    errors.name = '근무지 이름을 입력하세요.';
  } else if (name.length > MAX_POST_NAME_LENGTH) {
    errors.name = `근무지 이름은 ${MAX_POST_NAME_LENGTH}자 이하로 입력하세요.`;
  } else if (activePosts().some((p) => p.name === name && p.id !== input.id)) {
    errors.name = '같은 이름의 근무지가 있습니다.';
  }
  if (slots.length === 0) {
    errors.slots = '시간대를 하나 이상 입력하세요.';
  } else if (slots.length > MAX_SLOTS) {
    errors.slots = `시간대는 ${MAX_SLOTS}개까지입니다.`;
  } else if (slots.some((x) => x.length > MAX_SLOT_LABEL_LENGTH)) {
    errors.slots = `시간대 이름은 ${MAX_SLOT_LABEL_LENGTH}자 이하로 입력하세요.`;
  } else if (new Set(slots).size !== slots.length) {
    errors.slots = '같은 이름의 시간대가 있습니다.';
  }
  const soldiers = new Set(mockDb.profiles.filter((p) => p.is_active && p.role === 'soldier').map((p) => p.id));
  if (roster.length === 0) {
    errors.roster = '순번 명단에 병사를 넣으세요.';
  } else if (new Set(roster).size !== roster.length || roster.some((id) => !soldiers.has(id))) {
    errors.roster = '명단을 다시 확인하세요.';
  } else if (!errors.slots && roster.length < slots.length) {
    errors.roster = `하루에 ${slots.length}명이 서므로 명단에 ${slots.length}명 이상 넣으세요.`;
  }
  if (Object.keys(errors).length > 0) return { ok: false, reason: 'invalid', errors };

  const today = localISO(new Date(now));
  const changed =
    !existing ||
    JSON.stringify(existing.slots) !== JSON.stringify(slots) ||
    JSON.stringify(rosterOf(existing.id)) !== JSON.stringify(roster);
  const post = existing ?? { id: nextId('d', mockDb.duty_posts), is_active: true };
  post.name = name;
  if (changed) {
    post.slots = slots;
    post.start_date = today;
    // 바뀐 명단에는 오늘부터의 손 수정·교대가 맞지 않으므로 지운다
    mockDb.duty_overrides = mockDb.duty_overrides.filter((o) => o.post_id !== post.id || o.date < today);
    mockDb.duty_rosters = mockDb.duty_rosters
      .filter((r) => r.post_id !== post.id)
      .concat(roster.map((userId, i) => ({ post_id: post.id, user_id: userId, order: i + 1 })));
  }
  if (!existing) mockDb.duty_posts.push(post);
  writeAuditLog(officer, existing ? 'update_duty_post' : 'create_duty_post', 'duty_posts', post.id, now);
  return { ok: true, post: getDutyPosts().find((p) => p.id === post.id) };
}

// 간부만. 근무지를 없애면 그 근무지의 근무도 달력에서 사라진다.
export function deleteDutyPost(id, now = Date.now()) {
  const officer = requireOfficer();
  if (!officer) return { ok: false, reason: 'forbidden' };
  const post = mockDb.duty_posts.find((p) => p.id === id && p.is_active);
  if (!post) return { ok: false, reason: 'not_found' };
  post.is_active = false;
  writeAuditLog(officer, 'delete_duty_post', 'duty_posts', post.id, now);
  return { ok: true };
}
