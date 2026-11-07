-- Phase 5-3a: 휴가 일수와 상점 (leave_grants, merit_points)
-- 사용법: 01_members.sql, 02_events.sql을 먼저 실행한 뒤, 이 파일 내용을 SQL Editor에 모두 붙여 넣고 Run. 여러 번 실행해도 된다.
--
-- - 받은 휴가 일수(연가·포상휴가·위로휴가)와 포상 외박·외출 횟수는 leave_grants에 둔다. 간부가 승인한 것만 남은 일수에 들어간다.
-- - 상점·벌점·전환 기록은 merit_points에 둔다. 남은 상점은 저장하지 않고 합계로 매번 계산한다.
-- - 벌점은 상점을 0점까지만 깎는다. 상점 전환은 간부가 승인하는 순간 상점을 뺀다.
-- - 같은 병사의 상점을 동시에 두 번 쓰지 않도록, 상점을 바꾸는 함수는 그 병사 단위로 잠그고(advisory lock) 확인한다.
-- - 휴가·외박·외출 신청(쓴 일수)은 5-3b에서 옮긴다.

create table if not exists public.leave_grants (
  id text primary key default gen_random_uuid()::text,
  user_id text not null references public.profiles (id),
  leave_type text not null check (leave_type in ('annual', 'reward', 'consolation', 'overnight_pass', 'outing_pass')),
  days int not null check (days >= 1),
  reason text not null check (char_length(reason) between 1 and 100),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  decided_by text references public.profiles (id),
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  source text not null default 'request' check (source in ('request', 'merit')),
  merit_cost int not null default 0 check (merit_cost >= 0)
);
create index if not exists leave_grants_user_idx on public.leave_grants (user_id);

create table if not exists public.merit_points (
  id text primary key default gen_random_uuid()::text,
  user_id text not null references public.profiles (id),
  kind text not null check (kind in ('merit', 'demerit', 'conversion')),
  points int not null,
  given_points int,
  reason text not null check (char_length(reason) between 1 and 100),
  given_by text references public.profiles (id),
  grant_id text references public.leave_grants (id),
  created_at timestamptz not null default now()
);
create index if not exists merit_points_user_idx on public.merit_points (user_id);

alter table public.leave_grants enable row level security;
alter table public.merit_points enable row level security;
revoke all on public.leave_grants, public.merit_points from anon, authenticated;

-- ── 서버 안에서만 쓰는 도우미 ─────────────────────────────────

-- 상점을 무엇으로 몇 점에 바꿔 주는가. ★ js/settings.js의 MERIT_COSTS와 같아야 한다 (바꾸면 둘 다 바꾼다)
create or replace function private.merit_cost(p_target text) returns int
language sql immutable set search_path = '' as $$
  select case p_target when 'reward' then 100 when 'overnight_pass' then 100 when 'outing_pass' then 50 end;
$$;

-- 간부가 한 번에 줄 수 있는 상점·벌점. ★ js/settings.js의 MAX_POINTS_PER_ENTRY와 같아야 한다
create or replace function private.max_points_per_entry() returns int
language sql immutable set search_path = '' as $$ select 50; $$;

create or replace function private.merit_balance(p_user text) returns int
language sql stable set search_path = '' as $$
  select coalesce(sum(points), 0)::int from public.merit_points where user_id = p_user;
$$;

-- 아직 처리되지 않은 전환 요청에 걸린 상점 (같은 상점을 두 번 쓰지 못하게)
create or replace function private.pending_conversion_cost(p_user text) returns int
language sql stable set search_path = '' as $$
  select coalesce(sum(merit_cost), 0)::int from public.leave_grants
  where user_id = p_user and source = 'merit' and status = 'pending';
$$;

-- 그 병사의 상점을 바꾸는 동안 다른 요청이 끼어들지 않게 잠근다 (거래가 끝나면 풀린다)
create or replace function private.lock_merit(p_user text) returns void
language sql volatile set search_path = '' as $$
  select pg_advisory_xact_lock(hashtext('merit:' || p_user));
$$;

create or replace function private.grant_label(p_type text) returns text
language sql immutable set search_path = '' as $$
  select case p_type when 'annual' then '연가' when 'reward' then '포상휴가' when 'consolation' then '위로휴가'
    when 'overnight_pass' then '포상 외박' when 'outing_pass' then '포상 외출' end;
$$;

create or replace function private.grant_unit(p_type text) returns text
language sql immutable set search_path = '' as $$
  select case when p_type in ('overnight_pass', 'outing_pass') then '회' else '일' end;
$$;

create or replace function private.grant_json(g public.leave_grants) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'id', g.id, 'user_id', g.user_id, 'leave_type', g.leave_type, 'days', g.days, 'reason', g.reason,
    'status', g.status, 'decided_by', g.decided_by, 'requested_at', g.requested_at, 'decided_at', g.decided_at,
    'source', g.source, 'merit_cost', g.merit_cost
  );
$$;

create or replace function private.merit_json(m public.merit_points) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'id', m.id, 'user_id', m.user_id, 'kind', m.kind, 'points', m.points, 'given_points', m.given_points,
    'reason', m.reason, 'given_by', m.given_by, 'grant_id', m.grant_id, 'created_at', m.created_at
  );
$$;

-- ── 앱이 부르는 함수 ──────────────────────────────────────────

-- 5-2의 load_state에 휴가 일수·상점을 더한다. 병사는 자기 것만, 간부는 모두 받는다.
create or replace function public.load_state(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_me public.profiles := private.session_profile(p_token);
  v_all boolean;
begin
  if v_me.id is null then
    return jsonb_build_object('ok', false, 'reason', 'session');
  end if;
  v_all := v_me.role = 'officer';
  return jsonb_build_object(
    'ok', true,
    'me', private.profile_json(v_me),
    'profiles', coalesce((
      select jsonb_agg(private.profile_json(p) order by p.id) from public.profiles p
      where v_all or p.id = v_me.id or (p.role = 'officer' and p.is_active)
    ), '[]'::jsonb),
    'active_soldiers', (select count(*) from public.profiles where role = 'soldier' and is_active),
    'events', private.visible_events(v_me),
    'leave_grants', coalesce((
      select jsonb_agg(private.grant_json(g) order by g.requested_at, g.id) from public.leave_grants g
      where v_all or g.user_id = v_me.id
    ), '[]'::jsonb),
    'merit_points', coalesce((
      select jsonb_agg(private.merit_json(m) order by m.created_at, m.id) from public.merit_points m
      where v_all or m.user_id = v_me.id
    ), '[]'::jsonb)
  );
end;
$$;

-- 병사가 받은 일수(포상휴가·위로휴가)를 요청한다. 결과: { ok: true, grant } 또는 { ok: false, reason, errors }
create or replace function public.request_leave_grant(p_token text, p_leave_type text, p_days int, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_me public.profiles := private.session_profile(p_token);
  v_reason text := btrim(coalesce(p_reason, ''));
  v_errors jsonb := '{}';
  v_grant public.leave_grants;
begin
  if v_me.id is null or v_me.role <> 'soldier' then return jsonb_build_object('ok', false, 'reason', 'forbidden'); end if;
  if p_leave_type is null or p_leave_type not in ('reward', 'consolation') then
    v_errors := v_errors || '{"leave_type": "포상휴가나 위로휴가를 고르세요."}';
  end if;
  if p_days is null or p_days < 1 or p_days > 30 then v_errors := v_errors || '{"days": "일수는 1~30 사이의 숫자로 입력하세요."}'; end if;
  if v_reason = '' then v_errors := v_errors || '{"reason": "사유를 입력하세요."}';
  elsif char_length(v_reason) > 100 then v_errors := v_errors || '{"reason": "사유는 100자 이하로 입력하세요."}';
  end if;
  if v_errors <> '{}'::jsonb then return jsonb_build_object('ok', false, 'reason', 'invalid', 'errors', v_errors); end if;

  insert into public.leave_grants (user_id, leave_type, days, reason)
  values (v_me.id, p_leave_type, p_days, v_reason) returning * into v_grant;
  return jsonb_build_object('ok', true, 'grant', private.grant_json(v_grant));
end;
$$;

-- 병사가 상점을 포상휴가·포상 외박·포상 외출로 바꿔 달라고 요청한다 (간부 승인 대기)
create or replace function public.request_merit_conversion(p_token text, p_target text, p_count int) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_me public.profiles := private.session_profile(p_token);
  v_cost int;
  v_available int;
  v_unit text;
  v_grant public.leave_grants;
begin
  if v_me.id is null or v_me.role <> 'soldier' then return jsonb_build_object('ok', false, 'reason', 'forbidden'); end if;
  if p_target is null or p_target not in ('reward', 'overnight_pass', 'outing_pass') then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'errors', '{"target": "무엇으로 바꿀지 고르세요."}'::jsonb);
  end if;
  v_unit := private.grant_unit(p_target);
  if p_count is null or p_count < 1 then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'errors',
      jsonb_build_object('count', '바꿀 ' || case when v_unit = '회' then '횟수' else '일수' end || '를 1 이상의 숫자로 입력하세요.'));
  end if;
  perform private.lock_merit(v_me.id);
  v_cost := p_count * private.merit_cost(p_target);
  v_available := private.merit_balance(v_me.id) - private.pending_conversion_cost(v_me.id);
  if v_cost > v_available then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'errors', jsonb_build_object('count',
      '상점이 모자랍니다. ' || private.grant_label(p_target) || ' ' || p_count || v_unit || '에는 ' || v_cost
      || '점이 필요하고, 지금 쓸 수 있는 상점은 ' || v_available || '점입니다.'));
  end if;
  insert into public.leave_grants (user_id, leave_type, days, reason, source, merit_cost)
  values (v_me.id, p_target, p_count, '상점 ' || v_cost || '점 전환', 'merit', v_cost) returning * into v_grant;
  return jsonb_build_object('ok', true, 'grant', private.grant_json(v_grant));
end;
$$;

-- 간부가 받은 일수 요청·상점 전환 요청을 승인·반려한다. 전환은 승인하는 순간 상점을 뺀다.
-- 결과: { ok: true, grant } 또는 { ok: false, reason: forbidden | invalid | not_found | already_decided | not_enough_merit, balance }
create or replace function public.decide_leave_grant(p_token text, p_id text, p_decision text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_me public.profiles := private.session_profile(p_token);
  v_grant public.leave_grants;
  v_balance int;
begin
  if v_me.id is null or v_me.role <> 'officer' then return jsonb_build_object('ok', false, 'reason', 'forbidden'); end if;
  if p_decision is null or p_decision not in ('approve', 'reject') then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  select * into v_grant from public.leave_grants where id = p_id for update;
  if v_grant.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_grant.status <> 'pending' then return jsonb_build_object('ok', false, 'reason', 'already_decided'); end if;

  if p_decision = 'approve' and v_grant.source = 'merit' then
    perform private.lock_merit(v_grant.user_id);
    v_balance := private.merit_balance(v_grant.user_id);
    if v_balance < v_grant.merit_cost then
      return jsonb_build_object('ok', false, 'reason', 'not_enough_merit', 'balance', v_balance);
    end if;
    insert into public.merit_points (user_id, kind, points, reason, given_by, grant_id)
    values (v_grant.user_id, 'conversion', -v_grant.merit_cost,
      private.grant_label(v_grant.leave_type) || ' ' || v_grant.days || private.grant_unit(v_grant.leave_type) || '로 전환',
      v_me.id, v_grant.id);
  end if;
  update public.leave_grants set
    status = case when p_decision = 'approve' then 'approved' else 'rejected' end,
    decided_by = v_me.id, decided_at = now()
  where id = p_id returning * into v_grant;
  insert into public.audit_logs (actor_id, action, target_table, target_id)
  values (v_me.id, case when p_decision = 'approve' then 'approve_leave_grant' else 'reject_leave_grant' end, 'leave_grants', p_id);
  return jsonb_build_object('ok', true, 'grant', private.grant_json(v_grant));
end;
$$;

-- 간부가 병사에게 상점(+)·벌점(-)을 준다. 벌점은 지금 상점까지만 깎는다(0점 아래로 내려가지 않음).
-- 결과: { ok: true, entry, balance } 또는 { ok: false, reason, errors }
create or replace function public.give_points(p_token text, p_user_id text, p_kind text, p_points int, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_me public.profiles := private.session_profile(p_token);
  v_reason text := btrim(coalesce(p_reason, ''));
  v_errors jsonb := '{}';
  v_max int := private.max_points_per_entry();
  v_deducted int;
  v_entry public.merit_points;
begin
  if v_me.id is null or v_me.role <> 'officer' then return jsonb_build_object('ok', false, 'reason', 'forbidden'); end if;
  if not exists (select 1 from public.profiles where id = p_user_id and is_active and role = 'soldier') then
    v_errors := v_errors || '{"user_id": "병사를 고르세요."}';
  end if;
  if p_kind is null or p_kind not in ('merit', 'demerit') then v_errors := v_errors || '{"kind": "상점인지 벌점인지 고르세요."}'; end if;
  if p_points is null or p_points < 1 or p_points > v_max then
    v_errors := v_errors || jsonb_build_object('points', '점수는 1~' || v_max || ' 사이의 숫자로 입력하세요.');
  end if;
  if v_reason = '' then v_errors := v_errors || '{"reason": "사유를 입력하세요."}';
  elsif char_length(v_reason) > 100 then v_errors := v_errors || '{"reason": "사유는 100자 이하로 입력하세요."}';
  end if;
  if v_errors <> '{}'::jsonb then return jsonb_build_object('ok', false, 'reason', 'invalid', 'errors', v_errors); end if;

  perform private.lock_merit(p_user_id);
  v_deducted := case when p_kind = 'merit' then p_points else least(p_points, greatest(0, private.merit_balance(p_user_id))) end;
  insert into public.merit_points (user_id, kind, points, given_points, reason, given_by)
  values (p_user_id, p_kind, case when p_kind = 'merit' then p_points else -v_deducted end, p_points, v_reason, v_me.id)
  returning * into v_entry;
  insert into public.audit_logs (actor_id, action, target_table, target_id)
  values (v_me.id, case when p_kind = 'merit' then 'give_merit' else 'give_demerit' end, 'merit_points', v_entry.id);
  return jsonb_build_object('ok', true, 'entry', private.merit_json(v_entry), 'balance', private.merit_balance(p_user_id));
end;
$$;

-- 앱(공개 키)에 여는 함수
revoke execute on all functions in schema private from public, anon, authenticated;
revoke execute on function public.load_state(text) from public, anon, authenticated;
revoke execute on function public.request_leave_grant(text, text, int, text) from public, anon, authenticated;
revoke execute on function public.request_merit_conversion(text, text, int) from public, anon, authenticated;
revoke execute on function public.decide_leave_grant(text, text, text) from public, anon, authenticated;
revoke execute on function public.give_points(text, text, text, int, text) from public, anon, authenticated;
grant execute on function public.load_state(text) to anon, authenticated;
grant execute on function public.request_leave_grant(text, text, int, text) to anon, authenticated;
grant execute on function public.request_merit_conversion(text, text, int) to anon, authenticated;
grant execute on function public.decide_leave_grant(text, text, text) to anon, authenticated;
grant execute on function public.give_points(text, text, text, int, text) to anon, authenticated;

-- ── 가상 데이터 (연습용, js/mock-data.js와 같음. 일수·점수는 지어낸 값이다) ─────────
insert into public.leave_grants (id, user_id, leave_type, days, reason, status, decided_by, requested_at, decided_at, source, merit_cost) values
  ('g01', 'u01', 'annual', 24, '정기 연가', 'approved', 'o01', '2026-01-02T09:00:00.000Z', '2026-01-02T09:00:00.000Z', 'request', 0),
  ('g02', 'u02', 'annual', 24, '정기 연가', 'approved', 'o01', '2026-01-02T09:00:00.000Z', '2026-01-02T09:00:00.000Z', 'request', 0),
  ('g03', 'u03', 'annual', 24, '정기 연가', 'approved', 'o01', '2026-01-02T09:00:00.000Z', '2026-01-02T09:00:00.000Z', 'request', 0),
  ('g04', 'u04', 'annual', 24, '정기 연가', 'approved', 'o01', '2026-01-02T09:00:00.000Z', '2026-01-02T09:00:00.000Z', 'request', 0),
  ('g05', 'u05', 'annual', 24, '정기 연가', 'approved', 'o01', '2026-01-02T09:00:00.000Z', '2026-01-02T09:00:00.000Z', 'request', 0),
  ('g06', 'u06', 'annual', 24, '정기 연가', 'approved', 'o01', '2026-01-02T09:00:00.000Z', '2026-01-02T09:00:00.000Z', 'request', 0),
  ('g07', 'u07', 'annual', 24, '정기 연가', 'approved', 'o01', '2026-01-02T09:00:00.000Z', '2026-01-02T09:00:00.000Z', 'request', 0),
  ('g08', 'u08', 'annual', 24, '정기 연가', 'approved', 'o01', '2026-01-02T09:00:00.000Z', '2026-01-02T09:00:00.000Z', 'request', 0),
  ('g09', 'u09', 'annual', 24, '정기 연가', 'approved', 'o01', '2026-01-02T09:00:00.000Z', '2026-01-02T09:00:00.000Z', 'request', 0),
  ('g10', 'u10', 'annual', 24, '정기 연가', 'approved', 'o01', '2026-01-02T09:00:00.000Z', '2026-01-02T09:00:00.000Z', 'request', 0),
  ('g11', 'u11', 'annual', 24, '정기 연가', 'approved', 'o01', '2026-01-02T09:00:00.000Z', '2026-01-02T09:00:00.000Z', 'request', 0),
  ('g12', 'u12', 'annual', 24, '정기 연가', 'approved', 'o01', '2026-01-02T09:00:00.000Z', '2026-01-02T09:00:00.000Z', 'request', 0),
  ('g13', 'u13', 'annual', 24, '정기 연가', 'approved', 'o01', '2026-01-02T09:00:00.000Z', '2026-01-02T09:00:00.000Z', 'request', 0),
  ('g14', 'u14', 'annual', 24, '정기 연가', 'approved', 'o01', '2026-01-02T09:00:00.000Z', '2026-01-02T09:00:00.000Z', 'request', 0),
  ('g15', 'u15', 'annual', 24, '정기 연가', 'approved', 'o01', '2026-01-02T09:00:00.000Z', '2026-01-02T09:00:00.000Z', 'request', 0),
  ('g16', 'u16', 'annual', 24, '정기 연가', 'approved', 'o01', '2026-01-02T09:00:00.000Z', '2026-01-02T09:00:00.000Z', 'request', 0),
  ('g17', 'u17', 'annual', 24, '정기 연가', 'approved', 'o01', '2026-01-02T09:00:00.000Z', '2026-01-02T09:00:00.000Z', 'request', 0),
  ('g18', 'u18', 'annual', 24, '정기 연가', 'approved', 'o01', '2026-01-02T09:00:00.000Z', '2026-01-02T09:00:00.000Z', 'request', 0),
  ('g19', 'u19', 'annual', 24, '정기 연가', 'approved', 'o01', '2026-01-02T09:00:00.000Z', '2026-01-02T09:00:00.000Z', 'request', 0),
  ('g20', 'u20', 'annual', 24, '정기 연가', 'approved', 'o01', '2026-01-02T09:00:00.000Z', '2026-01-02T09:00:00.000Z', 'request', 0),
  ('g21', 'u01', 'reward', 3, '체육대회 우승', 'approved', 'o01', '2026-10-17T09:00:00.000Z', '2026-10-17T09:00:00.000Z', 'request', 0),
  ('g22', 'u01', 'consolation', 2, '장기 파견 위로', 'pending', null, '2026-10-20T09:00:00.000Z', null, 'request', 0),
  ('g23', 'u02', 'reward', 2, '경계 근무 유공', 'pending', null, '2026-10-21T09:00:00.000Z', null, 'request', 0),
  ('g24', 'u03', 'reward', 1, '생활관 점검 우수', 'rejected', 'o02', '2026-10-15T09:00:00.000Z', '2026-10-15T09:00:00.000Z', 'request', 0),
  ('g25', 'u01', 'outing_pass', 1, '부대 행사 지원', 'approved', 'o01', '2026-10-18T09:00:00.000Z', '2026-10-18T09:00:00.000Z', 'request', 0)
on conflict (id) do nothing;

insert into public.merit_points (id, user_id, kind, points, given_points, reason, given_by, grant_id, created_at) values
  ('m01', 'u01', 'merit', 50, 50, '환경 미화 우수', 'o01', null, '2026-09-10T09:00:00.000Z'),
  ('m02', 'u01', 'merit', 50, 50, '사격 우수', 'o02', null, '2026-10-05T09:00:00.000Z'),
  ('m03', 'u01', 'merit', 30, 30, '체력 측정 특급', 'o02', null, '2026-10-07T09:00:00.000Z'),
  ('m04', 'u01', 'demerit', -10, 10, '청소 불량', 'o01', null, '2026-10-12T09:00:00.000Z'),
  ('m05', 'u02', 'merit', 30, 30, '경계 근무 성실', 'o01', null, '2026-10-08T09:00:00.000Z'),
  ('m06', 'u03', 'merit', 50, 50, '체육대회 우승', 'o02', null, '2026-10-16T09:00:00.000Z'),
  ('m07', 'u03', 'merit', 50, 50, '생활관 점검 우수', 'o01', null, '2026-10-17T09:00:00.000Z')
on conflict (id) do nothing;
