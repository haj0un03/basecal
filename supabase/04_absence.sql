-- Phase 5-3b: 출타율과 휴가·외박·외출 신청 (leave_settings, leave_rate_periods, leave_requests, leave_request_items)
-- 사용법: 01, 02, 03 SQL을 먼저 실행한 뒤, 이 파일 내용을 SQL Editor에 모두 붙여 넣고 Run. 여러 번 실행해도 된다.
--
-- - 신청은 간부 승인 없이 바로 자리를 잡는다. 정원 확인과 저장을 서버 함수 하나에서 한 번에 한다.
--   신청 함수는 모두 같은 잠금(advisory lock)을 잡고 확인하므로, 두 사람이 동시에 마지막 자리를 신청해도 한 명만 들어간다.
-- - 하루 정원 = 활성 병사 수 × 출타율(소수점 버림). 기간별 출타율이 있으면 그 값(겹치면 낮은 값).
--   휴가는 휴가·총 출타 두 정원 모두, 외박·외출은 총 출타 정원만 본다.
-- - 병사는 자기 신청만 자세히 받고, 다른 병사의 출타는 날짜와 종류만 받는다(이름·번호 없음). 자리 수를 계산하기 위해서다.
-- - 날짜는 한국 시각 기준이다.
-- - 근무가 있는 날 막기는 근무를 서버로 옮기는 5-3c 전까지 앱(화면)에서만 확인한다.

create table if not exists public.leave_settings (
  id text primary key default gen_random_uuid()::text,
  kind text not null check (kind in ('total', 'leave')),
  rate int not null check (rate between 0 and 100),
  updated_by text references public.profiles (id),
  updated_at timestamptz not null default now()
);

create table if not exists public.leave_rate_periods (
  id text primary key default gen_random_uuid()::text,
  kind text not null check (kind in ('total', 'leave')),
  start_date date not null,
  end_date date not null check (end_date >= start_date),
  rate int not null check (rate between 0 and 100),
  created_by text references public.profiles (id),
  created_at timestamptz not null default now(),
  source_event_id text references public.events (id) on delete set null
);

create table if not exists public.leave_requests (
  id text primary key default gen_random_uuid()::text,
  user_id text not null references public.profiles (id),
  kind text not null check (kind in ('leave', 'overnight', 'outing')),
  event_id text references public.events (id) on delete set null,
  start_date date not null,
  end_date date not null check (end_date >= start_date),
  status text not null default 'requested' check (status in ('requested', 'cancelled')),
  requested_at timestamptz not null default now(),
  cancelled_at timestamptz,
  reward_pass boolean not null default false
);
create index if not exists leave_requests_dates_idx on public.leave_requests (start_date, end_date);
create index if not exists leave_requests_user_idx on public.leave_requests (user_id);

create table if not exists public.leave_request_items (
  id bigint generated always as identity primary key,
  request_id text not null references public.leave_requests (id) on delete cascade,
  leave_type text not null check (leave_type in ('annual', 'reward', 'consolation')),
  days int not null check (days >= 1)
);

alter table public.leave_settings enable row level security;
alter table public.leave_rate_periods enable row level security;
alter table public.leave_requests enable row level security;
alter table public.leave_request_items enable row level security;
revoke all on public.leave_settings, public.leave_rate_periods, public.leave_requests, public.leave_request_items from anon, authenticated;

-- ── 서버 안에서만 쓰는 도우미 ─────────────────────────────────

-- 외박·외출 횟수. ★ js/settings.js의 OVERNIGHT_PER_QUARTER, WEEKEND_OUTING_PER_QUARTER,
--   WEEKEND_ABSENCE_PER_MONTH, WEEKDAY_OUTING_PER_MONTH와 같아야 한다 (바꾸면 둘 다 바꾼다)
create or replace function private.absence_limit(p_name text) returns int
language sql immutable set search_path = '' as $$
  select case p_name when 'overnight_per_quarter' then 1 when 'weekend_outing_per_quarter' then 2
    when 'weekend_per_month' then 1 when 'weekday_outing_per_month' then 2 end;
$$;

-- 오늘 (한국 시각)
create or replace function private.today() returns date
language sql stable set search_path = '' as $$ select (now() at time zone 'Asia/Seoul')::date; $$;

-- 신청할 수 있는 마지막 날: 다음 달 같은 날 (그날이 없으면 그 달 마지막 날)
create or replace function private.apply_window_end() returns date
language sql stable set search_path = '' as $$ select (private.today() + interval '1 month')::date; $$;

create or replace function private.active_soldiers() returns int
language sql stable set search_path = '' as $$
  select count(*)::int from public.profiles where role = 'soldier' and is_active;
$$;

-- 그날 출타율. 기간별 출타율이 있으면 그중 낮은 값, 없으면 가장 최근 기본값, 둘 다 없으면 null(제한 없음)
create or replace function private.rate_on(p_kind text, p_date date) returns int
language sql stable set search_path = '' as $$
  select coalesce(
    (select min(rate) from public.leave_rate_periods where kind = p_kind and p_date between start_date and end_date),
    (select rate from public.leave_settings where kind = p_kind order by updated_at desc, id desc limit 1)
  );
$$;

-- 그날 정원 (null이면 제한 없음)
create or replace function private.capacity_on(p_kind text, p_date date) returns int
language sql stable set search_path = '' as $$
  select case when private.rate_on(p_kind, p_date) is null then null
    else floor(private.active_soldiers() * private.rate_on(p_kind, p_date) / 100.0)::int end;
$$;

-- 그날 걸친 신청 수. total이면 휴가·외박·외출 모두, leave면 휴가만
create or replace function private.count_on(p_kind text, p_date date) returns int
language sql stable set search_path = '' as $$
  select count(*)::int from public.leave_requests
  where status = 'requested' and p_date between start_date and end_date
    and (p_kind = 'total' or kind = 'leave');
$$;

-- 기간 중 더 신청할 수 없는 날짜 (휴가는 휴가·총 출타, 외박·외출은 총 출타)
create or replace function private.full_dates(p_request_kind text, p_start date, p_end date) returns date[]
language sql stable set search_path = '' as $$
  select coalesce(array_agg(d::date order by d), '{}') from generate_series(p_start::timestamp, p_end::timestamp, interval '1 day') d
  where (private.capacity_on('total', d::date) is not null
         and private.count_on('total', d::date) >= private.capacity_on('total', d::date))
     or (p_request_kind = 'leave' and private.capacity_on('leave', d::date) is not null
         and private.count_on('leave', d::date) >= private.capacity_on('leave', d::date));
$$;

-- 날짜를 "11/12"처럼
create or replace function private.md(p_date date) returns text
language sql immutable set search_path = '' as $$
  select extract(month from p_date)::int || '/' || extract(day from p_date)::int;
$$;

-- 휴가·외박·외출 공통 날짜 확인. 문제가 있으면 안내 문구, 없으면 null (화면의 안내와 같다)
create or replace function private.absence_date_error(p_user text, p_kind text, p_start date, p_end date) returns text
language plpgsql stable set search_path = '' as $$
declare
  v_overlap public.leave_requests;
  v_full date[];
begin
  if p_start is null or p_end is null then return '출발일과 복귀일을 고르세요.'; end if;
  if p_end < p_start then return '복귀일은 출발일과 같거나 뒤여야 합니다.'; end if;
  if p_start < private.today() or p_end > private.apply_window_end() then
    return '오늘부터 한 달 이내(' || private.today() || ' ~ ' || private.apply_window_end() || ')의 날짜만 신청할 수 있습니다.';
  end if;
  select * into v_overlap from public.leave_requests
  where user_id = p_user and status = 'requested' and start_date <= p_end and end_date >= p_start limit 1;
  if v_overlap.id is not null then
    return '이미 신청한 출타(' || v_overlap.start_date || ' ~ ' || v_overlap.end_date || ')와 날짜가 겹칩니다.';
  end if;
  v_full := private.full_dates(p_kind, p_start, p_end);
  if array_length(v_full, 1) > 0 then
    return '마감된 날짜가 있어 신청할 수 없습니다: ' || (select string_agg(private.md(x), ', ') from unnest(v_full) x);
  end if;
  return null;
end;
$$;

-- 외박·외출 횟수 확인 (포상으로 쓰면 확인하지 않는다). 문제가 있으면 안내 문구, 없으면 null
create or replace function private.absence_quota_error(p_user text, p_kind text, p_start date) returns text
language plpgsql stable set search_path = '' as $$
declare
  v_q_start date := date_trunc('quarter', p_start::timestamp)::date;
  v_q_end date := (date_trunc('quarter', p_start::timestamp) + interval '3 months' - interval '1 day')::date;
  v_m_start date := date_trunc('month', p_start::timestamp)::date;
  v_m_end date := (date_trunc('month', p_start::timestamp) + interval '1 month' - interval '1 day')::date;
  v_q_label text := extract(month from v_q_start)::int || '~' || extract(month from v_q_end)::int || '월';
  v_m_label text := extract(month from p_start)::int || '월';
  v_weekend boolean := extract(dow from p_start) in (0, 6);
  v_count int;
begin
  if p_kind = 'overnight' or v_weekend then
    if p_kind = 'overnight' then
      select count(*) into v_count from public.leave_requests where user_id = p_user and status = 'requested' and not reward_pass
        and kind = 'overnight' and start_date between v_q_start and v_q_end;
      if v_count >= private.absence_limit('overnight_per_quarter') then
        return '이번 분기(' || v_q_label || ') 외박 ' || private.absence_limit('overnight_per_quarter') || '회를 이미 썼습니다.';
      end if;
    else
      select count(*) into v_count from public.leave_requests where user_id = p_user and status = 'requested' and not reward_pass
        and kind = 'outing' and extract(dow from start_date) in (0, 6) and start_date between v_q_start and v_q_end;
      if v_count >= private.absence_limit('weekend_outing_per_quarter') then
        return '이번 분기(' || v_q_label || ') 주말 외출 ' || private.absence_limit('weekend_outing_per_quarter') || '회를 모두 썼습니다.';
      end if;
    end if;
    -- 그 달의 외박 + 주말 외출 (휴가는 세지 않는다)
    select count(*) into v_count from public.leave_requests where user_id = p_user and status = 'requested' and not reward_pass
      and (kind = 'overnight' or (kind = 'outing' and extract(dow from start_date) in (0, 6)))
      and start_date between v_m_start and v_m_end;
    if v_count >= private.absence_limit('weekend_per_month') then
      return v_m_label || '에 이미 외박이나 주말 외출을 썼습니다. 외박·주말 외출은 한 달에 '
        || private.absence_limit('weekend_per_month') || '개만 쓸 수 있습니다.';
    end if;
    return null;
  end if;
  select count(*) into v_count from public.leave_requests where user_id = p_user and status = 'requested' and not reward_pass
    and kind = 'outing' and extract(dow from start_date) not in (0, 6) and start_date between v_m_start and v_m_end;
  if v_count >= private.absence_limit('weekday_outing_per_month') then
    return v_m_label || ' 평일 외출 ' || private.absence_limit('weekday_outing_per_month') || '회를 모두 썼습니다.';
  end if;
  return null;
end;
$$;

-- 신청을 한 번에 하나씩 처리한다 (정원 확인과 저장 사이에 다른 신청이 끼어들지 않게)
create or replace function private.lock_absence() returns void
language sql volatile set search_path = '' as $$ select pg_advisory_xact_lock(hashtext('absence')); $$;

create or replace function private.request_json(r public.leave_requests) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', r.id, 'user_id', r.user_id, 'kind', r.kind, 'event_id', r.event_id,
    'start_date', r.start_date, 'end_date', r.end_date, 'status', r.status,
    'requested_at', r.requested_at, 'cancelled_at', r.cancelled_at, 'reward_pass', r.reward_pass
  );
$$;

-- ── 앱이 부르는 함수 ──────────────────────────────────────────

-- 5-3a의 load_state에 출타율·출타 신청을 더한다.
-- 병사: 자기 신청(자세히) + 다른 병사 출타는 날짜·종류만(other_absences). 간부: 모든 신청.
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
    'active_soldiers', private.active_soldiers(),
    'events', private.visible_events(v_me),
    'leave_grants', coalesce((
      select jsonb_agg(private.grant_json(g) order by g.requested_at, g.id) from public.leave_grants g
      where v_all or g.user_id = v_me.id
    ), '[]'::jsonb),
    'merit_points', coalesce((
      select jsonb_agg(private.merit_json(m) order by m.created_at, m.id) from public.merit_points m
      where v_all or m.user_id = v_me.id
    ), '[]'::jsonb),
    'leave_settings', coalesce((
      select jsonb_agg(jsonb_build_object('id', s.id, 'kind', s.kind, 'rate', s.rate, 'updated_by', s.updated_by, 'updated_at', s.updated_at)
        order by s.updated_at, s.id) from public.leave_settings s
    ), '[]'::jsonb),
    'leave_rate_periods', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'kind', p.kind, 'start_date', p.start_date, 'end_date', p.end_date, 'rate', p.rate,
        'created_by', p.created_by, 'created_at', p.created_at, 'source_event_id', p.source_event_id) order by p.start_date, p.id)
      from public.leave_rate_periods p
    ), '[]'::jsonb),
    'leave_requests', coalesce((
      select jsonb_agg(private.request_json(r) order by r.requested_at, r.id) from public.leave_requests r
      where v_all or r.user_id = v_me.id
    ), '[]'::jsonb),
    'leave_request_items', coalesce((
      select jsonb_agg(jsonb_build_object('request_id', i.request_id, 'leave_type', i.leave_type, 'days', i.days) order by i.id)
      from public.leave_request_items i join public.leave_requests r on r.id = i.request_id
      where v_all or r.user_id = v_me.id
    ), '[]'::jsonb),
    'other_absences', case when v_all then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object('kind', r.kind, 'start_date', r.start_date, 'end_date', r.end_date) order by r.start_date)
      from public.leave_requests r
      where r.user_id <> v_me.id and r.status = 'requested' and r.end_date >= private.today() - 1
    ), '[]'::jsonb) end
  );
end;
$$;

-- 휴가 신청 (병사만). 종류별 일수의 합 = 기간 일수(출발·복귀일 포함), 남은 일수 안에서.
-- 결과: { ok: true, request } 또는 { ok: false, reason: forbidden | invalid, errors: { dates, items } }
create or replace function public.apply_leave(p_token text, p_start_date text, p_end_date text, p_annual int, p_reward int, p_consolation int) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_me public.profiles := private.session_profile(p_token);
  v_start date := private.to_date_or_null(p_start_date);
  v_end date := private.to_date_or_null(coalesce(nullif(p_end_date, ''), p_start_date));
  v_items jsonb := jsonb_build_object('annual', coalesce(p_annual, 0), 'reward', coalesce(p_reward, 0), 'consolation', coalesce(p_consolation, 0));
  v_error text;
  v_total int;
  v_sum int;
  v_short text;
  v_event public.events;
  v_request public.leave_requests;
begin
  if v_me.id is null or v_me.role <> 'soldier' then return jsonb_build_object('ok', false, 'reason', 'forbidden'); end if;
  if coalesce(p_annual, 0) < 0 or coalesce(p_reward, 0) < 0 or coalesce(p_consolation, 0) < 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'errors', '{"items": "종류별 일수는 0 이상의 숫자로 입력하세요."}'::jsonb);
  end if;
  perform private.lock_absence();
  v_error := private.absence_date_error(v_me.id, 'leave', v_start, v_end);
  if v_error is not null then return jsonb_build_object('ok', false, 'reason', 'invalid', 'errors', jsonb_build_object('dates', v_error)); end if;

  v_total := v_end - v_start + 1;
  v_sum := coalesce(p_annual, 0) + coalesce(p_reward, 0) + coalesce(p_consolation, 0);
  if v_sum <> v_total then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'errors',
      jsonb_build_object('items', '종류별 일수의 합(' || v_sum || '일)이 휴가 기간(' || v_total || '일)과 같아야 합니다.'));
  end if;
  -- 남은 일수 = 승인된 받은 일수 − 신청된 휴가의 사용 일수
  select string_agg(private.grant_label(t.type) || ' ' || (t.want - t.remaining) || '일 부족 (남은 ' || t.remaining || '일)', ', ' order by t.ord)
  into v_short
  from (
    select x.type, x.ord, (v_items ->> x.type)::int as want,
      coalesce((select sum(days) from public.leave_grants where user_id = v_me.id and leave_type = x.type and status = 'approved'), 0)
      - coalesce((select sum(i.days) from public.leave_request_items i join public.leave_requests r on r.id = i.request_id
          where r.user_id = v_me.id and r.status = 'requested' and r.kind = 'leave' and i.leave_type = x.type), 0) as remaining
    from (values ('annual', 1), ('reward', 2), ('consolation', 3)) x(type, ord)
  ) t
  where t.want > t.remaining;
  if v_short is not null then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'errors', jsonb_build_object('items', v_short));
  end if;

  insert into public.events (type, title, start_date, end_date, author_id) values ('leave', '휴가', v_start, v_end, v_me.id) returning * into v_event;
  insert into public.leave_requests (user_id, kind, event_id, start_date, end_date)
  values (v_me.id, 'leave', v_event.id, v_start, v_end) returning * into v_request;
  insert into public.leave_request_items (request_id, leave_type, days)
  select v_request.id, x.type, (v_items ->> x.type)::int from (values ('annual'), ('reward'), ('consolation')) x(type)
  where (v_items ->> x.type)::int > 0;
  return jsonb_build_object('ok', true, 'request', private.request_json(v_request));
end;
$$;

-- 외박·외출 신청 (병사만). 외출은 하루, 외박은 토요일 출발 → 일요일 복귀. 포상으로 쓰면 횟수 제한 대신 포상 1회를 쓴다.
create or replace function public.apply_absence(p_token text, p_kind text, p_start_date text, p_use_pass boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_me public.profiles := private.session_profile(p_token);
  v_start date := private.to_date_or_null(p_start_date);
  v_end date;
  v_label text := case p_kind when 'overnight' then '외박' when 'outing' then '외출' end;
  v_pass text := case p_kind when 'overnight' then 'overnight_pass' when 'outing' then 'outing_pass' end;
  v_error text;
  v_left int;
  v_event public.events;
  v_request public.leave_requests;
begin
  if v_me.id is null or v_me.role <> 'soldier' then return jsonb_build_object('ok', false, 'reason', 'forbidden'); end if;
  if v_label is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'errors', '{"kind": "외박인지 외출인지 고르세요."}'::jsonb);
  end if;
  if p_kind = 'overnight' and (v_start is null or extract(dow from v_start) <> 6) then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'errors', '{"dates": "외박은 토요일 출발, 일요일 복귀(1박 2일)만 신청할 수 있습니다."}'::jsonb);
  end if;
  v_end := case when p_kind = 'overnight' then v_start + 1 else v_start end;
  perform private.lock_absence();
  v_error := coalesce(private.absence_date_error(v_me.id, p_kind, v_start, v_end),
    case when coalesce(p_use_pass, false) then null else private.absence_quota_error(v_me.id, p_kind, v_start) end);
  if v_error is not null then return jsonb_build_object('ok', false, 'reason', 'invalid', 'errors', jsonb_build_object('dates', v_error)); end if;
  if coalesce(p_use_pass, false) then
    v_left := coalesce((select sum(days) from public.leave_grants where user_id = v_me.id and leave_type = v_pass and status = 'approved'), 0)
      - (select count(*) from public.leave_requests where user_id = v_me.id and kind = p_kind and status = 'requested' and reward_pass);
    if v_left < 1 then
      return jsonb_build_object('ok', false, 'reason', 'invalid', 'errors', jsonb_build_object('use_pass', '남은 포상 ' || v_label || '이 없습니다.'));
    end if;
  end if;

  insert into public.events (type, title, start_date, end_date, author_id) values (p_kind, v_label, v_start, v_end, v_me.id) returning * into v_event;
  insert into public.leave_requests (user_id, kind, event_id, start_date, end_date, reward_pass)
  values (v_me.id, p_kind, v_event.id, v_start, v_end, coalesce(p_use_pass, false)) returning * into v_request;
  return jsonb_build_object('ok', true, 'request', private.request_json(v_request));
end;
$$;

-- 내 출타 취소 (본인만). 신청 기록은 남기고 달력 일정만 지운다. 자리와 일수·포상이 되돌아온다.
create or replace function public.cancel_leave_request(p_token text, p_id text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_me public.profiles := private.session_profile(p_token);
  v_request public.leave_requests;
begin
  if v_me.id is null then return jsonb_build_object('ok', false, 'reason', 'forbidden'); end if;
  select * into v_request from public.leave_requests where id = p_id and user_id = v_me.id for update;
  if v_request.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_request.status <> 'requested' then return jsonb_build_object('ok', false, 'reason', 'already_cancelled'); end if;
  update public.leave_requests set status = 'cancelled', cancelled_at = now() where id = p_id returning * into v_request;
  if v_request.event_id is not null then delete from public.events where id = v_request.event_id; end if;
  return jsonb_build_object('ok', true, 'request', private.request_json(v_request));
end;
$$;

-- 기본 출타율 (간부만). 휴가 비율은 총 출타 비율보다 클 수 없다. 바뀐 것만 기록한다.
create or replace function public.set_default_rates(p_token text, p_total int, p_leave int) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_me public.profiles := private.session_profile(p_token);
  v_errors jsonb := '{}';
  v_changed jsonb := '[]';
  v_id text;
begin
  if v_me.id is null or v_me.role <> 'officer' then return jsonb_build_object('ok', false, 'reason', 'forbidden'); end if;
  if p_total is null or p_total < 0 or p_total > 100 then v_errors := v_errors || '{"total": "출타율은 0~100 사이의 정수로 입력하세요."}'; end if;
  if p_leave is null or p_leave < 0 or p_leave > 100 then v_errors := v_errors || '{"leave": "출타율은 0~100 사이의 정수로 입력하세요."}'; end if;
  if v_errors = '{}'::jsonb and p_leave > p_total then
    v_errors := jsonb_build_object('leave', '휴가는 총 출타에 포함되므로 휴가 비율(' || p_leave || '%)이 총 출타 비율(' || p_total || '%)보다 클 수 없습니다.');
  end if;
  if v_errors <> '{}'::jsonb then return jsonb_build_object('ok', false, 'reason', 'invalid', 'errors', v_errors); end if;
  if p_total is distinct from (select rate from public.leave_settings where kind = 'total' order by updated_at desc, id desc limit 1) then
    insert into public.leave_settings (kind, rate, updated_by) values ('total', p_total, v_me.id) returning id into v_id;
    insert into public.audit_logs (actor_id, action, target_table, target_id) values (v_me.id, 'set_leave_rate', 'leave_settings', v_id);
    v_changed := v_changed || '["total"]';
  end if;
  if p_leave is distinct from (select rate from public.leave_settings where kind = 'leave' order by updated_at desc, id desc limit 1) then
    insert into public.leave_settings (kind, rate, updated_by) values ('leave', p_leave, v_me.id) returning id into v_id;
    insert into public.audit_logs (actor_id, action, target_table, target_id) values (v_me.id, 'set_leave_rate', 'leave_settings', v_id);
    v_changed := v_changed || '["leave"]';
  end if;
  return jsonb_build_object('ok', true, 'changed', v_changed);
end;
$$;

-- 기간별 출타율 넣기·지우기 (간부만)
create or replace function public.add_rate_period(p_token text, p_kind text, p_start_date text, p_end_date text, p_rate int) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_me public.profiles := private.session_profile(p_token);
  v_start date := private.to_date_or_null(p_start_date);
  v_end date := private.to_date_or_null(coalesce(nullif(p_end_date, ''), p_start_date));
  v_errors jsonb := '{}';
  v_id text;
begin
  if v_me.id is null or v_me.role <> 'officer' then return jsonb_build_object('ok', false, 'reason', 'forbidden'); end if;
  if p_kind is null or p_kind not in ('total', 'leave') then v_errors := v_errors || '{"kind": "총 출타인지 휴가인지 고르세요."}'; end if;
  if v_start is null then v_errors := v_errors || '{"start_date": "시작 날짜를 입력하세요."}';
  elsif v_end is null or v_end < v_start then v_errors := v_errors || '{"end_date": "끝나는 날짜는 시작 날짜와 같거나 뒤여야 합니다."}';
  end if;
  if p_rate is null or p_rate < 0 or p_rate > 100 then v_errors := v_errors || '{"rate": "출타율은 0~100 사이의 정수로 입력하세요."}'; end if;
  if v_errors <> '{}'::jsonb then return jsonb_build_object('ok', false, 'reason', 'invalid', 'errors', v_errors); end if;
  insert into public.leave_rate_periods (kind, start_date, end_date, rate, created_by) values (p_kind, v_start, v_end, p_rate, v_me.id) returning id into v_id;
  insert into public.audit_logs (actor_id, action, target_table, target_id) values (v_me.id, 'add_rate_period', 'leave_rate_periods', v_id);
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.delete_rate_period(p_token text, p_id text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_me public.profiles := private.session_profile(p_token);
begin
  if v_me.id is null or v_me.role <> 'officer' then return jsonb_build_object('ok', false, 'reason', 'forbidden'); end if;
  delete from public.leave_rate_periods where id = p_id;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  insert into public.audit_logs (actor_id, action, target_table, target_id) values (v_me.id, 'delete_rate_period', 'leave_rate_periods', p_id);
  return jsonb_build_object('ok', true);
end;
$$;

-- 훈련 기간 출타율 0% (간부만). 훈련 부대 일정과 연결한다. 이미 연결된 것이 있으면 새 기간으로 바꾼다.
create or replace function public.set_training_rate(p_token text, p_event_id text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_me public.profiles := private.session_profile(p_token);
  v_event public.events;
begin
  if v_me.id is null or v_me.role <> 'officer' then return jsonb_build_object('ok', false, 'reason', 'forbidden'); end if;
  select * into v_event from public.events where id = p_event_id and type = 'unit' and unit_category = 'training';
  if v_event.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  delete from public.leave_rate_periods where source_event_id = p_event_id;
  insert into public.leave_rate_periods (kind, start_date, end_date, rate, created_by, source_event_id)
  select k, v_event.start_date, v_event.end_date, 0, v_me.id, p_event_id from unnest(array['total', 'leave']) k;
  insert into public.audit_logs (actor_id, action, target_table, target_id) values (v_me.id, 'set_training_rate', 'leave_rate_periods', p_event_id);
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.remove_training_rate(p_token text, p_event_id text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_me public.profiles := private.session_profile(p_token);
begin
  if v_me.id is null or v_me.role <> 'officer' then return jsonb_build_object('ok', false, 'reason', 'forbidden'); end if;
  delete from public.leave_rate_periods where source_event_id = p_event_id;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  insert into public.audit_logs (actor_id, action, target_table, target_id) values (v_me.id, 'remove_training_rate', 'leave_rate_periods', p_event_id);
  return jsonb_build_object('ok', true);
end;
$$;

-- 앱(공개 키)에 여는 함수
revoke execute on all functions in schema private from public, anon, authenticated;
revoke execute on function public.load_state(text) from public, anon, authenticated;
revoke execute on function public.apply_leave(text, text, text, int, int, int) from public, anon, authenticated;
revoke execute on function public.apply_absence(text, text, text, boolean) from public, anon, authenticated;
revoke execute on function public.cancel_leave_request(text, text) from public, anon, authenticated;
revoke execute on function public.set_default_rates(text, int, int) from public, anon, authenticated;
revoke execute on function public.add_rate_period(text, text, text, text, int) from public, anon, authenticated;
revoke execute on function public.delete_rate_period(text, text) from public, anon, authenticated;
revoke execute on function public.set_training_rate(text, text) from public, anon, authenticated;
revoke execute on function public.remove_training_rate(text, text) from public, anon, authenticated;
grant execute on function public.load_state(text) to anon, authenticated;
grant execute on function public.apply_leave(text, text, text, int, int, int) to anon, authenticated;
grant execute on function public.apply_absence(text, text, text, boolean) to anon, authenticated;
grant execute on function public.cancel_leave_request(text, text) to anon, authenticated;
grant execute on function public.set_default_rates(text, int, int) to anon, authenticated;
grant execute on function public.add_rate_period(text, text, text, text, int) to anon, authenticated;
grant execute on function public.delete_rate_period(text, text) to anon, authenticated;
grant execute on function public.set_training_rate(text, text) to anon, authenticated;
grant execute on function public.remove_training_rate(text, text) to anon, authenticated;

-- ── 가상 데이터 (연습용, js/mock-data.js와 같음. 지어낸 신청이다) ─────────
-- 출타율: 총 출타 35%, 휴가 20% (사용자 확정 값)
insert into public.leave_settings (id, kind, rate, updated_by, updated_at) values
  ('s01', 'total', 35, 'o01', '2026-10-01T09:00:00.000Z'),
  ('s02', 'leave', 20, 'o01', '2026-10-01T09:00:00.000Z')
on conflict (id) do nothing;

-- 11/12~13 휴가 4명(휴가 마감), 11/5~6 휴가 1명
insert into public.events (id, type, title, start_date, end_date, author_id) values
  ('e04', 'leave', '휴가', '2026-11-12', '2026-11-13', 'u05'),
  ('e05', 'leave', '휴가', '2026-11-12', '2026-11-13', 'u06'),
  ('e06', 'leave', '휴가', '2026-11-12', '2026-11-13', 'u07'),
  ('e07', 'leave', '휴가', '2026-11-12', '2026-11-13', 'u08'),
  ('e08', 'leave', '휴가', '2026-11-05', '2026-11-06', 'u10')
on conflict (id) do nothing;

insert into public.leave_requests (id, user_id, kind, event_id, start_date, end_date, status, requested_at) values
  ('r01', 'u05', 'leave', 'e04', '2026-11-12', '2026-11-13', 'requested', '2026-10-20T09:00:00.000Z'),
  ('r02', 'u06', 'leave', 'e05', '2026-11-12', '2026-11-13', 'requested', '2026-10-20T09:00:00.000Z'),
  ('r03', 'u07', 'leave', 'e06', '2026-11-12', '2026-11-13', 'requested', '2026-10-20T09:00:00.000Z'),
  ('r04', 'u08', 'leave', 'e07', '2026-11-12', '2026-11-13', 'requested', '2026-10-20T09:00:00.000Z'),
  ('r05', 'u10', 'leave', 'e08', '2026-11-05', '2026-11-06', 'requested', '2026-10-21T09:00:00.000Z')
on conflict (id) do nothing;

insert into public.leave_request_items (request_id, leave_type, days)
select x.request_id, 'annual', 2 from (values ('r01'), ('r02'), ('r03'), ('r04'), ('r05')) x(request_id)
where not exists (select 1 from public.leave_request_items i where i.request_id = x.request_id);
