-- Phase 5-2: 달력 일정 (events)
-- 사용법: 01_members.sql을 먼저 실행한 뒤, 이 파일 내용을 SQL Editor에 모두 붙여 넣고 Run. 여러 번 실행해도 된다.
--
-- - 부대 일정은 한 번만 저장하고 모두가 함께 본다. 개인 일정(근무·기타)은 쓴 사람만 보고 고친다.
-- - 훈련은 제목·설명을 저장하지 않는다 (화면에는 "훈련"으로만 보인다).
-- - 부대 일정의 추가·수정·삭제는 audit_logs에 남긴다.
-- - 휴가·외박·외출 일정(leave, overnight, outing)은 5-3에서 신청과 함께 만든다.

create table if not exists public.events (
  id text primary key default gen_random_uuid()::text,
  type text not null check (type in ('personal', 'duty', 'unit', 'leave', 'overnight', 'outing')),
  title text check (char_length(title) <= 30),
  start_date date not null,
  end_date date not null check (end_date >= start_date),
  time text check (time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  author_id text not null references public.profiles (id),
  memo text not null default '' check (char_length(memo) <= 200),
  repeat_yearly boolean not null default false,
  unit_category text check (unit_category in ('event', 'inspection', 'training', 'other')),
  created_at timestamptz not null default now()
);
create index if not exists events_author_idx on public.events (author_id);
create index if not exists events_dates_idx on public.events (start_date, end_date);

alter table public.events enable row level security;
revoke all on public.events from anon, authenticated;

-- ── 서버 안에서만 쓰는 도우미 ─────────────────────────────────

create or replace function private.event_json(e public.events) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'id', e.id, 'type', e.type, 'title', e.title, 'start_date', e.start_date, 'end_date', e.end_date,
    'time', e.time, 'author_id', e.author_id, 'memo', e.memo, 'repeat_yearly', e.repeat_yearly,
    'unit_category', e.unit_category
  );
$$;

create or replace function private.to_date_or_null(p text) returns date
language plpgsql immutable set search_path = '' as $$
begin
  if p !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return null; end if;
  return p::date;
exception when others then
  return null;
end;
$$;

-- 날짜 확인. 문제가 있으면 errors에 더한다 (화면의 안내 문구와 같다)
create or replace function private.date_errors(p_start text, p_end text) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  v_start date := private.to_date_or_null(p_start);
  v_end date := private.to_date_or_null(coalesce(nullif(p_end, ''), p_start));
begin
  if v_start is null then return '{"start_date": "날짜를 입력하세요."}'; end if;
  if v_end is null then return '{"end_date": "끝나는 날짜를 확인하세요."}'; end if;
  if v_end < v_start then return '{"end_date": "끝나는 날짜는 시작 날짜와 같거나 뒤여야 합니다."}'; end if;
  return '{}';
end;
$$;

-- 화면에 보낼 일정: 부대 일정 전부 + 내가 쓴 일정
create or replace function private.visible_events(p_me public.profiles) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(private.event_json(e) order by e.start_date, e.id), '[]'::jsonb)
  from public.events e where e.type = 'unit' or e.author_id = p_me.id;
$$;

-- ── 앱이 부르는 함수 ──────────────────────────────────────────

-- 5-1의 load_state에 일정을 더한다
create or replace function public.load_state(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_me public.profiles := private.session_profile(p_token);
begin
  if v_me.id is null then
    return jsonb_build_object('ok', false, 'reason', 'session');
  end if;
  return jsonb_build_object(
    'ok', true,
    'me', private.profile_json(v_me),
    'profiles', coalesce((
      select jsonb_agg(private.profile_json(p) order by p.id) from public.profiles p
      where v_me.role = 'officer' or p.id = v_me.id or (p.role = 'officer' and p.is_active)
    ), '[]'::jsonb),
    'active_soldiers', (select count(*) from public.profiles where role = 'soldier' and is_active),
    'events', private.visible_events(v_me)
  );
end;
$$;

-- 개인 일정 추가(p_id가 null) 또는 수정. 본인이 쓴 근무·기타 일정만 고칠 수 있다.
-- 결과: { ok: true, event } 또는 { ok: false, reason: forbidden | not_found | invalid, errors }
create or replace function public.save_personal_event(
  p_token text, p_id text, p_kind text, p_title text, p_start_date text, p_end_date text, p_time text, p_memo text
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_me public.profiles := private.session_profile(p_token);
  v_title text := btrim(coalesce(p_title, ''));
  v_memo text := btrim(coalesce(p_memo, ''));
  v_time text := nullif(btrim(coalesce(p_time, '')), '');
  v_errors jsonb := '{}';
  v_event public.events;
begin
  if v_me.id is null then return jsonb_build_object('ok', false, 'reason', 'forbidden'); end if;
  if p_id is not null and not exists (
    select 1 from public.events where id = p_id and type in ('personal', 'duty') and author_id = v_me.id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if p_kind is null or p_kind not in ('duty', 'other') then v_errors := v_errors || '{"kind": "종류를 고르세요."}'; end if;
  if v_title = '' then v_errors := v_errors || '{"title": "제목을 입력하세요."}';
  elsif char_length(v_title) > 30 then v_errors := v_errors || '{"title": "제목은 30자 이하로 입력하세요."}';
  end if;
  v_errors := v_errors || private.date_errors(p_start_date, p_end_date);
  if v_time is not null and v_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then v_errors := v_errors || '{"time": "시간을 확인하세요."}'; end if;
  if char_length(v_memo) > 200 then v_errors := v_errors || '{"memo": "메모는 200자 이하로 입력하세요."}'; end if;
  if v_errors <> '{}'::jsonb then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'errors', v_errors);
  end if;

  if p_id is null then
    insert into public.events (type, title, start_date, end_date, time, author_id, memo)
    values (case when p_kind = 'duty' then 'duty' else 'personal' end, v_title, p_start_date::date,
            coalesce(nullif(p_end_date, ''), p_start_date)::date, v_time, v_me.id, v_memo)
    returning * into v_event;
  else
    update public.events set
      type = case when p_kind = 'duty' then 'duty' else 'personal' end, title = v_title,
      start_date = p_start_date::date, end_date = coalesce(nullif(p_end_date, ''), p_start_date)::date,
      time = v_time, memo = v_memo, repeat_yearly = false
    where id = p_id returning * into v_event;
  end if;
  return jsonb_build_object('ok', true, 'event', private.event_json(v_event));
end;
$$;

create or replace function public.delete_personal_event(p_token text, p_id text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_me public.profiles := private.session_profile(p_token);
begin
  if v_me.id is null then return jsonb_build_object('ok', false, 'reason', 'forbidden'); end if;
  delete from public.events where id = p_id and type in ('personal', 'duty') and author_id = v_me.id;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- 부대 일정 추가(p_id가 null) 또는 수정 (간부만). 훈련은 제목·설명을 버린다.
create or replace function public.save_unit_event(
  p_token text, p_id text, p_category text, p_title text, p_start_date text, p_end_date text, p_memo text
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_me public.profiles := private.session_profile(p_token);
  v_training boolean := p_category = 'training';
  v_title text := btrim(coalesce(p_title, ''));
  v_memo text := btrim(coalesce(p_memo, ''));
  v_errors jsonb := '{}';
  v_event public.events;
begin
  if v_me.id is null or v_me.role <> 'officer' then return jsonb_build_object('ok', false, 'reason', 'forbidden'); end if;
  if p_id is not null and not exists (select 1 from public.events where id = p_id and type = 'unit') then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if p_category is null or p_category not in ('event', 'inspection', 'training', 'other') then
    v_errors := v_errors || '{"unit_category": "분류를 고르세요."}';
  end if;
  if not coalesce(v_training, false) then
    if v_title = '' then v_errors := v_errors || '{"title": "제목을 입력하세요."}';
    elsif char_length(v_title) > 30 then v_errors := v_errors || '{"title": "제목은 30자 이하로 입력하세요."}';
    end if;
    if char_length(v_memo) > 200 then v_errors := v_errors || '{"memo": "설명은 200자 이하로 입력하세요."}'; end if;
  end if;
  v_errors := v_errors || private.date_errors(p_start_date, p_end_date);
  if v_errors <> '{}'::jsonb then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'errors', v_errors);
  end if;

  if v_training then
    v_title := null;
    v_memo := '';
  end if;
  if p_id is null then
    insert into public.events (type, unit_category, title, start_date, end_date, author_id, memo)
    values ('unit', p_category, v_title, p_start_date::date, coalesce(nullif(p_end_date, ''), p_start_date)::date, v_me.id, v_memo)
    returning * into v_event;
    insert into public.audit_logs (actor_id, action, target_table, target_id) values (v_me.id, 'create_unit_event', 'events', v_event.id);
  else
    update public.events set
      unit_category = p_category, title = v_title, start_date = p_start_date::date,
      end_date = coalesce(nullif(p_end_date, ''), p_start_date)::date, memo = v_memo, time = null, repeat_yearly = false
    where id = p_id returning * into v_event;
    insert into public.audit_logs (actor_id, action, target_table, target_id) values (v_me.id, 'update_unit_event', 'events', v_event.id);
  end if;
  return jsonb_build_object('ok', true, 'event', private.event_json(v_event));
end;
$$;

create or replace function public.delete_unit_event(p_token text, p_id text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_me public.profiles := private.session_profile(p_token);
begin
  if v_me.id is null or v_me.role <> 'officer' then return jsonb_build_object('ok', false, 'reason', 'forbidden'); end if;
  delete from public.events where id = p_id and type = 'unit';
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  insert into public.audit_logs (actor_id, action, target_table, target_id) values (v_me.id, 'delete_unit_event', 'events', p_id);
  return jsonb_build_object('ok', true);
end;
$$;

-- 앱(공개 키)에 여는 함수
revoke execute on all functions in schema private from public, anon, authenticated;
revoke execute on function public.load_state(text) from public, anon, authenticated;
revoke execute on function public.save_personal_event(text, text, text, text, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.delete_personal_event(text, text) from public, anon, authenticated;
revoke execute on function public.save_unit_event(text, text, text, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.delete_unit_event(text, text) from public, anon, authenticated;
grant execute on function public.load_state(text) to anon, authenticated;
grant execute on function public.save_personal_event(text, text, text, text, text, text, text, text) to anon, authenticated;
grant execute on function public.delete_personal_event(text, text) to anon, authenticated;
grant execute on function public.save_unit_event(text, text, text, text, text, text, text) to anon, authenticated;
grant execute on function public.delete_unit_event(text, text) to anon, authenticated;

-- ── 가상 부대 일정 (연습용, js/mock-data.js와 같음. 지어낸 일정이다) ─────────
insert into public.events (id, type, unit_category, title, start_date, end_date, author_id, memo) values
  ('e01', 'unit', 'event', '체육대회', '2026-10-16', '2026-10-16', 'o01', '중대 대항 체육대회'),
  ('e02', 'unit', 'inspection', '생활관 점검', '2026-10-21', '2026-10-21', 'o01', ''),
  ('e03', 'unit', 'training', null, '2026-10-26', '2026-10-30', 'o01', '')
on conflict (id) do nothing;
