// 데이터 계층. 화면 코드는 가상 데이터를 직접 읽지 않고 이 파일의 함수만 쓴다.
// Phase 5에서 이 파일 안쪽만 Supabase로 바꿔 끼운다.
import { mockDb, mockAuth } from './mock-data.js';
import { MERIT_POINTS_PER_REWARD_DAY, MAX_POINTS_PER_ENTRY } from './settings.js';

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
      reason: `포상휴가 ${grant.days}일로 전환`,
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
// 상점을 포상휴가로 바꾸려면 병사가 요청하고 간부가 승인한다. 승인할 때 상점이 빠진다.
// 벌점으로 상점이 마이너스가 될 수 있다 (임시. prd.md 11번 확인 항목).

function meritBalance(userId) {
  return mockDb.merit_points.filter((m) => m.user_id === userId).reduce((sum, m) => sum + m.points, 0);
}

// 아직 처리되지 않은 전환 요청에 걸려 있는 상점 (같은 상점을 두 번 쓰지 못하게)
function pendingConversionCost(userId) {
  return mockDb.leave_grants
    .filter((g) => g.user_id === userId && g.source === 'merit' && g.status === 'pending')
    .reduce((sum, g) => sum + g.merit_cost, 0);
}

// 병사만. 결과: { balance, reserved, available, pointsPerDay, history: [...] }
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
    pointsPerDay: MERIT_POINTS_PER_REWARD_DAY,
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

  const entry = {
    id: nextId('m', mockDb.merit_points),
    user_id: target.id,
    kind: input.kind,
    points: input.kind === 'merit' ? points : -points,
    reason,
    given_by: officer.id,
    grant_id: null,
    created_at: new Date(now).toISOString(),
  };
  mockDb.merit_points.push(entry);
  writeAuditLog(officer, input.kind === 'merit' ? 'give_merit' : 'give_demerit', 'merit_points', entry.id, now);
  return { ok: true, entry: { ...entry }, balance: meritBalance(target.id) };
}

// 병사만. 상점을 포상휴가 days일로 바꿔 달라고 요청한다 (간부 승인 대기).
// 결과: { ok: true, grant } 또는 { ok: false, reason: 'forbidden' | 'invalid', errors }
export function requestMeritConversion(input, now = Date.now()) {
  const user = getCurrentUser();
  if (!user || user.role !== 'soldier') return { ok: false, reason: 'forbidden' };
  const days = Number(input.days);
  const cost = days * MERIT_POINTS_PER_REWARD_DAY;
  const available = meritBalance(user.id) - pendingConversionCost(user.id);
  const errors = {};
  if (!Number.isInteger(days) || days < 1) {
    errors.days = '바꿀 일수를 1 이상의 숫자로 입력하세요.';
  } else if (cost > available) {
    errors.days = `상점이 모자랍니다. ${days}일에는 ${cost}점이 필요하고, 지금 쓸 수 있는 상점은 ${available}점입니다.`;
  }
  if (Object.keys(errors).length > 0) return { ok: false, reason: 'invalid', errors };

  const grant = {
    id: nextId('g', mockDb.leave_grants),
    user_id: user.id,
    leave_type: 'reward',
    days,
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
// 정원(출타율) 확인은 3-3에서 붙인다.

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

// 병사만. input: { start_date, end_date, items: { annual, reward, consolation } }
// 결과: { ok: true, request } 또는 { ok: false, reason: 'forbidden' | 'invalid', errors }
export function applyLeave(input, now = Date.now()) {
  const user = getCurrentUser();
  if (!user || user.role !== 'soldier') return { ok: false, reason: 'forbidden' };
  const { start: windowStart, end: windowEnd } = getApplyWindow(now);
  const start = input.start_date;
  const end = input.end_date || start;
  const errors = {};

  if (!isDate(start) || !isDate(end)) {
    errors.dates = '출발일과 복귀일을 고르세요.';
  } else if (end < start) {
    errors.dates = '복귀일은 출발일과 같거나 뒤여야 합니다.';
  } else if (start < windowStart || end > windowEnd) {
    errors.dates = `오늘부터 한 달 이내(${windowStart} ~ ${windowEnd})의 날짜만 신청할 수 있습니다.`;
  } else {
    // 이미 신청한 내 출타와 날짜가 겹치면 막는다 (가정, current_status.md 참고)
    const overlap = getMyLeaveRequests().find(
      (r) => r.status === 'requested' && r.start_date <= end && r.end_date >= start,
    );
    if (overlap) errors.dates = `이미 신청한 출타(${overlap.start_date} ~ ${overlap.end_date})와 날짜가 겹칩니다.`;
  }

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
