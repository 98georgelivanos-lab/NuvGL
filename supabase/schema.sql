-- Streamfield account sync — minimal schema for sharing addon lists
-- across devices/apps (e.g. a future NuvioTV build pointed at the same project).
--
-- Run this once in your Supabase project's SQL Editor
-- (Dashboard -> SQL Editor -> New query -> paste -> Run).

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

create policy "Users manage their own addons"
  on public.addons
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Replace the full addon list for a profile in one call.
create or replace function public.sync_push_addons(p_addons jsonb, p_profile_id int default 1)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
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
