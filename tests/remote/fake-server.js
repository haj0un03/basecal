// 점검용 가짜 서버 ("서버 모드 흉내"). 진짜 Supabase 대신 앱의 서버 함수 호출에 답한다.
// - 앱은 js/config.js가 있는 서버 모드로 돈다. 이 파일이 fetch를 가로채 https://fake.basecal.test 로 가는 호출에 답한다
// - 일은 가상 데이터 모드의 앱 코드(/full/js/data.js, 따로 불러온 다른 사본)가 하고,
//   load_state는 supabase/*.sql과 같은 규칙으로 걸러서 준다: 병사는 자기 것 + 간부 이름 + 다른 병사 출타는 날짜·종류만,
//   근무표는 서버가 계산해 이름과 함께, 대기 중인 남의 시설 신청은 이름 없이
// - 그래서 "가상 데이터 모드에서는 되는데 서버 모드 병사 화면에서만 안 되는" 문제를 잡을 수 있다
// 접속 토큰은 사람 번호 그대로 쓴다 (점검용).
(() => {
  const FAKE = 'https://fake.basecal.test';
  const realFetch = window.fetch.bind(window);
  const ready = Promise.all([import('../full/js/data.js'), import('../full/js/mock-data.js')]);

  // 점검 페이지가 호출을 세어 볼 수 있게
  window.__fakeCalls = [];

  async function handle(name, args) {
    const [d, { mockDb, mockAuth }] = await ready;
    const as = (id) => {
      d.signOut();
      const p = mockDb.profiles.find((x) => x.id === id);
      const auth = mockAuth.find((a) => a.user_id === id);
      return p && auth ? d.signIn(p.name, auth.code) : { ok: false };
    };
    if (name === 'sign_in') {
      d.signOut();
      const r = d.signIn(args.p_name, args.p_code);
      return r.ok ? { ok: true, token: r.user.id, user: r.user } : r;
    }
    if (name === 'sign_out') return { ok: true };
    const me = mockDb.profiles.find((p) => p.id === args.p_token && p.is_active);
    if (!me) return name === 'load_state' ? { ok: false, reason: 'session' } : { ok: false, reason: 'forbidden' };
    if (name === 'load_state') return loadState(d, mockDb, me, as);

    as(me.id);
    const t = args;
    switch (name) {
      case 'save_personal_event': {
        const input = { kind: t.p_kind, title: t.p_title, start_date: t.p_start_date, end_date: t.p_end_date, time: t.p_time, memo: t.p_memo };
        return t.p_id ? d.updatePersonalEvent(t.p_id, input) : d.addPersonalEvent(input);
      }
      case 'delete_personal_event': return d.deletePersonalEvent(t.p_id);
      case 'save_unit_event': {
        const input = { unit_category: t.p_category, title: t.p_title, start_date: t.p_start_date, end_date: t.p_end_date, memo: t.p_memo };
        return t.p_id ? d.updateUnitEvent(t.p_id, input) : d.addUnitEvent(input);
      }
      case 'delete_unit_event': return d.deleteUnitEvent(t.p_id);
      case 'request_leave_grant': return d.requestLeaveGrant({ leave_type: t.p_leave_type, days: t.p_days, reason: t.p_reason });
      case 'request_merit_conversion': return d.requestMeritConversion({ target: t.p_target, count: t.p_count });
      case 'decide_leave_grant': return d.decideLeaveGrant(t.p_id, t.p_decision);
      case 'give_points': return d.givePoints({ user_id: t.p_user_id, kind: t.p_kind, points: t.p_points, reason: t.p_reason });
      case 'apply_leave':
        return d.applyLeave({ start_date: t.p_start_date, end_date: t.p_end_date, items: { annual: t.p_annual, reward: t.p_reward, consolation: t.p_consolation } });
      case 'apply_absence': return d.applyAbsence({ kind: t.p_kind, start_date: t.p_start_date, use_pass: t.p_use_pass });
      case 'cancel_leave_request': return d.cancelLeaveRequest(t.p_id);
      case 'set_default_rates': return d.setDefaultRates({ total: t.p_total, leave: t.p_leave });
      case 'add_rate_period': return d.addRatePeriod({ kind: t.p_kind, start_date: t.p_start_date, end_date: t.p_end_date, rate: t.p_rate });
      case 'delete_rate_period': return d.deleteRatePeriod(t.p_id);
      case 'set_training_rate': return d.setTrainingRate(t.p_event_id);
      case 'remove_training_rate': return d.removeTrainingRate(t.p_event_id);
      case 'save_duty_post': return d.saveDutyPost({ id: t.p_id ?? undefined, name: t.p_name, slots: t.p_slots, roster: t.p_roster });
      case 'delete_duty_post': return d.deleteDutyPost(t.p_id);
      case 'set_duty_override': return d.setDutyOverride({ post_id: t.p_post_id, date: t.p_date, slot: t.p_slot, user_id: t.p_user_id });
      case 'clear_duty_override': return d.clearDutyOverride({ post_id: t.p_post_id, date: t.p_date, slot: t.p_slot });
      case 'request_duty_swap':
        return d.requestDutySwap({
          kind: t.p_kind,
          requester_duty: { post_id: t.p_r_post, date: t.p_r_date, slot: t.p_r_slot },
          partner_id: t.p_partner_id,
          partner_duty: t.p_p_post ? { post_id: t.p_p_post, date: t.p_p_date, slot: t.p_p_slot } : null,
          reason: t.p_reason,
        });
      case 'cancel_duty_swap': return d.cancelDutySwap(t.p_id);
      case 'decide_duty_swap': return d.decideDutySwap(t.p_id, t.p_decision, t.p_reject_reason);
      case 'request_reservation':
        return d.requestReservation({ facility_id: t.p_facility_id, date: t.p_date, start_time: t.p_start_time, hours: t.p_hours });
      case 'cancel_reservation': return d.cancelReservation(t.p_id);
      case 'decide_reservation': return d.decideReservation(t.p_id, t.p_decision, t.p_reason);
      case 'add_facility_block':
        return d.addFacilityBlock({
          facility_id: t.p_facility_id, date: t.p_date, all_day: t.p_all_day, start_time: t.p_start_time, end_time: t.p_end_time, reason: t.p_reason,
        });
      case 'delete_facility_block': return d.deleteFacilityBlock(t.p_id);
      default: return { ok: false, reason: 'unknown_function', name };
    }
  }

  // supabase/*.sql의 load_state와 같은 규칙으로 걸러서 준다
  function loadState(d, db, me, as) {
    const all = me.role === 'officer';
    const today = d.getApplyWindow().start;
    const addDays = (iso, n) => {
      const [y, m, dd] = iso.split('-').map(Number);
      const x = new Date(y, m - 1, dd + n);
      return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
    };
    const copy = (rows) => rows.map((r) => ({ ...r }));
    const mineOrAll = (rows, key = 'user_id') => copy(rows.filter((r) => all || r[key] === me.id));
    const myRequestIds = new Set(db.leave_requests.filter((r) => all || r.user_id === me.id).map((r) => r.id));
    const nameOf = (id) => db.profiles.find((p) => p.id === id)?.name ?? null;

    // 근무표: 서버가 계산해 이름과 함께 (간부로 계산해서 모두 보이게)
    as('o01');
    const boardStart = addDays(today, -31);
    const boardEnd = addDays(d.getApplyWindow().end, 1);
    const rows = [];
    for (let x = boardStart; x <= boardEnd; x = addDays(x, 1)) {
      d.getDutyBoard(x).forEach((post) =>
        post.slots.forEach((s) => rows.push({ post_id: post.post_id, date: x, slot: s.slot, user_id: s.user_id, name: s.name, source: s.source })),
      );
    }

    const masked = (r) => {
      const open = all || r.user_id === me.id || r.status === 'approved';
      return {
        ...r,
        user_id: open ? r.user_id : null,
        user_name: open ? nameOf(r.user_id) : null,
        reject_reason: all || r.user_id === me.id ? r.reject_reason : null,
      };
    };
    return {
      ok: true,
      me: { ...me },
      profiles: copy(db.profiles.filter((p) => all || p.id === me.id || (p.role === 'officer' && p.is_active))),
      active_soldiers: db.profiles.filter((p) => p.role === 'soldier' && p.is_active).length,
      events: copy(db.events.filter((e) => e.type === 'unit' || e.author_id === me.id)),
      leave_grants: mineOrAll(db.leave_grants),
      merit_points: mineOrAll(db.merit_points),
      leave_settings: copy(db.leave_settings),
      leave_rate_periods: copy(db.leave_rate_periods),
      leave_requests: mineOrAll(db.leave_requests),
      leave_request_items: copy(db.leave_request_items.filter((i) => myRequestIds.has(i.request_id))),
      other_absences: all
        ? []
        : db.leave_requests
            .filter((r) => r.user_id !== me.id && r.status === 'requested' && r.end_date >= addDays(today, -1))
            .map((r) => ({ kind: r.kind, start_date: r.start_date, end_date: r.end_date })),
      duty_posts: copy(db.duty_posts.filter((p) => p.is_active)),
      duty_rosters: all ? copy(db.duty_rosters) : [],
      duty_overrides: all ? copy(db.duty_overrides) : [],
      duty_board: { start: boardStart, end: boardEnd, rows },
      duty_swaps: db.duty_swaps
        .filter((w) => all || w.requester_id === me.id || w.partner_id === me.id)
        .map((w) => ({ ...w, requester_name: nameOf(w.requester_id), partner_name: nameOf(w.partner_id) })),
      soldier_names: all ? [] : db.profiles.filter((p) => p.role === 'soldier' && p.is_active).map((p) => ({ id: p.id, name: p.name })),
      facilities: copy(db.facilities),
      reservations: db.reservations
        .filter((r) => all || r.user_id === me.id || (['pending', 'approved'].includes(r.status) && r.date >= addDays(today, -1)))
        .map(masked),
      facility_blocks: copy(db.facility_blocks.filter((b) => b.date >= addDays(today, -1))),
    };
  }

  window.fetch = async (url, options = {}) => {
    const u = String(url);
    if (!u.startsWith(FAKE)) return realFetch(url, options);
    const name = u.split('/rest/v1/rpc/')[1];
    const args = JSON.parse(options.body || '{}');
    window.__fakeCalls.push(name);
    // 서버로 오가는 것처럼 JSON으로 바꿔 보낸다 (날짜·객체를 그대로 넘기지 않게)
    const result = JSON.parse(JSON.stringify(await handle(name, args)));
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
})();
