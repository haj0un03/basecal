// 신청 탭 휴가 영역
// - 병사: 휴가 종류별·상점·포상 외박/외출 현황, 달력으로 휴가 신청·취소, 받은 일수 요청(포상·위로),
//   상점 → 포상휴가·포상 외박·포상 외출 전환 요청, 상점·벌점 내역
// - 간부: 받은 일수·상점 전환 승인·반려, 상점·벌점 주기, 출타율(총 출타·휴가, 기본·기간별)과 출타 현황 달력
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
  applyAbsence,
  getMyAbsenceQuota,
  cancelLeaveRequest,
  getDayAvailability,
  getAbsenceRoster,
  getRateSettings,
  setDefaultRates,
  addRatePeriod,
  deleteRatePeriod,
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

  parts.push(...(user.role === 'soldier' ? soldierParts(redraw, user) : officerParts(redraw, user)));
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

function officerParts(redraw, user) {
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

  parts.push(...quotaParts(redraw, user));
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

// ── 병사: 달력으로 휴가·외박·외출 신청 ("휴가 계산기") ────────────────

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const APPLY_ORDER = ['annual', 'reward', 'consolation'];
const ABSENCE_KINDS = ['leave', 'overnight', 'outing'];
const ABSENCE_KIND_LABELS = { leave: '휴가', overnight: '외박', outing: '외출' };

// 신청 달력에서 고른 종류(휴가·외박·외출), 보고 있는 달, 고른 출발일·복귀일, 종류별 일수. 다른 사람이 들어오면 처음으로.
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
    applyState = { userId: user.id, kind: 'leave', year: y, month: m - 1, start: null, end: null, alloc: null, message: null };
  }
  const st = applyState;
  const remaining = Object.fromEntries(summary.map((x) => [x.leave_type, x.remaining]));
  const myActive = getMyLeaveRequests().filter((r) => r.status === 'requested');
  const myAbsenceOn = (iso) => myActive.find((r) => r.start_date <= iso && iso <= r.end_date);
  // 보고 있는 달 중 신청할 수 있는 날짜의 남은 자리 (3-3)
  const monthFirst = isoOf(st.year, st.month, 1);
  const monthLast = isoOf(st.year, st.month, new Date(st.year, st.month + 1, 0).getDate());
  const seatStart = monthFirst > win.start ? monthFirst : win.start;
  // 말일이 토요일이면 다음 날(일요일)까지 봐야 외박 가능 여부를 알 수 있어 하루 더 본다
  const seatEnd = nextDayOf(monthLast) < win.end ? nextDayOf(monthLast) : win.end;
  const seats = Object.fromEntries(
    // 고른 종류의 남은 자리: 휴가는 휴가·총 출타 중 적은 쪽, 외박·외출은 총 출타
    (seatStart <= seatEnd ? getDayAvailability(st.kind, seatStart, seatEnd) : []).map((x) => [x.date, x]),
  );

  const box = el('div', 'apply-box');
  box.append(el('h3', 'apply-title', '출타 신청'));
  if (st.message) {
    const msg = el('p', 'apply-message', st.message);
    msg.setAttribute('role', 'status');
    msg.tabIndex = -1;
    box.append(msg);
  }

  // 종류 고르기: 휴가 / 외박 / 외출. 바꾸면 고른 날짜를 지운다.
  const kinds = el('div', 'apply-kinds');
  kinds.setAttribute('role', 'group');
  kinds.setAttribute('aria-label', '신청 종류');
  ABSENCE_KINDS.forEach((kind) => {
    const b = button(`apply-kind type-${kind}`, ABSENCE_KIND_LABELS[kind], null, () => {
      if (st.kind === kind) return;
      st.kind = kind;
      st.start = null;
      st.end = null;
      st.alloc = null;
      st.message = null;
      redraw(`.apply-kind[data-kind="${kind}"]`);
    });
    b.dataset.kind = kind;
    b.setAttribute('aria-pressed', String(st.kind === kind));
    kinds.append(b);
  });
  box.append(kinds);
  if (st.kind !== 'leave') box.append(quotaLine(st.start ?? win.start));

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

  // 신청 달력: 요일 줄 + 한 주에 한 줄. 이미 신청한 휴가는 달력 탭처럼 그 주 안에서 막대 하나로 잇고,
  // 글자는 막대 가운데에 한 번만 쓴다. 주가 바뀌면 새 줄에서 글자를 다시 쓴다.
  const grid = el('div', 'apply-grid');
  const weekdays = el('div', 'apply-weekdays');
  WEEKDAYS.forEach((name, i) => {
    const head = el('div', 'cal-weekday', name);
    if (i === 0) head.classList.add('sun');
    if (i === 6) head.classList.add('sat');
    weekdays.append(head);
  });
  grid.append(weekdays);

  const first = new Date(st.year, st.month, 1).getDay();
  const lastDay = new Date(st.year, st.month + 1, 0).getDate();
  const weekCount = Math.ceil((first + lastDay) / 7);
  for (let w = 0; w < weekCount; w += 1) {
    const week = el('div', 'apply-week');
    const days = [];
    for (let col = 0; col < 7; col += 1) {
      const day = w * 7 + col - first + 1;
      days.push(day >= 1 && day <= lastDay ? isoOf(st.year, st.month, day) : null);
    }
    days.forEach((iso, col) => {
      if (!iso) {
        const blank = el('div', 'apply-blank');
        blank.style.gridColumn = String(col + 1);
        week.append(blank);
        return;
      }
      week.append(applyDayCell(iso, col));
    });

    // 이 주에 걸치는 내 휴가를 막대로 놓는다 (내 신청은 서로 겹치지 않으므로 한 줄이면 된다)
    const inMonth = days.filter(Boolean);
    const weekStart = inMonth[0];
    const weekEnd = inMonth[inMonth.length - 1];
    myActive
      .filter((r) => r.start_date <= weekEnd && r.end_date >= weekStart)
      .forEach((r) => {
        const from = r.start_date > weekStart ? r.start_date : weekStart;
        const to = r.end_date < weekEnd ? r.end_date : weekEnd;
        const bar = el('div', `apply-bar type-${r.kind}`, ABSENCE_KIND_LABELS[r.kind]);
        bar.style.gridColumn = `${days.indexOf(from) + 1} / ${days.indexOf(to) + 2}`;
        bar.dataset.start = from;
        bar.dataset.end = to;
        if (r.start_date < from) bar.classList.add('cont-left');
        if (r.end_date > to) bar.classList.add('cont-right');
        bar.setAttribute('aria-hidden', 'true');
        week.append(bar);
      });
    grid.append(week);
  }

  function applyDayCell(iso, col) {
    const mine = myAbsenceOn(iso);
    const outside = iso < win.start || iso > win.end;
    // 외박은 토요일 출발 → 일요일 복귀만. 일요일도 신청 기간 안이고, 내 출타가 없고, 마감이 아니어야 한다.
    const sunday = nextDayOf(iso);
    const notSaturday =
      st.kind === 'overnight' && (col !== 6 || sunday > win.end || Boolean(myAbsenceOn(sunday)) || Boolean(seats[sunday]?.full));
    const cell = button('apply-day', '', null, () => {
      if (notSaturday) return;
      if (st.kind === 'outing') {
        // 외출은 하루짜리라 한 번 누르면 끝
        st.start = iso;
        st.end = iso;
      } else if (st.kind === 'overnight') {
        // 토요일을 누르면 토~일(1박 2일)이 잡힌다
        st.start = iso;
        st.end = sunday;
      } else if (!st.start || st.end || iso < st.start) {
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
    cell.style.gridColumn = String(col + 1);
    cell.append(el('span', 'apply-num', String(Number(iso.slice(8)))));
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
      label = `, 이미 신청한 ${ABSENCE_KIND_LABELS[mine.kind]}`;
    } else if (notSaturday && st.start && iso >= st.start && iso <= (st.end ?? st.start)) {
      // 고른 외박의 일요일(복귀일): 기간 표시만 하고 누르지는 않는다
      cell.disabled = true;
    } else if (notSaturday) {
      // 외박을 고르면 토요일만 누를 수 있다
      cell.disabled = true;
      cell.classList.add('not-allowed');
      label = ', 외박은 토요일 출발만 가능';
    } else if (seats[iso]?.full) {
      // 정원이 찬 날: 회색 "마감", 누를 수 없음
      cell.disabled = true;
      cell.classList.add('full');
      cell.append(el('span', 'apply-seats', '마감'));
      label = ', 마감';
    } else if (seats[iso] && seats[iso].remaining !== null) {
      cell.append(el('span', 'apply-seats', `${seats[iso].remaining}자리`));
      label = `, 남은 자리 ${seats[iso].remaining}`;
    }
    const end = st.end ?? st.start;
    if (st.start && iso >= st.start && iso <= end) {
      cell.classList.add('in-range');
      if (iso === st.start) cell.classList.add('range-start');
      if (iso === end) cell.classList.add('range-end');
      label += st.kind === 'outing' ? ', 외출일' : iso === st.start ? ', 출발일' : iso === end ? ', 복귀일' : ', 기간';
    }
    cell.setAttribute('aria-label', `${shortDay(iso)}${label}`);
    return cell;
  }
  box.append(grid);

  // 안내 또는 기간과 종류별 일수
  if (!st.start) {
    const first =
      st.kind === 'outing'
        ? '외출할 날을 누르세요.'
        : st.kind === 'overnight'
          ? '외박할 토요일을 누르세요 (토요일 출발 → 일요일 복귀).'
          : '출발일을 누르세요.';
    box.append(el('p', 'apply-guide', `${first} 신청할 수 있는 날짜: ${shortDay(win.start)} ~ ${shortDay(win.end)}. 날짜 아래 숫자는 남은 자리, 회색 "마감"은 정원이 찬 날입니다.`));
    return [box];
  }
  if (!st.end) {
    box.append(el('p', 'apply-guide', `출발일 ${shortDay(st.start)}. 이제 복귀일을 누르세요. (하루짜리면 같은 날을 한 번 더)`));
    return [box];
  }

  if (st.kind !== 'leave') {
    box.append(...absenceFormParts(redraw, st));
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


function nextDayOf(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const next = new Date(y, m - 1, d + 1);
  return isoOf(next.getFullYear(), next.getMonth(), next.getDate());
}

function isWeekendDay(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const day = new Date(y, m - 1, d).getDay();
  return day === 0 || day === 6;
}

// 외박·외출 횟수 안내: 그 날짜가 속한 분기의 외박·주말 외출, 그 달의 평일 외출 (포상으로 쓴 것은 세지 않음)
function quotaLine(iso) {
  const q = getMyAbsenceQuota(iso);
  const line = el('p', 'apply-quota');
  line.append(
    el('span', '', `${q.quarter.label}: 외박 ${q.quarter.overnight}/${q.limits.overnight} · 주말 외출 ${q.quarter.weekendOuting}/${q.limits.weekendOuting} (둘 중 한 종류만)`),
    el('span', '', `${q.month.label}: 평일 외출 ${q.month.weekdayOuting}/${q.limits.weekdayOuting}`),
  );
  return line;
}

// 외박·외출 신청 부분: 기간(또는 하루)과 포상 사용 여부
function absenceFormParts(redraw, st) {
  const kindLabel = ABSENCE_KIND_LABELS[st.kind];
  const passType = st.kind === 'overnight' ? 'overnight_pass' : 'outing_pass';
  const passLeft = getMyPassSummary().find((x) => x.type === passType)?.remaining ?? 0;
  // 받침에 맞는 조사: 외박으로, 외출로
  const ro = st.kind === 'outing' ? '로' : '으로';
  const parts = [];
  const range = el('p', 'apply-range');
  if (st.kind === 'outing') {
    range.append(el('strong', '', shortDay(st.start)), ` · ${isWeekendDay(st.start) ? '주말' : '평일'} 외출 (하루)`);
  } else {
    range.append(el('strong', '', `${shortDay(st.start)} ~ ${shortDay(st.end)}`), ' · 외박 (1박 2일)');
  }
  parts.push(range);

  const form = el('form', 'apply-form');
  form.noValidate = true;
  const passRow = el('label', 'apply-pass');
  const pass = document.createElement('input');
  pass.type = 'checkbox';
  pass.name = 'use_pass';
  pass.disabled = passLeft < 1;
  passRow.append(pass, ` 포상 ${kindLabel}${ro} 쓰기 (남은 ${passLeft}회)`);
  form.append(passRow);
  form.append(el('p', 'help', `${kindLabel}은 휴가 일수를 쓰지 않고, 총 출타 정원 안에서 나갑니다. 포상으로 쓰면 분기·한 달 횟수에 들어가지 않습니다.${passLeft < 1 ? ` 남은 포상 ${kindLabel}이 없어 일반 ${kindLabel}${ro} 신청합니다.` : ''}`));
  const error = el('p', 'form-error');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  form.append(error);
  const submit = el('button', 'primary-button', `${kindLabel} 신청하기`);
  submit.type = 'submit';
  submit.dataset.action = 'apply-absence';
  const reset = button('secondary-button', '날짜 다시 고르기', 'apply-reset', () => {
    st.start = null;
    st.end = null;
    redraw('.apply-title');
  });
  form.append(submit, reset);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const result = applyAbsence({ kind: st.kind, start_date: st.start, end_date: st.end, use_pass: pass.checked });
    if (!result.ok) {
      error.textContent = result.errors ? Object.values(result.errors).join(' ') : '신청할 수 없습니다.';
      error.hidden = false;
      return;
    }
    const when = st.kind === 'outing' ? shortDay(st.start) : `${shortDay(st.start)} ~ ${shortDay(st.end)}`;
    st.message = `${when} ${pass.checked ? `포상 ${kindLabel}` : kindLabel}을 신청했습니다. 달력에도 표시됩니다.`;
    st.start = null;
    st.end = null;
    redraw('.apply-message');
  });
  parts.push(form);
  return parts;
}

// 병사: 내 출타 신청 내역 (휴가·외박·외출, 취소 가능)
function myRequestParts(redraw) {
  const parts = [];
  const head = el('div', 'leave-sub-head');
  head.append(el('h3', '', '내 출타 신청 내역'));
  parts.push(head);
  const requests = getMyLeaveRequests();
  if (requests.length === 0) {
    parts.push(el('p', 'cal-empty', '신청한 출타가 없습니다.'));
    return parts;
  }
  const list = el('ul', 'grant-list request-list');
  requests.forEach((r) => {
    const active = r.status === 'requested';
    const item = el('li', `grant-item request-${r.status}`);
    item.dataset.requestId = r.id;
    const kindLabel = ABSENCE_KIND_LABELS[r.kind];
    const when = r.start_date === r.end_date ? shortDay(r.start_date) : `${shortDay(r.start_date)} ~ ${shortDay(r.end_date)}`;
    const meta =
      r.kind === 'leave'
        ? r.items.map((x) => `${LEAVE_TYPE_LABELS[x.leave_type]} ${x.days}`).join(' + ')
        : `${r.kind === 'outing' ? (isWeekendDay(r.start_date) ? '주말 외출' : '평일 외출') : '외박'} · ${r.reward_pass ? `포상 ${kindLabel} 사용` : '일반'}`;
    item.dataset.kind = r.kind;
    item.append(
      el('span', `status-badge ${active ? 'status-approved' : 'status-rejected'}`, active ? '신청' : '취소'),
      el('span', `type-badge type-${r.kind}`, kindLabel),
      el('span', 'grant-title', r.kind === 'leave' ? `${when} · ${r.days}일` : when),
      el('span', 'grant-meta', meta),
    );
    if (active) {
      const actions = el('span', 'grant-actions');
      actions.append(
        button('small-button danger', '취소', null, () => {
          const back = r.kind === 'leave' ? ' 일수가 되돌아옵니다.' : r.reward_pass ? ` 포상 ${kindLabel} 1회가 되돌아옵니다.` : '';
          if (!window.confirm(`${when} ${kindLabel} 신청을 취소할까요?${back}`)) return;
          cancelLeaveRequest(r.id);
          applyState.message =
            r.kind === 'leave'
              ? '휴가 신청을 취소했습니다. 일수가 되돌아왔습니다.'
              : `${kindLabel} 신청을 취소했습니다.${r.reward_pass ? ` 포상 ${kindLabel} 1회가 되돌아왔습니다.` : ''}`;
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

// ── 간부: 출타율(총 출타·휴가), 기간별 출타율, 출타 현황 달력 (3-3) ──────────

const RATE_LABELS = { total: '총 출타', leave: '휴가' };
const REQUEST_KIND_LABELS = { leave: '휴가', overnight: '외박', outing: '외출' };
let rateMessage = null;
// 간부 출타 현황 달력에서 보고 있는 달과 고른 날
let rosterState = null;

function quotaParts(redraw, user) {
  // 화면 순서: 출타 현황 달력 → 출타율 → 기간별 출타율 (2026-10-24 사용자 요청)
  const parts = [...rosterParts(redraw, user)];
  const settings = getRateSettings();
  const capacity = (rate) => Math.floor((settings.soldiers * rate) / 100);

  // 기본 출타율: 총 출타, 휴가
  const head = el('div', 'leave-sub-head');
  head.append(el('h3', '', '출타율'));
  parts.push(head);
  parts.push(
    el(
      'p',
      'help',
      `하루 정원 = 부대 전체 병사 ${settings.soldiers}명 × 출타율 (소수점 버림). 휴가는 총 출타에 포함됩니다. 외박·외출은 총 출타 정원 안에서만 나갈 수 있습니다.`,
    ),
  );
  if (rateMessage) {
    const msg = el('p', 'apply-message', rateMessage);
    msg.setAttribute('role', 'status');
    msg.tabIndex = -1;
    parts.push(msg);
    rateMessage = null;
  }
  const form = el('form', 'rate-form');
  form.noValidate = true;
  ['total', 'leave'].forEach((kind) => {
    const row = el('label', 'rate-row');
    const input = document.createElement('input');
    input.type = 'number';
    input.inputMode = 'numeric';
    input.min = '0';
    input.max = '100';
    input.name = kind;
    input.value = settings.defaults[kind] ?? '';
    const cap = el('span', 'rate-capacity');
    const update = () => {
      const raw = input.value.trim();
      const rate = Number(raw);
      cap.textContent = raw !== '' && Number.isInteger(rate) && rate >= 0 && rate <= 100 ? `→ 하루 ${capacity(rate)}명` : '';
    };
    input.addEventListener('input', update);
    update();
    row.append(el('span', 'rate-kind', RATE_LABELS[kind]), input, el('span', 'rate-unit', '%'), cap);
    form.append(row);
  });
  const error = el('p', 'form-error');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const save = el('button', 'primary-button', '출타율 저장');
  save.type = 'submit';
  save.dataset.action = 'save-rates';
  form.append(error, save);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const result = setDefaultRates({ total: form.elements.total.value, leave: form.elements.leave.value });
    if (!result.ok) {
      const entries = Object.entries(result.errors ?? {});
      error.textContent = entries.length
        ? entries.map(([kind, message]) => `${RATE_LABELS[kind]}: ${message}`).join(' ')
        : '저장할 수 없습니다.';
      error.hidden = false;
      form.elements[entries[0]?.[0] ?? 'total'].focus();
      return;
    }
    rateMessage = result.changed.length ? '출타율을 저장했습니다. 날짜별 남은 자리에 바로 반영됩니다.' : '바뀐 값이 없습니다.';
    redraw('.leave-section .apply-message');
  });
  parts.push(form);

  // 기간별 출타율
  const periodHead = el('div', 'leave-sub-head');
  periodHead.append(
    el('h3', '', '기간별 출타율'),
    button('small-button', '+ 기간 추가', 'add-period', () => openPeriodDialog(redraw)),
  );
  parts.push(periodHead);
  parts.push(el('p', 'help', '그 기간에는 기본 출타율 대신 이 값을 씁니다 (예: 훈련 기간 총 출타 0%). 겹치면 더 낮은 값을 씁니다.'));
  if (settings.periods.length === 0) {
    parts.push(el('p', 'cal-empty', '넣은 기간이 없습니다.'));
  } else {
    const list = el('ul', 'grant-list period-list');
    settings.periods.forEach((p) => {
      const item = el('li', 'grant-item');
      item.dataset.periodId = p.id;
      item.append(
        el('span', 'grant-title', `${RATE_LABELS[p.kind]} ${p.rate}%`),
        el('span', 'grant-meta', `${shortDay(p.start_date)} ~ ${shortDay(p.end_date)} · 하루 ${capacity(p.rate)}명`),
      );
      const actions = el('span', 'grant-actions');
      actions.append(
        button('small-button danger', '삭제', null, () => {
          if (!window.confirm(`${RATE_LABELS[p.kind]} ${p.rate}% (${shortDay(p.start_date)} ~ ${shortDay(p.end_date)}) 기간을 지울까요?`)) return;
          deleteRatePeriod(p.id);
          redraw('[data-action="add-period"]');
        }),
      );
      item.append(actions);
      list.append(item);
    });
    parts.push(list);
  }
  return parts;
}

// 간부: 출타 현황 달력. 날짜를 누르면 그날 휴가·외박·외출 나간 인원과 명단을 보여 준다.
function rosterParts(redraw, user) {
  const today = getApplyWindow().start;
  if (!rosterState || rosterState.userId !== user.id) {
    const [y, m] = today.split('-').map(Number);
    rosterState = { userId: user.id, year: y, month: m - 1, selected: today };
  }
  const rs = rosterState;
  const box = el('div', 'apply-box roster-box');
  box.append(el('h3', 'apply-title', '출타 현황'));
  box.append(el('p', 'help roster-help', '날짜 아래 숫자는 그날 나간 인원(휴가·외박·외출)입니다. 날짜를 누르면 명단이 나옵니다.'));

  const nav = el('div', 'apply-nav');
  const move = (delta, selector) => {
    const d = new Date(rs.year, rs.month + delta, 1);
    rs.year = d.getFullYear();
    rs.month = d.getMonth();
    rs.selected = isoOf(rs.year, rs.month, 1) <= today && today <= isoOf(rs.year, rs.month, new Date(rs.year, rs.month + 1, 0).getDate())
      ? today
      : isoOf(rs.year, rs.month, 1);
    redraw(selector);
  };
  const prev = button('cal-nav-button', '‹', 'roster-prev', () => move(-1, '[data-action="roster-prev"]'));
  prev.setAttribute('aria-label', '이전 달');
  const next = button('cal-nav-button', '›', 'roster-next', () => move(1, '[data-action="roster-next"]'));
  next.setAttribute('aria-label', '다음 달');
  nav.append(prev, el('span', 'apply-month', `${rs.year}년 ${rs.month + 1}월`), next);
  box.append(nav);

  const lastDay = new Date(rs.year, rs.month + 1, 0).getDate();
  const roster = Object.fromEntries(
    getAbsenceRoster(isoOf(rs.year, rs.month, 1), isoOf(rs.year, rs.month, lastDay)).map((x) => [x.date, x]),
  );

  const grid = el('div', 'apply-grid');
  const weekdays = el('div', 'apply-weekdays');
  WEEKDAYS.forEach((name, i) => {
    const head = el('div', 'cal-weekday', name);
    if (i === 0) head.classList.add('sun');
    if (i === 6) head.classList.add('sat');
    weekdays.append(head);
  });
  grid.append(weekdays);
  const first = new Date(rs.year, rs.month, 1).getDay();
  const weekCount = Math.ceil((first + lastDay) / 7);
  for (let w = 0; w < weekCount; w += 1) {
    const week = el('div', 'apply-week roster-week');
    for (let col = 0; col < 7; col += 1) {
      const day = w * 7 + col - first + 1;
      if (day < 1 || day > lastDay) {
        const blank = el('div', 'apply-blank');
        blank.style.gridColumn = String(col + 1);
        week.append(blank);
        continue;
      }
      const iso = isoOf(rs.year, rs.month, day);
      const info = roster[iso];
      const cell = button('apply-day roster-day', '', null, () => {
        rs.selected = iso;
        redraw(`.roster-day[data-date="${iso}"]`);
      });
      cell.dataset.date = iso;
      cell.style.gridColumn = String(col + 1);
      if (col === 0) cell.classList.add('sun');
      if (col === 6) cell.classList.add('sat');
      if (iso === today) cell.classList.add('today');
      cell.append(el('span', 'apply-num', String(day)));
      // 표시: 초과 > 마감(총 출타) > 휴가마감 > 나간 인원 수
      let label = `${shortDay(iso)}, 출타 ${info.total.count}명`;
      if (info.over) {
        cell.classList.add('over');
        cell.append(el('span', 'apply-seats', '초과'));
        label += ', 정원 초과';
      } else if (info.totalFull) {
        cell.classList.add('full');
        cell.append(el('span', 'apply-seats', '마감'));
        label += ', 마감';
      } else if (info.leaveFull) {
        cell.classList.add('leave-full');
        cell.append(el('span', 'apply-seats', '휴가마감'));
        label += ', 휴가 마감';
      } else if (info.total.count > 0) {
        cell.append(el('span', 'apply-seats', `${info.total.count}명`));
      }
      const selected = iso === rs.selected;
      cell.classList.toggle('selected', selected);
      cell.setAttribute('aria-pressed', String(selected));
      cell.setAttribute('aria-label', label);
      week.append(cell);
    }
    grid.append(week);
  }
  box.append(grid);

  // 고른 날의 인원과 명단
  const info = roster[rs.selected];
  if (info) {
    const detail = el('div', 'roster-detail');
    detail.setAttribute('aria-live', 'polite');
    detail.append(el('h4', '', shortDay(rs.selected)));
    const count = (l) => (l.capacity === null ? `${l.count}명` : `${l.count}/${l.capacity}명`);
    const summary = el('p', 'roster-summary');
    summary.append(
      el('span', `roster-chip${info.totalFull ? ' full' : ''}`, `총 출타 ${count(info.total)}${info.totalFull ? ' 마감' : ''}`),
      el('span', `roster-chip${info.leaveFull ? ' full' : ''}`, `휴가 ${count(info.leave)}${info.leaveFull ? ' 마감' : ''}`),
    );
    detail.append(summary);
    if (info.over) {
      detail.append(el('p', 'grant-meta over-note', '출타율을 낮춰 정원을 넘었습니다. 기존 신청은 그대로 두고, 이날은 새 신청을 받지 않습니다.'));
    }
    if (info.people.length === 0) {
      detail.append(el('p', 'cal-empty', '이날 나간 사람이 없습니다.'));
    } else {
      ['leave', 'overnight', 'outing'].forEach((kind) => {
        const people = info.people.filter((p) => p.kind === kind);
        if (!people.length) return;
        const row = el('p', 'roster-people');
        row.dataset.kind = kind;
        row.append(
          el('span', `type-badge type-${kind}`, `${REQUEST_KIND_LABELS[kind]} ${people.length}`),
          ` ${people.map((p) => `${p.name}(${p.position})`).join(', ')}`,
        );
        detail.append(row);
      });
    }
    box.append(detail);
  }
  return [box];
}

function openPeriodDialog(redraw) {
  const today = getApplyWindow().start;
  return openForm(
    `<form class="dialog-body" novalidate>
      <h2 id="leave-dialog-title">기간별 출타율 추가</h2>
      <fieldset class="field">
        <legend class="field-label">종류</legend>
        <div class="choice-row">
          <label class="choice"><input type="radio" name="kind" value="total" checked> 총 출타</label>
          <label class="choice"><input type="radio" name="kind" value="leave"> 휴가</label>
        </div>
        <span class="field-error" data-error-for="kind" hidden></span>
      </fieldset>
      ${field('start_date', '시작 날짜', `<input name="start_date" type="date" value="${today}" required>`)}
      ${field('end_date', '끝나는 날짜 (하루면 비워 두기)', '<input name="end_date" type="date">')}
      ${field('rate', '출타율 (%)', '<input name="rate" type="number" inputmode="numeric" min="0" max="100" value="0" required>')}
      <p class="help">예: 훈련 기간에는 총 출타 0% (휴가·외박·외출 모두 막힘). 이미 신청한 사람은 그대로 두고, 정원을 넘은 날은 새 신청을 받지 않습니다.</p>
      <p class="form-error" role="alert" hidden></p>
      <button type="submit" class="primary-button">추가</button>
      <button type="button" class="secondary-button" data-action="close">취소</button>
    </form>`,
    (f) => addRatePeriod({ kind: f.kind.value, start_date: f.start_date.value, end_date: f.end_date.value, rate: f.rate.value }),
    () => redraw('[data-action="add-period"]'),
    'start_date',
  );
}
