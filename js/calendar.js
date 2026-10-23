// 달력 탭: 월간 달력, 전역 D-day, 선택한 날의 일정 목록, 개인 일정 추가·수정·삭제
import { getCalendarEvents, addPersonalEvent, updatePersonalEvent, deletePersonalEvent } from './data.js';

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

// 일정 종류는 색과 함께 항상 글자로도 구분한다 (CLAUDE.md 디자인 규칙).
const TYPE_LABELS = {
  personal: '개인',
  duty: '근무',
  unit: '부대',
  leave: '휴가',
  overnight: '외박',
  outing: '외출',
  reservation: '시설',
};
const CATEGORY_LABELS = { training: '훈련', inspection: '점검', event: '행사', other: '기타' };
// 개인 일정은 종류(근무·생일·기타)로 글자를 붙인다.
const KIND_LABELS = { duty: '근무', birthday: '생일', other: '개인' };

function badgeText(e) {
  return (e.kind && KIND_LABELS[e.kind]) || TYPE_LABELS[e.type] || e.type;
}
// 한 주 줄에 보여 줄 막대 줄 수. 넘치면 날짜 칸에 +N으로 표시한다.
const MAX_LANES = 2;
// 필터 버튼 순서 (prd.md 4번의 일정 종류 7가지). 생일·기타는 "개인"에 들어간다.
const FILTER_TYPES = ['personal', 'duty', 'unit', 'leave', 'overnight', 'outing', 'reservation'];

// 보고 있는 달과 고른 날짜. 다른 사람이 들어오면 처음(오늘)으로 돌린다.
let state = null;
// 일정 창에서 저장·삭제한 뒤 달력을 다시 그릴 때 쓴다.
let redraw = () => {};

export function toISODate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function daysBetween(fromISO, toISO) {
  const toUTC = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUTC(toISO) - toUTC(fromISO)) / 86400000);
}

function ddayText(dischargeDate, todayISO) {
  const days = daysBetween(todayISO, dischargeDate);
  if (days > 0) return `전역까지 D-${days}`;
  if (days === 0) return '오늘 전역합니다 (D-Day)';
  return '전역일이 지났습니다';
}

function formatDay(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const weekday = WEEKDAYS[new Date(y, m - 1, d).getDay()];
  return `${m}월 ${d}일 (${weekday})`;
}

function formatShort(iso) {
  const [, m, d] = iso.split('-').map(Number);
  return `${m}/${d}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function renderCalendar(container, user, today = new Date()) {
  const todayISO = toISODate(today);
  if (!state || state.userId !== user.id) {
    // hidden: 필터로 끈 일정 종류
    state = { userId: user.id, year: today.getFullYear(), month: today.getMonth(), selected: todayISO, hidden: new Set() };
  }
  const { year, month } = state;
  // 다시 그린 뒤에도 방금 누른 버튼에 초점을 둔다 (키보드로 쓰는 사람을 위해).
  const draw = (focusSelector) => {
    renderCalendar(container, user, today);
    if (focusSelector) container.querySelector(focusSelector)?.focus();
  };
  redraw = draw;

  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const firstISO = toISODate(first);
  const lastISO = toISODate(last);
  const allEvents = getCalendarEvents(firstISO, lastISO);
  // 필터로 끈 종류는 달력 막대와 목록에서 모두 뺀다.
  const events = allEvents.filter((e) => !state.hidden.has(e.type));
  const eventsOn = (iso) => events.filter((e) => e.start_date <= iso && iso <= e.end_date);
  const hiddenOn = (iso) => allEvents.filter((e) => state.hidden.has(e.type) && e.start_date <= iso && iso <= e.end_date);

  // 전역 D-day
  const dday = el('p', 'dday');
  dday.append(el('strong', '', ddayText(user.discharge_date, todayISO)), ` · 전역 예정일 ${user.discharge_date}`);

  // 달 넘기기
  const nav = el('div', 'cal-nav');
  const prev = el('button', 'cal-nav-button', '‹');
  prev.type = 'button';
  prev.setAttribute('aria-label', '이전 달');
  const next = el('button', 'cal-nav-button', '›');
  next.type = 'button';
  next.setAttribute('aria-label', '다음 달');
  const title = el('h2', 'cal-title', `${year}년 ${month + 1}월`);
  const todayButton = el('button', 'cal-today-button', '오늘');
  todayButton.type = 'button';
  const moveMonth = (delta, focusSelector) => {
    const d = new Date(year, month + delta, 1);
    state.year = d.getFullYear();
    state.month = d.getMonth();
    // 오늘이 있는 달이면 오늘을, 아니면 1일을 고른다.
    state.selected = state.year === today.getFullYear() && state.month === today.getMonth() ? todayISO : toISODate(d);
    draw(focusSelector);
  };
  prev.dataset.action = 'prev';
  next.dataset.action = 'next';
  todayButton.dataset.action = 'today';
  prev.addEventListener('click', () => moveMonth(-1, '[data-action="prev"]'));
  next.addEventListener('click', () => moveMonth(1, '[data-action="next"]'));
  todayButton.addEventListener('click', () => {
    state.year = today.getFullYear();
    state.month = today.getMonth();
    state.selected = todayISO;
    draw('[data-action="today"]');
  });
  nav.append(prev, title, next, todayButton);

  // 일정 종류 필터. 색 안내(범례) 역할도 한다. 켜진 버튼은 ✓로도 표시한다.
  const filters = el('div', 'cal-filters');
  filters.setAttribute('role', 'group');
  filters.setAttribute('aria-label', '보여 줄 일정 종류');
  FILTER_TYPES.forEach((type) => {
    const shown = !state.hidden.has(type);
    const chip = el('button', `filter-chip type-${type}`);
    chip.type = 'button';
    chip.dataset.filter = type;
    chip.setAttribute('aria-pressed', String(shown));
    chip.append(el('span', 'filter-mark', shown ? '✓' : ''), el('span', 'filter-dot'), el('span', 'filter-label', TYPE_LABELS[type]));
    chip.addEventListener('click', () => {
      if (state.hidden.has(type)) state.hidden.delete(type);
      else state.hidden.add(type);
      draw(`[data-filter="${type}"]`);
    });
    filters.append(chip);
  });
  if (state.hidden.size > 0) {
    const showAll = el('button', 'filter-reset', '모두 보기');
    showAll.type = 'button';
    showAll.dataset.action = 'show-all';
    showAll.addEventListener('click', () => {
      state.hidden.clear();
      draw(`[data-filter="${FILTER_TYPES[0]}"]`);
    });
    filters.append(showAll);
  }

  // 요일 줄 + 한 주에 한 줄. 여러 날 일정은 그 주 안에서 막대 하나로 잇는다.
  const grid = el('div', 'cal-grid');
  const weekdays = el('div', 'cal-weekdays');
  WEEKDAYS.forEach((name, i) => {
    const head = el('div', 'cal-weekday', name);
    if (i === 0) head.classList.add('sun');
    if (i === 6) head.classList.add('sat');
    weekdays.append(head);
  });
  grid.append(weekdays);

  const lastDay = last.getDate();
  const offset = first.getDay();
  const weekCount = Math.ceil((offset + lastDay) / 7);

  for (let w = 0; w < weekCount; w += 1) {
    const week = el('div', 'cal-week');
    // 이 줄의 7칸 날짜. 이번 달이 아닌 칸은 null.
    const days = [];
    for (let col = 0; col < 7; col += 1) {
      const day = w * 7 + col - offset + 1;
      days.push(day >= 1 && day <= lastDay ? toISODate(new Date(year, month, day)) : null);
    }

    days.forEach((iso, col) => {
      if (!iso) {
        const blank = el('div', 'cal-blank');
        blank.style.gridColumn = String(col + 1);
        if (col === 6) blank.classList.add('last-col');
        week.append(blank);
        return;
      }
      week.append(dayCell(iso, col));
    });

    // 이 주에 걸치는 일정을 막대로 놓는다. 먼저 시작하고 긴 일정부터 윗줄에 둔다.
    const inMonth = days.filter(Boolean);
    const weekStart = inMonth[0];
    const weekEnd = inMonth[inMonth.length - 1];
    const segments = events
      .filter((e) => e.start_date <= weekEnd && e.end_date >= weekStart)
      .map((e) => {
        const from = e.start_date > weekStart ? e.start_date : weekStart;
        const to = e.end_date < weekEnd ? e.end_date : weekEnd;
        return { e, from, to, fromCol: days.indexOf(from), toCol: days.indexOf(to) };
      })
      .sort((a, b) => a.fromCol - b.fromCol || b.toCol - b.fromCol - (a.toCol - a.fromCol));

    // 줄마다 마지막으로 차지한 칸. 막대 하나는 끝날 때까지 같은 줄을 쓴다.
    const laneEnds = [];
    const hiddenCount = new Array(7).fill(0);
    segments.forEach(({ e, from, to, fromCol, toCol }) => {
      let lane = laneEnds.findIndex((end) => end < fromCol);
      if (lane === -1) lane = laneEnds.length;
      laneEnds[lane] = toCol;
      if (lane >= MAX_LANES) {
        for (let col = fromCol; col <= toCol; col += 1) hiddenCount[col] += 1;
        return;
      }
      const bar = el('div', `cal-bar type-${e.type}`, e.title);
      bar.style.gridColumn = `${fromCol + 1} / ${toCol + 2}`;
      bar.style.gridRow = String(lane + 2);
      bar.dataset.id = e.id;
      bar.dataset.start = from;
      bar.dataset.end = to;
      // 이전 주(또는 이전 달)에서 이어지거나 다음으로 이어지면 그쪽 모서리를 각지게 한다.
      if (e.start_date < from) bar.classList.add('cont-left');
      if (e.end_date > to) bar.classList.add('cont-right');
      bar.setAttribute('aria-hidden', 'true');
      week.append(bar);
    });

    hiddenCount.forEach((count, col) => {
      if (count === 0) return;
      const more = el('span', 'cal-more', `+${count}`);
      more.style.gridColumn = String(col + 1);
      more.setAttribute('aria-hidden', 'true');
      week.append(more);
    });

    grid.append(week);
  }

  function dayCell(iso, col) {
    const dayEvents = eventsOn(iso);
    const cell = el('button', 'cal-day');
    cell.type = 'button';
    cell.dataset.date = iso;
    cell.style.gridColumn = String(col + 1);
    if (col === 0) cell.classList.add('sun');
    if (col === 6) cell.classList.add('sat', 'last-col');
    if (iso === todayISO) {
      cell.classList.add('today');
      cell.setAttribute('aria-current', 'date');
    }
    const selected = iso === state.selected;
    cell.classList.toggle('selected', selected);
    cell.setAttribute('aria-pressed', String(selected));
    const titles = dayEvents.map((e) => e.title).join(', ');
    cell.setAttribute(
      'aria-label',
      `${formatDay(iso)}${iso === todayISO ? ', 오늘' : ''}, 일정 ${dayEvents.length}개${titles ? `: ${titles}` : ''}`,
    );
    cell.append(el('span', 'cal-num', String(Number(iso.slice(8)))));
    cell.addEventListener('click', () => {
      state.selected = iso;
      draw(`[data-date="${iso}"]`);
    });
    return cell;
  }

  // 고른 날의 일정 목록
  const dayList = el('section', 'cal-day-list');
  dayList.setAttribute('aria-live', 'polite');
  const listHead = el('div', 'cal-day-list-head');
  const addButton = el('button', 'small-button', '+ 일정 추가');
  addButton.type = 'button';
  addButton.dataset.action = 'add-event';
  addButton.addEventListener('click', () => openEventDialog({ date: state.selected }));
  listHead.append(el('h3', '', formatDay(state.selected)), addButton);
  dayList.append(listHead);
  const selectedEvents = eventsOn(state.selected);
  const hiddenCount = hiddenOn(state.selected).length;
  if (selectedEvents.length === 0) {
    dayList.append(el('p', 'cal-empty', '일정이 없습니다.'));
  } else {
    const list = el('ul', 'cal-event-list');
    selectedEvents.forEach((e) => {
      const item = el('li', `cal-event type-${e.type}`);
      item.append(el('span', 'type-badge', badgeText(e)), el('span', 'cal-event-title', e.title));
      const meta = [];
      if (e.unit_category && e.unit_category !== 'training') meta.push(CATEGORY_LABELS[e.unit_category]);
      if (e.start_date !== e.end_date) meta.push(`${formatShort(e.start_date)}~${formatShort(e.end_date)}`);
      if (e.time) meta.push(e.time);
      if (e.memo) meta.push(e.memo);
      if (e.repeat_yearly) meta.push('매년');
      if (meta.length) item.append(el('span', 'cal-event-meta', meta.join(' · ')));
      if (e.editable) {
        const actions = el('span', 'cal-event-actions');
        const edit = el('button', 'small-button', '수정');
        edit.type = 'button';
        edit.addEventListener('click', () => openEventDialog({ event: e }));
        const remove = el('button', 'small-button danger', '삭제');
        remove.type = 'button';
        remove.addEventListener('click', () => {
          if (!window.confirm(`"${e.title}" 일정을 지울까요?`)) return;
          deletePersonalEvent(e.id);
          redraw('[data-action="add-event"]');
        });
        actions.append(edit, remove);
        item.append(actions);
      }
      list.append(item);
    });
    dayList.append(list);
  }
  if (hiddenCount > 0) {
    dayList.append(el('p', 'cal-hidden-note', `필터로 숨긴 일정 ${hiddenCount}개`));
  }

  container.replaceChildren(dday, nav, filters, grid, dayList);
}

// ── 개인 일정 추가·수정 창 ──────────────────────────────────

const eventDialog = document.getElementById('event-dialog');

// 닫힘 알림은 조금 늦게 온다. 그 사이 다른 창을 열었다면 지우지 않는다.
eventDialog.addEventListener('close', () => {
  if (!eventDialog.open) eventDialog.replaceChildren();
});

// event가 있으면 수정, 없으면 date 날짜로 새로 추가
function openEventDialog({ event = null, date = null }) {
  const editing = Boolean(event);
  const field = (name, label, input) => `
    <label class="field" data-field="${name}">
      <span class="field-label">${label}</span>
      ${input}
      <span class="field-error" data-error-for="${name}" hidden></span>
    </label>`;

  eventDialog.innerHTML = `
    <form class="dialog-body" novalidate>
      <h2 id="event-dialog-title">${editing ? '일정 수정' : '일정 추가'}</h2>
      <fieldset class="field">
        <legend class="field-label">종류</legend>
        <div class="choice-row">
          <label class="choice"><input type="radio" name="kind" value="duty"> 근무</label>
          <label class="choice"><input type="radio" name="kind" value="birthday"> 생일</label>
          <label class="choice"><input type="radio" name="kind" value="other"> 기타</label>
        </div>
        <span class="field-error" data-error-for="kind" hidden></span>
      </fieldset>
      ${field('title', '제목', '<input name="title" maxlength="30" required>')}
      ${field('start_date', '시작 날짜', '<input name="start_date" type="date" required>')}
      ${field('end_date', '끝나는 날짜 (하루면 비워 두기)', '<input name="end_date" type="date">')}
      <p class="help birthday-help" hidden>생일은 매년 같은 날에 표시됩니다.</p>
      ${field('time', '시간 (선택)', '<input name="time" type="time">')}
      ${field('memo', '메모 (선택)', '<textarea name="memo" rows="2" maxlength="200"></textarea>')}
      <p class="form-error" role="alert" hidden></p>
      <button type="submit" class="primary-button">저장</button>
      <button type="button" class="secondary-button" data-action="close">취소</button>
    </form>
  `;

  const form = eventDialog.querySelector('form');
  const f = form.elements;
  const kind = event?.kind ?? 'other';
  form.querySelector(`input[name="kind"][value="${kind}"]`).checked = true;
  f.title.value = event?.title ?? '';
  // 매년 반복 일정은 처음 등록한 날짜를 고친다.
  f.start_date.value = event ? event.original_start_date : date;
  f.end_date.value = event && event.end_date !== event.start_date ? event.end_date : '';
  f.time.value = event?.time ?? '';
  f.memo.value = event?.memo ?? '';

  // 생일은 하루짜리라 끝나는 날짜를 숨긴다.
  const syncKind = () => {
    const isBirthday = f.kind.value === 'birthday';
    form.querySelector('[data-field="end_date"]').hidden = isBirthday;
    form.querySelector('.birthday-help').hidden = !isBirthday;
    form.querySelector('[data-field="start_date"] .field-label').textContent = isBirthday ? '날짜' : '시작 날짜';
  };
  form.querySelectorAll('input[name="kind"]').forEach((radio) => radio.addEventListener('change', syncKind));
  syncKind();

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    form.querySelectorAll('.field-error, .form-error').forEach((node) => {
      node.hidden = true;
    });
    const input = {
      kind: f.kind.value,
      title: f.title.value,
      start_date: f.start_date.value,
      end_date: f.end_date.value,
      time: f.time.value,
      memo: f.memo.value,
    };
    const result = editing ? updatePersonalEvent(event.id, input) : addPersonalEvent(input);

    if (result.ok) {
      eventDialog.close();
      // 생일이 아니면 저장한 일정의 시작 날짜를 보여 준다.
      if (state && input.kind !== 'birthday') {
        const [y, m] = result.event.start_date.split('-').map(Number);
        state.year = y;
        state.month = m - 1;
        state.selected = result.event.start_date;
      }
      redraw('[data-action="add-event"]');
      return;
    }
    if (result.reason === 'invalid') {
      Object.entries(result.errors).forEach(([name, message]) => {
        const node = form.querySelector(`[data-error-for="${name}"]`);
        if (node) {
          node.textContent = message;
          node.hidden = false;
        }
      });
      const first = Object.keys(result.errors)[0];
      f[first]?.focus?.();
      return;
    }
    const error = form.querySelector('.form-error');
    error.textContent = '이 일정은 고칠 수 없습니다. 다시 시도해 주세요.';
    error.hidden = false;
  });

  form.querySelector('[data-action="close"]').addEventListener('click', () => eventDialog.close());
  eventDialog.showModal();
  f.title.focus();
}
