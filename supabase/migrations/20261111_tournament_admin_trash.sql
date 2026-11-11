-- КиберРадар: редактирование турниров из любых источников и корзина на 7 дней.
-- Выполнить один раз в Supabase SQL Editor ПОСЛЕ публикации файлов сайта.

create table if not exists public.tournament_overrides (
  source_id text primary key,
  patch jsonb not null default '{}'::jsonb,
  is_trashed boolean not null default false,
  permanently_hidden boolean not null default false,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table public.tournament_overrides enable row level security;

drop policy if exists "tournament_overrides: public read" on public.tournament_overrides;
create policy "tournament_overrides: public read" on public.tournament_overrides
  for select to anon, authenticated using (true);
drop policy if exists "tournament_overrides: admin insert" on public.tournament_overrides;
create policy "tournament_overrides: admin insert" on public.tournament_overrides
  for insert to authenticated with check (public.is_admin());
drop policy if exists "tournament_overrides: admin update" on public.tournament_overrides;
create policy "tournament_overrides: admin update" on public.tournament_overrides
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "tournament_overrides: admin delete" on public.tournament_overrides;
create policy "tournament_overrides: admin delete" on public.tournament_overrides
  for delete to authenticated using (public.is_admin());
grant select on public.tournament_overrides to anon, authenticated;
grant insert, update, delete on public.tournament_overrides to authenticated;

create table if not exists public.tournament_trash (
  source_id text primary key,
  source_type text not null check (source_type in ('manual','faceit','vk','static')),
  snapshot jsonb not null,
  deleted_at timestamptz not null default now(),
  purge_at timestamptz not null default (now() + interval '7 days'),
  deleted_by uuid references auth.users(id) on delete set null
);
alter table public.tournament_trash enable row level security;
drop policy if exists "tournament_trash: admin only" on public.tournament_trash;
create policy "tournament_trash: admin only" on public.tournament_trash
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
grant select, insert, update, delete on public.tournament_trash to authenticated;

create or replace function public.trash_tournament(p_source_id text, p_source_type text, p_snapshot jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'admin access required'; end if;
  if p_source_id is null or length(p_source_id) < 1 or length(p_source_id) > 200 then raise exception 'invalid source id'; end if;
  if p_source_type not in ('manual','faceit','vk','static') then raise exception 'invalid source type'; end if;
  insert into public.tournament_trash(source_id, source_type, snapshot, deleted_at, purge_at, deleted_by)
  values (p_source_id, p_source_type, coalesce(p_snapshot, '{}'::jsonb), now(), now() + interval '7 days', auth.uid())
  on conflict (source_id) do update set source_type = excluded.source_type, snapshot = excluded.snapshot,
    deleted_at = now(), purge_at = now() + interval '7 days', deleted_by = auth.uid();
  insert into public.tournament_overrides(source_id, patch, is_trashed, permanently_hidden, updated_by, updated_at)
  values (p_source_id, '{}'::jsonb, true, false, auth.uid(), now())
  on conflict (source_id) do update set is_trashed = true, permanently_hidden = false,
    updated_by = auth.uid(), updated_at = now();
end;
$$;

create or replace function public.restore_tournament(p_source_id text)
returns void language plpgsql security definer set search_path = public as $$
declare
  tr public.tournament_trash%rowtype;
  restored_patch jsonb;
  restored_data jsonb;
begin
  if not public.is_admin() then raise exception 'admin access required'; end if;
  select * into tr from public.tournament_trash
    where source_id = p_source_id and purge_at > now() for update;
  if not found then raise exception 'tournament is not in the active trash'; end if;

  -- Сохраняем правки, сделанные до удаления.
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into restored_patch
  from jsonb_each(tr.snapshot)
  where key = any(array['name','disc','kind','format','city','op','platform','team','teams','start','end','tba','startsAt','regEnd','prize','fee','desc','fee_note','contact','site','siteName','student','ru']);

  update public.tournament_overrides
    set patch = restored_patch, is_trashed = false, permanently_hidden = false,
        updated_by = auth.uid(), updated_at = now()
    where source_id = p_source_id;

  -- Для внешних источников создаём резервную запись в ручном каталоге.
  -- Если исходный JSON ещё содержит турнир, allTournaments() дедуплицирует запись по исходному ID.
  -- Если источник уже удалил старый анонс, восстановленная запись всё равно вернётся в каталог.
  if tr.source_type <> 'manual' then
    restored_data := (tr.snapshot - array['id','st','_sourceId','manual','restored_source_id'])
      || jsonb_build_object('restored_source_id', p_source_id);
    insert into public.tournaments(data, expires_at, created_by)
    values (restored_data, null, auth.uid());
  end if;

  delete from public.tournament_trash where source_id = p_source_id;
end;
$$;

create or replace function public.purge_expired_tournament_trash()
returns integer language plpgsql security definer set search_path = public as $$
declare r record; removed integer := 0; manual_id text;
begin
  -- Cron запускается без JWT (auth.uid() = NULL); пользовательский вызов разрешён только администратору.
  if auth.uid() is not null and not public.is_admin() then raise exception 'admin access required'; end if;
  for r in select source_id from public.tournament_trash where purge_at <= now() for update loop
    if r.source_id ~ '^m-[0-9a-fA-F-]{36}$' then
      manual_id := substring(r.source_id from 3);
      delete from public.tournaments where id::text = manual_id;
    end if;
    -- Удаляем резервную копию, созданную при восстановлении внешнего события.
    delete from public.tournaments where data->>'restored_source_id' = r.source_id;
    insert into public.tournament_overrides(source_id, patch, is_trashed, permanently_hidden, updated_at)
      values (r.source_id, '{}'::jsonb, false, true, now())
    on conflict (source_id) do update set patch = '{}'::jsonb, is_trashed = false,
      permanently_hidden = true, updated_at = now();
    delete from public.tournament_trash where source_id = r.source_id;
    removed := removed + 1;
  end loop;
  return removed;
end;
$$;

revoke all on function public.trash_tournament(text,text,jsonb) from public;
revoke all on function public.restore_tournament(text) from public;
revoke all on function public.purge_expired_tournament_trash() from public;
grant execute on function public.trash_tournament(text,text,jsonb) to authenticated;
grant execute on function public.restore_tournament(text) to authenticated;
grant execute on function public.purge_expired_tournament_trash() to authenticated;

-- Если pg_cron включён (Database → Extensions), очищаем корзину каждые 5 минут.
-- Без pg_cron очистка выполняется при открытии администратором админ-панели.
do $$
declare existing_job_id bigint;
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    select jobid into existing_job_id from cron.job where jobname = 'kiberradar-purge-tournament-trash' limit 1;
    if existing_job_id is not null then perform cron.unschedule(existing_job_id); end if;
    perform cron.schedule('kiberradar-purge-tournament-trash', '*/5 * * * *',
      'select public.purge_expired_tournament_trash();');
  else
    raise notice 'pg_cron is not enabled. Enable it in Database → Extensions to purge trash automatically.';
  end if;
end $$;
