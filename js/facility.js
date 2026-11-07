// 신청 탭 시설 영역 (Phase 4, prd.md "핵심 3. 시설 예약")
// 순서: 달력(날짜) → 약도 → 시설 → 시간 → 예약 (2026-11-07 사용자 결정)
// - 모두: 예약 신청(1시간 단위, 최대 2시간, 오늘부터 2주, 하루 1건), 내 예약과 취소
// - 간부: 승인 대기 목록(신청 시각 순) 승인·반려, 시설 막기·풀기
import {
  getFacilities,
  getFacilityDay,
  getReservationWindow,
  getReservationDayInfo,
  getMyReservations,
  requestReservation,
  cancelReservation,
  getPendingReservations,
  decideReservation,
  getFacilityBlocks,
  addFacilityBlock,
  deleteFacilityBlock,
  NETWORK_ERROR,
} from './data.js';
import { MAX_RESERVATION_HOURS } from './settings.js';

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const KIND_LABELS = { futsal: '풋살', tennis: '테니스', field: '운동장', gym: '체육관' };
const SLOT_TEXT = { free: '빈 시간', pending: '신청 중', approved: '예약됨', mine: '내 신청', blocked: '사용 불가', past: '지남' };
const STATUS = {
  pending: ['status-pending', '대기'],
  approved: ['status-approved', '승인'],
  rejected: ['status-rejected', '반려'],
  cancelled: ['status-cancelled', '취소'],
};

const dialog = document.getElementById('facility-dialog');
dialog.addEventListener('close', () => {
  if (!dialog.open) dialog.replaceChildren();
});

// 고른 날짜·시설·시간 (다시 그려도 유지)
const st = { userId: null, year: 0, month: 0, date: null, facilityId: null, start: null, hours: 0, message: null };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className, text, action, onClick) {
  const b = el('button', className, text);
  b.type = 'button';
  if (action) b.dataset.action = action;
  b.addEventListener('click', onClick);
  return b;
}

function isoOf(year, month, day) {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function shortDay(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${m}/${d}(${WEEKDAYS[new Date(y, m - 1, d).getDay()]})`;
}

function addHour(time, n) {
  return `${String(Number(time.slice(0, 2)) + n).padStart(2, '0')}:00`;
}

function subHead(title, ...actions) {
  const head = el('div', 'leave-sub-head');
  head.append(el('h3', '', title), ...actions);
  return head;
}

function resetPick() {
  st.facilityId = null;
  st.start = null;
  st.hours = 0;
}

export function renderFacilitySection(section, user, focusSelector) {
  const redraw = (selector) => renderFacilitySection(section, user, selector);
  if (st.userId !== user.id) {
    const [y, m] = getReservationWindow().start.split('-').map(Number);
    Object.assign(st, { userId: user.id, year: y, month: m - 1, date: null, message: null });
    resetPick();
  }
  const parts = [el('h2', '', '시설')];
  if (user.role === 'officer') parts.push(...pendingParts(redraw));
  parts.push(bookingBox(redraw), ...myParts(redraw));
  if (user.role === 'officer') parts.push(...blockParts(redraw));
  section.replaceChildren(...parts);
  if (focusSelector) section.querySelector(focusSelector)?.focus();
}

// ── 예약 신청: 1 날짜 → 2 약도 → 3 시간 ──────────────────────

function bookingBox(redraw) {
  const box = el('div', 'apply-box fac-box');
  box.append(el('h3', 'apply-title', '시설 예약'));
  if (st.message) {
    const msg = el('p', 'apply-message', st.message);
    msg.setAttribute('role', 'status');
    msg.tabIndex = -1;
    box.append(msg);
  }
  box.append(el('p', 'fac-step', '1. 날짜를 고르세요'), dateCalendar(redraw));
  if (!st.date) {
    const win = getReservationWindow();
    box.append(el('p', 'apply-guide', `예약할 수 있는 날짜: ${shortDay(win.start)} ~ ${shortDay(win.end)}. 모든 시설 09:00~21:00, 1시간 단위로 한 번에 ${MAX_RESERVATION_HOURS}시간까지, 하루 1건입니다.`));
    return box;
  }

  const info = getReservationDayInfo(st.date);
  const day = getFacilityDay(st.date);
  const notices = [];
  if (info.away) notices.push(['fac-warn', '이날은 출타 중이라 예약할 수 없습니다.']);
  if (info.limit_reached) {
    const r = info.mine[0];
    notices.push(['fac-warn', `이날은 이미 ${r.facility_label} ${r.start_time}~${r.end_time} 예약이 있습니다. 하루 1건만 예약할 수 있습니다.`]);
  }
  if (info.duties.length) notices.push(['fac-note', `이날 근무가 있습니다 (${info.duties.join(', ')}). 시간이 겹치지 않는지 확인하세요.`]);
  notices.forEach(([cls, text]) => box.append(el('p', cls, text)));

  box.append(el('p', 'fac-step', `2. ${shortDay(st.date)} 시설을 고르세요 (약도)`), mapGrid(redraw, day));
  const facility = day.find((f) => f.id === st.facilityId);
  if (!facility) return box;

  box.append(el('p', 'fac-step', `3. ${facility.label} 시간을 고르세요`));
  box.append(el('p', 'help', `빈 시간을 누르면 1시간, 바로 다음 시간을 한 번 더 누르면 ${MAX_RESERVATION_HOURS}시간입니다.`));
  box.append(slotGrid(redraw, facility));
  const canBook = !info.away && !info.limit_reached;
  if (st.start) {
    const end = addHour(st.start, st.hours);
    const summary = el('p', 'apply-range');
    summary.append(el('strong', '', `${shortDay(st.date)} ${facility.label}`), ` ${st.start}~${end} (${st.hours}시간)`);
    box.append(summary);
    const error = el('p', 'form-error');
    error.setAttribute('role', 'alert');
    error.hidden = true;
    const submit = button('primary-button', '예약 신청하기', 'reserve', async () => {
      submit.disabled = true;
      const result = await requestReservation({ facility_id: facility.id, date: st.date, start_time: st.start, hours: st.hours });
      submit.disabled = false;
      if (!result.ok) {
        error.textContent = result.errors?.time ?? (result.reason === 'network' ? NETWORK_ERROR : '예약할 수 없습니다.');
        error.hidden = false;
        return;
      }
      st.message = `${shortDay(st.date)} ${facility.label} ${st.start}~${end} 예약을 신청했습니다. 간부가 승인하면 달력에 표시됩니다.`;
      resetPick();
      redraw('.fac-box .apply-message');
    });
    submit.disabled = !canBook;
    box.append(error, submit);
  }
  return box;
}

// 1. 날짜: 예약할 수 있는 기간이 걸친 달만 넘긴다
function dateCalendar(redraw) {
  const win = getReservationWindow();
  const wrap = el('div', 'fac-cal-wrap');
  const [minY, minM] = win.start.split('-').map(Number);
  const [maxY, maxM] = win.end.split('-').map(Number);
  const min = minY * 12 + (minM - 1);
  const max = maxY * 12 + (maxM - 1);
  const cur = st.year * 12 + st.month;
  const move = (n) => {
    const d = new Date(st.year, st.month + n, 1);
    st.year = d.getFullYear();
    st.month = d.getMonth();
    const at = st.year * 12 + st.month;
    const stuck = (n > 0 && at >= max) || (n < 0 && at <= min);
    redraw(`[data-action="${(n > 0) !== stuck ? 'fac-next' : 'fac-prev'}"]`);
  };
  const nav = el('div', 'apply-nav');
  const prev = button('cal-nav-button', '‹', 'fac-prev', () => move(-1));
  prev.setAttribute('aria-label', '이전 달');
  prev.disabled = cur <= min;
  const next = button('cal-nav-button', '›', 'fac-next', () => move(1));
  next.setAttribute('aria-label', '다음 달');
  next.disabled = cur >= max;
  nav.append(prev, el('span', 'apply-month', `${st.year}년 ${st.month + 1}월`), next);
  wrap.append(nav);

  const grid = el('div', 'fac-cal');
  WEEKDAYS.forEach((name, i) => {
    const head = el('div', 'cal-weekday', name);
    if (i === 0) head.classList.add('sun');
    if (i === 6) head.classList.add('sat');
    grid.append(head);
  });
  const first = new Date(st.year, st.month, 1).getDay();
  const lastDay = new Date(st.year, st.month + 1, 0).getDate();
  for (let i = 0; i < first; i += 1) grid.append(el('div', 'fac-cal-blank'));
  for (let day = 1; day <= lastDay; day += 1) {
    const iso = isoOf(st.year, st.month, day);
    const col = (first + day - 1) % 7;
    const cell = button('fac-cal-day', '', null, () => {
      st.date = iso;
      st.message = null;
      resetPick();
      redraw(`.fac-cal-day[data-date="${iso}"]`);
    });
    cell.dataset.date = iso;
    cell.append(el('span', 'fac-cal-num', String(day)));
    if (col === 0) cell.classList.add('sun');
    if (col === 6) cell.classList.add('sat');
    if (iso === win.start) cell.classList.add('today');
    if (iso === st.date) cell.classList.add('selected');
    cell.setAttribute('aria-pressed', String(iso === st.date));
    let label = '';
    if (iso < win.start || iso > win.end) {
      cell.disabled = true;
      cell.classList.add('outside');
      label = ', 예약할 수 없는 날짜';
    } else {
      const info = getReservationDayInfo(iso);
      if (info.away) {
        cell.classList.add('away');
        cell.append(el('span', 'fac-cal-tag', '출타'));
        label = ', 출타 중';
      } else if (info.mine.length) {
        cell.classList.add('has-mine');
        cell.append(el('span', 'fac-cal-tag', info.mine[0].status === 'approved' ? '예약' : '신청'));
        label = `, 내 예약 ${info.mine[0].facility_label} ${info.mine[0].start_time}`;
      }
    }
    cell.setAttribute('aria-label', `${shortDay(iso)}${label}`);
    grid.append(cell);
  }
  wrap.append(grid);
  return wrap;
}

// 2. 약도: 4칸 2줄. 칸마다 빈 시간 수, 다 차면 "마감", 하루 종일 막혔으면 "사용 불가"
function mapGrid(redraw, day) {
  const map = el('div', 'fac-map');
  map.setAttribute('role', 'group');
  map.setAttribute('aria-label', '시설 약도');
  day.forEach((f, i) => {
    const cell = button(`fac-cell kind-${f.kind}`, '', null, () => {
      st.facilityId = f.id;
      st.start = null;
      st.hours = 0;
      redraw(`.fac-cell[data-facility="${f.id}"]`);
    });
    cell.dataset.facility = f.id;
    cell.style.gridRow = String(f.map_row);
    cell.style.gridColumn = `${f.map_col} / span ${f.map_span}`;
    cell.append(el('span', 'fac-cell-no', String(i + 1)), el('span', 'fac-cell-name', f.name), el('span', 'fac-cell-building', f.building));
    let status;
    if (f.blocked_all) {
      status = '사용 불가';
      cell.classList.add('closed');
    } else if (f.free_count === 0) {
      status = '마감';
      cell.classList.add('closed');
    } else {
      status = `빈 시간 ${f.free_count}`;
    }
    cell.append(el('span', 'fac-cell-free', status));
    if (f.id === st.facilityId) cell.classList.add('selected');
    cell.setAttribute('aria-pressed', String(f.id === st.facilityId));
    cell.setAttribute('aria-label', `${f.label} ${KIND_LABELS[f.kind]}, ${status}`);
    map.append(cell);
  });
  return map;
}

// 3. 시간: 빈 시간을 누르면 1시간, 바로 다음 칸을 누르면 2시간
function slotGrid(redraw, facility) {
  const grid = el('div', 'fac-slots');
  const startIndex = st.start ? facility.slots.findIndex((s) => s.start_time === st.start) : -1;
  facility.slots.forEach((slot, i) => {
    const chosen = startIndex >= 0 && i >= startIndex && i < startIndex + st.hours;
    const b = button(`fac-slot state-${slot.state}`, '', null, () => {
      if (slot.state !== 'free') return;
      if (st.start && i === startIndex && st.hours === 1) {
        // 고른 칸을 다시 누르면 풀기
        st.start = null;
        st.hours = 0;
      } else if (st.start && st.hours < MAX_RESERVATION_HOURS && i === startIndex + st.hours) {
        st.hours += 1;
      } else {
        st.start = slot.start_time;
        st.hours = 1;
      }
      redraw(`.fac-slot[data-start="${slot.start_time}"]`);
    });
    b.dataset.start = slot.start_time;
    b.append(el('span', 'fac-slot-time', `${slot.start_time}~${slot.end_time}`));
    let text = SLOT_TEXT[slot.state];
    if (slot.state === 'approved') text = `예약 · ${slot.user_name}`;
    if (slot.state === 'mine') text = slot.status === 'approved' ? '내 예약' : '내 신청';
    if (slot.state === 'blocked') text = `사용 불가 · ${slot.reason}`;
    b.append(el('span', 'fac-slot-state', text));
    if (slot.state !== 'free') b.disabled = true;
    if (chosen) b.classList.add('chosen');
    b.setAttribute('aria-pressed', String(chosen));
    b.setAttribute('aria-label', `${slot.start_time}부터 ${slot.end_time}까지, ${text}${chosen ? ', 고름' : ''}`);
    grid.append(b);
  });
  return grid;
}

// ── 내 예약 ──────────────────────────────────────────────

function reservationItem(redraw, r, actions) {
  const item = el('li', `grant-item fac-item status-${r.status}`);
  item.dataset.reservationId = r.id;
  const [cls, text] = STATUS[r.status];
  item.append(el('span', `status-badge ${cls}`, text), el('span', 'grant-title', `${shortDay(r.date)} ${r.facility_label} ${r.start_time}~${r.end_time}`));
  if (r.status === 'rejected') item.append(el('span', 'grant-meta fac-reject', `반려 사유: ${r.reject_reason}`));
  if (actions.length) {
    const box = el('span', 'grant-actions');
    box.append(...actions);
    item.append(box);
  }
  return item;
}

function myParts(redraw) {
  const parts = [subHead('내 예약')];
  const mine = getMyReservations();
  if (mine.length === 0) {
    parts.push(el('p', 'cal-empty', '예약한 시설이 없습니다.'));
    return parts;
  }
  const today = getReservationWindow().start;
  const list = el('ul', 'grant-list fac-my-list');
  mine.forEach((r) => {
    const actions = [];
    if ((r.status === 'pending' || r.status === 'approved') && r.date >= today) {
      actions.push(
        button('small-button danger', '취소', null, async () => {
          if (!window.confirm(`${shortDay(r.date)} ${r.facility_label} ${r.start_time}~${r.end_time} 예약을 취소할까요?`)) return;
          const result = await cancelReservation(r.id);
          if (result.reason === 'network') window.alert(NETWORK_ERROR);
          redraw('.fac-box .apply-title');
        }),
      );
    }
    list.append(reservationItem(redraw, r, actions));
  });
  parts.push(list);
  return parts;
}

// ── 간부: 승인 대기 ──────────────────────────────────────────

function pendingParts(redraw) {
  const head = subHead('승인 대기');
  head.querySelector('h3').tabIndex = -1;
  head.classList.add('fac-pending-head');
  const parts = [head];
  const pending = getPendingReservations();
  if (pending.length === 0) {
    parts.push(el('p', 'cal-empty', '승인 대기 중인 예약이 없습니다.'));
    return parts;
  }
  parts.push(el('p', 'help', '먼저 신청한 순서입니다. 승인하면 신청자의 달력에 표시됩니다.'));
  const list = el('ul', 'grant-list fac-pending-list');
  pending.forEach((r) => {
    const requested = new Date(r.requested_at);
    const item = reservationItem(redraw, r, [
      button('small-button approve', '승인', null, async () => {
        const result = await decideReservation(r.id, 'approve');
        if (!result.ok) window.alert(result.reason === 'network' ? NETWORK_ERROR : '승인할 수 없습니다.');
        redraw('.fac-pending-head h3');
      }),
      button('small-button danger', '반려', null, () => openRejectDialog(redraw, r)),
    ]);
    item.insertBefore(
      el('span', 'grant-meta', `${r.user_name} · ${requested.getMonth() + 1}/${requested.getDate()} ${String(requested.getHours()).padStart(2, '0')}:${String(requested.getMinutes()).padStart(2, '0')} 신청`),
      item.querySelector('.grant-actions'),
    );
    list.append(item);
  });
  parts.push(list);
  return parts;
}

function openRejectDialog(redraw, r) {
  dialog.innerHTML = `
    <form class="dialog-body" novalidate>
      <h2 id="facility-dialog-title">예약 반려</h2>
      <p class="help fac-target"></p>
      <label class="field">
        <span class="field-label">반려 사유 (신청자에게 보임)</span>
        <input name="reject_reason" maxlength="100" placeholder="예: 그날 부대 행사">
        <span class="field-error" data-error-for="reject_reason" hidden></span>
      </label>
      <p class="form-error" role="alert" hidden></p>
      <button type="submit" class="primary-button">반려하기</button>
      <button type="button" class="secondary-button" data-action="close">취소</button>
    </form>
  `;
  const form = dialog.querySelector('form');
  form.querySelector('.fac-target').textContent = `${r.user_name} · ${shortDay(r.date)} ${r.facility_label} ${r.start_time}~${r.end_time}`;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    form.querySelectorAll('.field-error, .form-error').forEach((node) => {
      node.hidden = true;
    });
    const result = await decideReservation(r.id, 'reject', form.elements.reject_reason.value);
    if (result.ok) {
      dialog.close();
      redraw('.fac-pending-head h3');
      return;
    }
    if (result.errors?.reject_reason) {
      const node = form.querySelector('[data-error-for="reject_reason"]');
      node.textContent = result.errors.reject_reason;
      node.hidden = false;
      form.elements.reject_reason.focus();
      return;
    }
    const error = form.querySelector('.form-error');
    error.textContent = result.reason === 'network' ? NETWORK_ERROR : result.reason === 'already_decided' ? '이미 처리된 예약입니다.' : '반려할 수 없습니다.';
    error.hidden = false;
  });
  form.querySelector('[data-action="close"]').addEventListener('click', () => dialog.close());
  dialog.showModal();
  form.elements.reject_reason.focus();
}

// ── 간부: 시설 막기 ──────────────────────────────────────────

function blockParts(redraw) {
  const add = button('small-button', '+ 시설 막기', 'add-block', () => openBlockDialog(redraw));
  const parts = [subHead('시설 막기', add)];
  parts.push(el('p', 'help', '점검·부대 행사 등으로 못 쓰는 시설을 막아 두면 그 시간은 회색 "사용 불가"로 보이고 신청할 수 없습니다.'));
  const blocks = getFacilityBlocks();
  if (blocks.length === 0) {
    parts.push(el('p', 'cal-empty', '막아 둔 시설이 없습니다.'));
    return parts;
  }
  const list = el('ul', 'grant-list fac-block-list');
  blocks.forEach((b) => {
    const item = el('li', 'grant-item');
    item.dataset.blockId = b.id;
    item.append(
      el('span', 'status-badge status-cancelled', '사용 불가'),
      el('span', 'grant-title', `${shortDay(b.date)} ${b.facility_label} ${b.time_label}`),
      el('span', 'grant-meta', `${b.reason} · ${b.created_by_name}`),
    );
    const actions = el('span', 'grant-actions');
    actions.append(
      button('small-button danger', '풀기', null, async () => {
        if (!window.confirm('이 막기를 풀까요? 그 시간에 다시 예약할 수 있게 됩니다.')) return;
        const result = await deleteFacilityBlock(b.id);
        if (result.reason === 'network') window.alert(NETWORK_ERROR);
        redraw('[data-action="add-block"]');
      }),
    );
    item.append(actions);
    list.append(item);
  });
  parts.push(list);
  return parts;
}

function openBlockDialog(redraw) {
  const facilities = getFacilities();
  const hours = [];
  for (let h = 9; h <= 21; h += 1) hours.push(`${String(h).padStart(2, '0')}:00`);
  const options = (list, selected) => list.map((t) => `<option value="${t}"${t === selected ? ' selected' : ''}>${t}</option>`).join('');
  dialog.innerHTML = `
    <form class="dialog-body" novalidate>
      <h2 id="facility-dialog-title">시설 막기</h2>
      <label class="field">
        <span class="field-label">시설</span>
        <select name="facility_id"><option value="all">모든 시설</option></select>
        <span class="field-error" data-error-for="facility_id" hidden></span>
      </label>
      <label class="field">
        <span class="field-label">날짜</span>
        <input name="date" type="date">
        <span class="field-error" data-error-for="date" hidden></span>
      </label>
      <fieldset class="field">
        <legend class="field-label">시간</legend>
        <div class="choice-row">
          <label class="choice"><input type="radio" name="span" value="all" checked> 하루 종일</label>
          <label class="choice"><input type="radio" name="span" value="time"> 시간 정하기</label>
        </div>
        <div class="fac-block-times" hidden>
          <select name="start_time" aria-label="시작 시간">${options(hours.slice(0, -1), '09:00')}</select>
          <span>~</span>
          <select name="end_time" aria-label="끝 시간">${options(hours.slice(1), '10:00')}</select>
        </div>
        <span class="field-error" data-error-for="time" hidden></span>
      </fieldset>
      <label class="field">
        <span class="field-label">사유 (모두에게 보임)</span>
        <input name="reason" maxlength="50" placeholder="예: 잔디 보수">
        <span class="field-error" data-error-for="reason" hidden></span>
      </label>
      <p class="form-error" role="alert" hidden></p>
      <button type="submit" class="primary-button">막기</button>
      <button type="button" class="secondary-button" data-action="close">취소</button>
    </form>
  `;
  const form = dialog.querySelector('form');
  const f = form.elements;
  f.facility_id.append(
    ...facilities.map((x) => {
      const option = el('option', '', x.label);
      option.value = x.id;
      return option;
    }),
  );
  f.date.value = st.date ?? getReservationWindow().start;
  f.date.min = getReservationWindow().start;
  const times = form.querySelector('.fac-block-times');
  form.addEventListener('change', (e) => {
    if (e.target.name === 'span') times.hidden = f.span.value !== 'time';
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    form.querySelectorAll('.field-error, .form-error').forEach((node) => {
      node.hidden = true;
    });
    const result = await addFacilityBlock({
      facility_id: f.facility_id.value,
      date: f.date.value,
      all_day: f.span.value === 'all',
      start_time: f.start_time.value,
      end_time: f.end_time.value,
      reason: f.reason.value,
    });
    if (result.ok) {
      dialog.close();
      redraw('[data-action="add-block"]');
      return;
    }
    if (result.reason === 'invalid') {
      Object.entries(result.errors).forEach(([name, message]) => {
        const node = form.querySelector(`[data-error-for="${name}"]`);
        node.textContent = message;
        node.hidden = false;
      });
      const first = Object.keys(result.errors)[0];
      (first === 'time' ? f.span[0] : f[first])?.focus?.();
      return;
    }
    const error = form.querySelector('.form-error');
    error.textContent = result.reason === 'network' ? NETWORK_ERROR : '간부만 시설을 막을 수 있습니다.';
    error.hidden = false;
  });
  form.querySelector('[data-action="close"]').addEventListener('click', () => dialog.close());
  dialog.showModal();
  f.facility_id.focus();
}
