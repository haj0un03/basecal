// 신청 탭 휴가 영역
// - 병사: 휴가 종류별·상점 현황, 받은 일수 요청(포상·위로), 상점 → 포상휴가 전환 요청, 상점·벌점 내역
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
} from './data.js';
import { MAX_POINTS_PER_ENTRY } from './settings.js';

const LEAVE_TYPE_LABELS = { annual: '연가', reward: '포상휴가', consolation: '위로휴가' };
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

  parts.push(...(user.role === 'soldier' ? soldierParts(redraw) : officerParts(redraw)));
  section.replaceChildren(...parts);
  if (focusSelector) section.querySelector(focusSelector)?.focus();
}

// ── 병사 ─────────────────────────────────────────────────

function soldierParts(redraw) {
  const parts = [];
  const merit = getMyMeritSummary();

  // 휴가 종류별 남은 일수 + 상점
  const summary = el('div', 'leave-summary');
  summary.setAttribute('aria-label', '내 휴가 일수와 상점');
  getMyLeaveSummary().forEach(({ leave_type: type, granted, used, remaining }) => {
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
    el('span', 'leave-card-detail', merit.reserved ? `전환 대기 ${merit.reserved}` : `${merit.pointsPerDay}점 = 포상 1일`),
  );
  summary.append(meritCard);
  parts.push(summary);

  parts.push(placeholder('달력에서 날짜를 골라 휴가·외박·외출 신청하기는 다음 단계(3-2)에서 만듭니다.'));

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
      `포상휴가·위로휴가를 새로 받았으면 요청하세요. 상점은 ${merit.pointsPerDay}점마다 포상휴가 1일로 바꿔 달라고 요청할 수 있습니다. 간부가 승인하면 남은 일수에 더해집니다.`,
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
        el('span', 'grant-title', `${LEAVE_TYPE_LABELS[g.leave_type]} ${g.days}일`),
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
        el('span', 'grant-meta', `${formatDate(m.created_at)} · ${m.given_by_name}`),
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
      const title = `${g.name} · ${LEAVE_TYPE_LABELS[g.leave_type]} ${g.days}일${isConversion ? ` (상점 ${g.merit_cost}점 전환)` : ''}`;
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
          if (!window.confirm(`${g.name}의 ${LEAVE_TYPE_LABELS[g.leave_type]} ${g.days}일 요청을 반려할까요?`)) return;
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
  parts.push(el('p', 'help', '병사를 골라 사유와 함께 상점이나 벌점을 줍니다. 벌점은 그 병사의 상점에서 빠집니다.'));

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

// 병사: 상점 → 포상휴가 전환 요청
function openConversionDialog(redraw, merit) {
  const maxDays = Math.max(0, Math.floor(merit.available / merit.pointsPerDay));
  const form = openForm(
    `<form class="dialog-body" novalidate>
      <h2 id="leave-dialog-title">상점을 포상휴가로 전환</h2>
      <p class="summary-box">지금 상점 <strong class="conv-balance"></strong><br>
        쓸 수 있는 상점 <strong class="conv-available"></strong> (전환 대기 제외)<br>
        상점 <strong class="conv-rate"></strong> = 포상휴가 1일</p>
      ${field('days', `바꿀 일수 (최대 ${maxDays}일)`, `<input name="days" type="number" inputmode="numeric" min="1" max="${Math.max(maxDays, 1)}" value="${maxDays >= 1 ? 1 : ''}" required>`)}
      <p class="help conv-preview" aria-live="polite"></p>
      <p class="help">간부가 승인할 때 상점이 빠지고 포상휴가가 더해집니다.</p>
      <p class="form-error" role="alert" hidden></p>
      <button type="submit" class="primary-button">전환 요청</button>
      <button type="button" class="secondary-button" data-action="close">취소</button>
    </form>`,
    (f) => requestMeritConversion({ days: f.days.value }),
    () => redraw('[data-action="convert-merit"]'),
    'days',
  );
  form.querySelector('.conv-balance').textContent = `${merit.balance}점`;
  form.querySelector('.conv-available').textContent = `${merit.available}점`;
  form.querySelector('.conv-rate').textContent = `${merit.pointsPerDay}점`;
  const preview = form.querySelector('.conv-preview');
  const update = () => {
    const days = Number(form.elements.days.value);
    preview.textContent =
      Number.isInteger(days) && days >= 1
        ? `필요한 상점 ${days * merit.pointsPerDay}점 · 전환 후 남는 상점 ${merit.available - days * merit.pointsPerDay}점`
        : '';
  };
  form.elements.days.addEventListener('input', update);
  update();
  if (maxDays < 1) {
    preview.textContent = `상점이 ${merit.pointsPerDay}점 이상 있어야 전환할 수 있습니다.`;
    form.querySelector('button[type="submit"]').disabled = true;
  }
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
      <p class="help">벌점은 그 병사의 상점에서 빠집니다.</p>
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
