// 앱의 시작점. 위쪽 사용자 영역과 아래쪽 탭 3개의 틀을 그린다.
import { getCurrentUser } from './data.js';

const TABS = {
  calendar: { title: '달력', note: '월간 달력과 일정은 Phase 2에서 만듭니다.' },
  leave: { title: '휴가', note: '휴가·외박·외출 신청은 Phase 3에서 만듭니다.' },
  facility: { title: '시설', note: '시설 예약은 Phase 4에서 만듭니다.' },
};

const ROLE_LABELS = { soldier: '병사', officer: '간부' };

const view = document.getElementById('view');
const userButton = document.getElementById('user-button');
const userMenu = document.getElementById('user-menu');

function currentTab() {
  const tab = location.hash.slice(1);
  return TABS[tab] ? tab : 'calendar';
}

function renderView() {
  const tab = currentTab();
  const { title, note } = TABS[tab];

  const heading = document.createElement('h1');
  heading.textContent = title;
  const placeholder = document.createElement('p');
  placeholder.className = 'placeholder';
  placeholder.textContent = note;
  view.replaceChildren(heading, placeholder);

  document.querySelectorAll('.tab').forEach((link) => {
    if (link.dataset.tab === tab) {
      link.setAttribute('aria-current', 'page');
    } else {
      link.removeAttribute('aria-current');
    }
  });
  document.title = `${title} - 부대 달력`;
}

function renderUser() {
  const user = getCurrentUser();
  if (!user) return;

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

  // 비밀번호 변경과 로그아웃은 1-2에서 동작하게 만든다.
  const items = ['비밀번호 변경', '로그아웃'].map((label) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'user-menu-item';
    item.textContent = `${label} (준비 중)`;
    item.disabled = true;
    return item;
  });

  userMenu.replaceChildren(info, ...items);
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
window.addEventListener('hashchange', renderView);

renderUser();
renderView();
