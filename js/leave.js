// 신청 탭 휴가 영역: 휴가 현황(병사), 받은 일수 요청(병사), 받은 일수 승인·반려(간부)
import {
  getMyLeaveSummary,
  getMyLeaveGrants,
  requestLeaveGrant,
  getPendingLeaveGrants,
  decideLeaveGrant,
} from './data.js';

const LEAVE_TYPE_LABELS = { annual: '연가', reward: '포상휴가', consolation: '위로휴가' };
const STATUS_LABELS = { pending: '대기', approved: '승인', rejected: '반려' };

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

function formatDate(isoTime) {
  const d = new Date(isoTime);
  return `${d.getMonth() + 1}/${d.getDate()}`;
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

  if (user.role === 'soldier') {
    parts.push(...soldierParts(redraw));
  } else {
    parts.push(...officerParts(redraw));
  }

  section.replaceChildren(...parts);
  if (focusSelector) section.querySelector(focusSelector)?.focus();
}

function soldierParts(redraw) {
  const parts = [];

  // 종류별 남은 일수
  const summary = el('div', 'leave-summary');
  summary.setAttribute('aria-label', '내 휴가 일수');
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
  parts.push(summary);

  parts.push(placeholder('달력에서 날짜를 골라 휴가·외박·외출 신청하기는 다음 단계(3-2)에서 만듭니다.'));

  // 받은 일수 요청과 내 요청 목록
  const head = el('div', 'leave-sub-head');
  const requestButton = el('button', 'small-button', '+ 받은 일수 요청');
  requestButton.type = 'button';
  requestButton.dataset.action = 'request-grant';
  requestButton.addEventListener('click', () => openGrantDialog(redraw));
  head.append(el('h3', '', '받은 휴가 일수 요청'), requestButton);
  parts.push(head);
  parts.push(
    el('p', 'help', '포상휴가처럼 새로 받은 휴가가 있으면 요청하세요. 간부가 승인하면 남은 일수에 더해집니다.'),
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
  return parts;
}

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
      const item = el('li', 'grant-item status-pending');
      item.dataset.grantId = g.id;
      item.append(
        el('span', 'grant-title', `${g.name} · ${LEAVE_TYPE_LABELS[g.leave_type]} ${g.days}일`),
        el('span', 'grant-meta', `${g.position} · ${g.reason} · ${formatDate(g.requested_at)} 요청`),
      );
      const actions = el('span', 'grant-actions');
      const approve = el('button', 'small-button approve', '승인');
      approve.type = 'button';
      approve.addEventListener('click', () => {
        decideLeaveGrant(g.id, 'approve');
        redraw('.leave-sub-head h3');
      });
      const reject = el('button', 'small-button danger', '반려');
      reject.type = 'button';
      reject.addEventListener('click', () => {
        if (!window.confirm(`${g.name}의 ${LEAVE_TYPE_LABELS[g.leave_type]} ${g.days}일 요청을 반려할까요?`)) return;
        decideLeaveGrant(g.id, 'reject');
        redraw('.leave-sub-head h3');
      });
      actions.append(approve, reject);
      item.append(actions);
      list.append(item);
    });
    parts.push(list);
  }

  parts.push(placeholder('날짜별 출타 인원과 신청자 명단, 출타율 입력은 다음 단계(3-3)에서 만듭니다.', true));
  return parts;
}

// 병사: 받은 일수 요청 창
function openGrantDialog(redraw) {
  const field = (name, label, input) => `
    <label class="field" data-field="${name}">
      <span class="field-label">${label}</span>
      ${input}
      <span class="field-error" data-error-for="${name}" hidden></span>
    </label>`;

  leaveDialog.innerHTML = `
    <form class="dialog-body" novalidate>
      <h2 id="leave-dialog-title">받은 휴가 일수 요청</h2>
      <fieldset class="field">
        <legend class="field-label">휴가 종류</legend>
        <div class="choice-row">
          <label class="choice"><input type="radio" name="leave_type" value="annual"> 연가</label>
          <label class="choice"><input type="radio" name="leave_type" value="reward" checked> 포상</label>
          <label class="choice"><input type="radio" name="leave_type" value="consolation"> 위로</label>
        </div>
        <span class="field-error" data-error-for="leave_type" hidden></span>
      </fieldset>
      ${field('days', '일수', '<input name="days" type="number" inputmode="numeric" min="1" max="30" required>')}
      ${field('reason', '사유', '<input name="reason" maxlength="100" required placeholder="예: 체육대회 우승">')}
      <p class="help">간부가 승인해야 남은 일수에 더해집니다.</p>
      <p class="form-error" role="alert" hidden></p>
      <button type="submit" class="primary-button">요청하기</button>
      <button type="button" class="secondary-button" data-action="close">취소</button>
    </form>
  `;

  const form = leaveDialog.querySelector('form');
  const f = form.elements;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    form.querySelectorAll('.field-error, .form-error').forEach((node) => {
      node.hidden = true;
    });
    const result = requestLeaveGrant({ leave_type: f.leave_type.value, days: f.days.value, reason: f.reason.value });
    if (result.ok) {
      leaveDialog.close();
      redraw('[data-action="request-grant"]');
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
    error.textContent = '병사만 받은 일수를 요청할 수 있습니다.';
    error.hidden = false;
  });
  form.querySelector('[data-action="close"]').addEventListener('click', () => leaveDialog.close());
  leaveDialog.showModal();
  f.days.focus();
}
