-- Phase 5-4: 시설 예약 (facilities, reservations, facility_blocks)
-- 사용법: 01~05 SQL을 먼저 실행한 뒤, 이 파일 내용을 SQL Editor에 모두 붙여 넣고 Run. 여러 번 실행해도 된다.
--
-- - 시설 7곳, 모두 09:00~21:00, 1시간 단위, 한 번에 최대 2시간, 오늘부터 2주, 한 사람 하루 1건.
-- - 먼저 신청한 사람만 받는다: 신청 함수는 잠금을 잡고 겹침을 확인한 뒤 저장하므로, 같은 시간을 동시에 눌러도 한 명만 들어간다.
-- - 간부가 승인하면 확정, 반려하면 사유를 남긴다. 반려·취소되면 그 시간대는 다시 열린다.
-- - 간부가 막아 둔 시간(facility_blocks)은 신청할 수 없다. 대기·승인된 예약이 있는 시간은 막을 수 없다(먼저 반려).
-- - 출타 중인 날은 예약할 수 없다. 시각은 한국 시각 기준이다.
-- - 병사는 다른 사람의 대기 중인 신청을 이름 없이 받는다("신청 중"). 승인된 예약은 이름과 함께 보인다(PRD).

create table if not exists public.facilities (
  id text primary key,
  name text not null,
  building text not null,
  kind text not null check (kind in ('futsal', 'tennis', 'field', 'gym')),
  open_time text not null check (open_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  close_time text not null check (close_time ~ '^([01][0-9]|2[0-4]):[0-5][0-9]$'),
  slot_minutes int not null default 60,
  map_row int not null,
  map_col int not null,
  map_span int not null default 1
);

create table if not exists public.reservations (
  id text primary key default gen_random_uuid()::text,
  facility_id text not null references public.facilities (id),
  user_id text not null references public.profiles (id),
  date date not null,
  start_time text not null check (start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  end_time text not null check (end_time ~ '^([01][0-9]|2[0-4]):[0-5][0-9]$'),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  reject_reason text,
  decided_by text references public.profiles (id),
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  cancelled_at timestamptz
);
create index if not exists reservations_date_idx on public.reservations (facility_id, date);

create table if not exists public.facility_blocks (
  id text primary key default gen_random_uuid()::text,
  facility_id text references public.facilities (id),
  date date not null,
  start_time text,
  end_time text,
  reason text not null check (char_length(reason) between 1 and 50),
  created_by text references public.profiles (id),
  created_at timestamptz not null default now()
);

alter table public.facilities enable row level security;
alter table public.reservations enable row level security;
alter table public.facility_blocks enable row level security;
revoke all on public.facilities, public.reservations, public.facility_blocks from anon, authenticated;

-- ── 서버 안에서만 쓰는 도우미 ─────────────────────────────────

-- 예약 기준 값. ★ js/settings.js의 RESERVATION_DAYS_AHEAD, MAX_RESERVATION_HOURS, RESERVATIONS_PER_DAY와 같아야 한다
create or replace function private.reservation_limit(p_name text) returns int
language sql immutable set search_path = '' as $$
  select case p_name when 'days_ahead' then 14 when 'max_hours' then 2 when 'per_day' then 1 end;
$$;

create or replace function private.minutes(p_time text) returns int
language sql immutable set search_path = '' as $$
  select split_part(p_time, ':', 1)::int * 60 + split_part(p_time, ':', 2)::int;
$$;

create or replace function private.hhmm(p_minutes int) returns text
language sql immutable set search_path = '' as $$
  select lpad((p_minutes / 60)::text, 2, '0') || ':' || lpad((p_minutes % 60)::text, 2, '0');
$$;

-- 지금 한국 시각의 분 (오늘 이미 시작한 시간대를 막기 위해)
create or replace function private.now_minutes() returns int
language sql stable set search_path = '' as $$
  select extract(hour from now() at time zone 'Asia/Seoul')::int * 60 + extract(minute from now() at time zone 'Asia/Seoul')::int;
$$;

create or replace function private.facility_label(p_id text) returns text
language sql stable set search_path = '' as $$
  select coalesce((select name || '(' || building || ')' from public.facilities where id = p_id), '(없어진 시설)');
$$;

create or replace function private.lock_facility() returns void
language sql volatile set search_path = '' as $$ select pg_advisory_xact_lock(hashtext('facility')); $$;

-- 예약 한 건. p_viewer가 간부이거나 본인이면 모두, 아니면 대기 중인 신청은 이름·번호를 뺀다
create or replace function private.reservation_json(r public.reservations, p_viewer public.profiles) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', r.id, 'facility_id', r.facility_id,
    'user_id', case when p_viewer.role = 'officer' or r.user_id = p_viewer.id or r.status = 'approved' then r.user_id end,
    'user_name', case when p_viewer.role = 'officer' or r.user_id = p_viewer.id or r.status = 'approved'
      then (select name from public.profiles where id = r.user_id) end,
    'date', r.date, 'start_time', r.start_time, 'end_time', r.end_time, 'status', r.status,
    'reject_reason', case when p_viewer.role = 'officer' or r.user_id = p_viewer.id then r.reject_reason end,
    'decided_by', r.decided_by, 'requested_at', r.requested_at, 'decided_at', r.decided_at, 'cancelled_at', r.cancelled_at
  );
$$;

-- ── 앱이 부르는 함수 ──────────────────────────────────────────

-- 5-3c까지의 load_state 내용 (인원·일정·휴가·상점·출타·근무). 이 파일부터는 여기에 새 부분을 더해 load_state를 만든다
create or replace function private.load_state_base(v_me public.profiles) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_all boolean := v_me.role = 'officer';
begin
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
    ), '[]'::jsonb) end,
    'duty_posts', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'slots', to_jsonb(p.slots), 'start_date', p.start_date, 'is_active', p.is_active) order by p.id)
      from public.duty_posts p where p.is_active
    ), '[]'::jsonb),
    'duty_rosters', case when v_all then coalesce((
      select jsonb_agg(jsonb_build_object('post_id', r.post_id, 'user_id', r.user_id, 'order', r.order_no) order by r.post_id, r.order_no)
      from public.duty_rosters r
    ), '[]'::jsonb) else '[]'::jsonb end,
    'duty_overrides', case when v_all then coalesce((
      select jsonb_agg(jsonb_build_object('post_id', o.post_id, 'date', o.date, 'slot', o.slot, 'user_id', o.user_id, 'source', o.source,
        'changed_by', o.changed_by, 'changed_at', o.changed_at))
      from public.duty_overrides o where o.date >= private.today() - 31
    ), '[]'::jsonb) else '[]'::jsonb end,
    'duty_board', jsonb_build_object(
      'start', private.today() - 31,
      'end', private.apply_window_end() + 1,
      'rows', coalesce((
        select jsonb_agg(jsonb_build_object('post_id', p.id, 'date', d::date, 'slot', x.slot, 'user_id', x.user_id,
          'name', pr.name, 'source', x.source) order by p.id, d, x.slot)
        from generate_series((private.today() - 31)::timestamp, (private.apply_window_end() + 1)::timestamp, interval '1 day') d
        cross join public.duty_posts p
        cross join lateral private.post_day(p, d::date) x
        left join public.profiles pr on pr.id = x.user_id
        where p.is_active
      ), '[]'::jsonb)
    ),
    'duty_swaps', coalesce((
      select jsonb_agg(private.swap_json(w) order by w.requested_at, w.id) from public.duty_swaps w
      where v_all or w.requester_id = v_me.id or w.partner_id = v_me.id
    ), '[]'::jsonb),
    'soldier_names', case when v_all then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name) order by p.name)
      from public.profiles p where p.role = 'soldier' and p.is_active
    ), '[]'::jsonb) end
  );
end;
$$;

-- 5-3c의 load_state(private.load_state_base)에 시설을 더한다
create or replace function public.load_state(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_me public.profiles := private.session_profile(p_token);
  v_all boolean;
  v_base jsonb;
begin
  if v_me.id is null then
    return jsonb_build_object('ok', false, 'reason', 'session');
  end if;
  v_all := v_me.role = 'officer';
  v_base := private.load_state_base(v_me);
  return v_base || jsonb_build_object(
    'facilities', coalesce((
      select jsonb_agg(jsonb_build_object('id', f.id, 'name', f.name, 'building', f.building, 'kind', f.kind,
        'open_time', f.open_time, 'close_time', f.close_time, 'slot_minutes', f.slot_minutes,
        'map_row', f.map_row, 'map_col', f.map_col, 'map_span', f.map_span) order by f.id)
      from public.facilities f
    ), '[]'::jsonb),
    -- 간부: 모든 예약 / 병사: 내 예약 전부 + 다른 사람의 대기·승인 예약(어제부터)
    'reservations', coalesce((
      select jsonb_agg(private.reservation_json(r, v_me) order by r.date, r.start_time, r.id) from public.reservations r
      where v_all or r.user_id = v_me.id or (r.status in ('pending', 'approved') and r.date >= private.today() - 1)
    ), '[]'::jsonb),
    'facility_blocks', coalesce((
      select jsonb_agg(jsonb_build_object('id', b.id, 'facility_id', b.facility_id, 'date', b.date, 'start_time', b.start_time,
        'end_time', b.end_time, 'reason', b.reason, 'created_by', b.created_by, 'created_at', b.created_at) order by b.date, b.id)
      from public.facility_blocks b where b.date >= private.today() - 1
    ), '[]'::jsonb)
  );
end;
$$;

-- 예약 신청 (병사·간부 모두). p_hours: 1~2
create or replace function public.request_reservation(p_token text, p_facility_id text, p_date text, p_start_time text, p_hours int) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_me public.profiles := private.session_profile(p_token);
  v_f public.facilities;
  v_date date := private.to_date_or_null(p_date);
  v_end_day date := private.today() + private.reservation_limit('days_ahead');
  v_start int;
  v_end int;
  v_mine public.reservations;
  v_block public.facility_blocks;
  v_res public.reservations;
  v_max int := private.reservation_limit('max_hours');
begin
  if v_me.id is null then return jsonb_build_object('ok', false, 'reason', 'forbidden'); end if;
  select * into v_f from public.facilities where id = p_facility_id;
  if v_f.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_date is null or v_date < private.today() or v_date > v_end_day then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'errors', jsonb_build_object('time',
      '오늘부터 2주 이내(' || private.today() || ' ~ ' || v_end_day || ')의 날짜만 예약할 수 있습니다.'));
  end if;
  if p_start_time is null or p_start_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'errors', '{"time": "시작 시간을 고르세요."}'::jsonb);
  end if;
  if p_hours is null or p_hours < 1 or p_hours > v_max then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'errors', jsonb_build_object('time', '한 번에 1시간부터 ' || v_max || '시간까지 예약할 수 있습니다.'));
  end if;
  v_start := private.minutes(p_start_time);
  v_end := v_start + p_hours * v_f.slot_minutes;
  if v_start < private.minutes(v_f.open_time) or v_end > private.minutes(v_f.close_time)
     or (v_start - private.minutes(v_f.open_time)) % v_f.slot_minutes <> 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'errors', jsonb_build_object('time',
      '운영 시간(' || v_f.open_time || ' ~ ' || v_f.close_time || ') 안에서 1시간 단위로 고르세요.'));
  end if;
  if v_date = private.today() and v_start < private.now_minutes() then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'errors', '{"time": "이미 시작한 시간대는 예약할 수 없습니다."}'::jsonb);
  end if;
  if private.is_away(v_me.id, v_date) then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'errors', '{"time": "출타 중인 날은 시설을 예약할 수 없습니다."}'::jsonb);
  end if;

  perform private.lock_facility();
  if (select count(*) from public.reservations where user_id = v_me.id and date = v_date and status in ('pending', 'approved'))
     >= private.reservation_limit('per_day') then
    select * into v_mine from public.reservations where user_id = v_me.id and date = v_date and status in ('pending', 'approved') limit 1;
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'errors', jsonb_build_object('time',
      '하루에 ' || private.reservation_limit('per_day') || '건만 예약할 수 있습니다. 이미 ' || private.facility_label(v_mine.facility_id)
      || ' ' || v_mine.start_time || '~' || v_mine.end_time || ' 예약이 있습니다.'));
  end if;
  select * into v_block from public.facility_blocks b
  where (b.facility_id is null or b.facility_id = v_f.id) and b.date = v_date
    and (b.start_time is null or (private.minutes(b.start_time) < v_end and v_start < private.minutes(b.end_time)))
  limit 1;
  if v_block.id is not null then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'errors', jsonb_build_object('time', '사용 불가인 시간이 있습니다 (' || v_block.reason || ').'));
  end if;
  if exists (select 1 from public.reservations r where r.facility_id = v_f.id and r.date = v_date and r.status in ('pending', 'approved')
             and private.minutes(r.start_time) < v_end and v_start < private.minutes(r.end_time)) then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'errors', '{"time": "이미 신청된 시간이 있습니다. 다른 시간을 고르세요."}'::jsonb);
  end if;
  insert into public.reservations (facility_id, user_id, date, start_time, end_time)
  values (v_f.id, v_me.id, v_date, private.hhmm(v_start), private.hhmm(v_end)) returning * into v_res;
  return jsonb_build_object('ok', true, 'reservation', private.reservation_json(v_res, v_me));
end;
$$;

-- 신청한 사람만, 대기·승인일 때 취소
create or replace function public.cancel_reservation(p_token text, p_id text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_me public.profiles := private.session_profile(p_token);
  v_res public.reservations;
begin
  if v_me.id is null then return jsonb_build_object('ok', false, 'reason', 'forbidden'); end if;
  select * into v_res from public.reservations where id = p_id for update;
  if v_res.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_res.user_id <> v_me.id then return jsonb_build_object('ok', false, 'reason', 'forbidden'); end if;
  if v_res.status not in ('pending', 'approved') then return jsonb_build_object('ok', false, 'reason', 'already_decided'); end if;
  update public.reservations set status = 'cancelled', cancelled_at = now() where id = p_id;
  return jsonb_build_object('ok', true);
end;
$$;

-- 간부: 승인·반려(사유 필수)
create or replace function public.decide_reservation(p_token text, p_id text, p_decision text, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_me public.profiles := private.session_profile(p_token);
  v_res public.reservations;
  v_text text := btrim(coalesce(p_reason, ''));
begin
  if v_me.id is null or v_me.role <> 'officer' then return jsonb_build_object('ok', false, 'reason', 'forbidden'); end if;
  if p_decision is null or p_decision not in ('approve', 'reject') then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  select * into v_res from public.reservations where id = p_id for update;
  if v_res.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_res.status <> 'pending' then return jsonb_build_object('ok', false, 'reason', 'already_decided'); end if;
  if p_decision = 'reject' then
    if v_text = '' then return jsonb_build_object('ok', false, 'reason', 'invalid', 'errors', '{"reject_reason": "반려 사유를 입력하세요."}'::jsonb); end if;
    if char_length(v_text) > 100 then return jsonb_build_object('ok', false, 'reason', 'invalid', 'errors', '{"reject_reason": "사유는 100자 이하로 입력하세요."}'::jsonb); end if;
  end if;
  update public.reservations set
    status = case when p_decision = 'approve' then 'approved' else 'rejected' end,
    reject_reason = case when p_decision = 'reject' then v_text end,
    decided_by = v_me.id, decided_at = now()
  where id = p_id;
  insert into public.audit_logs (actor_id, action, target_table, target_id)
  values (v_me.id, case when p_decision = 'approve' then 'approve_reservation' else 'reject_reservation' end, 'reservations', p_id);
  return jsonb_build_object('ok', true);
end;
$$;

-- 간부: 시설 막기. p_facility_id가 'all'이면 모든 시설, p_all_day면 하루 종일
create or replace function public.add_facility_block(p_token text, p_facility_id text, p_date text, p_all_day boolean, p_start_time text, p_end_time text, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_me public.profiles := private.session_profile(p_token);
  v_all_facilities boolean := p_facility_id = 'all';
  v_date date := private.to_date_or_null(p_date);
  v_reason text := btrim(coalesce(p_reason, ''));
  v_start text;
  v_end text;
  v_errors jsonb := '{}';
  v_clash text;
  v_id text;
begin
  if v_me.id is null or v_me.role <> 'officer' then return jsonb_build_object('ok', false, 'reason', 'forbidden'); end if;
  if not v_all_facilities and not exists (select 1 from public.facilities where id = p_facility_id) then
    v_errors := v_errors || '{"facility_id": "시설을 고르세요."}';
  end if;
  if v_date is null then v_errors := v_errors || '{"date": "날짜를 고르세요."}';
  elsif v_date < private.today() then v_errors := v_errors || '{"date": "지난 날짜는 막을 수 없습니다."}';
  end if;
  if not coalesce(p_all_day, false) then
    if coalesce(p_start_time, '') !~ '^([01][0-9]|2[0-3]):00$' or coalesce(p_end_time, '') !~ '^([01][0-9]|2[0-4]):00$' then
      v_errors := v_errors || '{"time": "시작·끝 시간을 정시로 고르세요."}';
    elsif p_end_time <= p_start_time then
      v_errors := v_errors || '{"time": "끝 시간은 시작 시간보다 뒤여야 합니다."}';
    else
      v_start := p_start_time;
      v_end := p_end_time;
    end if;
  end if;
  if v_reason = '' then v_errors := v_errors || '{"reason": "사유를 입력하세요."}';
  elsif char_length(v_reason) > 50 then v_errors := v_errors || '{"reason": "사유는 50자 이하로 입력하세요."}';
  end if;
  if v_errors <> '{}'::jsonb then return jsonb_build_object('ok', false, 'reason', 'invalid', 'errors', v_errors); end if;

  perform private.lock_facility();
  select string_agg(private.facility_label(r.facility_id) || ' ' || r.start_time || '~' || r.end_time || ' ' || p.name, ', ' order by r.start_time)
  into v_clash
  from public.reservations r join public.profiles p on p.id = r.user_id
  where r.date = v_date and r.status in ('pending', 'approved') and (v_all_facilities or r.facility_id = p_facility_id)
    and (v_start is null or (private.minutes(r.start_time) < private.minutes(v_end) and private.minutes(v_start) < private.minutes(r.end_time)));
  if v_clash is not null then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'errors', jsonb_build_object('time', '이 시간에 예약이 있어 막을 수 없습니다. 먼저 반려하세요: ' || v_clash));
  end if;
  insert into public.facility_blocks (facility_id, date, start_time, end_time, reason, created_by)
  values (case when v_all_facilities then null else p_facility_id end, v_date, v_start, v_end, v_reason, v_me.id) returning id into v_id;
  insert into public.audit_logs (actor_id, action, target_table, target_id) values (v_me.id, 'add_facility_block', 'facility_blocks', v_id);
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.delete_facility_block(p_token text, p_id text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_me public.profiles := private.session_profile(p_token);
begin
  if v_me.id is null or v_me.role <> 'officer' then return jsonb_build_object('ok', false, 'reason', 'forbidden'); end if;
  delete from public.facility_blocks where id = p_id;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  insert into public.audit_logs (actor_id, action, target_table, target_id) values (v_me.id, 'delete_facility_block', 'facility_blocks', p_id);
  return jsonb_build_object('ok', true);
end;
$$;

-- 앱(공개 키)에 여는 함수
revoke execute on all functions in schema private from public, anon, authenticated;
revoke execute on function public.load_state(text) from public, anon, authenticated;
revoke execute on function public.request_reservation(text, text, text, text, int) from public, anon, authenticated;
revoke execute on function public.cancel_reservation(text, text) from public, anon, authenticated;
revoke execute on function public.decide_reservation(text, text, text, text) from public, anon, authenticated;
revoke execute on function public.add_facility_block(text, text, text, boolean, text, text, text) from public, anon, authenticated;
revoke execute on function public.delete_facility_block(text, text) from public, anon, authenticated;
grant execute on function public.load_state(text) to anon, authenticated;
grant execute on function public.request_reservation(text, text, text, text, int) to anon, authenticated;
grant execute on function public.cancel_reservation(text, text) to anon, authenticated;
grant execute on function public.decide_reservation(text, text, text, text) to anon, authenticated;
grant execute on function public.add_facility_block(text, text, text, boolean, text, text, text) to anon, authenticated;
grant execute on function public.delete_facility_block(text, text) to anon, authenticated;

-- ── 시설과 가상 데이터 (js/mock-data.js와 같음) ─────────
-- 시설 7곳 (2026-11-07 사용자 결정, 모두 09–21시). 약도: 1~4 윗줄, 5~7 아랫줄, 실내체육관 두 칸
insert into public.facilities (id, name, building, kind, open_time, close_time, slot_minutes, map_row, map_col, map_span) values
  ('f01', '풋살장', '청룡관', 'futsal', '09:00', '21:00', 60, 1, 1, 1),
  ('f02', '풋살장', '주작관', 'futsal', '09:00', '21:00', 60, 1, 2, 1),
  ('f03', '테니스장', '주작관', 'tennis', '09:00', '21:00', 60, 1, 3, 1),
  ('f04', '대운동장', '주작관', 'field', '09:00', '21:00', 60, 1, 4, 1),
  ('f05', '풋살장', '이정란관', 'futsal', '09:00', '21:00', 60, 2, 1, 1),
  ('f06', '테니스장', '이정란관', 'tennis', '09:00', '21:00', 60, 2, 2, 1),
  ('f07', '실내체육관', '이정란관', 'gym', '09:00', '21:00', 60, 2, 3, 2)
on conflict (id) do nothing;

-- 가상 예약: 11/10 풋살장(청룡관) 10–12시 승인·14–15시 대기, 실내체육관 19–21시 대기. 가상 막기: 11/11 대운동장 하루 종일
insert into public.reservations (id, facility_id, user_id, date, start_time, end_time, status, decided_by, requested_at, decided_at) values
  ('v01', 'f01', 'u03', '2026-11-10', '10:00', '12:00', 'approved', 'o01', '2026-11-05T09:00:00.000Z', '2026-11-05T10:00:00.000Z'),
  ('v02', 'f01', 'u04', '2026-11-10', '14:00', '15:00', 'pending', null, '2026-11-06T09:00:00.000Z', null),
  ('v03', 'f07', 'u09', '2026-11-10', '19:00', '21:00', 'pending', null, '2026-11-06T12:00:00.000Z', null)
on conflict (id) do nothing;

insert into public.facility_blocks (id, facility_id, date, start_time, end_time, reason, created_by, created_at) values
  ('b01', 'f04', '2026-11-11', null, null, '잔디 보수', 'o01', '2026-11-05T09:00:00.000Z')
on conflict (id) do nothing;
