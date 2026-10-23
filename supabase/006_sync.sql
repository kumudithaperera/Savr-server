-- Morsel: sync across devices (MORSE-56) - recipes, folders, folder membership
-- and recipe photos, for signed-in Morsel Plus members.
--
-- Run once in the Supabase SQL editor after 001_subscriptions.sql. It creates
-- the private Storage bucket too (no dashboard step).
--
-- Unlike 003/005, the APP talks to these tables directly, with the user's own
-- JWT (lib/sync/remote.ts) - there is no backend route in between. So RLS here
-- is the whole security boundary, and it is written to be:
--   * a user reads and writes only rows whose user_id is their auth.uid();
--   * writing also needs an active Plus subscription (public.has_plus()), read
--     from the service-role-only `subscriptions` table - the anon key in the app
--     bundle can't fake it, for the reason spelled out in 001 (finding C1);
--   * nobody can DELETE a row. A delete is a tombstone (deleted_at), so it can
--     reach the user's other devices; the rows go when the account does
--     (on delete cascade) - and the Storage objects with them, via DELETE
--     /account (server/src/lib/supabase.ts), since Storage doesn't cascade.
--
-- Conflicts are last-write-wins on the device's own clock (client_updated_at),
-- enforced in a trigger so a stale device can't overwrite a newer row no matter
-- what it sends. Devices pull by updated_at, which the trigger sets from the
-- SERVER clock - so a phone with a wrong clock can't hide its changes from, or
-- skip changes on, the others.

begin;

-- ---------------------------------------------------------------------------
-- has_plus() - does the calling user have an active Plus subscription?
-- ---------------------------------------------------------------------------
-- security definer so it can read `subscriptions` through RLS on the caller's
-- behalf; it takes no argument and only ever answers for auth.uid(), so it
-- can't be used to probe someone else's plan. Same rule as the server's
-- resolveEntitlement: plan 'plus', and a null expiry means it doesn't expire.
create or replace function public.has_plus()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.subscriptions s
     where s.user_id = auth.uid()
       and s.plan = 'plus'
       and (s.expires_at is null or s.expires_at > now())
  );
$$;

revoke all on function public.has_plus() from public, anon;
grant execute on function public.has_plus() to authenticated;

-- ---------------------------------------------------------------------------
-- sync_guard() - the ordering rules, for every synced table.
-- ---------------------------------------------------------------------------
create or replace function public.sync_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    -- Ownership never moves (RLS checks the new row too; this is belt and braces).
    if new.user_id <> old.user_id then
      raise exception 'user_id is immutable';
    end if;
    -- Last write wins: an older (or the same) version is skipped silently -
    -- returning null drops just this row, so a batch upsert still applies the
    -- rest. The app sees the row missing from the upsert's result and fetches
    -- the newer copy instead.
    if new.client_updated_at <= old.client_updated_at then
      return null;
    end if;
    -- A build that predates the row's shape would drop fields it can't see.
    if new.schema_version < old.schema_version then
      return null;
    end if;
  end if;
  -- clock_timestamp(), not now(): every row of a batch gets its own instant, so
  -- pull pages ordered by updated_at have (practically) no ties to split.
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- synced_recipes
-- ---------------------------------------------------------------------------
create table if not exists public.synced_recipes (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- The app's local recipe id ("<epoch ms>-<base36>"); unique per user only.
  id text not null check (char_length(id) between 1 and 64 and id ~ '^[A-Za-z0-9._-]+$'),
  -- The recipe fields that travel (lib/sync/merge.ts SYNCED_RECIPE_FIELDS), plus
  -- any written by a newer build. Empty (or just {mergedInto}) on a tombstone:
  -- deleting a recipe removes its content from the cloud too.
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  schema_version int not null default 1 check (schema_version > 0),
  -- Device epoch ms of the change - the last-write-wins key.
  client_updated_at bigint not null check (client_updated_at > 0),
  deleted_at bigint,
  -- "<user id>/<recipe id>.jpg#<rev>" in the user-recipe-images bucket, or null.
  image_path text check (image_path is null or char_length(image_path) <= 200),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (user_id, id),
  -- 256 KB of recipe is far beyond any real one; stops the table being used as
  -- free storage through a hand-rolled client.
  constraint synced_recipes_data_size check (pg_column_size(data) <= 262144)
);

create index if not exists synced_recipes_pull_idx
  on public.synced_recipes (user_id, updated_at, id);

drop trigger if exists synced_recipes_guard on public.synced_recipes;
create trigger synced_recipes_guard
  before insert or update on public.synced_recipes
  for each row execute function public.sync_guard();

-- ---------------------------------------------------------------------------
-- synced_folders
-- ---------------------------------------------------------------------------
create table if not exists public.synced_folders (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null check (char_length(id) between 1 and 64 and id ~ '^[A-Za-z0-9._-]+$'),
  -- {name, createdAt, pinnedAt}; {mergedInto} or {} on a tombstone.
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  schema_version int not null default 1 check (schema_version > 0),
  client_updated_at bigint not null check (client_updated_at > 0),
  deleted_at bigint,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (user_id, id),
  constraint synced_folders_data_size check (pg_column_size(data) <= 8192)
);

create index if not exists synced_folders_pull_idx
  on public.synced_folders (user_id, updated_at, id);

drop trigger if exists synced_folders_guard on public.synced_folders;
create trigger synced_folders_guard
  before insert or update on public.synced_folders
  for each row execute function public.sync_guard();

-- ---------------------------------------------------------------------------
-- synced_recipe_folders - which recipe is filed in which folder.
-- ---------------------------------------------------------------------------
create table if not exists public.synced_recipe_folders (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  recipe_id text not null check (char_length(recipe_id) between 1 and 64 and recipe_id ~ '^[A-Za-z0-9._-]+$'),
  folder_id text not null check (char_length(folder_id) between 1 and 64 and folder_id ~ '^[A-Za-z0-9._-]+$'),
  schema_version int not null default 1 check (schema_version > 0),
  client_updated_at bigint not null check (client_updated_at > 0),
  deleted_at bigint,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (user_id, recipe_id, folder_id)
);

create index if not exists synced_recipe_folders_pull_idx
  on public.synced_recipe_folders (user_id, updated_at, recipe_id, folder_id);

drop trigger if exists synced_recipe_folders_guard on public.synced_recipe_folders;
create trigger synced_recipe_folders_guard
  before insert or update on public.synced_recipe_folders
  for each row execute function public.sync_guard();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.synced_recipes enable row level security;
alter table public.synced_recipes force row level security;
alter table public.synced_folders enable row level security;
alter table public.synced_folders force row level security;
alter table public.synced_recipe_folders enable row level security;
alter table public.synced_recipe_folders force row level security;

revoke all on public.synced_recipes from anon, authenticated;
revoke all on public.synced_folders from anon, authenticated;
revoke all on public.synced_recipe_folders from anon, authenticated;

-- No DELETE grant, on purpose (see the header).
grant select, insert, update on public.synced_recipes to authenticated;
grant select, insert, update on public.synced_folders to authenticated;
grant select, insert, update on public.synced_recipe_folders to authenticated;

-- Reading your own rows doesn't need Plus: if a subscription lapses, the copy
-- in the cloud is still the user's own data. Writing does.
do $$
declare
  t text;
begin
  foreach t in array array['synced_recipes', 'synced_folders', 'synced_recipe_folders'] loop
    execute format('drop policy if exists "read own rows" on public.%I', t);
    execute format(
      'create policy "read own rows" on public.%I for select to authenticated
         using (user_id = auth.uid())', t);

    execute format('drop policy if exists "plus members insert own rows" on public.%I', t);
    execute format(
      'create policy "plus members insert own rows" on public.%I for insert to authenticated
         with check (user_id = auth.uid() and public.has_plus())', t);

    execute format('drop policy if exists "plus members update own rows" on public.%I', t);
    execute format(
      'create policy "plus members update own rows" on public.%I for update to authenticated
         using (user_id = auth.uid() and public.has_plus())
         with check (user_id = auth.uid() and public.has_plus())', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Storage: private bucket for synced recipe photos, one folder per user.
-- ---------------------------------------------------------------------------
-- 2 MB cap: the app uploads ~1280px JPEGs (lib/sync/images.ts), well under it.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('user-recipe-images', 'user-recipe-images', false, 2097152, array['image/jpeg'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "sync images: read own" on storage.objects;
create policy "sync images: read own" on storage.objects for select to authenticated
  using (bucket_id = 'user-recipe-images' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "sync images: plus members upload own" on storage.objects;
create policy "sync images: plus members upload own" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'user-recipe-images'
    and (storage.foldername(name))[1] = auth.uid()::text
    and public.has_plus()
  );

-- Upserting a replaced photo is an UPDATE on storage.objects.
drop policy if exists "sync images: plus members replace own" on storage.objects;
create policy "sync images: plus members replace own" on storage.objects for update to authenticated
  using (
    bucket_id = 'user-recipe-images'
    and (storage.foldername(name))[1] = auth.uid()::text
    and public.has_plus()
  )
  with check (
    bucket_id = 'user-recipe-images'
    and (storage.foldername(name))[1] = auth.uid()::text
    and public.has_plus()
  );

-- Removing a deleted recipe's photo. Allowed without Plus: it only frees space.
drop policy if exists "sync images: delete own" on storage.objects;
create policy "sync images: delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'user-recipe-images' and (storage.foldername(name))[1] = auth.uid()::text);

commit;

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
-- select relname, relrowsecurity, relforcerowsecurity from pg_class
--  where relname in ('synced_recipes', 'synced_folders', 'synced_recipe_folders');
--   -> all true, true
--
-- RLS checks - run as a test user via the SQL editor's role switcher, or:
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub": "<user A uuid>", "role": "authenticated"}';
--   * select count(*) from synced_recipes where user_id <> auth.uid();   -> 0
--   * insert into synced_recipes (user_id, id, client_updated_at)
--       values ('<user B uuid>', 'x', 1);                               -> RLS error
--   * as a user with no Plus row: insert ... (user_id = own)           -> RLS error
--   * as a Plus user: insert id 'x' at client_updated_at 10, then upsert it at 5
--       -> the row still says 10 (stale write skipped by sync_guard)
