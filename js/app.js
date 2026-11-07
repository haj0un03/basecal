// 앱의 시작점. 들어오지 않았으면 들어오기 화면을, 들어왔으면 사용자 영역과 아래쪽 탭을 그린다.
import {
  init,
  NETWORK_ERROR,
  getCurrentUser,
  signIn,
  signOut,
  getDemoAccounts,
  getPositions,
  getMembers,
  addMember,
  reissueCode,
} from './data.js';
import { renderCalendar } from './calendar.js';
import { renderLeaveSection } from './leave.js';
import { renderDutySection } from './duty.js';

// 신청 탭은 위쪽 탭(휴가·근무·시설)으로 영역을 하나씩 보여준다 (2026-11-07 사용자 요청).
// 주소: #apply/leave, #apply/duty, #apply/facility (#apply는 휴가)
// 아직 만들지 않은 영역의 안내는 역할별로 다르다 (prd.md 3번 권한, 6번 주요 화면).
// - all: 모두에게, soldier: 병사에게만, officer: 간부에게만 (간부 전용 표시와 함께)
const TABS = {
  calendar: { title: '달력' },
  apply: { title: '신청' },
};

const APPLY_PANELS = [
  { key: 'leave', label: '휴가' },
  // 병사에게는 "근무 교대", 간부에게는 "근무"
  { key: 'duty', label: '근무', soldierLabel: '근무 교대' },
  {
    key: 'facility',
    label: '시설',
    placeholder: {
      heading: '시설',
      all: '시설 목록, 날짜별 시간대 현황, 예약 신청, 내 예약은 Phase 4에서 만듭니다.',
      officer: '예약 승인 대기 목록은 Phase 4에서 만듭니다.',
    },
  },
];

// 예전 탭 주소로 들어와도 신청 탭의 그 영역을 연다.
const OLD_TABS = { leave: 'apply/leave', facility: 'apply/facility' };

// 신청 탭에서 마지막으로 본 영역. 하단 "신청" 탭을 누르면 그 영역으로 돌아간다.
let lastPanel = 'leave';
// 마지막으로 그린 주소. 탭이나 영역이 바뀌면 화면 맨 위부터 보여 준다.
let lastRoute = null;

const ROLE_LABELS = { soldier: '병사', officer: '간부' };

const view = document.getElementById('view');
const userButton = document.getElementById('user-button');
const topbarTitle = document.getElementById('topbar-title');
const userMenu = document.getElementById('user-menu');
const memberDialog = document.getElementById('member-dialog');

function currentRoute() {
  const hash = location.hash.slice(1);
  const [tab, panel] = (OLD_TABS[hash] ?? hash).split('/');
  if (!TABS[tab]) return { tab: 'calendar', panel: null };
  if (tab !== 'apply') return { tab, panel: null };
  return { tab, panel: APPLY_PANELS.some((x) => x.key === panel) ? panel : 'leave' };
}

function formatCode(code) {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

function placeholder(text, officerOnly = false) {
  const p = document.createElement('p');
  p.className = officerOnly ? 'placeholder officer-only' : 'placeholder';
  if (officerOnly) {
    const badge = document.createElement('span');
    badge.className = 'officer-badge';
    badge.textContent = '간부 전용';
    p.append(badge);
  }
  p.append(text);
  return p;
}

function renderSection(spec, user) {
  const section = document.createElement('section');
  section.className = 'section';
  if (spec.heading) {
    const h2 = document.createElement('h2');
    h2.textContent = spec.heading;
    section.append(h2);
  }
  if (spec.all) section.append(placeholder(spec.all));
  if (spec.soldier && user.role === 'soldier') section.append(placeholder(spec.soldier));
  if (spec.officer && user.role === 'officer') section.append(placeholder(spec.officer, true));
  return section;
}

// 신청 탭 위쪽 탭: 휴가 | 근무 | 시설
function applyNav(panel, user) {
  const nav = document.createElement('nav');
  nav.className = 'subtabs';
  nav.setAttribute('aria-label', '신청 메뉴');
  APPLY_PANELS.forEach((x) => {
    const link = document.createElement('a');
    link.className = 'subtab';
    link.href = `#apply/${x.key}`;
    link.dataset.panel = x.key;
    link.textContent = user.role === 'soldier' && x.soldierLabel ? x.soldierLabel : x.label;
    if (x.key === panel) link.setAttribute('aria-current', 'page');
    nav.append(link);
  });
  return nav;
}

function renderView(user) {
  const { tab, panel } = currentRoute();
  const { title } = TABS[tab];
  // 위쪽 탭을 눌러 다시 그릴 때 그 탭에 초점을 둔다
  const focusedPanel = document.activeElement?.closest?.('.subtab')?.dataset.panel;

  const heading = document.createElement('h1');
  heading.textContent = title;
  const parts = [heading];
  if (tab === 'calendar') {
    const calendar = document.createElement('div');
    calendar.className = 'calendar';
    renderCalendar(calendar, user);
    parts.push(calendar);
  }
  if (tab === 'apply') {
    lastPanel = panel;
    parts.push(applyNav(panel, user));
    const spec = APPLY_PANELS.find((x) => x.key === panel);
    if (spec.placeholder) {
      parts.push(renderSection(spec.placeholder, user));
    } else {
      const section = document.createElement('section');
      section.className = `section ${panel}-section`;
      if (panel === 'leave') renderLeaveSection(section, user);
      if (panel === 'duty') renderDutySection(section, user);
      parts.push(section);
    }
  }
  view.replaceChildren(...parts);
  const route = `${tab}/${panel}`;
  if (lastRoute && route !== lastRoute) window.scrollTo(0, 0);
  lastRoute = route;
  if (focusedPanel) view.querySelector(`.subtab[data-panel="${focusedPanel}"]`)?.focus();

  document.querySelectorAll('.tab').forEach((link) => {
    if (link.dataset.tab === 'apply') link.href = `#apply/${lastPanel}`;
    if (link.dataset.tab === tab) {
      link.setAttribute('aria-current', 'page');
    } else {
      link.removeAttribute('aria-current');
    }
  });
  document.title = `${title} - 부대 달력`;
}

// ── 들어오기 화면: 이름 + 개인 코드 ──────────────────────────

function renderSignIn() {
  document.title = '들어오기 - 부대 달력';
  view.innerHTML = `
    <h1>들어오기</h1>
    <p class="help">이름과 간부에게 받은 개인 코드를 입력하세요. 코드를 잊었다면 간부에게 다시 발급받으세요.</p>
    <form class="login-form" novalidate>
      <label class="field">
        <span class="field-label">이름</span>
        <input name="name" autocomplete="name" maxlength="20" required>
      </label>
      <label class="field">
        <span class="field-label">개인 코드 (영문·숫자 6자리)</span>
        <input name="code" class="code-input" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="7" required>
      </label>
      <p class="form-error" role="alert" hidden></p>
      <button type="submit" class="primary-button">들어가기</button>
    </form>
    <details class="demo-hint">
      <summary>연습용 가상 인원 코드 보기</summary>
      <table class="demo-table">
        <thead><tr><th>이름</th><th>보직</th><th>개인 코드</th></tr></thead>
        <tbody></tbody>
      </table>
    </details>
  `;

  const tbody = view.querySelector('.demo-table tbody');
  getDemoAccounts().forEach(({ name, position, role, code }) => {
    const tr = document.createElement('tr');
    [name, `${position} · ${ROLE_LABELS[role]}`, code].forEach((text) => {
      const td = document.createElement('td');
      td.textContent = text;
      tr.append(td);
    });
    tbody.append(tr);
  });

  const form = view.querySelector('.login-form');
  const nameInput = form.elements.name;
  const codeInput = form.elements.code;
  const error = view.querySelector('.form-error');
  const showError = (message) => {
    error.textContent = message;
    error.hidden = false;
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!nameInput.value.trim() || !codeInput.value.trim()) {
      showError('이름과 개인 코드를 입력하세요.');
      return;
    }

    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    const result = await signIn(nameInput.value, codeInput.value);
    submit.disabled = false;
    if (result.ok) {
      history.replaceState(null, '', '#calendar');
      render();
      return;
    }

    codeInput.value = '';
    codeInput.focus();
    if (result.reason === 'format') {
      showError('개인 코드는 영문·숫자 6자리입니다. 0, O, 1, I, L은 쓰지 않습니다.');
    } else if (result.reason === 'locked') {
      const minutes = Math.ceil((result.lockedUntil - Date.now()) / 60000);
      showError(`5회 연속 틀려 이 이름으로는 들어올 수 없습니다. ${minutes}분 뒤에 다시 시도하세요.`);
    } else if (result.reason === 'inactive') {
      showError('사용할 수 없는 인원입니다. 간부에게 문의하세요.');
    } else if (result.reason === 'network') {
      showError(NETWORK_ERROR);
    } else {
      showError(`이름 또는 개인 코드가 맞지 않습니다. (남은 시도 ${result.remainingAttempts}회)`);
    }
  });

  nameInput.focus();
}

// ── 간부: 인원 추가·코드 발급, 코드 다시 발급 ──────────────────

function closeButton(label = '취소') {
  return `<button type="button" class="secondary-button" data-action="close">${label}</button>`;
}

function bindClose() {
  memberDialog.querySelectorAll('[data-action="close"]').forEach((button) => {
    button.addEventListener('click', () => memberDialog.close());
  });
}

function openAddMemberDialog() {
  const field = (name, label, type) => `
    <label class="field">
      <span class="field-label">${label}</span>
      <input name="${name}" type="${type}" required>
      <span class="field-error" data-error-for="${name}" hidden></span>
    </label>`;

  memberDialog.innerHTML = `
    <form class="dialog-body" novalidate>
      <h2 id="member-dialog-title">인원 추가·코드 발급</h2>
      ${field('name', '이름', 'text')}
      <fieldset class="field">
        <legend class="field-label">역할</legend>
        <div class="choice-row">
          <label class="choice"><input type="radio" name="role" value="soldier" checked> 병사</label>
          <label class="choice"><input type="radio" name="role" value="officer"> 간부</label>
        </div>
      </fieldset>
      <label class="field">
        <span class="field-label">보직</span>
        <input name="position" list="position-options" maxlength="20" required>
        <datalist id="position-options"></datalist>
        <span class="field-error" data-error-for="position" hidden></span>
      </label>
      ${field('enlist_date', '입대일', 'date')}
      ${field('discharge_date', '전역 예정일', 'date')}
      <p class="form-error" role="alert" hidden></p>
      <button type="submit" class="primary-button">추가하고 코드 발급</button>
      ${closeButton()}
    </form>
  `;

  const form = memberDialog.querySelector('form');
  // 이미 쓰이는 보직을 추천 목록으로 보여 준다. 목록에 없는 보직도 입력할 수 있다.
  const datalist = form.querySelector('#position-options');
  getPositions().forEach((position) => {
    const option = document.createElement('option');
    option.value = position;
    datalist.append(option);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    memberDialog.querySelectorAll('.field-error, .form-error').forEach((el) => {
      el.hidden = true;
    });

    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    const result = await addMember({
      name: form.elements.name.value,
      role: form.elements.role.value,
      position: form.elements.position.value,
      enlist_date: form.elements.enlist_date.value,
      discharge_date: form.elements.discharge_date.value,
    });

    submit.disabled = false;
    if (result.ok) {
      showIssuedCode(result, '인원을 추가했습니다');
      return;
    }
    if (result.reason === 'invalid') {
      Object.entries(result.errors).forEach(([name, message]) => {
        const el = memberDialog.querySelector(`[data-error-for="${name}"]`);
        if (el) {
          el.textContent = message;
          el.hidden = false;
        }
      });
      const first = Object.keys(result.errors)[0];
      form.elements[first]?.focus?.();
      return;
    }
    const error = memberDialog.querySelector('.form-error');
    error.textContent = result.reason === 'network' ? NETWORK_ERROR : '간부만 인원을 추가할 수 있습니다.';
    error.hidden = false;
  });

  bindClose();
  memberDialog.showModal();
  form.elements.name.focus();
}

function openReissueDialog() {
  memberDialog.innerHTML = `
    <form class="dialog-body" novalidate>
      <h2 id="member-dialog-title">코드 다시 발급</h2>
      <label class="field">
        <span class="field-label">대상</span>
        <select name="member"></select>
      </label>
      <p class="help">다시 발급하면 지금 쓰던 코드는 바로 쓸 수 없게 됩니다.</p>
      <p class="form-error" role="alert" hidden></p>
      <button type="submit" class="primary-button">다시 발급</button>
      ${closeButton()}
    </form>
  `;

  const form = memberDialog.querySelector('form');
  const select = form.elements.member;
  getMembers().forEach(({ id, name, position, role }) => {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = `${name} · ${position} (${ROLE_LABELS[role]})`;
    select.append(option);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    const result = await reissueCode(select.value);
    submit.disabled = false;
    if (result.ok) {
      showIssuedCode(result, '코드를 다시 발급했습니다');
      return;
    }
    const error = memberDialog.querySelector('.form-error');
    error.textContent =
      result.reason === 'forbidden'
        ? '간부만 코드를 발급할 수 있습니다.'
        : result.reason === 'network'
          ? NETWORK_ERROR
          : '대상을 다시 골라 주세요.';
    error.hidden = false;
  });

  bindClose();
  memberDialog.showModal();
}

function showIssuedCode({ user, code }, title) {
  memberDialog.innerHTML = `
    <div class="dialog-body">
      <h2 id="member-dialog-title"></h2>
      <p class="issued-target"></p>
      <p class="issued-code"></p>
      <p class="help">본인과 직접 만난 자리에서 알려 주세요. 이 창을 닫으면 코드를 다시 볼 수 없고, 잊으면 "코드 다시 발급"으로 새로 만듭니다.</p>
      <button type="button" class="primary-button" data-action="close">닫기</button>
    </div>
  `;
  memberDialog.querySelector('h2').textContent = title;
  memberDialog.querySelector('.issued-target').textContent = `${user.name} · ${user.position} · ${ROLE_LABELS[user.role]}`;
  const codeEl = memberDialog.querySelector('.issued-code');
  codeEl.textContent = formatCode(code);
  codeEl.setAttribute('aria-label', `개인 코드 ${code.split('').join(' ')}`);
  bindClose();
}

// 닫힘 알림은 조금 늦게 온다. 그 사이 다른 창을 열었다면 지우지 않는다.
memberDialog.addEventListener('close', () => {
  if (!memberDialog.open) memberDialog.replaceChildren();
});

// ── 사용자 메뉴와 전체 그리기 ───────────────────────────────

function menuButton(label, onClick) {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'user-menu-item';
  item.textContent = label;
  item.addEventListener('click', () => {
    setMenuOpen(false);
    onClick();
  });
  return item;
}

function renderUser(user) {
  // 화면 위 왼쪽: 현재 사용자의 이름과 보직 (앱 이름 자리). 오른쪽 ⋮ 버튼이 사용자 메뉴를 연다.
  const topName = document.createElement('span');
  topName.className = 'topbar-name';
  topName.textContent = user.name;
  const topSub = document.createElement('span');
  topSub.className = 'topbar-sub';
  topSub.textContent = user.position;
  topbarTitle.replaceChildren(topName, topSub);

  const info = document.createElement('div');
  info.className = 'user-menu-info';
  const name = document.createElement('div');
  name.className = 'user-menu-name';
  name.textContent = user.name;
  const sub = document.createElement('div');
  sub.className = 'user-menu-sub';
  sub.textContent = `${user.position} · ${ROLE_LABELS[user.role]}`;
  info.append(name, sub);

  const items = [];
  if (user.role === 'officer') {
    items.push(menuButton('인원 추가·코드 발급', openAddMemberDialog));
    items.push(menuButton('코드 다시 발급', openReissueDialog));
  }
  items.push(
    menuButton('로그아웃', async () => {
      await signOut();
      history.replaceState(null, '', location.pathname);
      render();
    }),
  );

  userMenu.replaceChildren(info, ...items);
}

function render() {
  const user = getCurrentUser();
  setMenuOpen(false);
  document.body.classList.toggle('signed-out', !user);
  if (!user) {
    // 들어오기 전에는 앱 이름을 보여 준다.
    const appTitle = document.createElement('span');
    appTitle.className = 'app-title';
    appTitle.textContent = '부대 달력';
    topbarTitle.replaceChildren(appTitle);
    renderSignIn();
    return;
  }
  renderUser(user);
  renderView(user);
}

function setMenuOpen(open) {
  userMenu.hidden = !open;
  userButton.setAttribute('aria-expanded', String(open));
}

userButton.addEventListener('click', (e) => {
  e.stopPropagation();
  setMenuOpen(userMenu.hidden);
});
document.addEventListener('click', (e) => {
  if (!userMenu.hidden && !userMenu.contains(e.target)) setMenuOpen(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') setMenuOpen(false);
});
window.addEventListener('hashchange', render);

// 서버 모드에서는 들어와 있던 사람의 데이터를 먼저 받아 온다
await init();
render();
