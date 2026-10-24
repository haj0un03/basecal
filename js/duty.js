// 신청 탭 근무 영역 (Phase 3.5, prd.md "추가. 근무 순번 편성")
// - 병사: 내 근무(오늘부터 한 달), 날짜별 근무표
// - 간부: 날짜별 근무표, 근무지·시간대·순번 명단 만들기·고치기·없애기
// 근무자는 순번으로 계산되어 각자의 달력에 "근무"로 자동 표시된다.
import {
  getApplyWindow,
  getMyDuties,
  getDutyBoard,
  getDutyPosts,
  saveDutyPost,
  deleteDutyPost,
  getSoldiers,
  NETWORK_ERROR,
} from './data.js';

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const SOURCE_LABELS = { substitute: '대신 섬', manual: '간부 수정', swap: '교대' };

const dutyDialog = document.getElementById('duty-dialog');
dutyDialog.addEventListener('close', () => {
  if (!dutyDialog.open) dutyDialog.replaceChildren();
});

// 근무표에서 보고 있는 날짜 (다시 그려도 유지)
const boardState = { date: null };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className, text, action, onClick) {
  const b = el('button', className, text);
  b.type = 'button';
  if (action) b.dataset.action = action;
  b.addEventListener('click', onClick);
  return b;
}

function shortDay(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${m}/${d}(${WEEKDAYS[new Date(y, m - 1, d).getDay()]})`;
}

function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const x = new Date(y, m - 1, d + n);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

function subHead(title, ...actions) {
  const head = el('div', 'leave-sub-head');
  head.append(el('h3', '', title), ...actions);
  return head;
}

export function renderDutySection(section, user, focusSelector) {
  const redraw = (selector) => renderDutySection(section, user, selector);
  const parts = [el('h2', '', '근무')];
  if (user.role === 'soldier') parts.push(...myDutyParts());
  parts.push(...boardParts(redraw, user));
  if (user.role === 'officer') parts.push(...postParts(redraw));
  section.replaceChildren(...parts);
  if (focusSelector) section.querySelector(focusSelector)?.focus();
}

// ── 병사: 내 근무 ──────────────────────────────────────────

function myDutyParts() {
  const win = getApplyWindow();
  const duties = getMyDuties(win.start, win.end);
  const parts = [subHead('내 근무')];
  parts.push(el('p', 'help', `${shortDay(win.start)}부터 한 달 동안의 근무입니다. 달력에도 "근무"로 보입니다.`));
  if (duties.length === 0) {
    parts.push(el('p', 'cal-empty', '이 기간에 근무가 없습니다.'));
    return parts;
  }
  const list = el('ul', 'grant-list duty-list');
  duties.forEach((d) => {
    const item = el('li', 'grant-item duty-item');
    item.dataset.date = d.date;
    item.append(
      el('span', 'type-badge type-duty', '근무'),
      el('span', 'grant-title', `${shortDay(d.date)} ${d.post_name} ${d.label}`),
    );
    if (SOURCE_LABELS[d.source]) item.append(el('span', 'grant-meta', SOURCE_LABELS[d.source]));
    list.append(item);
  });
  parts.push(list);
  return parts;
}

// ── 근무표 (모두) ──────────────────────────────────────────

function boardParts(redraw, user) {
  const today = getApplyWindow().start;
  if (!boardState.date) boardState.date = today;
  const date = boardState.date;
  const parts = [subHead('근무표')];

  const nav = el('div', 'apply-nav duty-nav');
  const prev = button('cal-nav-button', '‹', 'duty-prev', () => {
    boardState.date = addDays(date, -1);
    redraw('[data-action="duty-prev"]');
  });
  prev.setAttribute('aria-label', '전날');
  const next = button('cal-nav-button', '›', 'duty-next', () => {
    boardState.date = addDays(date, 1);
    redraw('[data-action="duty-next"]');
  });
  next.setAttribute('aria-label', '다음 날');
  const title = el('span', 'apply-month duty-date', shortDay(date));
  nav.append(prev, title, next);
  if (date !== today) {
    nav.append(
      button('small-button', '오늘', 'duty-today', () => {
        boardState.date = today;
        redraw('[data-action="duty-today"]');
      }),
    );
  }
  parts.push(nav);

  const board = getDutyBoard(date);
  if (board.length === 0) {
    parts.push(el('p', 'cal-empty', user.role === 'officer' ? '근무지가 없습니다. 아래에서 근무지를 추가하세요.' : '정해진 근무지가 없습니다.'));
    return parts;
  }
  const wrap = el('div', 'duty-board');
  board.forEach((post) => {
    const box = el('div', 'duty-post');
    box.dataset.postId = post.post_id;
    box.append(el('h4', 'duty-post-name', post.post_name));
    if (post.slots.length === 0) {
      box.append(el('p', 'cal-empty', '이날은 순번이 시작되기 전입니다.'));
    } else {
      const rows = el('ul', 'duty-slots');
      post.slots.forEach((slot) => {
        const row = el('li', 'duty-slot');
        row.dataset.slot = String(slot.slot);
        if (slot.user_id === user.id) row.classList.add('mine');
        row.append(el('span', 'duty-slot-label', slot.label), el('span', 'duty-slot-name', slot.name ?? '근무자 없음'));
        if (!slot.user_id) row.classList.add('empty');
        if (SOURCE_LABELS[slot.source]) row.append(el('span', 'duty-slot-source', SOURCE_LABELS[slot.source]));
        rows.append(row);
      });
      box.append(rows);
    }
    wrap.append(box);
  });
  parts.push(wrap);
  return parts;
}

// ── 간부: 근무지·시간대·순번 명단 ───────────────────────────

function postParts(redraw) {
  const add = button('small-button', '+ 근무지 추가', 'add-duty-post', () => openPostDialog(redraw));
  const parts = [subHead('근무지와 순번', add)];
  parts.push(
    el(
      'p',
      'help',
      '시간대마다 하루 1명이 서고, 날마다 명단 순서대로 넘어갑니다. 그날 나가 있는 사람은 건너뛰고 다음 사람이 대신 섭니다. 시간대나 명단을 고치면 오늘부터 명단 1번으로 다시 시작합니다.',
    ),
  );
  const posts = getDutyPosts();
  if (posts.length === 0) {
    parts.push(el('p', 'cal-empty', '근무지가 없습니다.'));
    return parts;
  }
  const list = el('ul', 'grant-list duty-post-list');
  posts.forEach((post) => {
    const item = el('li', 'grant-item');
    item.dataset.postId = post.id;
    item.append(
      el('span', 'grant-title', `${post.name} · ${post.slots.join(', ')}`),
      el('span', 'grant-meta', `순번 ${post.roster.length}명: ${post.roster.map((r) => r.name).join(' → ')} (${shortDay(post.start_date)}부터)`),
    );
    const actions = el('span', 'grant-actions');
    actions.append(
      button('small-button', '수정', null, () => openPostDialog(redraw, post)),
      button('small-button danger', '삭제', null, async () => {
        if (!window.confirm(`"${post.name}" 근무지를 없앨까요? 이 근무지의 근무가 모든 사람의 달력에서 사라집니다.`)) return;
        const result = await deleteDutyPost(post.id);
        if (result.reason === 'network') window.alert(NETWORK_ERROR);
        redraw('[data-action="add-duty-post"]');
      }),
    );
    item.append(actions);
    list.append(item);
  });
  parts.push(list);
  return parts;
}

function openPostDialog(redraw, post = null) {
  const soldiers = getSoldiers();
  const nameOf = (id) => {
    const s = soldiers.find((x) => x.id === id);
    return s ? `${s.name} · ${s.position}` : id;
  };
  let roster = post ? post.roster.map((r) => r.user_id) : [];

  dutyDialog.innerHTML = `
    <form class="dialog-body" novalidate>
      <h2 id="duty-dialog-title">${post ? '근무지 수정' : '근무지 추가'}</h2>
      <label class="field">
        <span class="field-label">근무지 이름</span>
        <input name="name" maxlength="20" placeholder="예: 불침번">
        <span class="field-error" data-error-for="name" hidden></span>
      </label>
      <label class="field">
        <span class="field-label">시간대 (쉼표로 나눔, 시간대마다 하루 1명)</span>
        <input name="slots" placeholder="예: 1번초, 2번초, 3번초, 4번초">
        <span class="field-error" data-error-for="slots" hidden></span>
      </label>
      <fieldset class="field">
        <legend class="field-label">순번 명단 (위에서부터 차례로)</legend>
        <ol class="roster-edit"></ol>
        <div class="roster-add">
          <select name="add_soldier" aria-label="명단에 넣을 병사"></select>
          <button type="button" class="small-button" data-action="roster-add">넣기</button>
        </div>
        <span class="field-error" data-error-for="roster" hidden></span>
      </fieldset>
      <p class="form-error" role="alert" hidden></p>
      <button type="submit" class="primary-button">저장</button>
      <button type="button" class="secondary-button" data-action="close">취소</button>
    </form>
  `;
  const form = dutyDialog.querySelector('form');
  const f = form.elements;
  f.name.value = post?.name ?? '';
  f.slots.value = post ? post.slots.join(', ') : '';
  const listNode = form.querySelector('.roster-edit');
  const select = f.add_soldier;

  const drawRoster = (focusSelector) => {
    listNode.replaceChildren(
      ...roster.map((id, i) => {
        const li = el('li', 'roster-edit-item');
        li.append(el('span', 'roster-edit-name', `${i + 1}. ${nameOf(id)}`));
        const up = button('small-button', '↑', null, () => {
          [roster[i - 1], roster[i]] = [roster[i], roster[i - 1]];
          drawRoster(`[data-roster-up="${i - 1}"]`);
        });
        up.dataset.rosterUp = String(i);
        up.setAttribute('aria-label', `${nameOf(id)} 위로`);
        up.disabled = i === 0;
        const down = button('small-button', '↓', null, () => {
          [roster[i + 1], roster[i]] = [roster[i], roster[i + 1]];
          drawRoster(`[data-roster-down="${i + 1}"]`);
        });
        down.dataset.rosterDown = String(i);
        down.setAttribute('aria-label', `${nameOf(id)} 아래로`);
        down.disabled = i === roster.length - 1;
        const remove = button('small-button danger', '빼기', null, () => {
          roster = roster.filter((x) => x !== id);
          drawRoster('[data-action="roster-add"]');
        });
        remove.setAttribute('aria-label', `${nameOf(id)} 빼기`);
        li.append(up, down, remove);
        return li;
      }),
    );
    if (roster.length === 0) listNode.append(el('li', 'cal-empty', '아래에서 병사를 넣으세요.'));
    select.replaceChildren(
      ...soldiers
        .filter((s) => !roster.includes(s.id))
        .map((s) => {
          const option = el('option', '', `${s.name} · ${s.position}`);
          option.value = s.id;
          return option;
        }),
    );
    form.querySelector('[data-action="roster-add"]').disabled = select.options.length === 0;
    if (focusSelector) form.querySelector(focusSelector)?.focus();
  };
  form.querySelector('[data-action="roster-add"]').addEventListener('click', () => {
    if (!select.value) return;
    roster.push(select.value);
    drawRoster('[data-action="roster-add"]');
  });
  drawRoster();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    form.querySelectorAll('.field-error, .form-error').forEach((node) => {
      node.hidden = true;
    });
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    const result = await saveDutyPost({ id: post?.id, name: f.name.value, slots: f.slots.value, roster });
    submit.disabled = false;
    if (result.ok) {
      dutyDialog.close();
      redraw('[data-action="add-duty-post"]');
      return;
    }
    if (result.reason === 'invalid') {
      Object.entries(result.errors).forEach(([name, message]) => {
        const node = form.querySelector(`[data-error-for="${name}"]`);
        node.textContent = message;
        node.hidden = false;
      });
      const first = Object.keys(result.errors)[0];
      (first === 'roster' ? select : f[first])?.focus?.();
      return;
    }
    const error = form.querySelector('.form-error');
    error.textContent =
      result.reason === 'network' ? NETWORK_ERROR : result.reason === 'not_found' ? '이 근무지를 찾을 수 없습니다.' : '간부만 근무지를 고칠 수 있습니다.';
    error.hidden = false;
  });
  form.querySelector('[data-action="close"]').addEventListener('click', () => dutyDialog.close());
  dutyDialog.showModal();
  f.name.focus();
}
