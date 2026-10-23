// 달력 탭: 월간 달력, 전역 D-day, 선택한 날의 일정 목록
import { getCalendarEvents } from './data.js';

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
const MAX_CHIPS = 2;

// 보고 있는 달과 고른 날짜. 다른 사람이 들어오면 처음(오늘)으로 돌린다.
let state = null;

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
    state = { userId: user.id, year: today.getFullYear(), month: today.getMonth(), selected: todayISO };
  }
  const { year, month } = state;
  // 다시 그린 뒤에도 방금 누른 버튼에 초점을 둔다 (키보드로 쓰는 사람을 위해).
  const draw = (focusSelector) => {
    renderCalendar(container, user, today);
    if (focusSelector) container.querySelector(focusSelector)?.focus();
  };

  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const firstISO = toISODate(first);
  const lastISO = toISODate(last);
  const events = getCalendarEvents(firstISO, lastISO);
  const eventsOn = (iso) => events.filter((e) => e.start_date <= iso && iso <= e.end_date);

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

  // 요일 줄
  const grid = el('div', 'cal-grid');
  WEEKDAYS.forEach((name, i) => {
    const head = el('div', 'cal-weekday', name);
    if (i === 0) head.classList.add('sun');
    if (i === 6) head.classList.add('sat');
    grid.append(head);
  });

  // 1일 앞의 빈칸
  for (let i = 0; i < first.getDay(); i += 1) {
    grid.append(el('div', 'cal-blank'));
  }

  for (let day = 1; day <= last.getDate(); day += 1) {
    const date = new Date(year, month, day);
    const iso = toISODate(date);
    const dayEvents = eventsOn(iso);

    const cell = el('button', 'cal-day');
    cell.type = 'button';
    cell.dataset.date = iso;
    if (date.getDay() === 0) cell.classList.add('sun');
    if (date.getDay() === 6) cell.classList.add('sat');
    if (iso === todayISO) {
      cell.classList.add('today');
      cell.setAttribute('aria-current', 'date');
    }
    const selected = iso === state.selected;
    cell.classList.toggle('selected', selected);
    cell.setAttribute('aria-pressed', String(selected));
    cell.setAttribute('aria-label', `${formatDay(iso)}${iso === todayISO ? ', 오늘' : ''}, 일정 ${dayEvents.length}개`);

    cell.append(el('span', 'cal-num', String(day)));
    dayEvents.slice(0, MAX_CHIPS).forEach((e) => {
      cell.append(el('span', `cal-chip type-${e.type}`, e.title));
    });
    if (dayEvents.length > MAX_CHIPS) {
      cell.append(el('span', 'cal-more', `+${dayEvents.length - MAX_CHIPS}`));
    }

    cell.addEventListener('click', () => {
      state.selected = iso;
      draw(`[data-date="${iso}"]`);
    });
    grid.append(cell);
  }

  // 고른 날의 일정 목록
  const dayList = el('section', 'cal-day-list');
  dayList.setAttribute('aria-live', 'polite');
  dayList.append(el('h3', '', formatDay(state.selected)));
  const selectedEvents = eventsOn(state.selected);
  if (selectedEvents.length === 0) {
    dayList.append(el('p', 'cal-empty', '일정이 없습니다.'));
  } else {
    const list = el('ul', 'cal-event-list');
    selectedEvents.forEach((e) => {
      const item = el('li', `cal-event type-${e.type}`);
      item.append(el('span', 'type-badge', TYPE_LABELS[e.type] ?? e.type), el('span', 'cal-event-title', e.title));
      const meta = [];
      if (e.unit_category && e.unit_category !== 'training') meta.push(CATEGORY_LABELS[e.unit_category]);
      if (e.start_date !== e.end_date) meta.push(`${formatShort(e.start_date)}~${formatShort(e.end_date)}`);
      if (e.time) meta.push(e.time);
      if (e.memo) meta.push(e.memo);
      if (meta.length) item.append(el('span', 'cal-event-meta', meta.join(' · ')));
      list.append(item);
    });
    dayList.append(list);
  }

  container.replaceChildren(dday, nav, grid, dayList);
}
