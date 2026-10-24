-- Phase 5-1: 들어오기와 인원 (profiles, audit_logs, 개인 코드, 접속 세션)
-- 사용법: Supabase 화면 → SQL Editor → New query → 이 파일 내용을 모두 붙여 넣고 Run.
-- 여러 번 실행해도 된다 (이미 있는 표와 가상 인원은 그대로 둔다).
--
-- 보안 구조
-- - 앱은 공개용(publishable) 키만 가진다. 그래서 표는 앱에서 직접 읽거나 쓸 수 없게 막고(RLS, 권한 회수),
--   아래 "앱이 부르는 함수"만 열어 둔다. 함수가 서버에서 접속 세션으로 사람을 확인하고 권한(간부만 등)을 검사한다.
-- - 개인 코드는 원문을 저장하지 않고 해시(bcrypt)로 private.member_codes에 둔다. private 스키마는 앱에서 보이지 않는다.
-- - 들어오면 무작위 접속 토큰을 주고, 서버에는 토큰의 해시만 저장한다 (30일 뒤 만료).

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- ── 표 ─────────────────────────────────────────────────────

create table if not exists public.profiles (
  id text primary key,
  name text not null check (char_length(name) between 1 and 20),
  role text not null check (role in ('soldier', 'officer')),
  position text not null check (char_length(position) between 1 and 20),
  enlist_date date not null,
  discharge_date date not null check (discharge_date > enlist_date),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id bigint generated always as identity primary key,
  actor_id text references public.profiles (id),
  action text not null,
  target_table text not null,
  target_id text,
  created_at timestamptz not null default now()
);

create table if not exists private.member_codes (
  user_id text primary key references public.profiles (id) on delete cascade,
  code_hash text not null,
  issued_at timestamptz not null default now()
);

create table if not exists private.sessions (
  token_hash text primary key,
  user_id text not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table if not exists private.login_failures (
  name text primary key,
  count int not null default 0,
  locked_until timestamptz
);

-- 앱(공개 키)에서 표를 직접 읽고 쓰지 못하게 한다. 읽기·쓰기는 아래 함수로만 한다.
alter table public.profiles enable row level security;
alter table public.audit_logs enable row level security;
revoke all on public.profiles, public.audit_logs from anon, authenticated;

-- ── 서버 안에서만 쓰는 도우미 ─────────────────────────────────

-- 대문자로 바꾸고 띄어쓰기·하이픈을 지운다
create or replace function private.normalize_code(p_code text) returns text
language sql immutable set search_path = '' as $$
  select upper(regexp_replace(coalesce(p_code, ''), '[[:space:]-]', '', 'g'));
$$;

-- 영문·숫자 6자리. 헷갈리는 0, O, 1, I, L은 쓰지 않는다.
create or replace function private.random_code() returns text
language plpgsql volatile set search_path = '' as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  bytes bytea := extensions.gen_random_bytes(6);
  result text := '';
begin
  for i in 0..5 loop
    result := result || substr(alphabet, get_byte(bytes, i) % length(alphabet) + 1, 1);
  end loop;
  return result;
end;
$$;

-- 이름이 같은 사람끼리는 코드가 겹치지 않게 만든다 (들어올 때 이름 + 코드로 한 명을 찾기 때문)
create or replace function private.new_code_for(p_name text, p_except text default null) returns text
language plpgsql volatile set search_path = '' as $$
declare
  v_code text;
begin
  loop
    v_code := private.random_code();
    exit when not exists (
      select 1 from public.profiles p join private.member_codes c on c.user_id = p.id
      where p.name = p_name and p.id is distinct from p_except
        and c.code_hash = extensions.crypt(v_code, c.code_hash)
    );
  end loop;
  return v_code;
end;
$$;

-- 접속 토큰으로 사람 찾기. 만료됐거나 활성 인원이 아니면 null
create or replace function private.session_profile(p_token text) returns public.profiles
language sql stable set search_path = '' as $$
  select p.* from private.sessions s join public.profiles p on p.id = s.user_id
  where s.token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
    and s.expires_at > now() and p.is_active;
$$;

-- u01, u02 … / o01, o02 … 순서로 다음 번호
create or replace function private.next_profile_id(p_prefix text) returns text
language sql volatile set search_path = '' as $$
  select p_prefix || lpad((coalesce(max(substr(id, 2)::int), 0) + 1)::text, 2, '0')
  from public.profiles where id ~ ('^' || p_prefix || '[0-9]+$');
$$;

create or replace function private.profile_json(p public.profiles) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'id', p.id, 'name', p.name, 'role', p.role, 'position', p.position,
    'enlist_date', p.enlist_date, 'discharge_date', p.discharge_date, 'is_active', p.is_active
  );
$$;

-- ── 앱이 부르는 함수 ──────────────────────────────────────────

-- 들어오기. 결과: { ok: true, token, user } 또는 { ok: false, reason: format | invalid | locked | inactive }
create or replace function public.sign_in(p_name text, p_code text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  max_failures constant int := 5;
  lock_minutes constant int := 10;
  v_name text := btrim(coalesce(p_name, ''));
  v_code text := private.normalize_code(p_code);
  v_fail private.login_failures;
  v_user public.profiles;
  v_token text;
begin
  if v_code !~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$' then
    return jsonb_build_object('ok', false, 'reason', 'format');
  end if;

  select * into v_fail from private.login_failures where name = v_name for update;
  if found and v_fail.locked_until > now() then
    return jsonb_build_object('ok', false, 'reason', 'locked',
      'locked_until', floor(extract(epoch from v_fail.locked_until) * 1000));
  end if;
  if found and v_fail.locked_until is not null then
    -- 잠금 시간이 지나면 실패 횟수를 처음부터 센다
    delete from private.login_failures where name = v_name;
  end if;

  select p.* into v_user from public.profiles p join private.member_codes c on c.user_id = p.id
  where p.name = v_name and c.code_hash = extensions.crypt(v_code, c.code_hash)
  limit 1;

  if v_user.id is null then
    insert into private.login_failures as f (name, count) values (v_name, 1)
    on conflict (name) do update set count = f.count + 1
    returning * into v_fail;
    if v_fail.count >= max_failures then
      update private.login_failures set locked_until = now() + make_interval(mins => lock_minutes)
      where name = v_name returning * into v_fail;
      return jsonb_build_object('ok', false, 'reason', 'locked',
        'locked_until', floor(extract(epoch from v_fail.locked_until) * 1000));
    end if;
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'remaining_attempts', max_failures - v_fail.count);
  end if;

  if not v_user.is_active then
    return jsonb_build_object('ok', false, 'reason', 'inactive');
  end if;

  delete from private.login_failures where name = v_name;
  delete from private.sessions where expires_at <= now();
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into private.sessions (token_hash, user_id, expires_at)
  values (encode(extensions.digest(v_token, 'sha256'), 'hex'), v_user.id, now() + interval '30 days');
  return jsonb_build_object('ok', true, 'token', v_token, 'user', private.profile_json(v_user));
end;
$$;

create or replace function public.sign_out(p_token text) returns jsonb
language sql volatile security definer set search_path = '' as $$
  delete from private.sessions where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');
  select jsonb_build_object('ok', true);
$$;

-- 화면에 필요한 데이터를 한 번에 받는다.
-- 간부: 모든 인원 / 병사: 본인과 간부(상점 준 간부 이름 등)만. 병사 수는 출타 정원 계산용으로 숫자만 준다.
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
    'active_soldiers', (select count(*) from public.profiles where role = 'soldier' and is_active)
  );
end;
$$;

-- 인원 추가 + 코드 발급 (간부만). 결과: { ok: true, user, code } 또는 { ok: false, reason, errors }
create or replace function public.add_member(
  p_token text, p_name text, p_role text, p_position text, p_enlist_date text, p_discharge_date text
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_me public.profiles := private.session_profile(p_token);
  v_name text := btrim(coalesce(p_name, ''));
  v_position text := regexp_replace(btrim(coalesce(p_position, '')), '[[:space:]]+', ' ', 'g');
  v_enlist date;
  v_discharge date;
  v_errors jsonb := '{}'::jsonb;
  v_user public.profiles;
  v_code text;
begin
  if v_me.id is null or v_me.role <> 'officer' then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;

  if v_name = '' then v_errors := v_errors || '{"name": "이름을 입력하세요."}';
  elsif char_length(v_name) > 20 then v_errors := v_errors || '{"name": "이름은 20자 이하로 입력하세요."}';
  end if;
  if p_role is null or p_role not in ('soldier', 'officer') then v_errors := v_errors || '{"role": "역할을 고르세요."}'; end if;
  if v_position = '' then v_errors := v_errors || '{"position": "보직을 입력하세요."}';
  elsif char_length(v_position) > 20 then v_errors := v_errors || '{"position": "보직은 20자 이하로 입력하세요."}';
  end if;
  begin
    v_enlist := p_enlist_date::date;
  exception when others then v_enlist := null;
  end;
  begin
    v_discharge := p_discharge_date::date;
  exception when others then v_discharge := null;
  end;
  if v_enlist is null then v_errors := v_errors || '{"enlist_date": "입대일을 입력하세요."}'; end if;
  if v_discharge is null then v_errors := v_errors || '{"discharge_date": "전역 예정일을 입력하세요."}';
  elsif v_enlist is not null and v_discharge <= v_enlist then
    v_errors := v_errors || '{"discharge_date": "전역 예정일은 입대일보다 뒤여야 합니다."}';
  end if;
  if v_errors <> '{}'::jsonb then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'errors', v_errors);
  end if;

  -- 두 간부가 동시에 추가해도 번호가 겹치지 않게 잠근다
  lock table public.profiles in share row exclusive mode;
  insert into public.profiles (id, name, role, position, enlist_date, discharge_date)
  values (private.next_profile_id(case when p_role = 'officer' then 'o' else 'u' end),
          v_name, p_role, v_position, v_enlist, v_discharge)
  returning * into v_user;
  v_code := private.new_code_for(v_name, v_user.id);
  insert into private.member_codes (user_id, code_hash) values (v_user.id, extensions.crypt(v_code, extensions.gen_salt('bf', 8)));
  insert into public.audit_logs (actor_id, action, target_table, target_id) values (v_me.id, 'issue_code', 'profiles', v_user.id);
  return jsonb_build_object('ok', true, 'user', private.profile_json(v_user), 'code', v_code);
end;
$$;

-- 코드 다시 발급 (간부만). 이전 코드는 바로 못 쓰고, 그 사람이 들어와 있던 기기도 나가진다.
create or replace function public.reissue_code(p_token text, p_user_id text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_me public.profiles := private.session_profile(p_token);
  v_user public.profiles;
  v_code text;
begin
  if v_me.id is null or v_me.role <> 'officer' then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;
  select * into v_user from public.profiles where id = p_user_id and is_active;
  if v_user.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  v_code := private.new_code_for(v_user.name, v_user.id);
  insert into private.member_codes (user_id, code_hash) values (v_user.id, extensions.crypt(v_code, extensions.gen_salt('bf', 8)))
  on conflict (user_id) do update set code_hash = excluded.code_hash, issued_at = now();
  delete from private.sessions
  where user_id = v_user.id and token_hash <> encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');
  insert into public.audit_logs (actor_id, action, target_table, target_id) values (v_me.id, 'reissue_code', 'profiles', v_user.id);
  return jsonb_build_object('ok', true, 'user', private.profile_json(v_user), 'code', v_code);
end;
$$;

-- 앱(공개 키)에는 위 다섯 함수만 연다
revoke execute on all functions in schema private from public, anon, authenticated;
revoke execute on function public.sign_in(text, text) from public, anon, authenticated;
revoke execute on function public.sign_out(text) from public, anon, authenticated;
revoke execute on function public.load_state(text) from public, anon, authenticated;
revoke execute on function public.add_member(text, text, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.reissue_code(text, text) from public, anon, authenticated;
grant execute on function public.sign_in(text, text) to anon, authenticated;
grant execute on function public.sign_out(text) to anon, authenticated;
grant execute on function public.load_state(text) to anon, authenticated;
grant execute on function public.add_member(text, text, text, text, text, text) to anon, authenticated;
grant execute on function public.reissue_code(text, text) to anon, authenticated;

-- ── 가상 인원 (연습용, js/mock-data.js와 같은 사람·같은 코드) ─────────
-- 모두 지어낸 이름이다. 실제 병사 정보를 넣지 않는다. 이미 있는 인원은 건드리지 않는다.
insert into public.profiles (id, name, role, position, enlist_date, discharge_date, is_active) values
  ('u01', '김하늘', 'soldier', '소총수', '2025-05-04', '2026-11-03', true),
  ('u02', '이바다', 'soldier', '운전병', '2025-05-29', '2026-11-28', true),
  ('u03', '박가온', 'soldier', '취사병', '2025-06-23', '2026-12-22', true),
  ('u04', '최나래', 'soldier', '통신병', '2025-07-18', '2027-01-17', true),
  ('u05', '정다온', 'soldier', '의무병', '2025-08-12', '2027-02-11', true),
  ('u06', '강보람', 'soldier', '행정병', '2025-09-06', '2027-03-05', true),
  ('u07', '조새벽', 'soldier', '정비병', '2025-10-01', '2027-03-31', true),
  ('u08', '윤겨울', 'soldier', '소총수', '2025-10-26', '2027-04-25', true),
  ('u09', '장한결', 'soldier', '소총수', '2025-11-20', '2027-05-19', true),
  ('u10', '임도담', 'soldier', '경계병', '2025-12-15', '2027-06-14', true),
  ('u11', '한마루', 'soldier', '소총수', '2026-01-09', '2027-07-08', true),
  ('u12', '오여름', 'soldier', '운전병', '2026-02-03', '2027-08-02', true),
  ('u13', '서누리', 'soldier', '취사병', '2026-02-28', '2027-08-27', true),
  ('u14', '신다솜', 'soldier', '통신병', '2026-03-25', '2027-09-24', true),
  ('u15', '권별하', 'soldier', '의무병', '2026-04-19', '2027-10-18', true),
  ('u16', '황이랑', 'soldier', '행정병', '2026-05-14', '2027-11-13', true),
  ('u17', '안소울', 'soldier', '정비병', '2026-06-08', '2027-12-07', true),
  ('u18', '송하람', 'soldier', '소총수', '2026-07-03', '2028-01-02', true),
  ('u19', '전가람', 'soldier', '소총수', '2026-07-28', '2028-01-27', true),
  ('u20', '홍새롬', 'soldier', '경계병', '2026-08-22', '2028-02-21', true),
  ('o01', '백지훈', 'officer', '중대장', '2019-03-04', '2029-02-28', true),
  ('o02', '남궁현', 'officer', '행정보급관', '2021-06-14', '2027-06-30', true)
on conflict (id) do nothing;

insert into private.member_codes (user_id, code_hash)
select v.id, extensions.crypt(v.code, extensions.gen_salt('bf', 8)) from (values
  ('u01', 'CZUTP6'),
  ('u02', 'X4DVGP'),
  ('u03', 'KM9YWP'),
  ('u04', 'PESAZ9'),
  ('u05', 'W95HUP'),
  ('u06', 'T3TTC3'),
  ('u07', 'R2M4MF'),
  ('u08', '4DEGQ6'),
  ('u09', '5C3E45'),
  ('u10', 'U5QXRQ'),
  ('u11', '8J4HNN'),
  ('u12', 'JTP49P'),
  ('u13', 'NGQETQ'),
  ('u14', '2YANKY'),
  ('u15', 'AVYQTT'),
  ('u16', 'JE3HGK'),
  ('u17', 'JQYGNU'),
  ('u18', 'CXVEDD'),
  ('u19', 'WTRKUD'),
  ('u20', 'W97YAV'),
  ('o01', 'YCM2Y5'),
  ('o02', 'BQEPH8')
) as v (id, code)
on conflict (user_id) do nothing;
