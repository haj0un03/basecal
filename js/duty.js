// 신청 탭 근무 영역 (Phase 3.5, prd.md "추가. 근무 순번 편성")
// - 병사("근무 교대" 탭): 내 근무 달력(오늘부터 한 달)과 교대 요청, 교대 요청 내역, 날짜별 근무표
// - 간부: 교대 요청 승인·반려(3.5-3), 날짜별 근무표와 근무자 손 수정(3.5-2), 근무지·시간대·순번 명단 만들기·고치기·없애기
// 근무자는 순번으로 계산되어 각자의 달력에 "근무"로 자동 표시된다.
import {
  getApplyWindow,
  getMyDuties,
  getDutyBoard,
  getDutyPosts,
  saveDutyPost,
  deleteDutyPost,
  getSoldiers,
  getDutyCandidates,
  setDutyOverride,
  clearDutyOverride,
  getSwapPartners,
  getSoldierDuties,
  requestDutySwap,
  getDutySwaps,
  getPendingSwapFor,
  cancelDutySwap,
  decideDutySwap,
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
// 내 근무 달력에서 보고 있는 달과 고른 날짜 (다시 그려도 유지)
const calState = { userId: null, year: null, month: null, selected: null };

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
  const parts = [el('h2', '', user.role === 'soldier' ? '근무 교대' : '근무')];
  if (user.role === 'soldier') parts.push(...myDutyParts(redraw, user), ...swapParts(redraw, user));
  if (user.role === 'officer') parts.push(...swapParts(redraw, user));
  parts.push(...boardParts(redraw, user));
  if (user.role === 'officer') parts.push(...postParts(redraw));
  section.replaceChildren(...parts);
  if (focusSelector) section.querySelector(focusSelector)?.focus();
}

// ── 병사: 내 근무 달력 ─────────────────────────────────────
// 오늘부터 한 달 동안의 근무를 달력으로 보여 준다. 날짜를 누르면 그날 근무 내용이 보이고 아래 근무표도 그날로 바뀐다.

function isoOf(year, month, day) {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function myDutyParts(redraw, user) {
  const win = getApplyWindow();
  const duties = getMyDuties(win.start, win.end);
  const byDate = new Map();
  duties.forEach((d) => byDate.set(d.date, [...(byDate.get(d.date) ?? []), d]));
  if (calState.userId !== user.id) {
    // 처음이거나 다른 사람으로 들어왔으면 이번 달부터
    const [y, m] = win.start.split('-').map(Number);
    Object.assign(calState, { userId: user.id, year: y, month: m - 1, selected: null });
  }
  const { year, month } = calState;

  const parts = [subHead('내 근무')];
  parts.push(el('p', 'help', `${shortDay(win.start)}부터 한 달 동안의 근무입니다. 날짜를 누르면 그날 근무와 근무표를 봅니다. 달력 탭에도 "근무"로 보입니다.`));
  const box = el('div', 'apply-box duty-cal-box');

  // 달 넘기기 (오늘부터 한 달이 걸친 달만)
  const [minY, minM] = win.start.split('-').map(Number);
  const [maxY, maxM] = win.end.split('-').map(Number);
  const cur = year * 12 + month;
  const min = minY * 12 + (minM - 1);
  const max = maxY * 12 + (maxM - 1);
  const move = (n, action) => {
    const d = new Date(year, month + n, 1);
    calState.year = d.getFullYear();
    calState.month = d.getMonth();
    // 끝 달에 닿아 누른 버튼이 막히면 반대쪽 버튼에 초점을 둔다
    const at = calState.year * 12 + calState.month;
    const stuck = (n > 0 && at >= max) || (n < 0 && at <= min);
    redraw(`[data-action="${stuck ? (n > 0 ? 'duty-cal-prev' : 'duty-cal-next') : action}"]`);
  };
  const nav = el('div', 'apply-nav');
  const prev = button('cal-nav-button', '‹', 'duty-cal-prev', () => move(-1, 'duty-cal-prev'));
  prev.setAttribute('aria-label', '이전 달');
  prev.disabled = cur <= min;
  const next = button('cal-nav-button', '›', 'duty-cal-next', () => move(1, 'duty-cal-next'));
  next.setAttribute('aria-label', '다음 달');
  next.disabled = cur >= max;
  nav.append(prev, el('span', 'apply-month', `${year}년 ${month + 1}월`), next);
  box.append(nav);

  const grid = el('div', 'duty-cal');
  WEEKDAYS.forEach((name, i) => {
    const head = el('div', 'cal-weekday', name);
    if (i === 0) head.classList.add('sun');
    if (i === 6) head.classList.add('sat');
    grid.append(head);
  });
  const first = new Date(year, month, 1).getDay();
  const lastDay = new Date(year, month + 1, 0).getDate();
  for (let i = 0; i < first; i += 1) grid.append(el('div', 'duty-cal-blank'));
  for (let day = 1; day <= lastDay; day += 1) {
    const iso = isoOf(year, month, day);
    const col = (first + day - 1) % 7;
    const mine = byDate.get(iso) ?? [];
    const outside = iso < win.start || iso > win.end;
    const cell = button('duty-cal-day', '', null, () => {
      calState.selected = iso;
      boardState.date = iso;
      redraw(`.duty-cal-day[data-date="${iso}"]`);
    });
    cell.dataset.date = iso;
    cell.append(el('span', 'duty-cal-num', String(day)));
    if (col === 0) cell.classList.add('sun');
    if (col === 6) cell.classList.add('sat');
    if (iso === win.start) cell.classList.add('today');
    if (iso === calState.selected) cell.classList.add('selected');
    cell.setAttribute('aria-pressed', String(iso === calState.selected));
    let label = '';
    if (outside) {
      cell.disabled = true;
      cell.classList.add('outside');
    } else if (mine.length) {
      // 근무 색과 "근무" 글자, 시간대 (색만으로 구분하지 않음)
      cell.classList.add('has-duty');
      cell.append(el('span', 'duty-cal-tag', mine.length > 1 ? `근무 ${mine.length}` : '근무'));
      cell.append(el('span', 'duty-cal-slot', mine.length > 1 ? '' : mine[0].label));
      label = `, 근무: ${mine.map((d) => `${d.post_name} ${d.label}`).join(', ')}`;
    }
    cell.setAttribute('aria-label', `${shortDay(iso)}${label}`);
    grid.append(cell);
  }
  box.append(grid);

  // 고른 날의 근무 내용과 교대 요청 버튼
  const sel = calState.selected;
  const detail = el('div', 'duty-cal-detail');
  detail.setAttribute('aria-live', 'polite');
  const list = sel ? byDate.get(sel) ?? [] : [];
  if (!sel) {
    detail.textContent = duties.length ? `이 기간 근무 ${duties.length}번. 날짜를 누르면 내용을 보고 교대를 요청할 수 있습니다.` : '이 기간에 근무가 없습니다.';
  } else if (list.length === 0) {
    detail.textContent = `${shortDay(sel)} 근무 없음`;
  }
  list.forEach((d) => {
    const line = el('div', 'duty-cal-line');
    line.append(el('span', '', `${shortDay(d.date)} ${d.post_name} ${d.label}${SOURCE_LABELS[d.source] ? ` (${SOURCE_LABELS[d.source]})` : ''}`));
    const pending = getPendingSwapFor(d);
    if (pending) {
      line.append(el('span', 'status-badge status-pending', '교대 요청 중'));
    } else {
      const ask = button('small-button', '교대 요청', null, () => openSwapDialog(redraw, d));
      ask.dataset.swapFor = `${d.post_id}:${d.date}:${d.slot}`;
      ask.setAttribute('aria-label', `${shortDay(d.date)} ${d.post_name} ${d.label} 교대 요청`);
      line.append(ask);
    }
    detail.append(line);
  });
  box.append(detail);
  parts.push(box);
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
    calState.selected = boardState.date;
    redraw('[data-action="duty-prev"]');
  });
  prev.setAttribute('aria-label', '전날');
  const next = button('cal-nav-button', '›', 'duty-next', () => {
    boardState.date = addDays(date, 1);
    calState.selected = boardState.date;
    redraw('[data-action="duty-next"]');
  });
  next.setAttribute('aria-label', '다음 날');
  const title = el('span', 'apply-month duty-date', shortDay(date));
  nav.append(prev, title, next);
  if (date !== today) {
    nav.append(
      button('small-button', '오늘', 'duty-today', () => {
        boardState.date = today;
        calState.selected = null;
        redraw('[data-action="duty-today"]');
      }),
    );
  }
  parts.push(nav);

  if (user.role === 'officer') {
    parts.push(el('p', 'help', '오늘부터 한 달 안의 근무는 "바꾸기"로 근무자를 바꿀 수 있습니다. 바꾼 날만 달라지고 나머지 날은 순번대로입니다.'));
  }
  const win = getApplyWindow();
  const editable = user.role === 'officer' && date >= win.start && date <= win.end;
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
        if (editable) {
          const edit = button('small-button', '바꾸기', null, () => openOverrideDialog(redraw, date, post, slot));
          edit.dataset.override = `${post.post_id}:${slot.slot}`;
          edit.setAttribute('aria-label', `${shortDay(date)} ${post.post_name} ${slot.label} 근무자 바꾸기`);
          row.append(edit);
        }
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

// ── 간부: 근무자 손 수정 ────────────────────────────────────

function openOverrideDialog(redraw, date, post, slot) {
  const focusBack = `[data-override="${post.post_id}:${slot.slot}"]`;
  const candidates = getDutyCandidates(post.post_id, date, slot.slot);
  const changed = slot.source === 'manual' || slot.source === 'swap';
  dutyDialog.innerHTML = `
    <form class="dialog-body" novalidate>
      <h2 id="duty-dialog-title">근무자 바꾸기</h2>
      <p class="help duty-override-target"></p>
      <label class="field">
        <span class="field-label">이 근무를 설 병사</span>
        <select name="user_id"></select>
        <span class="field-error" data-error-for="user_id" hidden></span>
      </label>
      <p class="help">출타 중이거나 그날 이미 근무가 있는 병사는 고를 수 없습니다.</p>
      <p class="form-error" role="alert" hidden></p>
      <button type="submit" class="primary-button">바꾸기</button>
      ${changed ? '<button type="button" class="secondary-button" data-action="reset-override">순번대로 되돌리기</button>' : ''}
      <button type="button" class="secondary-button" data-action="close">취소</button>
    </form>
  `;
  const form = dutyDialog.querySelector('form');
  const select = form.elements.user_id;
  form.querySelector('.duty-override-target').textContent =
    `${shortDay(date)} ${post.post_name} ${slot.label} · 지금: ${slot.name ?? '근무자 없음'}${SOURCE_LABELS[slot.source] ? ` (${SOURCE_LABELS[slot.source]})` : ''}`;
  select.append(
    ...candidates.map((c) => {
      const note = c.current ? ' — 지금 근무자' : c.blocked ? ` — ${c.blocked}` : '';
      const option = el('option', '', `${c.name} · ${c.position}${note}`);
      option.value = c.id;
      option.disabled = c.current || Boolean(c.blocked);
      return option;
    }),
  );
  const firstFree = candidates.find((c) => !c.current && !c.blocked);
  if (firstFree) select.value = firstFree.id;

  const showResult = (result) => {
    if (result.ok) {
      dutyDialog.close();
      redraw(focusBack);
      return;
    }
    if (result.reason === 'invalid') {
      const node = form.querySelector('[data-error-for="user_id"]');
      node.textContent = result.errors.user_id;
      node.hidden = false;
      select.focus();
      return;
    }
    const error = form.querySelector('.form-error');
    error.textContent =
      result.reason === 'network' ? NETWORK_ERROR : result.reason === 'not_found' ? '이 근무를 찾을 수 없습니다.' : '간부만 근무자를 바꿀 수 있습니다.';
    error.hidden = false;
  };
  const clearErrors = () =>
    form.querySelectorAll('.field-error, .form-error').forEach((node) => {
      node.hidden = true;
    });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors();
    showResult(await setDutyOverride({ post_id: post.post_id, date, slot: slot.slot, user_id: select.value }));
  });
  form.querySelector('[data-action="reset-override"]')?.addEventListener('click', async () => {
    clearErrors();
    showResult(await clearDutyOverride({ post_id: post.post_id, date, slot: slot.slot }));
  });
  form.querySelector('[data-action="close"]').addEventListener('click', () => dutyDialog.close());
  dutyDialog.showModal();
  select.focus();
}

// ── 근무 교대 (3.5-3) ──────────────────────────────────────
// 병사끼리 먼저 이야기한 뒤 한 명이 요청(사유 필수) → 간부가 승인·반려(반려 사유 필수).
// 맞바꾸기: 내 근무 ↔ 상대 근무. 대신 서기: 상대가 내 근무를 대신 선다.

const SWAP_STATUS = {
  pending: ['status-pending', '승인 대기'],
  approved: ['status-approved', '승인'],
  rejected: ['status-rejected', '반려'],
  cancelled: ['status-cancelled', '취소'],
};

function dayOf(d) {
  return `${Number(d.date.slice(5, 7))}/${Number(d.date.slice(8))}`;
}

function swapTitle(w) {
  const a = w.requester_duty;
  if (w.kind === 'cover') return `${dayOf(a)} ${a.post_name} ${a.label}: ${w.requester_name} → ${w.partner_name} 대신 서기`;
  const b = w.partner_duty;
  return `${w.requester_name} ${dayOf(a)} ${a.post_name} ${a.label} ↔ ${w.partner_name} ${dayOf(b)} ${b.post_name} ${b.label}`;
}

function swapItem(redraw, w, user) {
  const item = el('li', `grant-item swap-item status-${w.status}`);
  item.dataset.swapId = w.id;
  const [cls, text] = SWAP_STATUS[w.status];
  item.append(el('span', `status-badge ${cls}`, text), el('span', 'grant-title', swapTitle(w)));
  const requested = new Date(w.requested_at);
  const meta = [w.kind === 'cover' ? '대신 서기' : '맞바꾸기', `사유: ${w.reason}`, `${requested.getMonth() + 1}/${requested.getDate()} 요청`];
  if (w.role === 'partner') meta.unshift('나에게 온 요청');
  item.append(el('span', 'grant-meta', meta.join(' · ')));
  if (w.status === 'rejected') item.append(el('span', 'grant-meta swap-reject', `반려 사유: ${w.reject_reason}`));
  const actions = el('span', 'grant-actions');
  if (user.role === 'soldier' && w.role === 'requester' && w.status === 'pending') {
    actions.append(
      button('small-button danger', '요청 취소', null, async () => {
        if (!window.confirm('이 교대 요청을 취소할까요?')) return;
        const result = await cancelDutySwap(w.id);
        if (result.reason === 'network') window.alert(NETWORK_ERROR);
        redraw('.swap-head h3');
      }),
    );
  }
  if (user.role === 'officer' && w.status === 'pending') {
    if (w.problem) item.append(el('span', 'grant-meta swap-problem', `지금은 승인할 수 없음: ${w.problem}`));
    const approve = button('small-button approve', '승인', null, async () => {
      const result = await decideDutySwap(w.id, 'approve');
      if (!result.ok) window.alert(result.reason === 'stale' ? result.message : result.reason === 'network' ? NETWORK_ERROR : '승인할 수 없습니다.');
      redraw('.swap-head h3');
    });
    approve.disabled = Boolean(w.problem);
    actions.append(approve, button('small-button danger', '반려', null, () => openRejectDialog(redraw, w)));
  }
  if (actions.childElementCount) item.append(actions);
  return item;
}

function swapParts(redraw, user) {
  const swaps = getDutySwaps();
  const head = el('div', 'leave-sub-head swap-head');
  head.append(el('h3', '', user.role === 'officer' ? '교대 요청' : '교대 요청 내역'));
  head.querySelector('h3').tabIndex = -1;
  const parts = [head];
  if (user.role === 'soldier') {
    parts.push(el('p', 'help', '교대할 병사와 먼저 이야기한 뒤, 위 달력에서 내 근무 날을 눌러 요청하세요. 간부가 승인하면 근무가 바뀝니다. 상대에게도 이 요청이 보입니다.'));
  }
  const pending = swaps.filter((w) => w.status === 'pending');
  const done = swaps.filter((w) => w.status !== 'pending');
  if (user.role === 'officer') {
    if (pending.length === 0) parts.push(el('p', 'cal-empty', '승인 대기 중인 교대 요청이 없습니다.'));
    else {
      const list = el('ul', 'grant-list swap-list swap-pending');
      pending.forEach((w) => list.append(swapItem(redraw, w, user)));
      parts.push(list);
    }
    parts.push(subHead('교대 내역'));
    if (done.length === 0) parts.push(el('p', 'cal-empty', '처리한 교대가 없습니다.'));
    else {
      const list = el('ul', 'grant-list swap-list swap-done');
      done.forEach((w) => list.append(swapItem(redraw, w, user)));
      parts.push(list);
    }
    return parts;
  }
  if (swaps.length === 0) {
    parts.push(el('p', 'cal-empty', '교대 요청이 없습니다.'));
    return parts;
  }
  const list = el('ul', 'grant-list swap-list');
  swaps.forEach((w) => list.append(swapItem(redraw, w, user)));
  parts.push(list);
  return parts;
}

// 병사: 교대 요청 창 (내 근무 하나를 정해서 연다)
function openSwapDialog(redraw, duty) {
  const partners = getSwapPartners();
  dutyDialog.innerHTML = `
    <form class="dialog-body" novalidate>
      <h2 id="duty-dialog-title">근무 교대 요청</h2>
      <p class="help swap-target"></p>
      <fieldset class="field">
        <legend class="field-label">교대 방법</legend>
        <div class="choice-row">
          <label class="choice"><input type="radio" name="kind" value="swap" checked> 맞바꾸기</label>
          <label class="choice"><input type="radio" name="kind" value="cover"> 대신 서기</label>
        </div>
        <span class="help swap-kind-help"></span>
        <span class="field-error" data-error-for="kind" hidden></span>
      </fieldset>
      <label class="field">
        <span class="field-label">교대할 병사</span>
        <select name="partner_id"><option value="">고르세요</option></select>
        <span class="field-error" data-error-for="partner_id" hidden></span>
      </label>
      <label class="field swap-partner-duty">
        <span class="field-label">맞바꿀 상대 근무</span>
        <select name="partner_duty"></select>
        <span class="field-error" data-error-for="partner_duty" hidden></span>
      </label>
      <label class="field">
        <span class="field-label">사유 (간부에게 보임)</span>
        <input name="reason" maxlength="100" placeholder="예: 11/8 가족 면회">
        <span class="field-error" data-error-for="reason" hidden></span>
      </label>
      <p class="help">상대와 먼저 이야기했는지 확인하세요. 상대의 근무 교대 탭에도 이 요청이 보이고, 간부가 승인하면 근무가 바뀝니다.</p>
      <p class="form-error" role="alert" hidden></p>
      <button type="submit" class="primary-button">간부에게 요청하기</button>
      <button type="button" class="secondary-button" data-action="close">취소</button>
    </form>
  `;
  const form = dutyDialog.querySelector('form');
  const f = form.elements;
  form.querySelector('.swap-target').textContent = `내 근무: ${shortDay(duty.date)} ${duty.post_name} ${duty.label}`;
  f.partner_id.append(
    ...partners.map((x) => {
      const option = el('option', '', x.name);
      option.value = x.id;
      return option;
    }),
  );
  const dutyBox = form.querySelector('.swap-partner-duty');
  const kindHelp = form.querySelector('.swap-kind-help');
  const update = () => {
    const kind = f.kind.value;
    kindHelp.textContent =
      kind === 'swap' ? '내 근무와 상대 근무를 서로 바꿔 섭니다.' : '상대가 내 근무를 대신 섭니다. 내가 대신 서 줄 근무는 정하지 않습니다.';
    dutyBox.hidden = kind !== 'swap';
    const theirs = f.partner_id.value ? getSoldierDuties(f.partner_id.value) : [];
    f.partner_duty.replaceChildren(
      ...(f.partner_id.value
        ? theirs.length
          ? theirs.map((d) => {
              const option = el('option', '', `${shortDay(d.date)} ${d.post_name} ${d.label}`);
              option.value = `${d.post_id}|${d.date}|${d.slot}`;
              return option;
            })
          : [el('option', '', '이 병사는 한 달 안에 근무가 없습니다')]
        : [el('option', '', '먼저 병사를 고르세요')]),
    );
    if (!f.partner_id.value || theirs.length === 0) f.partner_duty.firstChild.value = '';
  };
  form.addEventListener('change', (e) => {
    if (e.target.name === 'kind' || e.target.name === 'partner_id') update();
  });
  update();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    form.querySelectorAll('.field-error, .form-error').forEach((node) => {
      node.hidden = true;
    });
    const [post_id, date, slot] = (f.partner_duty.value || '||').split('|');
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    const result = await requestDutySwap({
      kind: f.kind.value,
      requester_duty: { post_id: duty.post_id, date: duty.date, slot: duty.slot },
      partner_id: f.partner_id.value,
      partner_duty: post_id ? { post_id, date, slot: Number(slot) } : null,
      reason: f.reason.value,
    });
    submit.disabled = false;
    if (result.ok) {
      dutyDialog.close();
      redraw('.swap-head h3');
      return;
    }
    if (result.reason === 'invalid') {
      Object.entries(result.errors).forEach(([name, message]) => {
        const node = form.querySelector(`[data-error-for="${name}"]`);
        node.textContent = message;
        node.hidden = false;
      });
      const first = Object.keys(result.errors)[0];
      (first === 'kind' ? f.kind[0] : f[first])?.focus?.();
      return;
    }
    const error = form.querySelector('.form-error');
    error.textContent = result.reason === 'network' ? NETWORK_ERROR : '병사만 교대를 요청할 수 있습니다.';
    error.hidden = false;
  });
  form.querySelector('[data-action="close"]').addEventListener('click', () => dutyDialog.close());
  dutyDialog.showModal();
  f.kind[0].focus();
}

// 간부: 반려 사유 창
function openRejectDialog(redraw, w) {
  dutyDialog.innerHTML = `
    <form class="dialog-body" novalidate>
      <h2 id="duty-dialog-title">교대 요청 반려</h2>
      <p class="help swap-target"></p>
      <label class="field">
        <span class="field-label">반려 사유 (요청한 병사에게 보임)</span>
        <input name="reject_reason" maxlength="100" placeholder="예: 그날 위병소 인원 조정 필요">
        <span class="field-error" data-error-for="reject_reason" hidden></span>
      </label>
      <p class="form-error" role="alert" hidden></p>
      <button type="submit" class="primary-button">반려하기</button>
      <button type="button" class="secondary-button" data-action="close">취소</button>
    </form>
  `;
  const form = dutyDialog.querySelector('form');
  form.querySelector('.swap-target').textContent = swapTitle(w);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    form.querySelectorAll('.field-error, .form-error').forEach((node) => {
      node.hidden = true;
    });
    const result = await decideDutySwap(w.id, 'reject', form.elements.reject_reason.value);
    if (result.ok) {
      dutyDialog.close();
      redraw('.swap-head h3');
      return;
    }
    if (result.reason === 'invalid' && result.errors) {
      const node = form.querySelector('[data-error-for="reject_reason"]');
      node.textContent = result.errors.reject_reason;
      node.hidden = false;
      form.elements.reject_reason.focus();
      return;
    }
    const error = form.querySelector('.form-error');
    error.textContent = result.reason === 'network' ? NETWORK_ERROR : result.reason === 'already_decided' ? '이미 처리된 요청입니다.' : '반려할 수 없습니다.';
    error.hidden = false;
  });
  form.querySelector('[data-action="close"]').addEventListener('click', () => dutyDialog.close());
  dutyDialog.showModal();
  form.elements.reject_reason.focus();
}
