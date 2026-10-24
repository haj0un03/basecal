// 신청 탭 휴가 영역
// - 병사: 휴가 종류별·상점·포상 외박/외출 현황, 달력으로 휴가 신청·취소, 받은 일수 요청(포상·위로),
//   상점 → 포상휴가·포상 외박·포상 외출 전환 요청, 상점·벌점 내역
// - 간부: 받은 일수·상점 전환 승인·반려, 상점·벌점 주기
import {
  getMyLeaveSummary,
  getMyLeaveGrants,
  requestLeaveGrant,
  getPendingLeaveGrants,
  decideLeaveGrant,
  getMyMeritSummary,
  getSoldiers,
  givePoints,
  requestMeritConversion,
  getMyPassSummary,
  CONVERSION_TARGETS,
  PASS_TYPES,
  getApplyWindow,
  getMyLeaveRequests,
  applyLeave,
  cancelLeaveRequest,
} from './data.js';
import { MAX_POINTS_PER_ENTRY } from './settings.js';

const LEAVE_TYPE_LABELS = { annual: '연가', reward: '포상휴가', consolation: '위로휴가' };
// 받은 것(휴가 일수·포상 횟수) 전체 이름. 포상 외박·외출은 "회"로 센다.
const GRANT_LABELS = { ...LEAVE_TYPE_LABELS, overnight_pass: '포상 외박', outing_pass: '포상 외출' };

function unitOf(type) {
  return PASS_TYPES.includes(type) ? '회' : '일';
}
const STATUS_LABELS = { pending: '대기', approved: '승인', rejected: '반려' };
const MERIT_KIND_LABELS = { merit: '상점', demerit: '벌점', conversion: '전환' };

const leaveDialog = document.getElementById('leave-dialog');

// 닫힘 알림은 조금 늦게 온다. 그 사이 다른 창을 열었다면 지우지 않는다.
leaveDialog.addEventListener('close', () => {
  if (!leaveDialog.open) leaveDialog.replaceChildren();
});

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function placeholder(text, officerOnly = false) {
  const p = el('p', officerOnly ? 'placeholder officer-only' : 'placeholder');
  if (officerOnly) p.append(el('span', 'officer-badge', '간부 전용'));
  p.append(text);
  return p;
}

function button(className, text, action, onClick) {
  const b = el('button', className, text);
  b.type = 'button';
  if (action) b.dataset.action = action;
  b.addEventListener('click', onClick);
  return b;
}

function formatDate(isoTime) {
  const d = new Date(isoTime);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function signed(points) {
  return points > 0 ? `+${points}` : String(points);
}

// section 안을 다시 그린다. 처리 뒤 초점을 둘 곳(focusSelector)을 받을 수 있다.
export function renderLeaveSection(section, user, focusSelector) {
  const redraw = (selector) => renderLeaveSection(section, user, selector);
  const parts = [el('h2', '', '휴가')];

  // PRD: 휴가 영역에 이 안내를 항상 보여 준다.
  parts.push(
    el(
      'p',
      'leave-notice',
      '이 앱의 휴가 신청은 출타 인원 관리를 위한 것입니다. 정식 휴가 승인은 기존 부대 절차대로 따로 받으세요.',
    ),
  );

  parts.push(...(user.role === 'soldier' ? soldierParts(redraw, user) : officerParts(redraw)));
  section.replaceChildren(...parts);
  if (focusSelector) section.querySelector(focusSelector)?.focus();
}

// ── 병사 ─────────────────────────────────────────────────

function soldierParts(redraw, user) {
  const parts = [];
  const merit = getMyMeritSummary();

  // 휴가 종류별 남은 일수 + 상점
  const leaveSummary = getMyLeaveSummary();
  const summary = el('div', 'leave-summary');
  summary.setAttribute('aria-label', '내 휴가 일수와 상점');
  leaveSummary.forEach(({ leave_type: type, granted, used, remaining }) => {
    const card = el('div', `leave-card leave-${type}`);
    card.dataset.leaveType = type;
    card.append(
      el('span', 'leave-card-type', LEAVE_TYPE_LABELS[type]),
      el('strong', 'leave-card-remaining', `${remaining}일`),
      el('span', 'leave-card-detail', `받은 ${granted} · 쓴 ${used}`),
    );
    summary.append(card);
  });
  const meritCard = el('div', 'leave-card leave-merit');
  meritCard.dataset.leaveType = 'merit';
  const meritValue = el('strong', 'leave-card-remaining', `${merit.balance}점`);
  if (merit.balance < 0) meritValue.classList.add('negative');
  meritCard.append(
    el('span', 'leave-card-type', '상점'),
    meritValue,
    el('span', 'leave-card-detail', merit.reserved ? `전환 대기 ${merit.reserved}` : `${merit.costs.reward}점=휴가1일`),
  );
  summary.append(meritCard);
  parts.push(summary);

  // 포상 외박·포상 외출 남은 횟수 (외박·외출 신청 때 쓴다)
  const passes = el('p', 'pass-summary');
  getMyPassSummary().forEach(({ type, remaining }) => {
    const chip = el('span', 'pass-chip', `${GRANT_LABELS[type]} ${remaining}회`);
    chip.dataset.passType = type;
    passes.append(chip);
  });
  parts.push(passes);

  parts.push(...applyParts(redraw, user, leaveSummary));
  parts.push(...myRequestParts(redraw));
  parts.push(placeholder('외박·외출 신청은 다음 단계(3-4)에서, 날짜별 남은 자리·마감 표시는 3-3에서 만듭니다.'));

  // 받은 일수 요청 (포상휴가·위로휴가) + 상점 전환 요청
  const head = el('div', 'leave-sub-head');
  const buttons = el('div', 'leave-sub-buttons');
  buttons.append(
    button('small-button', '+ 받은 일수 요청', 'request-grant', () => openGrantDialog(redraw)),
    button('small-button merit-button', '상점 전환', 'convert-merit', () => openConversionDialog(redraw, merit)),
  );
  head.append(el('h3', '', '받은 휴가 일수 요청'), buttons);
  parts.push(head);
  parts.push(
    el(
      'p',
      'help',
      `포상휴가·위로휴가를 새로 받았으면 요청하세요. 상점은 ${merit.costs.reward}점마다 포상휴가 1일 또는 포상 외박 1회, ${merit.costs.outing_pass}점마다 포상 외출 1회로 바꿔 달라고 요청할 수 있습니다. 간부가 승인하면 더해집니다.`,
    ),
  );

  const grants = getMyLeaveGrants();
  if (grants.length === 0) {
    parts.push(el('p', 'cal-empty', '요청한 내역이 없습니다.'));
  } else {
    const list = el('ul', 'grant-list');
    grants.forEach((g) => {
      const item = el('li', `grant-item status-${g.status}`);
      item.dataset.grantId = g.id;
      item.append(
        el('span', `status-badge status-${g.status}`, STATUS_LABELS[g.status]),
        el('span', 'grant-title', `${GRANT_LABELS[g.leave_type]} ${g.days}${unitOf(g.leave_type)}`),
        el('span', 'grant-meta', `${g.reason} · ${formatDate(g.requested_at)} 요청`),
      );
      list.append(item);
    });
    parts.push(list);
  }

  // 상점·벌점 내역
  const meritHead = el('div', 'leave-sub-head');
  meritHead.append(el('h3', '', '상점·벌점 내역'));
  parts.push(meritHead);
  if (merit.history.length === 0) {
    parts.push(el('p', 'cal-empty', '받은 상점·벌점이 없습니다.'));
  } else {
    const list = el('ul', 'grant-list merit-list');
    merit.history.forEach((m) => {
      const item = el('li', `grant-item merit-${m.kind}`);
      item.append(
        el('span', `merit-badge merit-${m.kind}`, `${MERIT_KIND_LABELS[m.kind]} ${signed(m.points)}`),
        el('span', 'grant-title', m.reason),
        el(
          'span',
          'grant-meta',
          // 벌점이 상점보다 커서 0점까지만 깎인 경우 알려 준다.
          m.kind === 'demerit' && m.given_points > -m.points
            ? `${formatDate(m.created_at)} · ${m.given_by_name} · 벌점 ${m.given_points}점 중 ${-m.points}점만 차감 (상점은 0점 아래로 내려가지 않음)`
            : `${formatDate(m.created_at)} · ${m.given_by_name}`,
        ),
      );
      list.append(item);
    });
    parts.push(list);
  }
  return parts;
}

// ── 간부 ─────────────────────────────────────────────────

function officerParts(redraw) {
  const parts = [];
  const pending = getPendingLeaveGrants();

  const head = el('div', 'leave-sub-head');
  head.append(el('h3', '', `받은 휴가 일수 승인 대기 ${pending.length}건`));
  parts.push(head);

  if (pending.length === 0) {
    parts.push(el('p', 'cal-empty', '대기 중인 요청이 없습니다.'));
  } else {
    const list = el('ul', 'grant-list');
    pending.forEach((g) => {
      const isConversion = g.source === 'merit';
      const item = el('li', 'grant-item status-pending');
      item.dataset.grantId = g.id;
      const title = `${g.name} · ${GRANT_LABELS[g.leave_type]} ${g.days}${unitOf(g.leave_type)}${isConversion ? ` (상점 ${g.merit_cost}점 전환)` : ''}`;
      const meta = isConversion
        ? `${g.position} · 지금 상점 ${g.merit_balance}점 · ${formatDate(g.requested_at)} 요청`
        : `${g.position} · ${g.reason} · ${formatDate(g.requested_at)} 요청`;
      item.append(el('span', 'grant-title', title), el('span', 'grant-meta', meta));
      const error = el('span', 'grant-error');
      error.setAttribute('role', 'alert');
      error.hidden = true;
      const actions = el('span', 'grant-actions');
      actions.append(
        button('small-button approve', '승인', null, () => {
          const result = decideLeaveGrant(g.id, 'approve');
          if (!result.ok && result.reason === 'not_enough_merit') {
            error.textContent = `상점이 모자라 승인할 수 없습니다. 지금 상점 ${result.balance}점, 필요 ${g.merit_cost}점.`;
            error.hidden = false;
            return;
          }
          redraw('.leave-sub-head h3');
        }),
        button('small-button danger', '반려', null, () => {
          if (!window.confirm(`${g.name}의 ${GRANT_LABELS[g.leave_type]} ${g.days}${unitOf(g.leave_type)} 요청을 반려할까요?`)) return;
          decideLeaveGrant(g.id, 'reject');
          redraw('.leave-sub-head h3');
        }),
      );
      item.append(actions, error);
      list.append(item);
    });
    parts.push(list);
  }

  // 상점·벌점 주기
  const meritHead = el('div', 'leave-sub-head');
  meritHead.append(
    el('h3', '', '상점·벌점'),
    button('small-button merit-button', '+ 상점·벌점 주기', 'give-points', () => openPointsDialog(redraw)),
  );
  parts.push(meritHead);
  parts.push(el('p', 'help', '병사를 골라 사유와 함께 상점이나 벌점을 줍니다. 벌점은 그 병사의 상점에서 빠지고, 상점은 0점 아래로 내려가지 않습니다.'));

  parts.push(placeholder('날짜별 출타 인원과 신청자 명단, 출타율 입력은 다음 단계(3-3)에서 만듭니다.', true));
  return parts;
}

// ── 입력 창 ──────────────────────────────────────────────

function field(name, label, input) {
  return `
    <label class="field" data-field="${name}">
      <span class="field-label">${label}</span>
      ${input}
      <span class="field-error" data-error-for="${name}" hidden></span>
    </label>`;
}

// 공통: 창을 열고, 저장 함수의 결과에 따라 닫거나 항목별 오류를 보여 준다.
function openForm(html, submit, onDone, focusName) {
  leaveDialog.innerHTML = html;
  const form = leaveDialog.querySelector('form');
  const f = form.elements;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    form.querySelectorAll('.field-error, .form-error').forEach((node) => {
      node.hidden = true;
    });
    const result = submit(f);
    if (result.ok) {
      leaveDialog.close();
      onDone();
      return;
    }
    if (result.reason === 'invalid') {
      Object.entries(result.errors).forEach(([name, message]) => {
        const node = form.querySelector(`[data-error-for="${name}"]`);
        node.textContent = message;
        node.hidden = false;
      });
      f[Object.keys(result.errors)[0]]?.focus?.();
      return;
    }
    const error = form.querySelector('.form-error');
    error.textContent = '권한이 없습니다. 다시 들어와 주세요.';
    error.hidden = false;
  });
  form.querySelector('[data-action="close"]').addEventListener('click', () => leaveDialog.close());
  leaveDialog.showModal();
  f[focusName]?.focus();
  return form;
}

// 병사: 받은 일수 요청 (연가는 요청 대상이 아님)
function openGrantDialog(redraw) {
  openForm(
    `<form class="dialog-body" novalidate>
      <h2 id="leave-dialog-title">받은 휴가 일수 요청</h2>
      <fieldset class="field">
        <legend class="field-label">휴가 종류</legend>
        <div class="choice-row">
          <label class="choice"><input type="radio" name="leave_type" value="reward" checked> 포상휴가</label>
          <label class="choice"><input type="radio" name="leave_type" value="consolation"> 위로휴가</label>
        </div>
        <span class="field-error" data-error-for="leave_type" hidden></span>
      </fieldset>
      ${field('days', '일수', '<input name="days" type="number" inputmode="numeric" min="1" max="30" required>')}
      ${field('reason', '사유', '<input name="reason" maxlength="100" required placeholder="예: 체육대회 우승">')}
      <p class="help">간부가 승인해야 남은 일수에 더해집니다.</p>
      <p class="form-error" role="alert" hidden></p>
      <button type="submit" class="primary-button">요청하기</button>
      <button type="button" class="secondary-button" data-action="close">취소</button>
    </form>`,
    (f) => requestLeaveGrant({ leave_type: f.leave_type.value, days: f.days.value, reason: f.reason.value }),
    () => redraw('[data-action="request-grant"]'),
    'days',
  );
}

// 병사: 상점 → 포상휴가·포상 외박·포상 외출 전환 요청
function openConversionDialog(redraw, merit) {
  const choice = (target) =>
    `<label class="choice choice-stack"><input type="radio" name="target" value="${target}"${target === 'reward' ? ' checked' : ''}>
      <span>${GRANT_LABELS[target]}</span><small>${merit.costs[target]}점 = 1${unitOf(target)}</small></label>`;
  const form = openForm(
    `<form class="dialog-body" novalidate>
      <h2 id="leave-dialog-title">상점 전환</h2>
      <p class="summary-box">지금 상점 <strong class="conv-balance"></strong><br>
        쓸 수 있는 상점 <strong class="conv-available"></strong> (전환 대기 제외)</p>
      <fieldset class="field">
        <legend class="field-label">무엇으로 바꿀까요</legend>
        <div class="choice-row">${CONVERSION_TARGETS.map(choice).join('')}</div>
        <span class="field-error" data-error-for="target" hidden></span>
      </fieldset>
      ${field('count', '바꿀 수', '<input name="count" type="number" inputmode="numeric" min="1" value="1" required>')}
      <p class="help conv-preview" aria-live="polite"></p>
      <p class="help">간부가 승인할 때 상점이 빠지고 포상이 더해집니다. 포상 외박·외출은 외박·외출을 신청할 때 1회씩 씁니다.</p>
      <p class="form-error" role="alert" hidden></p>
      <button type="submit" class="primary-button">전환 요청</button>
      <button type="button" class="secondary-button" data-action="close">취소</button>
    </form>`,
    (f) => requestMeritConversion({ target: f.target.value, count: f.count.value }),
    () => redraw('[data-action="convert-merit"]'),
    'count',
  );
  form.querySelector('.conv-balance').textContent = `${merit.balance}점`;
  form.querySelector('.conv-available').textContent = `${merit.available}점`;
  const countLabel = form.querySelector('[data-field="count"] .field-label');
  const preview = form.querySelector('.conv-preview');
  const submit = form.querySelector('button[type="submit"]');
  const update = () => {
    const target = form.elements.target.value;
    const cost = merit.costs[target];
    const unit = unitOf(target);
    const max = Math.max(0, Math.floor(merit.available / cost));
    countLabel.textContent = `바꿀 ${unit === '회' ? '횟수' : '일수'} (최대 ${max}${unit})`;
    form.elements.count.max = String(Math.max(max, 1));
    submit.disabled = max < 1;
    if (max < 1) {
      preview.textContent = `${GRANT_LABELS[target]}(으)로 바꾸려면 상점이 ${cost}점 이상 있어야 합니다.`;
      return;
    }
    const count = Number(form.elements.count.value);
    preview.textContent =
      Number.isInteger(count) && count >= 1
        ? `필요한 상점 ${count * cost}점 · 전환 후 남는 상점 ${merit.available - count * cost}점`
        : '';
  };
  form.addEventListener('input', update);
  form.addEventListener('change', update);
  update();
}

// 간부: 상점·벌점 주기
function openPointsDialog(redraw) {
  const form = openForm(
    `<form class="dialog-body" novalidate>
      <h2 id="leave-dialog-title">상점·벌점 주기</h2>
      <label class="field" data-field="user_id">
        <span class="field-label">병사</span>
        <select name="user_id"></select>
        <span class="field-error" data-error-for="user_id" hidden></span>
      </label>
      <fieldset class="field">
        <legend class="field-label">종류</legend>
        <div class="choice-row">
          <label class="choice"><input type="radio" name="kind" value="merit" checked> 상점</label>
          <label class="choice"><input type="radio" name="kind" value="demerit"> 벌점</label>
        </div>
        <span class="field-error" data-error-for="kind" hidden></span>
      </fieldset>
      ${field('points', `점수 (1~${MAX_POINTS_PER_ENTRY})`, `<input name="points" type="number" inputmode="numeric" min="1" max="${MAX_POINTS_PER_ENTRY}" required>`)}
      ${field('reason', '사유', '<input name="reason" maxlength="100" required placeholder="예: 환경 미화 우수">')}
      <p class="help">벌점은 그 병사의 상점에서 빠집니다. 상점은 0점 아래로 내려가지 않습니다.</p>
      <p class="form-error" role="alert" hidden></p>
      <button type="submit" class="primary-button">주기</button>
      <button type="button" class="secondary-button" data-action="close">취소</button>
    </form>`,
    (f) => givePoints({ user_id: f.user_id.value, kind: f.kind.value, points: f.points.value, reason: f.reason.value }),
    () => redraw('[data-action="give-points"]'),
    'user_id',
  );
  const select = form.elements.user_id;
  getSoldiers().forEach(({ id, name, position, balance }) => {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = `${name} · ${position} (상점 ${balance}점)`;
    select.append(option);
  });
}

// ── 병사: 달력으로 휴가 신청 ("휴가 계산기") ────────────────

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const APPLY_ORDER = ['annual', 'reward', 'consolation'];

// 신청 달력에서 보고 있는 달, 고른 출발일·복귀일, 종류별 일수. 다른 사람이 들어오면 처음으로.
let applyState = null;

function isoOf(year, month, day) {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function inclusiveDays(start, end) {
  const utc = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((utc(end) - utc(start)) / 86400000) + 1;
}

function shortDay(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${m}/${d}(${WEEKDAYS[new Date(y, m - 1, d).getDay()]})`;
}

// 기간이 바뀌면 연가부터 남은 일수만큼 차례로 채운다.
function defaultAllocation(total, remaining) {
  const alloc = {};
  let left = total;
  APPLY_ORDER.forEach((type) => {
    alloc[type] = Math.max(0, Math.min(left, remaining[type]));
    left -= alloc[type];
  });
  return alloc;
}

function applyParts(redraw, user, summary) {
  const win = getApplyWindow();
  if (!applyState || applyState.userId !== user.id) {
    const [y, m] = win.start.split('-').map(Number);
    applyState = { userId: user.id, year: y, month: m - 1, start: null, end: null, alloc: null, message: null };
  }
  const st = applyState;
  const remaining = Object.fromEntries(summary.map((x) => [x.leave_type, x.remaining]));
  const myActive = getMyLeaveRequests().filter((r) => r.status === 'requested');
  const myLeaveOn = (iso) => myActive.find((r) => r.start_date <= iso && iso <= r.end_date);

  const box = el('div', 'apply-box');
  box.append(el('h3', 'apply-title', '휴가 신청'));
  if (st.message) {
    const msg = el('p', 'apply-message', st.message);
    msg.setAttribute('role', 'status');
    msg.tabIndex = -1;
    box.append(msg);
  }

  // 달 넘기기 (신청할 수 있는 달만)
  const [minY, minM] = win.start.split('-').map(Number);
  const [maxY, maxM] = win.end.split('-').map(Number);
  const cur = st.year * 12 + st.month;
  const nav = el('div', 'apply-nav');
  const prev = button('cal-nav-button', '‹', 'apply-prev', () => {
    const d = new Date(st.year, st.month - 1, 1);
    st.year = d.getFullYear();
    st.month = d.getMonth();
    redraw('[data-action="apply-prev"]');
  });
  prev.setAttribute('aria-label', '이전 달');
  prev.disabled = cur <= minY * 12 + (minM - 1);
  const next = button('cal-nav-button', '›', 'apply-next', () => {
    const d = new Date(st.year, st.month + 1, 1);
    st.year = d.getFullYear();
    st.month = d.getMonth();
    redraw('[data-action="apply-next"]');
  });
  next.setAttribute('aria-label', '다음 달');
  next.disabled = cur >= maxY * 12 + (maxM - 1);
  nav.append(prev, el('span', 'apply-month', `${st.year}년 ${st.month + 1}월`), next);
  box.append(nav);

  // 신청 달력
  const grid = el('div', 'apply-grid');
  WEEKDAYS.forEach((name, i) => {
    const head = el('div', 'cal-weekday', name);
    if (i === 0) head.classList.add('sun');
    if (i === 6) head.classList.add('sat');
    grid.append(head);
  });
  const first = new Date(st.year, st.month, 1).getDay();
  const lastDay = new Date(st.year, st.month + 1, 0).getDate();
  for (let i = 0; i < first; i += 1) grid.append(el('div', 'apply-blank'));
  for (let day = 1; day <= lastDay; day += 1) {
    const iso = isoOf(st.year, st.month, day);
    const mine = myLeaveOn(iso);
    const outside = iso < win.start || iso > win.end;
    const cell = button('apply-day', '', null, () => {
      if (!st.start || st.end || iso < st.start) {
        st.start = iso;
        st.end = null;
      } else {
        st.end = iso;
      }
      st.alloc = null;
      st.message = null;
      redraw(`.apply-day[data-date="${iso}"]`);
    });
    cell.dataset.date = iso;
    cell.append(el('span', 'apply-num', String(day)));
    const col = (first + day - 1) % 7;
    if (col === 0) cell.classList.add('sun');
    if (col === 6) cell.classList.add('sat');
    if (iso === win.start) cell.classList.add('today');
    let label = '';
    if (outside) {
      cell.disabled = true;
      cell.classList.add('outside');
      label = ', 신청할 수 없는 날짜';
    } else if (mine) {
      cell.disabled = true;
      cell.classList.add('mine');
      cell.append(el('span', 'apply-tag', '휴가'));
      label = ', 이미 신청한 휴가';
    }
    const end = st.end ?? st.start;
    if (st.start && iso >= st.start && iso <= end) {
      cell.classList.add('in-range');
      if (iso === st.start) cell.classList.add('range-start');
      if (iso === end) cell.classList.add('range-end');
      label += iso === st.start ? ', 출발일' : iso === end ? ', 복귀일' : ', 휴가 기간';
    }
    cell.setAttribute('aria-label', `${shortDay(iso)}${label}`);
    grid.append(cell);
  }
  box.append(grid);

  // 안내 또는 기간과 종류별 일수
  if (!st.start) {
    box.append(el('p', 'apply-guide', `출발일을 누르세요. 신청할 수 있는 날짜: ${shortDay(win.start)} ~ ${shortDay(win.end)}`));
    return [box];
  }
  if (!st.end) {
    box.append(el('p', 'apply-guide', `출발일 ${shortDay(st.start)}. 이제 복귀일을 누르세요. (하루짜리면 같은 날을 한 번 더)`));
    return [box];
  }

  const total = inclusiveDays(st.start, st.end);
  if (!st.alloc) st.alloc = defaultAllocation(total, remaining);
  const range = el('p', 'apply-range');
  range.append(el('strong', '', `${shortDay(st.start)} ~ ${shortDay(st.end)}`), ` · ${total}일 (출발·복귀일 포함)`);
  box.append(range);

  const form = el('form', 'apply-form');
  form.noValidate = true;
  const rows = el('div', 'apply-alloc');
  APPLY_ORDER.forEach((type) => {
    const row = el('label', 'apply-alloc-row');
    const input = document.createElement('input');
    input.type = 'number';
    input.inputMode = 'numeric';
    input.min = '0';
    input.max = String(Math.max(0, remaining[type]));
    input.name = type;
    input.value = String(st.alloc[type]);
    row.append(
      el('span', 'apply-alloc-type', LEAVE_TYPE_LABELS[type]),
      input,
      el('span', 'apply-alloc-left', `일 / 남은 ${remaining[type]}일`),
    );
    rows.append(row);
  });
  form.append(rows);

  const sumLine = el('p', 'apply-sum');
  sumLine.setAttribute('aria-live', 'polite');
  const updateSum = () => {
    APPLY_ORDER.forEach((type) => {
      st.alloc[type] = Number(form.elements[type].value || 0);
    });
    const sum = APPLY_ORDER.reduce((s, type) => s + st.alloc[type], 0);
    const ok = sum === total;
    sumLine.textContent = ok ? `합계 ${sum}일 / ${total}일 ✓` : `합계 ${sum}일 / ${total}일 — 기간과 같게 맞추세요`;
    sumLine.classList.toggle('mismatch', !ok);
  };
  form.addEventListener('input', updateSum);
  form.append(sumLine);
  const error = el('p', 'form-error');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  form.append(error);

  const submit = el('button', 'primary-button', `${total}일 휴가 신청하기`);
  submit.type = 'submit';
  submit.dataset.action = 'apply-leave';
  const reset = button('secondary-button', '날짜 다시 고르기', 'apply-reset', () => {
    st.start = null;
    st.end = null;
    st.alloc = null;
    redraw('.apply-title');
  });
  form.append(submit, reset);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    updateSum();
    const result = applyLeave({ start_date: st.start, end_date: st.end, items: { ...st.alloc } });
    if (!result.ok) {
      error.textContent = result.errors ? Object.values(result.errors).join(' ') : '신청할 수 없습니다.';
      error.hidden = false;
      return;
    }
    st.message = `${shortDay(st.start)} ~ ${shortDay(st.end)} ${total}일 휴가를 신청했습니다. 달력에도 표시됩니다.`;
    st.start = null;
    st.end = null;
    st.alloc = null;
    redraw('.apply-message');
  });
  updateSum();
  box.append(form);
  return [box];
}

// 병사: 내 휴가 신청 내역 (취소 가능)
function myRequestParts(redraw) {
  const parts = [];
  const head = el('div', 'leave-sub-head');
  head.append(el('h3', '', '내 휴가 신청 내역'));
  parts.push(head);
  const requests = getMyLeaveRequests().filter((r) => r.kind === 'leave');
  if (requests.length === 0) {
    parts.push(el('p', 'cal-empty', '신청한 휴가가 없습니다.'));
    return parts;
  }
  const list = el('ul', 'grant-list request-list');
  requests.forEach((r) => {
    const active = r.status === 'requested';
    const item = el('li', `grant-item request-${r.status}`);
    item.dataset.requestId = r.id;
    const breakdown = r.items.map((x) => `${LEAVE_TYPE_LABELS[x.leave_type]} ${x.days}`).join(' + ');
    item.append(
      el('span', `status-badge ${active ? 'status-approved' : 'status-rejected'}`, active ? '신청' : '취소'),
      el('span', 'grant-title', `${shortDay(r.start_date)} ~ ${shortDay(r.end_date)} · ${r.days}일`),
      el('span', 'grant-meta', breakdown),
    );
    if (active) {
      const actions = el('span', 'grant-actions');
      actions.append(
        button('small-button danger', '취소', null, () => {
          if (!window.confirm(`${shortDay(r.start_date)} ~ ${shortDay(r.end_date)} 휴가 신청을 취소할까요? 일수가 되돌아옵니다.`)) return;
          cancelLeaveRequest(r.id);
          applyState.message = '휴가 신청을 취소했습니다. 일수가 되돌아왔습니다.';
          redraw('.apply-message');
        }),
      );
      item.append(actions);
    }
    list.append(item);
  });
  parts.push(list);
  return parts;
}
