-- Phase 5-3c: 근무 (duty_posts, duty_rosters, duty_overrides, duty_swaps)
-- 사용법: 01~04 SQL을 먼저 실행한 뒤, 이 파일 내용을 SQL Editor에 모두 붙여 넣고 Run. 여러 번 실행해도 된다.
--
-- - 근무자는 저장하지 않고 서버가 매번 계산한다(근무표). 저장하는 것은 근무지·순번 명단·손 수정·교대 결과뿐이다.
--   기준일부터 날마다 시간대 수만큼 순번이 넘어가고, 그날 나가 있거나 이미 근무가 있는 사람은 그날 순번에 없는 다음 사람이 대신 선다.
-- - 서버가 근무표를 계산해 주므로, 병사는 누가 출타했는지 몰라도 "대신 섬"이 반영된 근무표를 본다.
-- - 근무가 있는 날에는 휴가·외박·외출을 신청할 수 없다 (이제 서버도 확인한다).
-- - 근무 교대: 병사 한 명이 요청(사유) → 간부 승인·반려. 승인할 때 다시 확인한다.
-- - 근무·출타를 바꾸는 함수는 같은 잠금을 잡고 처리한다(근무표가 출타에 따라 달라지므로).

create table if not exists public.duty_posts (
  id text primary key default gen_random_uuid()::text,
  name text not null check (char_length(name) between 1 and 20),
  slots text[] not null,
  start_date date not null,
  is_active boolean not null default true
);

create table if not exists public.duty_rosters (
  post_id text not null references public.duty_posts (id) on delete cascade,
  user_id text not null references public.profiles (id),
  order_no int not null,
  primary key (post_id, user_id)
);

create table if not exists public.duty_overrides (
  post_id text not null references public.duty_posts (id) on delete cascade,
  date date not null,
  slot int not null,
  user_id text not null references public.profiles (id),
  source text not null check (source in ('manual', 'swap')),
  changed_by text references public.profiles (id),
  changed_at timestamptz not null default now(),
  primary key (post_id, date, slot)
);

create table if not exists public.duty_swaps (
  id text primary key default gen_random_uuid()::text,
  kind text not null check (kind in ('swap', 'cover')),
  requester_id text not null references public.profiles (id),
  requester_post text not null references public.duty_posts (id) on delete cascade,
  requester_date date not null,
  requester_slot int not null,
  partner_id text not null references public.profiles (id),
  partner_post text references public.duty_posts (id) on delete cascade,
  partner_date date,
  partner_slot int,
  reason text not null check (char_length(reason) between 1 and 100),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  reject_reason text,
  decided_by text references public.profiles (id),
  requested_at timestamptz not null default now(),
  decided_at timestamptz
);

alter table public.duty_posts enable row level security;
alter table public.duty_rosters enable row level security;
alter table public.duty_overrides enable row level security;
alter table public.duty_swaps enable row level security;
revoke all on public.duty_posts, public.duty_rosters, public.duty_overrides, public.duty_swaps from anon, authenticated;

-- ── 서버 안에서만 쓰는 도우미 ─────────────────────────────────

create or replace function private.is_away(p_user text, p_date date) returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from public.leave_requests
    where user_id = p_user and status = 'requested' and p_date between start_date and end_date);
$$;

-- 한 근무지의 그날 근무 (js/data.js의 postDay와 같은 규칙)
-- source: rotation(순번) | substitute(대신 섬) | manual(간부 손 수정) | swap(교대)
create or replace function private.post_day(p_post public.duty_posts, p_date date)
returns table (slot int, label text, user_id text, source text)
language plpgsql stable set search_path = '' as $$
#variable_conflict use_column
declare
  v_roster text[];
  v_k int := coalesce(array_length(p_post.slots, 1), 0);
  v_n int;
  v_base bigint;
  v_natural text[] := '{}';
  v_taken text[];
  v_over record;
  v_user text;
  v_src text;
  v_cand text;
  s int;
  i int;
begin
  select coalesce(array_agg(r.user_id order by r.order_no), '{}') into v_roster from public.duty_rosters r where r.post_id = p_post.id;
  v_n := coalesce(array_length(v_roster, 1), 0);
  if p_date < p_post.start_date or v_k = 0 or v_n < v_k then return; end if;
  v_base := (p_date - p_post.start_date)::bigint * v_k;
  for s in 0 .. v_k - 1 loop
    v_natural := v_natural || v_roster[(((v_base + s) % v_n) + 1)::int];
  end loop;
  select coalesce(array_agg(o.user_id), '{}') into v_taken from public.duty_overrides o where o.post_id = p_post.id and o.date = p_date;
  for s in 0 .. v_k - 1 loop
    select o.user_id as uid, o.source as src into v_over from public.duty_overrides o
    where o.post_id = p_post.id and o.date = p_date and o.slot = s;
    if found then
      slot := s; label := p_post.slots[s + 1]; user_id := v_over.uid; source := v_over.src;
      return next;
      continue;
    end if;
    v_user := v_natural[s + 1];
    v_src := 'rotation';
    if v_user = any (v_taken) or private.is_away(v_user, p_date) then
      v_src := 'substitute';
      v_user := null;
      for i in 1 .. v_n - 1 loop
        v_cand := v_roster[(((v_base + s + i) % v_n) + 1)::int];
        if not (v_cand = any (v_taken)) and not (v_cand = any (v_natural)) and not private.is_away(v_cand, p_date) then
          v_user := v_cand;
          exit;
        end if;
      end loop;
    end if;
    if v_user is not null then v_taken := v_taken || v_user; end if;
    slot := s; label := p_post.slots[s + 1]; user_id := v_user; source := v_src;
    return next;
  end loop;
end;
$$;

-- 한 사람의 근무 (start~end)
create or replace function private.duties_of(p_user text, p_start date, p_end date)
returns table (duty_date date, post_id text, post_name text, slot int, label text, source text)
language sql stable set search_path = '' as $$
  select d::date, p.id, p.name, x.slot, x.label, x.source
  from generate_series(p_start::timestamp, p_end::timestamp, interval '1 day') d
  cross join public.duty_posts p
  cross join lateral private.post_day(p, d::date) x
  where p.is_active and x.user_id = p_user
  order by 1, 2, 4;
$$;

-- 그 근무(근무지·날짜·시간대)의 지금 근무자
create or replace function private.duty_holder(p_post text, p_date date, p_slot int) returns text
language sql stable set search_path = '' as $$
  select x.user_id from public.duty_posts p cross join lateral private.post_day(p, p_date) x
  where p.id = p_post and p.is_active and x.slot = p_slot;
$$;

-- "11/12 불침번 1번초"
create or replace function private.duty_name(p_post text, p_date date, p_slot int) returns text
language sql stable set search_path = '' as $$
  select private.md(p_date) || ' ' || coalesce(p.name, '(없어진 근무지)') || ' ' || coalesce(p.slots[p_slot + 1], (p_slot + 1) || '번')
  from (select 1) one left join public.duty_posts p on p.id = p_post;
$$;

-- 그날 그 사람의 다른 근무 (근무지·시간대 하나를 빼고). 없으면 null
create or replace function private.other_duty(p_user text, p_date date, p_post text, p_slot int) returns text
language sql stable set search_path = '' as $$
  select d.post_name || ' ' || d.label from private.duties_of(p_user, p_date, p_date) d
  where not (d.post_id is not distinct from p_post and d.slot is not distinct from p_slot) limit 1;
$$;

-- 근무·출타가 서로 끼어들지 않게 같은 잠금을 쓴다 (04의 lock_absence)

-- 출타 날짜 확인에 "근무가 있는 날은 막기"를 더한다 (04의 함수를 바꿔 끼운다)
create or replace function private.absence_date_error(p_user text, p_kind text, p_start date, p_end date) returns text
language plpgsql stable set search_path = '' as $$
declare
  v_overlap public.leave_requests;
  v_duty record;
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
  select * into v_duty from private.duties_of(p_user, p_start, p_end) limit 1;
  if found then
    return private.md(v_duty.duty_date) || ' ' || v_duty.post_name || ' ' || v_duty.label || ' 근무가 있습니다. 먼저 근무를 교대하세요.';
  end if;
  v_full := private.full_dates(p_kind, p_start, p_end);
  if array_length(v_full, 1) > 0 then
    return '마감된 날짜가 있어 신청할 수 없습니다: ' || (select string_agg(private.md(x), ', ') from unnest(v_full) x);
  end if;
  return null;
end;
$$;

-- 근무 교대가 지금 가능한지. 문제가 있으면 안내 문구, 없으면 null (요청할 때와 승인할 때 같이 쓴다. js/data.js의 checkSwap과 같다)
create or replace function private.swap_error(
  p_kind text, p_requester text, p_r_post text, p_r_date date, p_r_slot int,
  p_partner text, p_p_post text, p_p_date date, p_p_slot int
) returns text
language plpgsql stable set search_path = '' as $$
declare
  v_partner public.profiles;
  v_requester_name text := (select name from public.profiles where id = p_requester);
  v_other text;
begin
  select * into v_partner from public.profiles where id = p_partner and is_active and role = 'soldier';
  if v_partner.id is null then return '교대할 병사를 고르세요.'; end if;
  if v_partner.id = p_requester then return '자기 자신과는 교대할 수 없습니다.'; end if;
  if p_kind = 'swap' and (p_p_post is null or p_p_date is null or p_p_slot is null) then return '맞바꿀 상대의 근무를 고르세요.'; end if;
  if p_r_date is null or p_r_date < private.today() or p_r_date > private.apply_window_end()
     or (p_kind = 'swap' and (p_p_date < private.today() or p_p_date > private.apply_window_end())) then
    return '오늘부터 한 달 이내(' || private.today() || ' ~ ' || private.apply_window_end() || ')의 근무만 교대할 수 있습니다.';
  end if;
  if private.duty_holder(p_r_post, p_r_date, p_r_slot) is distinct from p_requester then
    return v_requester_name || '의 ' || private.duty_name(p_r_post, p_r_date, p_r_slot) || ' 근무가 바뀌어 교대할 수 없습니다.';
  end if;
  if p_kind = 'swap' then
    if p_r_post = p_p_post and p_r_date = p_p_date and p_r_slot = p_p_slot then return '같은 근무끼리는 맞바꿀 수 없습니다.'; end if;
    if private.duty_holder(p_p_post, p_p_date, p_p_slot) is distinct from p_partner then
      return v_partner.name || '의 ' || private.duty_name(p_p_post, p_p_date, p_p_slot) || ' 근무가 바뀌어 교대할 수 없습니다.';
    end if;
  end if;
  -- 상대가 내 근무 날에 설 수 있는지
  if private.is_away(p_partner, p_r_date) then
    return v_partner.name || '은(는) ' || private.duty_name(p_r_post, p_r_date, p_r_slot) || ' 날에 출타 중입니다.';
  end if;
  select d.post_name || ' ' || d.label into v_other from private.duties_of(p_partner, p_r_date, p_r_date) d
  where not (p_kind = 'swap' and d.post_id = p_p_post and d.duty_date = p_p_date and d.slot = p_p_slot) limit 1;
  if v_other is not null then
    return v_partner.name || '은(는) ' || private.duty_name(p_r_post, p_r_date, p_r_slot) || ' 날에 이미 ' || v_other || ' 근무가 있습니다.';
  end if;
  if p_kind = 'swap' then
    -- 나도 상대 근무 날에 설 수 있어야 한다
    if private.is_away(p_requester, p_p_date) then
      return v_requester_name || '은(는) ' || private.duty_name(p_p_post, p_p_date, p_p_slot) || ' 날에 출타 중입니다.';
    end if;
    select d.post_name || ' ' || d.label into v_other from private.duties_of(p_requester, p_p_date, p_p_date) d
    where not (d.post_id = p_r_post and d.duty_date = p_r_date and d.slot = p_r_slot) limit 1;
    if v_other is not null then
      return v_requester_name || '은(는) ' || private.duty_name(p_p_post, p_p_date, p_p_slot) || ' 날에 이미 ' || v_other || ' 근무가 있습니다.';
    end if;
  end if;
  return null;
end;
$$;

create or replace function private.swap_json(w public.duty_swaps) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', w.id, 'kind', w.kind,
    'requester_id', w.requester_id, 'requester_name', (select name from public.profiles where id = w.requester_id),
    'requester_duty', jsonb_build_object('post_id', w.requester_post, 'date', w.requester_date, 'slot', w.requester_slot),
    'partner_id', w.partner_id, 'partner_name', (select name from public.profiles where id = w.partner_id),
    'partner_duty', case when w.partner_post is null then null
      else jsonb_build_object('post_id', w.partner_post, 'date', w.partner_date, 'slot', w.partner_slot) end,
    'reason', w.reason, 'status', w.status, 'reject_reason', w.reject_reason,
    'decided_by', w.decided_by, 'requested_at', w.requested_at, 'decided_at', w.decided_at
  );
$$;

-- 승인 대기 중인 교대에 걸린 근무인지
create or replace function private.pending_swap_on(p_post text, p_date date, p_slot int) returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from public.duty_swaps where status = 'pending' and (
    (requester_post = p_post and requester_date = p_date and requester_slot = p_slot)
    or (partner_post = p_post and partner_date = p_date and partner_slot = p_slot)));
$$;

-- ── 앱이 부르는 함수 ──────────────────────────────────────────

-- 5-3b의 load_state에 근무를 더한다.
-- 모두: 근무지, 근무표(서버가 계산, 지난 한 달 ~ 신청 기간 끝, 근무자 이름 포함), 교대(병사는 자기와 관련된 것만)
-- 간부: 순번 명단, 손 수정 기록 / 병사: 교대 상대로 고를 병사 이름(soldier_names)
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

-- 근무지 추가(p_id null)·수정 (간부만). 시간대나 명단이 바뀌면 오늘부터 명단 1번으로 다시 시작하고, 오늘부터의 손 수정·교대를 지운다.
create or replace function public.save_duty_post(p_token text, p_id text, p_name text, p_slots jsonb, p_roster jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_me public.profiles := private.session_profile(p_token);
  v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_slots text[];
  v_roster text[];
  v_errors jsonb := '{}';
  v_post public.duty_posts;
  v_changed boolean;
begin
  if v_me.id is null or v_me.role <> 'officer' then return jsonb_build_object('ok', false, 'reason', 'forbidden'); end if;
  if p_id is not null then
    select * into v_post from public.duty_posts where id = p_id and is_active;
    if v_post.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  end if;
  select coalesce(array_agg(regexp_replace(btrim(x), '\s+', ' ', 'g')), '{}') into v_slots
  from jsonb_array_elements_text(coalesce(p_slots, '[]')) x where btrim(x) <> '';
  select coalesce(array_agg(x), '{}') into v_roster from jsonb_array_elements_text(coalesce(p_roster, '[]')) x;

  if v_name = '' then v_errors := v_errors || '{"name": "근무지 이름을 입력하세요."}';
  elsif char_length(v_name) > 20 then v_errors := v_errors || '{"name": "근무지 이름은 20자 이하로 입력하세요."}';
  elsif exists (select 1 from public.duty_posts where is_active and name = v_name and id is distinct from p_id) then
    v_errors := v_errors || '{"name": "같은 이름의 근무지가 있습니다."}';
  end if;
  if coalesce(array_length(v_slots, 1), 0) = 0 then v_errors := v_errors || '{"slots": "시간대를 하나 이상 입력하세요."}';
  elsif array_length(v_slots, 1) > 8 then v_errors := v_errors || '{"slots": "시간대는 8개까지입니다."}';
  elsif exists (select 1 from unnest(v_slots) x where char_length(x) > 10) then v_errors := v_errors || '{"slots": "시간대 이름은 10자 이하로 입력하세요."}';
  elsif (select count(distinct x) from unnest(v_slots) x) <> array_length(v_slots, 1) then v_errors := v_errors || '{"slots": "같은 이름의 시간대가 있습니다."}';
  end if;
  if coalesce(array_length(v_roster, 1), 0) = 0 then v_errors := v_errors || '{"roster": "순번 명단에 병사를 넣으세요."}';
  elsif (select count(distinct x) from unnest(v_roster) x) <> array_length(v_roster, 1)
     or exists (select 1 from unnest(v_roster) x where not exists (select 1 from public.profiles p where p.id = x and p.is_active and p.role = 'soldier')) then
    v_errors := v_errors || '{"roster": "명단을 다시 확인하세요."}';
  elsif not (v_errors ? 'slots') and array_length(v_roster, 1) < array_length(v_slots, 1) then
    v_errors := v_errors || jsonb_build_object('roster', '하루에 ' || array_length(v_slots, 1) || '명이 서므로 명단에 ' || array_length(v_slots, 1) || '명 이상 넣으세요.');
  end if;
  if v_errors <> '{}'::jsonb then return jsonb_build_object('ok', false, 'reason', 'invalid', 'errors', v_errors); end if;

  perform private.lock_absence();
  v_changed := v_post.id is null or v_post.slots is distinct from v_slots
    or (select coalesce(array_agg(r.user_id order by r.order_no), '{}') from public.duty_rosters r where r.post_id = v_post.id) is distinct from v_roster;
  if v_post.id is null then
    insert into public.duty_posts (name, slots, start_date) values (v_name, v_slots, private.today()) returning * into v_post;
  else
    update public.duty_posts set name = v_name where id = v_post.id returning * into v_post;
  end if;
  if v_changed then
    update public.duty_posts set slots = v_slots, start_date = private.today() where id = v_post.id;
    delete from public.duty_overrides where post_id = v_post.id and date >= private.today();
    delete from public.duty_rosters where post_id = v_post.id;
    insert into public.duty_rosters (post_id, user_id, order_no) select v_post.id, x, n from unnest(v_roster) with ordinality t(x, n);
  end if;
  insert into public.audit_logs (actor_id, action, target_table, target_id)
  values (v_me.id, case when p_id is null then 'create_duty_post' else 'update_duty_post' end, 'duty_posts', v_post.id);
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.delete_duty_post(p_token text, p_id text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_me public.profiles := private.session_profile(p_token);
begin
  if v_me.id is null or v_me.role <> 'officer' then return jsonb_build_object('ok', false, 'reason', 'forbidden'); end if;
  update public.duty_posts set is_active = false where id = p_id and is_active;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  insert into public.audit_logs (actor_id, action, target_table, target_id) values (v_me.id, 'delete_duty_post', 'duty_posts', p_id);
  return jsonb_build_object('ok', true);
end;
$$;

-- 간부 손 수정: 그날 그 시간대의 근무자를 바꾼다 (오늘부터 한 달 안)
create or replace function public.set_duty_override(p_token text, p_post_id text, p_date text, p_slot int, p_user_id text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_me public.profiles := private.session_profile(p_token);
  v_date date := private.to_date_or_null(p_date);
  v_post public.duty_posts;
  v_holder text;
  v_soldier public.profiles;
  v_other text;
  v_message text;
begin
  if v_me.id is null or v_me.role <> 'officer' then return jsonb_build_object('ok', false, 'reason', 'forbidden'); end if;
  select * into v_post from public.duty_posts where id = p_post_id and is_active;
  if v_post.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  perform private.lock_absence();
  if v_date is null or v_date < private.today() or v_date > private.apply_window_end() then
    v_message := '오늘부터 한 달 이내(' || private.today() || ' ~ ' || private.apply_window_end() || ')의 근무만 바꿀 수 있습니다.';
  elsif not exists (select 1 from private.post_day(v_post, v_date) x where x.slot = p_slot) then
    v_message := '이날은 이 근무지의 순번이 시작되기 전입니다.';
  else
    v_holder := private.duty_holder(p_post_id, v_date, p_slot);
    select * into v_soldier from public.profiles where id = p_user_id and is_active and role = 'soldier';
    if v_soldier.id is null then v_message := '근무를 설 병사를 고르세요.';
    elsif v_soldier.id = v_holder then v_message := '지금 근무자와 같은 사람입니다.';
    elsif private.is_away(v_soldier.id, v_date) then v_message := v_soldier.name || '은(는) 이날 출타 중입니다.';
    else
      v_other := private.other_duty(v_soldier.id, v_date, p_post_id, p_slot);
      if v_other is not null then v_message := v_soldier.name || '은(는) 이날 이미 ' || v_other || ' 근무가 있습니다.'; end if;
    end if;
  end if;
  if v_message is not null then return jsonb_build_object('ok', false, 'reason', 'invalid', 'errors', jsonb_build_object('user_id', v_message)); end if;

  insert into public.duty_overrides (post_id, date, slot, user_id, source, changed_by)
  values (p_post_id, v_date, p_slot, p_user_id, 'manual', v_me.id)
  on conflict (post_id, date, slot) do update set user_id = excluded.user_id, source = 'manual', changed_by = excluded.changed_by, changed_at = now();
  insert into public.audit_logs (actor_id, action, target_table, target_id) values (v_me.id, 'set_duty_override', 'duty_overrides', p_post_id || ':' || v_date || ':' || p_slot);
  return jsonb_build_object('ok', true);
end;
$$;

-- 간부: 손 수정·교대로 바뀐 근무를 순번대로 되돌린다
create or replace function public.clear_duty_override(p_token text, p_post_id text, p_date text, p_slot int) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_me public.profiles := private.session_profile(p_token);
  v_date date := private.to_date_or_null(p_date);
begin
  if v_me.id is null or v_me.role <> 'officer' then return jsonb_build_object('ok', false, 'reason', 'forbidden'); end if;
  if v_date is null or v_date < private.today() or v_date > private.apply_window_end() then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'errors', jsonb_build_object('user_id',
      '오늘부터 한 달 이내(' || private.today() || ' ~ ' || private.apply_window_end() || ')의 근무만 바꿀 수 있습니다.'));
  end if;
  perform private.lock_absence();
  delete from public.duty_overrides where post_id = p_post_id and date = v_date and slot = p_slot;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  insert into public.audit_logs (actor_id, action, target_table, target_id) values (v_me.id, 'clear_duty_override', 'duty_overrides', p_post_id || ':' || v_date || ':' || p_slot);
  return jsonb_build_object('ok', true);
end;
$$;

-- 병사: 근무 교대 요청. p_kind: swap(맞바꾸기) | cover(대신 서기, 상대 근무 없음)
create or replace function public.request_duty_swap(
  p_token text, p_kind text, p_r_post text, p_r_date text, p_r_slot int,
  p_partner_id text, p_p_post text, p_p_date text, p_p_slot int, p_reason text
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_me public.profiles := private.session_profile(p_token);
  v_reason text := btrim(coalesce(p_reason, ''));
  v_r_date date := private.to_date_or_null(p_r_date);
  v_p_date date := case when p_kind = 'swap' then private.to_date_or_null(p_p_date) end;
  v_errors jsonb := '{}';
  v_problem text;
  v_swap public.duty_swaps;
begin
  if v_me.id is null or v_me.role <> 'soldier' then return jsonb_build_object('ok', false, 'reason', 'forbidden'); end if;
  if v_reason = '' then v_errors := v_errors || '{"reason": "교대 사유를 입력하세요."}';
  elsif char_length(v_reason) > 100 then v_errors := v_errors || '{"reason": "사유는 100자 이하로 입력하세요."}';
  end if;
  if p_kind is null or p_kind not in ('swap', 'cover') then
    v_errors := v_errors || '{"kind": "맞바꾸기인지 대신 서기인지 고르세요."}';
  else
    perform private.lock_absence();
    v_problem := private.swap_error(p_kind, v_me.id, p_r_post, v_r_date, p_r_slot, p_partner_id,
      case when p_kind = 'swap' then p_p_post end, v_p_date, case when p_kind = 'swap' then p_p_slot end);
    if v_problem is not null then
      v_errors := v_errors || jsonb_build_object(case when v_problem = '맞바꿀 상대의 근무를 고르세요.' then 'partner_duty' else 'partner_id' end, v_problem);
    elsif private.pending_swap_on(p_r_post, v_r_date, p_r_slot) or (p_kind = 'swap' and private.pending_swap_on(p_p_post, v_p_date, p_p_slot)) then
      v_errors := v_errors || '{"partner_id": "이 근무로 이미 승인 대기 중인 교대 요청이 있습니다."}';
    end if;
  end if;
  if v_errors <> '{}'::jsonb then return jsonb_build_object('ok', false, 'reason', 'invalid', 'errors', v_errors); end if;

  insert into public.duty_swaps (kind, requester_id, requester_post, requester_date, requester_slot, partner_id, partner_post, partner_date, partner_slot, reason)
  values (p_kind, v_me.id, p_r_post, v_r_date, p_r_slot, p_partner_id,
    case when p_kind = 'swap' then p_p_post end, v_p_date, case when p_kind = 'swap' then p_p_slot end, v_reason)
  returning * into v_swap;
  return jsonb_build_object('ok', true, 'swap', private.swap_json(v_swap));
end;
$$;

-- 요청한 병사만, 승인 대기일 때만 취소
create or replace function public.cancel_duty_swap(p_token text, p_id text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_me public.profiles := private.session_profile(p_token);
  v_swap public.duty_swaps;
begin
  if v_me.id is null then return jsonb_build_object('ok', false, 'reason', 'forbidden'); end if;
  select * into v_swap from public.duty_swaps where id = p_id for update;
  if v_swap.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_swap.requester_id <> v_me.id then return jsonb_build_object('ok', false, 'reason', 'forbidden'); end if;
  if v_swap.status <> 'pending' then return jsonb_build_object('ok', false, 'reason', 'already_decided'); end if;
  update public.duty_swaps set status = 'cancelled', decided_at = now() where id = p_id;
  return jsonb_build_object('ok', true);
end;
$$;

-- 간부: 교대 승인(다시 확인하고 근무를 바꾼다)·반려(사유 필수)
create or replace function public.decide_duty_swap(p_token text, p_id text, p_decision text, p_reject_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_me public.profiles := private.session_profile(p_token);
  v_swap public.duty_swaps;
  v_text text := btrim(coalesce(p_reject_reason, ''));
  v_problem text;
begin
  if v_me.id is null or v_me.role <> 'officer' then return jsonb_build_object('ok', false, 'reason', 'forbidden'); end if;
  if p_decision is null or p_decision not in ('approve', 'reject') then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  perform private.lock_absence();
  select * into v_swap from public.duty_swaps where id = p_id for update;
  if v_swap.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_swap.status <> 'pending' then return jsonb_build_object('ok', false, 'reason', 'already_decided'); end if;
  if p_decision = 'reject' then
    if v_text = '' then return jsonb_build_object('ok', false, 'reason', 'invalid', 'errors', '{"reject_reason": "반려 사유를 입력하세요."}'::jsonb); end if;
    if char_length(v_text) > 100 then return jsonb_build_object('ok', false, 'reason', 'invalid', 'errors', '{"reject_reason": "사유는 100자 이하로 입력하세요."}'::jsonb); end if;
    update public.duty_swaps set status = 'rejected', reject_reason = v_text, decided_by = v_me.id, decided_at = now() where id = p_id;
  else
    v_problem := private.swap_error(v_swap.kind, v_swap.requester_id, v_swap.requester_post, v_swap.requester_date, v_swap.requester_slot,
      v_swap.partner_id, v_swap.partner_post, v_swap.partner_date, v_swap.partner_slot);
    if v_problem is not null then return jsonb_build_object('ok', false, 'reason', 'stale', 'message', v_problem); end if;
    insert into public.duty_overrides (post_id, date, slot, user_id, source, changed_by)
    values (v_swap.requester_post, v_swap.requester_date, v_swap.requester_slot, v_swap.partner_id, 'swap', v_me.id)
    on conflict (post_id, date, slot) do update set user_id = excluded.user_id, source = 'swap', changed_by = excluded.changed_by, changed_at = now();
    if v_swap.kind = 'swap' then
      insert into public.duty_overrides (post_id, date, slot, user_id, source, changed_by)
      values (v_swap.partner_post, v_swap.partner_date, v_swap.partner_slot, v_swap.requester_id, 'swap', v_me.id)
      on conflict (post_id, date, slot) do update set user_id = excluded.user_id, source = 'swap', changed_by = excluded.changed_by, changed_at = now();
    end if;
    update public.duty_swaps set status = 'approved', decided_by = v_me.id, decided_at = now() where id = p_id;
  end if;
  insert into public.audit_logs (actor_id, action, target_table, target_id)
  values (v_me.id, case when p_decision = 'approve' then 'approve_duty_swap' else 'reject_duty_swap' end, 'duty_swaps', p_id);
  return jsonb_build_object('ok', true);
end;
$$;

-- 앱(공개 키)에 여는 함수
revoke execute on all functions in schema private from public, anon, authenticated;
revoke execute on function public.load_state(text) from public, anon, authenticated;
revoke execute on function public.save_duty_post(text, text, text, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.delete_duty_post(text, text) from public, anon, authenticated;
revoke execute on function public.set_duty_override(text, text, text, int, text) from public, anon, authenticated;
revoke execute on function public.clear_duty_override(text, text, text, int) from public, anon, authenticated;
revoke execute on function public.request_duty_swap(text, text, text, text, int, text, text, text, int, text) from public, anon, authenticated;
revoke execute on function public.cancel_duty_swap(text, text) from public, anon, authenticated;
revoke execute on function public.decide_duty_swap(text, text, text, text) from public, anon, authenticated;
grant execute on function public.load_state(text) to anon, authenticated;
grant execute on function public.save_duty_post(text, text, text, jsonb, jsonb) to anon, authenticated;
grant execute on function public.delete_duty_post(text, text) to anon, authenticated;
grant execute on function public.set_duty_override(text, text, text, int, text) to anon, authenticated;
grant execute on function public.clear_duty_override(text, text, text, int) to anon, authenticated;
grant execute on function public.request_duty_swap(text, text, text, text, int, text, text, text, int, text) to anon, authenticated;
grant execute on function public.cancel_duty_swap(text, text) to anon, authenticated;
grant execute on function public.decide_duty_swap(text, text, text, text) to anon, authenticated;

-- ── 가상 데이터 (연습용, js/mock-data.js와 같음) ─────────
-- 불침번 1~4번초, 순번 10명, 기준일 2026-10-19
insert into public.duty_posts (id, name, slots, start_date) values
  ('d01', '불침번', array['1번초', '2번초', '3번초', '4번초'], '2026-10-19')
on conflict (id) do nothing;

insert into public.duty_rosters (post_id, user_id, order_no) values
  ('d01', 'u01', 1), ('d01', 'u02', 2), ('d01', 'u03', 3), ('d01', 'u04', 4), ('d01', 'u09', 5),
  ('d01', 'u10', 6), ('d01', 'u11', 7), ('d01', 'u12', 8), ('d01', 'u13', 9), ('d01', 'u14', 10)
on conflict (post_id, user_id) do nothing;
