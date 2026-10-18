-- КиберРадар: схема базы Supabase (аккаунты, роли, турниры администратора).
-- Выполнить один раз: Supabase → SQL Editor → New query → вставить весь файл → Run.

-- 1. Профили: роль пользователя ('user' или 'admin').
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  role text not null default 'user' check (role in ('user', 'admin')),
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

-- Пользователь видит только свою строку. Политик на изменение нет, поэтому сменить себе роль через сайт невозможно.
drop policy if exists "profiles: read own" on public.profiles;
create policy "profiles: read own" on public.profiles for select using (auth.uid() = id);

-- При регистрации автоматически создаётся профиль с ролью 'user'.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email);
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- Проверка «текущий пользователь — администратор» (используется в политиках ниже).
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- 2. Турниры, добавленные вручную.
create table if not exists public.tournaments (
  id uuid primary key default gen_random_uuid(),
  data jsonb not null,                 -- все поля турнира (название, даты, призы и т.д.)
  expires_at timestamptz,              -- после этого момента турнир не показывается и удаляется
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.tournaments enable row level security;

drop policy if exists "tournaments: public read active" on public.tournaments;
create policy "tournaments: public read active" on public.tournaments for select
  using (expires_at is null or expires_at > now());          -- посетители видят только неистёкшие

drop policy if exists "tournaments: admin read all" on public.tournaments;
create policy "tournaments: admin read all" on public.tournaments for select using (public.is_admin());

drop policy if exists "tournaments: admin insert" on public.tournaments;
create policy "tournaments: admin insert" on public.tournaments for insert with check (public.is_admin());

drop policy if exists "tournaments: admin update" on public.tournaments;
create policy "tournaments: admin update" on public.tournaments for update using (public.is_admin()) with check (public.is_admin());

drop policy if exists "tournaments: admin delete" on public.tournaments;
create policy "tournaments: admin delete" on public.tournaments for delete using (public.is_admin());

-- 3. Сделать себя администратором. СНАЧАЛА зарегистрируйтесь на сайте этой почтой и подтвердите её, ПОТОМ выполните:
-- update public.profiles set role = 'admin' where email = 'dezhenkov62@gmail.com';
