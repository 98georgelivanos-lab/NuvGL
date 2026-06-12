-- Streamfield account sync — minimal schema for sharing addon lists
-- across devices/apps (e.g. a future NuvioTV build pointed at the same project).
--
-- Run this once in your Supabase project's SQL Editor
-- (Dashboard -> SQL Editor -> New query -> paste -> Run).

create extension if not exists pgcrypto;

-- Linked devices (multi-device account sync) — created early since other
-- tables' RLS policies reference it.
create table if not exists public.linked_devices (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  device_user_id uuid not null references auth.users(id) on delete cascade,
  device_name text,
  linked_at timestamptz not null default now(),
  unique (owner_id, device_user_id)
);

alter table public.linked_devices enable row level security;

create policy "Owners and devices can view their links"
  on public.linked_devices
  for select
  using (auth.uid() = owner_id or auth.uid() = device_user_id);

create policy "Owners manage their linked devices"
  on public.linked_devices
  for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

create table if not exists public.addons (
  user_id uuid not null references auth.users(id) on delete cascade,
  profile_id int not null default 1,
  url text not null,
  sort_order int not null default 0,
  enabled boolean not null default true,
  name text,
  updated_at timestamptz not null default now(),
  primary key (user_id, profile_id, url)
);

alter table public.addons enable row level security;

drop policy if exists "Users manage their own addons" on public.addons;
create policy "Users manage their own addons"
  on public.addons
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Linked devices can read owner addons"
  on public.addons
  for select
  using (
    exists (
      select 1 from public.linked_devices
      where owner_id = addons.user_id and device_user_id = auth.uid()
    )
  );

-- Replace the full addon list for a profile in one call.
create or replace function public.sync_push_addons(p_addons jsonb, p_profile_id int default 1)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := public.get_sync_owner();
  item jsonb;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  delete from public.addons where user_id = uid and profile_id = p_profile_id;

  for item in select * from jsonb_array_elements(p_addons) loop
    insert into public.addons (user_id, profile_id, url, sort_order, enabled, name)
    values (
      uid,
      p_profile_id,
      item->>'url',
      coalesce((item->>'sort_order')::int, 0),
      coalesce((item->>'enabled')::boolean, true),
      item->>'name'
    );
  end loop;
end;
$$;

grant execute on function public.sync_push_addons(jsonb, int) to authenticated;

-- ============================================================================
-- Sync ownership (multi-device account sync)
-- ============================================================================

-- NuvioTV calls this to resolve which user's data a device should sync
-- against. If this device has been linked to another account, sync uses
-- that account's data; otherwise it's the signed-in user themself.
create or replace function public.get_sync_owner()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select owner_id from public.linked_devices where device_user_id = auth.uid() limit 1),
    auth.uid()
  );
$$;

grant execute on function public.get_sync_owner() to authenticated;

create or replace function public.unlink_device(p_device_user_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  delete from public.linked_devices
  where owner_id = auth.uid() and device_user_id = p_device_user_id::uuid;
end;
$$;

grant execute on function public.unlink_device(text) to authenticated;

-- Sync codes let a second device link itself to this account.
create table if not exists public.sync_codes (
  code text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  pin_hash text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.sync_codes enable row level security;
-- No direct table access; everything goes through the RPCs below.

create or replace function public.generate_sync_code(p_pin text)
returns table(code text)
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  new_code text;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;
  if p_pin is null or length(p_pin) < 4 then
    raise exception 'PIN must be at least 4 characters';
  end if;

  delete from public.sync_codes where owner_id = uid;

  new_code := upper(substr(encode(gen_random_bytes(4), 'hex'), 1, 6));

  insert into public.sync_codes (code, owner_id, pin_hash, expires_at)
  values (new_code, uid, crypt(p_pin, gen_salt('bf')), now() + interval '15 minutes');

  return query select new_code;
end;
$$;

grant execute on function public.generate_sync_code(text) to authenticated;

create or replace function public.get_sync_code(p_pin text)
returns table(code text)
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  rec record;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  select * into rec from public.sync_codes
  where owner_id = uid and expires_at > now()
  order by created_at desc
  limit 1;

  if rec is null or rec.pin_hash != crypt(p_pin, rec.pin_hash) then
    raise exception 'No active sync code for this PIN';
  end if;

  return query select rec.code;
end;
$$;

grant execute on function public.get_sync_code(text) to authenticated;

create or replace function public.claim_sync_code(p_code text, p_pin text, p_device_name text default null)
returns table(result_owner_id uuid, success boolean, message text)
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  rec record;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  select * into rec from public.sync_codes
  where code = upper(p_code) and expires_at > now();

  if rec is null then
    return query select null::uuid, false, 'Invalid or expired code';
    return;
  end if;

  if rec.pin_hash != crypt(p_pin, rec.pin_hash) then
    return query select null::uuid, false, 'Incorrect PIN';
    return;
  end if;

  if rec.owner_id = uid then
    return query select null::uuid, false, 'Cannot link a device to itself';
    return;
  end if;

  insert into public.linked_devices (owner_id, device_user_id, device_name)
  values (rec.owner_id, uid, p_device_name)
  on conflict (owner_id, device_user_id) do update set device_name = excluded.device_name;

  delete from public.sync_codes where code = rec.code;

  return query select rec.owner_id, true, 'Linked successfully';
end;
$$;

grant execute on function public.claim_sync_code(text, text, text) to authenticated;

-- ============================================================================
-- Plugins (NuvioTV plugin repos, mirrors addons)
-- ============================================================================

create table if not exists public.plugins (
  user_id uuid not null references auth.users(id) on delete cascade,
  profile_id int not null default 1,
  url text not null,
  name text,
  enabled boolean not null default true,
  sort_order int not null default 0,
  repo_type text,
  updated_at timestamptz not null default now(),
  primary key (user_id, profile_id, url)
);

alter table public.plugins enable row level security;

create policy "Users manage their own plugins"
  on public.plugins
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Linked devices can read owner plugins"
  on public.plugins
  for select
  using (
    exists (
      select 1 from public.linked_devices
      where owner_id = plugins.user_id and device_user_id = auth.uid()
    )
  );

create or replace function public.sync_push_plugins(p_plugins jsonb, p_profile_id int default 1)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := public.get_sync_owner();
  item jsonb;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  delete from public.plugins where user_id = uid and profile_id = p_profile_id;

  for item in select * from jsonb_array_elements(p_plugins) loop
    insert into public.plugins (user_id, profile_id, url, name, enabled, sort_order, repo_type)
    values (
      uid,
      p_profile_id,
      item->>'url',
      item->>'name',
      coalesce((item->>'enabled')::boolean, true),
      coalesce((item->>'sort_order')::int, 0),
      item->>'repo_type'
    );
  end loop;
end;
$$;

grant execute on function public.sync_push_plugins(jsonb, int) to authenticated;

-- ============================================================================
-- Library (saved/bookmarked content)
-- ============================================================================

create table if not exists public.library_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  profile_id int not null default 1,
  content_id text not null,
  content_type text not null,
  name text not null default '',
  poster text,
  poster_shape text not null default 'POSTER',
  background text,
  description text,
  release_info text,
  imdb_rating real,
  genres jsonb not null default '[]'::jsonb,
  addon_base_url text,
  added_at bigint not null default 0,
  updated_at timestamptz not null default now(),
  unique (user_id, profile_id, content_id, content_type)
);

alter table public.library_items enable row level security;

create policy "Users manage their own library items"
  on public.library_items
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create or replace function public.sync_push_library(p_items jsonb, p_profile_id int default 1)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := public.get_sync_owner();
  item jsonb;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  for item in select * from jsonb_array_elements(p_items) loop
    insert into public.library_items (
      user_id, profile_id, content_id, content_type, name, poster, poster_shape,
      background, description, release_info, imdb_rating, genres, addon_base_url, added_at, updated_at
    )
    values (
      uid,
      p_profile_id,
      item->>'content_id',
      item->>'content_type',
      coalesce(item->>'name', ''),
      item->>'poster',
      coalesce(item->>'poster_shape', 'POSTER'),
      item->>'background',
      item->>'description',
      item->>'release_info',
      (item->>'imdb_rating')::real,
      coalesce(item->'genres', '[]'::jsonb),
      item->>'addon_base_url',
      coalesce((item->>'added_at')::bigint, 0),
      now()
    )
    on conflict (user_id, profile_id, content_id, content_type) do update set
      name = excluded.name,
      poster = excluded.poster,
      poster_shape = excluded.poster_shape,
      background = excluded.background,
      description = excluded.description,
      release_info = excluded.release_info,
      imdb_rating = excluded.imdb_rating,
      genres = excluded.genres,
      addon_base_url = excluded.addon_base_url,
      added_at = excluded.added_at,
      updated_at = now();
  end loop;
end;
$$;

grant execute on function public.sync_push_library(jsonb, int) to authenticated;

create or replace function public.sync_pull_library(p_profile_id int default 1, p_limit int default 200, p_offset int default 0)
returns setof public.library_items
language sql
stable
security definer
set search_path = public
as $$
  select * from public.library_items
  where user_id = public.get_sync_owner() and profile_id = p_profile_id
  order by added_at desc
  limit p_limit offset p_offset;
$$;

grant execute on function public.sync_pull_library(int, int, int) to authenticated;

-- Remove library items server-side when they're deleted locally — without
-- this, sync_push_library (upsert-only) can never propagate a removal and
-- the next pull resurrects deleted items on every client.
-- p_keys: [{ "content_id": "...", "content_type": "..." }, ...]
create or replace function public.sync_delete_library(p_keys jsonb default '[]'::jsonb, p_profile_id int default 1)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := public.get_sync_owner();
  item jsonb;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  for item in select * from jsonb_array_elements(p_keys) loop
    delete from public.library_items
    where user_id = uid
      and profile_id = p_profile_id
      and content_id = item->>'content_id'
      and content_type = item->>'content_type';
  end loop;
end;
$$;

grant execute on function public.sync_delete_library(jsonb, int) to authenticated;

-- ============================================================================
-- Watch progress (with delta change-log for incremental sync)
-- ============================================================================

create table if not exists public.watch_progress (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  profile_id int not null default 1,
  content_id text not null,
  content_type text not null,
  video_id text not null,
  season int,
  episode int,
  position bigint not null default 0,
  duration bigint not null default 0,
  last_watched bigint not null default 0,
  progress_key text not null,
  updated_at timestamptz not null default now(),
  unique (user_id, profile_id, progress_key)
);

alter table public.watch_progress enable row level security;

create policy "Users manage their own watch progress"
  on public.watch_progress
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create table if not exists public.watch_progress_events (
  event_id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  profile_id int not null default 1,
  operation text not null,
  progress_key text not null,
  content_id text not null default '',
  content_type text not null default '',
  video_id text not null default '',
  season int,
  episode int,
  position bigint not null default 0,
  duration bigint not null default 0,
  last_watched bigint not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists watch_progress_events_user_profile_idx
  on public.watch_progress_events (user_id, profile_id, event_id);

alter table public.watch_progress_events enable row level security;

create policy "Users manage their own watch progress events"
  on public.watch_progress_events
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create or replace function public.sync_push_watch_progress(p_entries jsonb, p_profile_id int default 1)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := public.get_sync_owner();
  item jsonb;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  for item in select * from jsonb_array_elements(p_entries) loop
    insert into public.watch_progress (
      user_id, profile_id, content_id, content_type, video_id, season, episode,
      position, duration, last_watched, progress_key, updated_at
    )
    values (
      uid,
      p_profile_id,
      item->>'content_id',
      item->>'content_type',
      item->>'video_id',
      (item->>'season')::int,
      (item->>'episode')::int,
      coalesce((item->>'position')::bigint, 0),
      coalesce((item->>'duration')::bigint, 0),
      coalesce((item->>'last_watched')::bigint, 0),
      item->>'progress_key',
      now()
    )
    on conflict (user_id, profile_id, progress_key) do update set
      content_id = excluded.content_id,
      content_type = excluded.content_type,
      video_id = excluded.video_id,
      season = excluded.season,
      episode = excluded.episode,
      position = excluded.position,
      duration = excluded.duration,
      last_watched = excluded.last_watched,
      updated_at = now();

    insert into public.watch_progress_events (
      user_id, profile_id, operation, progress_key, content_id, content_type, video_id,
      season, episode, position, duration, last_watched
    )
    values (
      uid,
      p_profile_id,
      'upsert',
      item->>'progress_key',
      item->>'content_id',
      item->>'content_type',
      item->>'video_id',
      (item->>'season')::int,
      (item->>'episode')::int,
      coalesce((item->>'position')::bigint, 0),
      coalesce((item->>'duration')::bigint, 0),
      coalesce((item->>'last_watched')::bigint, 0)
    );
  end loop;
end;
$$;

grant execute on function public.sync_push_watch_progress(jsonb, int) to authenticated;

create or replace function public.sync_pull_watch_progress(p_profile_id int default 1, p_since_last_watched bigint default null, p_limit int default null)
returns setof public.watch_progress
language sql
stable
security definer
set search_path = public
as $$
  select * from public.watch_progress
  where user_id = public.get_sync_owner()
    and profile_id = p_profile_id
    and (p_since_last_watched is null or last_watched > p_since_last_watched)
  order by last_watched desc
  limit coalesce(p_limit, 9223372036854775807);
$$;

grant execute on function public.sync_pull_watch_progress(int, bigint, int) to authenticated;

create or replace function public.sync_get_watch_progress_delta_cursor(p_profile_id int default 1)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(max(event_id), 0) from public.watch_progress_events
  where user_id = public.get_sync_owner() and profile_id = p_profile_id;
$$;

grant execute on function public.sync_get_watch_progress_delta_cursor(int) to authenticated;

create or replace function public.sync_pull_watch_progress_delta(p_profile_id int default 1, p_since_event_id bigint default 0, p_limit int default 500)
returns setof public.watch_progress_events
language sql
stable
security definer
set search_path = public
as $$
  select * from public.watch_progress_events
  where user_id = public.get_sync_owner()
    and profile_id = p_profile_id
    and event_id > p_since_event_id
  order by event_id asc
  limit p_limit;
$$;

grant execute on function public.sync_pull_watch_progress_delta(int, bigint, int) to authenticated;

create or replace function public.sync_delete_watch_progress(p_keys text[], p_profile_id int default 1)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := public.get_sync_owner();
  k text;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  delete from public.watch_progress
  where user_id = uid and profile_id = p_profile_id and progress_key = any(p_keys);

  foreach k in array p_keys loop
    insert into public.watch_progress_events (user_id, profile_id, operation, progress_key)
    values (uid, p_profile_id, 'delete', k);
  end loop;
end;
$$;

grant execute on function public.sync_delete_watch_progress(text[], int) to authenticated;

-- ============================================================================
-- Watched items (with delta change-log for incremental sync)
-- ============================================================================

create table if not exists public.watched_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  profile_id int not null default 1,
  content_id text not null,
  content_type text not null,
  title text not null default '',
  season int,
  episode int,
  watched_at bigint not null default 0,
  updated_at timestamptz not null default now()
);

create unique index if not exists watched_items_unique_key
  on public.watched_items (user_id, profile_id, content_id, coalesce(season, -1), coalesce(episode, -1));

alter table public.watched_items enable row level security;

create policy "Users manage their own watched items"
  on public.watched_items
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create table if not exists public.watched_items_events (
  event_id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  profile_id int not null default 1,
  operation text not null,
  content_id text not null default '',
  content_type text not null default '',
  title text not null default '',
  season int,
  episode int,
  watched_at bigint not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists watched_items_events_user_profile_idx
  on public.watched_items_events (user_id, profile_id, event_id);

alter table public.watched_items_events enable row level security;

create policy "Users manage their own watched items events"
  on public.watched_items_events
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create or replace function public.sync_push_watched_items(p_items jsonb, p_profile_id int default 1)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := public.get_sync_owner();
  item jsonb;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  for item in select * from jsonb_array_elements(p_items) loop
    insert into public.watched_items (
      user_id, profile_id, content_id, content_type, title, season, episode, watched_at, updated_at
    )
    values (
      uid,
      p_profile_id,
      item->>'content_id',
      item->>'content_type',
      coalesce(item->>'title', ''),
      (item->>'season')::int,
      (item->>'episode')::int,
      coalesce((item->>'watched_at')::bigint, 0),
      now()
    )
    on conflict (user_id, profile_id, content_id, coalesce(season, -1), coalesce(episode, -1)) do update set
      content_type = excluded.content_type,
      title = excluded.title,
      watched_at = excluded.watched_at,
      updated_at = now();

    insert into public.watched_items_events (
      user_id, profile_id, operation, content_id, content_type, title, season, episode, watched_at
    )
    values (
      uid,
      p_profile_id,
      'upsert',
      item->>'content_id',
      item->>'content_type',
      coalesce(item->>'title', ''),
      (item->>'season')::int,
      (item->>'episode')::int,
      coalesce((item->>'watched_at')::bigint, 0)
    );
  end loop;
end;
$$;

grant execute on function public.sync_push_watched_items(jsonb, int) to authenticated;

create or replace function public.sync_pull_watched_items(p_profile_id int default 1, p_page int default 1, p_page_size int default 100)
returns setof public.watched_items
language sql
stable
security definer
set search_path = public
as $$
  select * from public.watched_items
  where user_id = public.get_sync_owner() and profile_id = p_profile_id
  order by watched_at desc
  limit p_page_size offset greatest(p_page - 1, 0) * p_page_size;
$$;

grant execute on function public.sync_pull_watched_items(int, int, int) to authenticated;

create or replace function public.sync_get_watched_items_delta_cursor(p_profile_id int default 1)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(max(event_id), 0) from public.watched_items_events
  where user_id = public.get_sync_owner() and profile_id = p_profile_id;
$$;

grant execute on function public.sync_get_watched_items_delta_cursor(int) to authenticated;

create or replace function public.sync_pull_watched_items_delta(p_profile_id int default 1, p_since_event_id bigint default 0, p_limit int default 500)
returns setof public.watched_items_events
language sql
stable
security definer
set search_path = public
as $$
  select * from public.watched_items_events
  where user_id = public.get_sync_owner()
    and profile_id = p_profile_id
    and event_id > p_since_event_id
  order by event_id asc
  limit p_limit;
$$;

grant execute on function public.sync_pull_watched_items_delta(int, bigint, int) to authenticated;

create or replace function public.sync_delete_watched_items(p_profile_id int default 1, p_keys jsonb default '[]'::jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := public.get_sync_owner();
  k jsonb;
  k_content_id text;
  k_season int;
  k_episode int;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  for k in select * from jsonb_array_elements(p_keys) loop
    k_content_id := k->>'content_id';
    k_season := (k->>'season')::int;
    k_episode := (k->>'episode')::int;

    delete from public.watched_items
    where user_id = uid and profile_id = p_profile_id
      and content_id = k_content_id
      and coalesce(season, -1) = coalesce(k_season, -1)
      and coalesce(episode, -1) = coalesce(k_episode, -1);

    insert into public.watched_items_events (user_id, profile_id, operation, content_id, season, episode)
    values (uid, p_profile_id, 'delete', k_content_id, k_season, k_episode);
  end loop;
end;
$$;

grant execute on function public.sync_delete_watched_items(int, jsonb) to authenticated;

-- ============================================================================
-- Profiles
-- ============================================================================

create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  profile_index int not null,
  name text not null default '',
  avatar_color_hex text not null default '#1E88E5',
  uses_primary_addons boolean not null default false,
  uses_primary_plugins boolean not null default false,
  avatar_id text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, profile_index)
);

alter table public.profiles enable row level security;

create policy "Users manage their own profiles"
  on public.profiles
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create or replace function public.sync_push_profiles(p_client_max_profiles int default 5, p_profiles jsonb default '[]'::jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := public.get_sync_owner();
  item jsonb;
  kept_indices int[] := '{}';
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  for item in select * from jsonb_array_elements(p_profiles) loop
    if (item->>'profile_index')::int is null then
      continue;
    end if;
    if array_length(kept_indices, 1) is not null and array_length(kept_indices, 1) >= p_client_max_profiles then
      exit;
    end if;

    kept_indices := kept_indices || (item->>'profile_index')::int;

    insert into public.profiles (
      user_id, profile_index, name, avatar_color_hex, uses_primary_addons, uses_primary_plugins,
      avatar_id, avatar_url, updated_at
    )
    values (
      uid,
      (item->>'profile_index')::int,
      coalesce(item->>'name', ''),
      coalesce(item->>'avatar_color_hex', '#1E88E5'),
      coalesce((item->>'uses_primary_addons')::boolean, false),
      coalesce((item->>'uses_primary_plugins')::boolean, false),
      item->>'avatar_id',
      item->>'avatar_url',
      now()
    )
    on conflict (user_id, profile_index) do update set
      name = excluded.name,
      avatar_color_hex = excluded.avatar_color_hex,
      uses_primary_addons = excluded.uses_primary_addons,
      uses_primary_plugins = excluded.uses_primary_plugins,
      avatar_id = excluded.avatar_id,
      avatar_url = excluded.avatar_url,
      updated_at = now();
  end loop;

  delete from public.profiles
  where user_id = uid
    and (array_length(kept_indices, 1) is null or profile_index <> all (kept_indices));
end;
$$;

grant execute on function public.sync_push_profiles(int, jsonb) to authenticated;

create or replace function public.sync_pull_profiles()
returns setof public.profiles
language sql
stable
security definer
set search_path = public
as $$
  select * from public.profiles
  where user_id = public.get_sync_owner()
  order by profile_index;
$$;

grant execute on function public.sync_pull_profiles() to authenticated;

create or replace function public.sync_delete_profile_data(p_profile_id int)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := public.get_sync_owner();
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  delete from public.addons where user_id = uid and profile_id = p_profile_id;
  delete from public.plugins where user_id = uid and profile_id = p_profile_id;
  delete from public.library_items where user_id = uid and profile_id = p_profile_id;
  delete from public.watch_progress where user_id = uid and profile_id = p_profile_id;
  delete from public.watch_progress_events where user_id = uid and profile_id = p_profile_id;
  delete from public.watched_items where user_id = uid and profile_id = p_profile_id;
  delete from public.watched_items_events where user_id = uid and profile_id = p_profile_id;
  delete from public.profile_settings_blobs where user_id = uid and profile_id = p_profile_id;
  delete from public.collections_blobs where user_id = uid and profile_id = p_profile_id;
  delete from public.home_catalog_settings_blobs where user_id = uid and profile_id = p_profile_id;
  delete from public.profile_pins where user_id = uid and profile_index = p_profile_id;
end;
$$;

grant execute on function public.sync_delete_profile_data(int) to authenticated;

-- ============================================================================
-- Profile PINs
-- ============================================================================

create table if not exists public.profile_pins (
  user_id uuid not null references auth.users(id) on delete cascade,
  profile_index int not null,
  pin_hash text,
  pin_enabled boolean not null default false,
  failed_attempts int not null default 0,
  pin_locked_until timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, profile_index)
);

alter table public.profile_pins enable row level security;

create policy "Users manage their own profile pins"
  on public.profile_pins
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create or replace function public.sync_pull_profile_locks()
returns table(profile_index int, pin_enabled boolean, pin_locked_until timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select profile_index, pin_enabled, pin_locked_until
  from public.profile_pins
  where user_id = public.get_sync_owner();
$$;

grant execute on function public.sync_pull_profile_locks() to authenticated;

create or replace function public.set_profile_pin(p_profile_id int, p_pin text, p_current_pin text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := public.get_sync_owner();
  rec record;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;
  if p_pin is null or length(p_pin) < 4 then
    raise exception 'PIN must be at least 4 characters';
  end if;

  select * into rec from public.profile_pins
  where user_id = uid and profile_index = p_profile_id;

  if rec is not null and rec.pin_enabled and rec.pin_hash is not null then
    if p_current_pin is null or rec.pin_hash != crypt(p_current_pin, rec.pin_hash) then
      raise exception 'Current PIN is required';
    end if;
  end if;

  insert into public.profile_pins (user_id, profile_index, pin_hash, pin_enabled, failed_attempts, pin_locked_until, updated_at)
  values (uid, p_profile_id, crypt(p_pin, gen_salt('bf')), true, 0, null, now())
  on conflict (user_id, profile_index) do update set
    pin_hash = excluded.pin_hash,
    pin_enabled = true,
    failed_attempts = 0,
    pin_locked_until = null,
    updated_at = now();
end;
$$;

grant execute on function public.set_profile_pin(int, text, text) to authenticated;

create or replace function public.clear_profile_pin(p_profile_id int, p_current_pin text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := public.get_sync_owner();
  rec record;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  select * into rec from public.profile_pins
  where user_id = uid and profile_index = p_profile_id;

  if rec is not null and rec.pin_enabled and rec.pin_hash is not null then
    if p_current_pin is null or rec.pin_hash != crypt(p_current_pin, rec.pin_hash) then
      raise exception 'Current PIN is required';
    end if;
  end if;

  update public.profile_pins
  set pin_hash = null, pin_enabled = false, failed_attempts = 0, pin_locked_until = null, updated_at = now()
  where user_id = uid and profile_index = p_profile_id;
end;
$$;

grant execute on function public.clear_profile_pin(int, text) to authenticated;

create or replace function public.verify_profile_pin(p_profile_id int, p_pin text)
returns table(unlocked boolean, retry_after_seconds int)
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := public.get_sync_owner();
  rec record;
  remaining int;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  select * into rec from public.profile_pins
  where user_id = uid and profile_index = p_profile_id;

  if rec is null or not rec.pin_enabled or rec.pin_hash is null then
    return query select true, 0;
    return;
  end if;

  if rec.pin_locked_until is not null and rec.pin_locked_until > now() then
    remaining := greatest(ceil(extract(epoch from (rec.pin_locked_until - now())))::int, 0);
    return query select false, remaining;
    return;
  end if;

  if rec.pin_hash = crypt(p_pin, rec.pin_hash) then
    update public.profile_pins
    set failed_attempts = 0, pin_locked_until = null, updated_at = now()
    where user_id = uid and profile_index = p_profile_id;
    return query select true, 0;
  else
    update public.profile_pins
    set failed_attempts = failed_attempts + 1,
        pin_locked_until = case when failed_attempts + 1 >= 5 then now() + interval '5 minutes' else pin_locked_until end,
        updated_at = now()
    where user_id = uid and profile_index = p_profile_id;

    select * into rec from public.profile_pins
    where user_id = uid and profile_index = p_profile_id;

    if rec.pin_locked_until is not null and rec.pin_locked_until > now() then
      remaining := greatest(ceil(extract(epoch from (rec.pin_locked_until - now())))::int, 0);
    else
      remaining := 0;
    end if;

    return query select false, remaining;
  end if;
end;
$$;

grant execute on function public.verify_profile_pin(int, text) to authenticated;

-- ============================================================================
-- Per-profile settings / collections / home catalog layout (JSON blobs)
-- ============================================================================

create table if not exists public.profile_settings_blobs (
  user_id uuid not null references auth.users(id) on delete cascade,
  profile_id int not null default 1,
  platform text not null default 'tv',
  settings_json jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, profile_id, platform)
);

alter table public.profile_settings_blobs enable row level security;

create policy "Users manage their own profile settings"
  on public.profile_settings_blobs
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create or replace function public.sync_push_profile_settings_blob(p_profile_id int default 1, p_settings_json jsonb default '{}'::jsonb, p_platform text default 'tv')
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := public.get_sync_owner();
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  insert into public.profile_settings_blobs (user_id, profile_id, platform, settings_json, updated_at)
  values (uid, p_profile_id, p_platform, p_settings_json, now())
  on conflict (user_id, profile_id, platform) do update set
    settings_json = excluded.settings_json,
    updated_at = now();
end;
$$;

grant execute on function public.sync_push_profile_settings_blob(int, jsonb, text) to authenticated;

create or replace function public.sync_pull_profile_settings_blob(p_profile_id int default 1, p_platform text default 'tv')
returns setof public.profile_settings_blobs
language sql
stable
security definer
set search_path = public
as $$
  select * from public.profile_settings_blobs
  where user_id = public.get_sync_owner() and profile_id = p_profile_id and platform = p_platform;
$$;

grant execute on function public.sync_pull_profile_settings_blob(int, text) to authenticated;

create table if not exists public.collections_blobs (
  user_id uuid not null references auth.users(id) on delete cascade,
  profile_id int not null default 1,
  collections_json jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, profile_id)
);

alter table public.collections_blobs enable row level security;

create policy "Users manage their own collections"
  on public.collections_blobs
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create or replace function public.sync_push_collections(p_profile_id int default 1, p_collections_json jsonb default '[]'::jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := public.get_sync_owner();
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  insert into public.collections_blobs (user_id, profile_id, collections_json, updated_at)
  values (uid, p_profile_id, p_collections_json, now())
  on conflict (user_id, profile_id) do update set
    collections_json = excluded.collections_json,
    updated_at = now();
end;
$$;

grant execute on function public.sync_push_collections(int, jsonb) to authenticated;

create or replace function public.sync_pull_collections(p_profile_id int default 1)
returns setof public.collections_blobs
language sql
stable
security definer
set search_path = public
as $$
  select * from public.collections_blobs
  where user_id = public.get_sync_owner() and profile_id = p_profile_id;
$$;

grant execute on function public.sync_pull_collections(int) to authenticated;

create table if not exists public.home_catalog_settings_blobs (
  user_id uuid not null references auth.users(id) on delete cascade,
  profile_id int not null default 1,
  platform text not null default 'tv',
  settings_json jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, profile_id, platform)
);

alter table public.home_catalog_settings_blobs enable row level security;

create policy "Users manage their own home catalog settings"
  on public.home_catalog_settings_blobs
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create or replace function public.sync_push_home_catalog_settings(p_profile_id int default 1, p_settings_json jsonb default '{}'::jsonb, p_platform text default 'tv')
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := public.get_sync_owner();
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  insert into public.home_catalog_settings_blobs (user_id, profile_id, platform, settings_json, updated_at)
  values (uid, p_profile_id, p_platform, p_settings_json, now())
  on conflict (user_id, profile_id, platform) do update set
    settings_json = excluded.settings_json,
    updated_at = now();
end;
$$;

grant execute on function public.sync_push_home_catalog_settings(int, jsonb, text) to authenticated;

create or replace function public.sync_pull_home_catalog_settings(p_profile_id int default 1, p_platform text default 'tv')
returns setof public.home_catalog_settings_blobs
language sql
stable
security definer
set search_path = public
as $$
  select * from public.home_catalog_settings_blobs
  where user_id = public.get_sync_owner() and profile_id = p_profile_id and platform = p_platform;
$$;

grant execute on function public.sync_pull_home_catalog_settings(int, text) to authenticated;

-- ============================================================================
-- Avatar catalog (public read-only reference data + storage bucket)
-- ============================================================================

create table if not exists public.avatar_catalog (
  id text primary key,
  display_name text not null,
  storage_path text not null,
  category text not null default 'general',
  sort_order int not null default 0,
  bg_color text
);

alter table public.avatar_catalog enable row level security;

create policy "Anyone can read the avatar catalog"
  on public.avatar_catalog
  for select
  using (true);

create or replace function public.get_avatar_catalog()
returns setof public.avatar_catalog
language sql
stable
security definer
set search_path = public
as $$
  select * from public.avatar_catalog order by sort_order, id;
$$;

grant execute on function public.get_avatar_catalog() to authenticated;

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

drop policy if exists "Avatar images are publicly accessible" on storage.objects;
create policy "Avatar images are publicly accessible"
  on storage.objects
  for select
  using (bucket_id = 'avatars');

-- ============================================================================
-- Sync overview (account screen summary)
-- ============================================================================

create or replace function public.get_sync_overview()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'addons', (
      select coalesce(jsonb_object_agg(profile_id::text, cnt), '{}'::jsonb)
      from (select profile_id, count(*) cnt from public.addons where user_id = public.get_sync_owner() group by profile_id) t
    ),
    'plugins', (
      select coalesce(jsonb_object_agg(profile_id::text, cnt), '{}'::jsonb)
      from (select profile_id, count(*) cnt from public.plugins where user_id = public.get_sync_owner() group by profile_id) t
    ),
    'library_items', (
      select coalesce(jsonb_object_agg(profile_id::text, cnt), '{}'::jsonb)
      from (select profile_id, count(*) cnt from public.library_items where user_id = public.get_sync_owner() group by profile_id) t
    ),
    'watch_progress', (
      select coalesce(jsonb_object_agg(profile_id::text, cnt), '{}'::jsonb)
      from (select profile_id, count(*) cnt from public.watch_progress where user_id = public.get_sync_owner() group by profile_id) t
    ),
    'watched_items', (
      select coalesce(jsonb_object_agg(profile_id::text, cnt), '{}'::jsonb)
      from (select profile_id, count(*) cnt from public.watched_items where user_id = public.get_sync_owner() group by profile_id) t
    ),
    'profiles', (
      select coalesce(jsonb_object_agg(profile_index::text, jsonb_build_object('name', name, 'color', avatar_color_hex)), '{}'::jsonb)
      from public.profiles where user_id = public.get_sync_owner()
    )
  );
$$;

grant execute on function public.get_sync_overview() to authenticated;
