// 앱의 시작점. 로그인하지 않았으면 로그인 화면을, 로그인했으면 사용자 영역과 아래쪽 탭을 그린다.
import {
  getCurrentUser,
  signIn,
  signOut,
  getCompanies,
  issueInviteCode,
  checkInviteCode,
  registerWithCode,
} from './data.js';

// 신청 탭은 휴가 영역(위)과 시설 영역(아래)을 한 화면에 이어서 보여준다.
// 각 영역의 안내는 역할별로 다르다 (prd.md 3번 권한, 6번 주요 화면).
// - all: 모두에게, soldier: 병사에게만, officer: 간부에게만 (간부 전용 표시와 함께)
const TABS = {
  calendar: {
    title: '달력',
    sections: [
      {
        all: '월간 달력, 선택한 날의 일정, 전역 D-day, 개인 일정 추가는 Phase 2에서 만듭니다.',
        officer: '부대 일정 추가·수정·삭제는 Phase 2에서 만듭니다.',
      },
    ],
  },
  apply: {
    title: '신청',
    sections: [
      {
        heading: '휴가',
        soldier: '휴가 종류별 남은 일수, 날짜별 남은 자리, 휴가·외박·외출 신청, 받은 일수 요청은 Phase 3에서 만듭니다.',
        officer: '날짜별 출타 인원과 신청자 명단, 출타율 입력, 받은 휴가 일수 승인은 Phase 3에서 만듭니다.',
      },
      {
        heading: '시설',
        all: '시설 목록, 날짜별 시간대 현황, 예약 신청, 내 예약은 Phase 4에서 만듭니다.',
        officer: '예약 승인 대기 목록은 Phase 4에서 만듭니다.',
      },
    ],
  },
};

// 예전 탭 주소로 들어와도 신청 탭을 연다.
const OLD_TABS = { leave: 'apply', facility: 'apply' };

const ROLE_LABELS = { soldier: '병사', officer: '간부' };

const CODE_ERRORS = {
  format: '보안코드 6자리 숫자를 입력하세요.',
  not_found: '맞지 않는 보안코드입니다. 간부에게 다시 확인하세요.',
  used: '이미 사용한 보안코드입니다. 간부에게 새 코드를 받으세요.',
  expired: '시간이 지나 만료된 보안코드입니다. 간부에게 새 코드를 받으세요.',
};

const view = document.getElementById('view');
const userButton = document.getElementById('user-button');
const userMenu = document.getElementById('user-menu');
const inviteDialog = document.getElementById('invite-dialog');

function currentTab() {
  const hash = location.hash.slice(1);
  const tab = OLD_TABS[hash] ?? hash;
  return TABS[tab] ? tab : 'calendar';
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

function renderView(user) {
  const tab = currentTab();
  const { title, sections } = TABS[tab];

  const heading = document.createElement('h1');
  heading.textContent = title;
  view.replaceChildren(heading, ...sections.map((spec) => renderSection(spec, user)));

  document.querySelectorAll('.tab').forEach((link) => {
    if (link.dataset.tab === tab) {
      link.setAttribute('aria-current', 'page');
    } else {
      link.removeAttribute('aria-current');
    }
  });
  document.title = `${title} - 부대 달력`;
}

function renderLogin() {
  document.title = '로그인 - 부대 달력';
  view.innerHTML = `
    <h1>로그인</h1>
    <form class="login-form" novalidate>
      <label class="field">
        <span class="field-label">아이디</span>
        <input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required>
      </label>
      <label class="field">
        <span class="field-label">비밀번호</span>
        <input name="password" type="password" autocomplete="current-password" required>
      </label>
      <p class="form-error" role="alert" hidden></p>
      <button type="submit" class="primary-button">로그인</button>
    </form>
    <button type="button" class="secondary-button" data-action="register">보안코드로 등록하기</button>
    <aside class="demo-hint">
      <strong>연습용 가상 계정</strong>
      <span>병사: soldier01 ~ soldier20</span>
      <span>간부: officer01, officer02</span>
      <span>비밀번호: test1234</span>
    </aside>
  `;

  const form = view.querySelector('.login-form');
  const error = view.querySelector('.form-error');
  const showError = (message) => {
    error.textContent = message;
    error.hidden = false;
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const username = form.username.value;
    const password = form.password.value;
    if (!username.trim() || !password) {
      showError('아이디와 비밀번호를 입력하세요.');
      return;
    }

    const result = signIn(username, password);
    if (result.ok) {
      history.replaceState(null, '', '#calendar');
      render();
      return;
    }

    form.password.value = '';
    form.password.focus();
    if (result.reason === 'locked') {
      const minutes = Math.ceil((result.lockedUntil - Date.now()) / 60000);
      showError(`비밀번호를 5회 연속 틀려 로그인이 막혔습니다. ${minutes}분 뒤에 다시 시도하세요.`);
    } else if (result.reason === 'inactive') {
      showError('사용할 수 없는 계정입니다. 간부에게 문의하세요.');
    } else {
      showError(`아이디 또는 비밀번호가 맞지 않습니다. (남은 시도 ${result.remainingAttempts}회)`);
    }
  });

  view.querySelector('[data-action="register"]').addEventListener('click', renderCodeEntry);
  form.username.focus();
}

// 등록 1단계: 간부에게 받은 보안코드 입력
function renderCodeEntry() {
  document.title = '보안코드로 등록하기 - 부대 달력';
  view.innerHTML = `
    <h1>보안코드로 등록하기</h1>
    <p class="help">간부에게 직접 받은 6자리 보안코드를 입력하세요. 코드는 발급 후 10분 동안 한 번만 쓸 수 있습니다.</p>
    <form class="login-form" novalidate>
      <label class="field">
        <span class="field-label">보안코드</span>
        <input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required>
      </label>
      <p class="form-error" role="alert" hidden></p>
      <button type="submit" class="primary-button">확인</button>
    </form>
    <button type="button" class="secondary-button" data-action="back">로그인으로 돌아가기</button>
  `;

  const form = view.querySelector('form');
  const error = view.querySelector('.form-error');

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = form.code.value.trim();
    const result = checkInviteCode(code);
    if (!result.ok) {
      error.textContent = CODE_ERRORS[result.reason];
      error.hidden = false;
      form.code.focus();
      return;
    }
    renderRegisterForm(code, result);
  });

  view.querySelector('[data-action="back"]').addEventListener('click', render);
  form.code.focus();
}

// 등록 2단계: 본인 정보 입력
function renderRegisterForm(code, { role, company }) {
  const field = (name, label, type = 'text', attrs = '') => `
    <label class="field">
      <span class="field-label">${label}</span>
      <input name="${name}" type="${type}" ${attrs} required>
      <span class="field-error" data-error-for="${name}" hidden></span>
    </label>`;

  view.innerHTML = `
    <h1>정보 입력</h1>
    <p class="summary-box">보안코드가 확인되었습니다. <strong class="register-target"></strong> 계정으로 등록합니다.</p>
    <form class="login-form" novalidate>
      ${field('name', '이름', 'text', 'autocomplete="name" maxlength="20"')}
      ${field('username', '아이디 (영문 소문자·숫자 4~20자)', 'text', 'autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="20"')}
      ${field('password', '비밀번호 (8자 이상)', 'password', 'autocomplete="new-password"')}
      ${field('passwordConfirm', '비밀번호 확인', 'password', 'autocomplete="new-password"')}
      ${field('enlist_date', '입대일', 'date')}
      ${field('discharge_date', '전역 예정일', 'date')}
      <p class="form-error" role="alert" hidden></p>
      <button type="submit" class="primary-button">등록하기</button>
    </form>
    <button type="button" class="secondary-button" data-action="back">처음으로 돌아가기</button>
  `;
  view.querySelector('.register-target').textContent = `${company} · ${ROLE_LABELS[role]}`;

  const form = view.querySelector('form');
  const formError = view.querySelector('.form-error');

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    view.querySelectorAll('.field-error').forEach((el) => {
      el.hidden = true;
    });
    formError.hidden = true;

    const result = registerWithCode({
      code,
      name: form.elements.name.value,
      username: form.username.value,
      password: form.password.value,
      passwordConfirm: form.passwordConfirm.value,
      enlist_date: form.enlist_date.value,
      discharge_date: form.discharge_date.value,
    });

    if (result.ok) {
      history.replaceState(null, '', '#calendar');
      render();
      return;
    }

    if (result.reason === 'invalid') {
      Object.entries(result.errors).forEach(([name, message]) => {
        const el = view.querySelector(`[data-error-for="${name}"]`);
        el.textContent = message;
        el.hidden = false;
      });
      form.elements[Object.keys(result.errors)[0]].focus();
      return;
    }

    // 입력하는 사이에 코드가 만료되었거나 다른 사람이 먼저 썼다.
    formError.textContent = CODE_ERRORS[result.reason];
    formError.hidden = false;
  });

  view.querySelector('[data-action="back"]').addEventListener('click', render);
  form.elements.name.focus();
}

// 간부: 일회용 보안코드 발급 창
let countdownTimer = null;

function formatCode(code) {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

function openInviteDialog() {
  inviteDialog.innerHTML = `
    <form class="dialog-body" novalidate>
      <h2 id="invite-title">일회용 보안코드 발급</h2>
      <fieldset class="field">
        <legend class="field-label">역할</legend>
        <div class="choice-row">
          <label class="choice"><input type="radio" name="role" value="soldier" checked> 병사</label>
          <label class="choice"><input type="radio" name="role" value="officer"> 간부</label>
        </div>
      </fieldset>
      <label class="field">
        <span class="field-label">소속</span>
        <select name="company"></select>
      </label>
      <p class="form-error" role="alert" hidden></p>
      <button type="submit" class="primary-button">발급하기</button>
      <button type="button" class="secondary-button" data-action="close">취소</button>
    </form>
  `;

  const form = inviteDialog.querySelector('form');
  const select = form.elements.company;
  getCompanies().forEach((company) => {
    const option = document.createElement('option');
    option.value = company;
    option.textContent = company;
    select.append(option);
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const result = issueInviteCode({ role: form.elements.role.value, company: select.value });
    if (!result.ok) {
      const error = form.querySelector('.form-error');
      error.textContent = result.reason === 'forbidden' ? '간부만 보안코드를 발급할 수 있습니다.' : '역할과 소속을 다시 골라 주세요.';
      error.hidden = false;
      return;
    }
    showIssuedCode(result);
  });

  inviteDialog.querySelector('[data-action="close"]').addEventListener('click', () => inviteDialog.close());
  inviteDialog.showModal();
}

function showIssuedCode({ code, role, company, expiresAt }) {
  inviteDialog.innerHTML = `
    <div class="dialog-body">
      <h2 id="invite-title">발급된 보안코드</h2>
      <p class="issued-code"></p>
      <p class="issued-target"></p>
      <p class="issued-timer" aria-live="polite"></p>
      <p class="help">병사와 직접 만난 자리에서 알려 주세요. 10분 동안 한 번만 쓸 수 있습니다.</p>
      <button type="button" class="primary-button" data-action="close">닫기</button>
    </div>
  `;
  const codeEl = inviteDialog.querySelector('.issued-code');
  codeEl.textContent = formatCode(code);
  codeEl.setAttribute('aria-label', `보안코드 ${code.split('').join(' ')}`);
  inviteDialog.querySelector('.issued-target').textContent = `${company} · ${ROLE_LABELS[role]}`;

  const timer = inviteDialog.querySelector('.issued-timer');
  const tick = () => {
    const left = Math.max(0, Date.parse(expiresAt) - Date.now());
    if (left === 0) {
      timer.textContent = '만료되었습니다. 새 코드를 발급하세요.';
      codeEl.classList.add('expired');
      clearInterval(countdownTimer);
      return;
    }
    const seconds = Math.ceil(left / 1000);
    timer.textContent = `남은 시간 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };
  clearInterval(countdownTimer);
  tick();
  countdownTimer = setInterval(tick, 1000);

  inviteDialog.querySelector('[data-action="close"]').addEventListener('click', () => inviteDialog.close());
}

inviteDialog.addEventListener('close', () => {
  clearInterval(countdownTimer);
  inviteDialog.replaceChildren();
});

function renderUser(user) {
  userButton.textContent = `${user.name} ▾`;

  const info = document.createElement('div');
  info.className = 'user-menu-info';
  const name = document.createElement('div');
  name.className = 'user-menu-name';
  name.textContent = user.name;
  const sub = document.createElement('div');
  sub.className = 'user-menu-sub';
  sub.textContent = `${user.company} · ${ROLE_LABELS[user.role]}`;
  info.append(name, sub);

  // 비밀번호 변경은 아직 만들지 않았다.
  const changePassword = document.createElement('button');
  changePassword.type = 'button';
  changePassword.className = 'user-menu-item';
  changePassword.textContent = '비밀번호 변경 (준비 중)';
  changePassword.disabled = true;
  const items = [changePassword];

  if (user.role === 'officer') {
    const issue = document.createElement('button');
    issue.type = 'button';
    issue.className = 'user-menu-item';
    issue.textContent = '일회용 보안코드 발급';
    issue.addEventListener('click', () => {
      setMenuOpen(false);
      openInviteDialog();
    });
    items.unshift(issue);
  }

  const logout = document.createElement('button');
  logout.type = 'button';
  logout.className = 'user-menu-item';
  logout.textContent = '로그아웃';
  logout.addEventListener('click', () => {
    signOut();
    history.replaceState(null, '', location.pathname);
    render();
  });

  userMenu.replaceChildren(info, ...items, logout);
}

function render() {
  const user = getCurrentUser();
  setMenuOpen(false);
  document.body.classList.toggle('signed-out', !user);
  if (!user) {
    renderLogin();
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

render();
