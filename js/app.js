// 앱의 시작점. 로그인하지 않았으면 로그인 화면을, 로그인했으면 사용자 영역과 아래쪽 탭을 그린다.
import { getCurrentUser, signIn, signOut } from './data.js';

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

const view = document.getElementById('view');
const userButton = document.getElementById('user-button');
const userMenu = document.getElementById('user-menu');

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
    <button type="button" class="secondary-button" disabled>보안코드로 등록하기 (준비 중)</button>
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

  form.username.focus();
}

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

  // 비밀번호 변경과 보안코드 발급(1-4)은 아직 만들지 않았다.
  const pending = (label) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'user-menu-item';
    item.textContent = `${label} (준비 중)`;
    item.disabled = true;
    return item;
  };
  const items = [pending('비밀번호 변경')];
  if (user.role === 'officer') {
    items.unshift(pending('일회용 보안코드 발급'));
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
