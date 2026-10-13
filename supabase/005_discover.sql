-- Morsel: Discover (searchable extraction cache) + the community recipe feed.
--
-- Run once in the Supabase SQL editor after 003_community.sql. Then:
--   1. Storage -> New bucket "community-images", Public = on. The server copies
--      expiring Instagram/TikTok photos there (services/rehost.ts).
--   2. Run `npm run backfill:discover` once to copy the existing Upstash
--      extraction cache into recipe_index.
--
-- Same security model as 003: RLS forced, no policies, nothing granted to
-- anon/authenticated. Only the backend (service role) reads or writes, and
-- `author_hash` / `saver_hash` never leave the server.
--
-- Admin workflow (Table Editor), in addition to 003's:
--   * Review the queue:     `discover_admin_queue` lists hidden, reported or
--                           flagged recipes, cache entries and suggestions.
--   * Restore after review: hidden = false (and needs_review = false).
--   * Take a post down:     recipe_posts.removed = true.
--   * Pull a cache entry:   recipe_index.hidden = true (it stays hidden; the
--                           indexer never un-hides a row).
--   * Bans and blocks are shared with the ideas board (community_banned_devices,
--     community_blocks).

begin;

-- ---------------------------------------------------------------------------
-- recipe_index - one row per extracted post/page, written by the server after
-- every validated cache fill (routes/extract.ts) and by the backfill script.
-- ---------------------------------------------------------------------------
create table if not exists public.recipe_index (
  -- `canonicalCacheKey` (ig:<code>, tt:<id>, web:<host><path>?<query>).
  canonical_key text primary key,
  -- Opaque id used in URLs, so canonical keys (which contain '/', '?') never
  -- have to be round-tripped through a path segment.
  id uuid not null unique default gen_random_uuid(),
  -- Rebuilt from canonical_key (lib/url.ts publicSourceUrl): never the link the
  -- first person pasted, which could carry their share id.
  source_url text not null,
  source_platform text not null check (source_platform in ('instagram', 'tiktok', 'web')),
  -- "@username" for social posts when the scraper reported one, else null.
  creator text,
  title text not null check (char_length(title) between 1 and 200),
  image_url text,
  category text not null check (category in ('meals', 'drinks', 'snacks', 'desserts')),
  servings integer,
  calories integer not null default 0,
  protein integer not null default 0,
  carbs integer not null default 0,
  fat integer not null default 0,
  ingredients text[] not null default '{}',
  -- The full ExtractedRecipe, handed out on save.
  recipe jsonb not null,
  diet_tags text[] not null default '{}',
  total_minutes integer,
  difficulty text check (difficulty in ('easy', 'medium', 'hard')),
  -- Null until the classify pass has run; the sweep retries these.
  classified_at timestamptz,
  search_text text not null default '',
  search_tsv tsvector generated always as (to_tsvector('simple', search_text)) stored,
  save_count integer not null default 0,
  report_count integer not null default 0,
  hidden boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.recipe_index is
  'Searchable copy of the extraction cache (Discover). Service role only.';

create index if not exists recipe_index_tsv_idx on public.recipe_index using gin (search_tsv);
create index if not exists recipe_index_diet_idx on public.recipe_index using gin (diet_tags);
create index if not exists recipe_index_popular_idx
  on public.recipe_index (hidden, save_count desc, created_at desc);
create index if not exists recipe_index_new_idx on public.recipe_index (hidden, created_at desc);
create index if not exists recipe_index_unclassified_idx
  on public.recipe_index (created_at) where classified_at is null;

-- ---------------------------------------------------------------------------
-- recipe_posts - a recipe someone shared from their library.
-- ---------------------------------------------------------------------------
create table if not exists public.recipe_posts (
  id uuid primary key default gen_random_uuid(),
  author_hash text not null,
  -- Moderated display name at post time; null = show the "Cook XXXX" handle.
  author_name text check (author_name is null or char_length(author_name) between 2 and 30),
  remix_of uuid references public.recipe_posts (id) on delete set null,
  note text not null default '' check (char_length(note) <= 500),
  title text not null check (char_length(title) between 1 and 120),
  image_url text,
  source_url text,
  source_platform text not null
    check (source_platform in ('instagram', 'tiktok', 'web', 'manual')),
  category text not null check (category in ('meals', 'drinks', 'snacks', 'desserts')),
  servings integer,
  calories integer not null default 0,
  protein integer not null default 0,
  carbs integer not null default 0,
  fat integer not null default 0,
  recipe jsonb not null,
  diet_tags text[] not null default '{}',
  total_minutes integer,
  difficulty text check (difficulty in ('easy', 'medium', 'hard')),
  search_text text not null default '',
  search_tsv tsvector generated always as (to_tsvector('simple', search_text)) stored,
  save_count integer not null default 0,
  remix_count integer not null default 0,
  comment_count integer not null default 0,
  report_count integer not null default 0,
  hidden boolean not null default false,
  needs_review boolean not null default false,
  removed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.recipe_posts is
  'Community recipe feed. Service role only. author_hash identifies the posting device for moderation and is never returned to the app.';

create index if not exists recipe_posts_tsv_idx on public.recipe_posts using gin (search_tsv);
create index if not exists recipe_posts_diet_idx on public.recipe_posts using gin (diet_tags);
create index if not exists recipe_posts_new_idx
  on public.recipe_posts (hidden, removed, created_at desc);
create index if not exists recipe_posts_popular_idx
  on public.recipe_posts (hidden, removed, save_count desc, created_at desc);
create index if not exists recipe_posts_remix_idx on public.recipe_posts (remix_of);
create index if not exists recipe_posts_author_idx on public.recipe_posts (author_hash);

-- ---------------------------------------------------------------------------
-- recipe_comments - suggested improvements on a post. Flat, oldest first.
-- ---------------------------------------------------------------------------
create table if not exists public.recipe_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.recipe_posts (id) on delete cascade,
  author_hash text not null,
  author_name text check (author_name is null or char_length(author_name) between 2 and 30),
  body text not null check (char_length(body) between 1 and 1000),
  -- Set by the post's author: "I made this change".
  applied boolean not null default false,
  report_count integer not null default 0,
  hidden boolean not null default false,
  needs_review boolean not null default false,
  removed boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists recipe_comments_post_idx on public.recipe_comments (post_id, created_at);
create index if not exists recipe_comments_author_idx on public.recipe_comments (author_hash);

-- ---------------------------------------------------------------------------
-- recipe_saves - one per (target, device), so save_count counts people.
-- ---------------------------------------------------------------------------
create table if not exists public.recipe_saves (
  target_type text not null check (target_type in ('post', 'index')),
  target_id uuid not null,
  saver_hash text not null,
  created_at timestamptz not null default now(),
  primary key (target_type, target_id, saver_hash)
);

-- ---------------------------------------------------------------------------
-- Reports: widen the shared table to the new targets.
-- ---------------------------------------------------------------------------
alter table public.community_reports drop constraint if exists community_reports_target_type_check;
alter table public.community_reports add constraint community_reports_target_type_check
  check (target_type in ('post', 'comment', 'recipe_post', 'recipe_comment', 'recipe_index'));

-- Same 3-reporter rule as 003, now routed to whichever table the target is in.
-- Threshold matches REPORT_HIDE_THRESHOLD in server/src/lib/community-db.ts.
create or replace function public.community_apply_report() returns trigger
language plpgsql set search_path = public as $$
declare
  reports integer;
begin
  select count(*) into reports from public.community_reports
   where target_type = new.target_type and target_id = new.target_id;

  if new.target_type = 'post' then
    update public.community_posts
       set report_count = reports, hidden = hidden or reports >= 3
     where id = new.target_id;
  elsif new.target_type = 'comment' then
    update public.community_comments
       set report_count = reports, hidden = hidden or reports >= 3
     where id = new.target_id;
  elsif new.target_type = 'recipe_post' then
    update public.recipe_posts
       set report_count = reports, hidden = hidden or reports >= 3
     where id = new.target_id;
  elsif new.target_type = 'recipe_comment' then
    update public.recipe_comments
       set report_count = reports, hidden = hidden or reports >= 3
     where id = new.target_id;
  elsif new.target_type = 'recipe_index' then
    update public.recipe_index
       set report_count = reports, hidden = hidden or reports >= 3
     where id = new.target_id;
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Counter triggers. Not security definer, for the same reason as 003.
-- ---------------------------------------------------------------------------

-- save_count = distinct savers.
create or replace function public.recipe_refresh_save_count() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.target_type = 'post' then
    update public.recipe_posts
       set save_count = (select count(*) from public.recipe_saves
                          where target_type = 'post' and target_id = new.target_id)
     where id = new.target_id;
  else
    update public.recipe_index
       set save_count = (select count(*) from public.recipe_saves
                          where target_type = 'index' and target_id = new.target_id)
     where id = new.target_id;
  end if;
  return null;
end;
$$;

drop trigger if exists recipe_saves_count on public.recipe_saves;
create trigger recipe_saves_count
  after insert on public.recipe_saves
  for each row execute function public.recipe_refresh_save_count();

-- comment_count = visible suggestions only.
create or replace function public.recipe_refresh_comment_count() returns trigger
language plpgsql set search_path = public as $$
declare
  target uuid := coalesce(new.post_id, old.post_id);
begin
  update public.recipe_posts
     set comment_count = (
       select count(*) from public.recipe_comments
        where post_id = target and not hidden and not removed
     )
   where id = target;
  return null;
end;
$$;

drop trigger if exists recipe_comments_count on public.recipe_comments;
create trigger recipe_comments_count
  after insert or update of hidden, removed or delete on public.recipe_comments
  for each row execute function public.recipe_refresh_comment_count();

-- remix_count = visible remixes of the parent.
create or replace function public.recipe_refresh_remix_count() returns trigger
language plpgsql set search_path = public as $$
declare
  parent uuid := coalesce(new.remix_of, old.remix_of);
begin
  if parent is null then
    return null;
  end if;
  update public.recipe_posts
     set remix_count = (
       select count(*) from public.recipe_posts
        where remix_of = parent and not hidden and not removed
     )
   where id = parent;
  return null;
end;
$$;

drop trigger if exists recipe_posts_remix_count on public.recipe_posts;
create trigger recipe_posts_remix_count
  after insert or update of hidden, removed or delete on public.recipe_posts
  for each row execute function public.recipe_refresh_remix_count();

-- ---------------------------------------------------------------------------
-- Admin queue.
-- ---------------------------------------------------------------------------
create or replace view public.discover_admin_queue
with (security_invoker = true) as
  select 'recipe_post'::text as target_type, p.id as target_id, p.author_hash,
         coalesce(p.author_name, '') || ': ' || p.title as text, p.note as detail,
         p.report_count, p.hidden, p.needs_review, p.created_at,
         (select string_agg(r.reason || coalesce(': ' || r.note, ''), ' | ' order by r.created_at)
            from public.community_reports r
           where r.target_type = 'recipe_post' and r.target_id = p.id) as reports
    from public.recipe_posts p
   where (p.hidden or p.report_count > 0 or p.needs_review) and not p.removed
  union all
  select 'recipe_comment', c.id, c.author_hash, c.body, null,
         c.report_count, c.hidden, c.needs_review, c.created_at,
         (select string_agg(r.reason || coalesce(': ' || r.note, ''), ' | ' order by r.created_at)
            from public.community_reports r
           where r.target_type = 'recipe_comment' and r.target_id = c.id)
    from public.recipe_comments c
   where (c.hidden or c.report_count > 0 or c.needs_review) and not c.removed
  union all
  select 'recipe_index', i.id, null, i.title, i.source_url,
         i.report_count, i.hidden, false, i.created_at,
         (select string_agg(r.reason || coalesce(': ' || r.note, ''), ' | ' order by r.created_at)
            from public.community_reports r
           where r.target_type = 'recipe_index' and r.target_id = i.id)
    from public.recipe_index i
   where i.hidden or i.report_count > 0
  order by created_at desc;

-- ---------------------------------------------------------------------------
-- Row Level Security: on, forced, no policies.
-- ---------------------------------------------------------------------------
alter table public.recipe_index enable row level security;
alter table public.recipe_index force row level security;
alter table public.recipe_posts enable row level security;
alter table public.recipe_posts force row level security;
alter table public.recipe_comments enable row level security;
alter table public.recipe_comments force row level security;
alter table public.recipe_saves enable row level security;
alter table public.recipe_saves force row level security;

revoke all on public.recipe_index from anon, authenticated;
revoke all on public.recipe_posts from anon, authenticated;
revoke all on public.recipe_comments from anon, authenticated;
revoke all on public.recipe_saves from anon, authenticated;
revoke all on public.discover_admin_queue from anon, authenticated;

commit;
