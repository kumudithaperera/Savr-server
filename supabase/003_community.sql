-- Morsel: the community ideas board (feature requests, votes, comments, reports).
--
-- Run this once in the Supabase SQL editor (Dashboard -> SQL Editor -> New query),
-- then confirm in Table Editor that every table below shows "RLS enabled".
--
-- The security model in one line: NO end user can touch these tables directly.
-- Every read and write goes through the Fastify backend (`routes/community.ts`)
-- using the service role, which bypasses RLS. The anon key that ships in the app
-- gets nothing here - not even SELECT - because rows carry `author_hash`, the one
-- value that ties an anonymous post back to the device that wrote it. The app
-- never sees it; only an admin in this dashboard does.
--
-- `author_hash` is sha256(COMMUNITY_HASH_PEPPER + ':' + device id). The pepper
-- lives only in the server environment, so this table alone cannot be joined
-- back to the `x-morsel-device-id` the app sends.
--
-- Admin workflow (all in Table Editor):
--   * Move an idea along:   posts.status -> planned / in_progress / shipped,
--                           and set posts.shipped_version (e.g. '1.0.21').
--   * Review the queue:     the `community_admin_queue` view lists anything
--                           hidden, reported or flagged for review.
--   * Restore after review: set hidden = false and needs_review = false.
--   * Take something down:  posts.status = 'removed' / comments.removed = true.
--   * Ban a device:         insert its author_hash into community_banned_devices.

begin;

-- ---------------------------------------------------------------------------
-- posts - one feature idea each.
-- ---------------------------------------------------------------------------
create table if not exists public.community_posts (
  id uuid primary key default gen_random_uuid(),
  author_hash text not null,
  title text not null check (char_length(title) between 1 and 120),
  body text not null default '' check (char_length(body) <= 2000),
  status text not null default 'open'
    check (status in ('open', 'planned', 'in_progress', 'shipped', 'removed')),
  -- Free text so it reads the way the release was named, e.g. '1.0.21'.
  shipped_version text,
  -- Stamped by trigger when status first becomes 'shipped'; orders that tab.
  shipped_at timestamptz,
  -- Denormalised counters, maintained by the triggers below so a list read is a
  -- single indexed query rather than three aggregates per row.
  score integer not null default 0,
  comment_count integer not null default 0,
  report_count integer not null default 0,
  -- True once enough distinct people report it. Hidden rows never reach the app.
  hidden boolean not null default false,
  -- Set when the server could not run the AI check at write time.
  needs_review boolean not null default false,
  created_at timestamptz not null default now()
);

comment on table public.community_posts is
  'Community board ideas. Service role only. author_hash identifies the posting device for moderation and is never returned to the app.';

create index if not exists community_posts_top_idx
  on public.community_posts (status, hidden, score desc, created_at desc);
create index if not exists community_posts_new_idx
  on public.community_posts (status, hidden, created_at desc);
create index if not exists community_posts_author_idx
  on public.community_posts (author_hash);

-- ---------------------------------------------------------------------------
-- comments - flat, oldest first, one level only.
-- ---------------------------------------------------------------------------
create table if not exists public.community_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.community_posts (id) on delete cascade,
  author_hash text not null,
  body text not null check (char_length(body) between 1 and 1000),
  report_count integer not null default 0,
  hidden boolean not null default false,
  needs_review boolean not null default false,
  -- Soft delete, so a removed comment stays available to an admin reviewing a report.
  removed boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists community_comments_post_idx
  on public.community_comments (post_id, created_at);
create index if not exists community_comments_author_idx
  on public.community_comments (author_hash);

-- ---------------------------------------------------------------------------
-- votes - one per (post, device); value is +1 or -1. Clearing a vote deletes it.
-- ---------------------------------------------------------------------------
create table if not exists public.community_votes (
  post_id uuid not null references public.community_posts (id) on delete cascade,
  voter_hash text not null,
  value smallint not null check (value in (-1, 1)),
  created_at timestamptz not null default now(),
  primary key (post_id, voter_hash)
);

create index if not exists community_votes_voter_idx
  on public.community_votes (voter_hash);

-- ---------------------------------------------------------------------------
-- reports - one per (target, reporter), so one device can't hide a post alone.
-- ---------------------------------------------------------------------------
create table if not exists public.community_reports (
  id uuid primary key default gen_random_uuid(),
  target_type text not null check (target_type in ('post', 'comment')),
  target_id uuid not null,
  reporter_hash text not null,
  reason text not null
    check (reason in ('spam', 'offensive', 'harassment', 'personal_info', 'off_topic', 'other')),
  note text check (note is null or char_length(note) <= 500),
  created_at timestamptz not null default now(),
  unique (target_type, target_id, reporter_hash)
);

create index if not exists community_reports_target_idx
  on public.community_reports (target_type, target_id);

-- ---------------------------------------------------------------------------
-- blocks - "hide posts from this person", per device.
-- ---------------------------------------------------------------------------
create table if not exists public.community_blocks (
  blocker_hash text not null,
  blocked_hash text not null,
  created_at timestamptz not null default now(),
  primary key (blocker_hash, blocked_hash)
);

-- ---------------------------------------------------------------------------
-- banned devices - an admin inserts here; the server refuses every write.
-- ---------------------------------------------------------------------------
create table if not exists public.community_banned_devices (
  author_hash text primary key,
  reason text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Triggers keeping the counters honest.
--
-- Deliberately NOT security definer: they run as whoever fired them, which is
-- only ever the service role (BYPASSRLS). Running as the table owner instead
-- would collide with `force row level security` below.
-- ---------------------------------------------------------------------------

-- Score = sum of votes. Recomputed rather than incremented so a concurrent
-- vote flip can never leave the counter drifted.
create or replace function public.community_refresh_score() returns trigger
language plpgsql set search_path = public as $$
declare
  target uuid := coalesce(new.post_id, old.post_id);
begin
  update public.community_posts
     set score = coalesce((select sum(value) from public.community_votes where post_id = target), 0)
   where id = target;
  return null;
end;
$$;

drop trigger if exists community_votes_score on public.community_votes;
create trigger community_votes_score
  after insert or update or delete on public.community_votes
  for each row execute function public.community_refresh_score();

-- comment_count = visible comments only, so a hidden or removed one drops out.
create or replace function public.community_refresh_comment_count() returns trigger
language plpgsql set search_path = public as $$
declare
  target uuid := coalesce(new.post_id, old.post_id);
begin
  update public.community_posts
     set comment_count = (
       select count(*) from public.community_comments
        where post_id = target and not hidden and not removed
     )
   where id = target;
  return null;
end;
$$;

drop trigger if exists community_comments_count on public.community_comments;
create trigger community_comments_count
  after insert or update of hidden, removed or delete on public.community_comments
  for each row execute function public.community_refresh_comment_count();

-- Three distinct reporters hide the target until an admin reviews it. The
-- threshold matches REPORT_HIDE_THRESHOLD in server/src/lib/community-db.ts.
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
  else
    update public.community_comments
       set report_count = reports, hidden = hidden or reports >= 3
     where id = new.target_id;
  end if;
  return null;
end;
$$;

drop trigger if exists community_reports_apply on public.community_reports;
create trigger community_reports_apply
  after insert on public.community_reports
  for each row execute function public.community_apply_report();

-- Stamp shipped_at the first time an idea is marked shipped.
create or replace function public.community_stamp_shipped() returns trigger
language plpgsql as $$
begin
  if new.status = 'shipped' and (old.status is distinct from 'shipped') and new.shipped_at is null then
    new.shipped_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists community_posts_shipped on public.community_posts;
create trigger community_posts_shipped
  before update of status on public.community_posts
  for each row execute function public.community_stamp_shipped();

-- ---------------------------------------------------------------------------
-- Admin queue - everything an admin should look at, newest first.
-- ---------------------------------------------------------------------------
create or replace view public.community_admin_queue
with (security_invoker = true) as
  select 'post'::text as target_type, p.id as target_id, p.id as post_id,
         p.author_hash, p.title as text, p.body as detail,
         p.report_count, p.hidden, p.needs_review, p.created_at,
         (select string_agg(r.reason || coalesce(': ' || r.note, ''), ' | ' order by r.created_at)
            from public.community_reports r
           where r.target_type = 'post' and r.target_id = p.id) as reports
    from public.community_posts p
   where (p.hidden or p.report_count > 0 or p.needs_review) and p.status <> 'removed'
  union all
  select 'comment', c.id, c.post_id, c.author_hash, c.body, null,
         c.report_count, c.hidden, c.needs_review, c.created_at,
         (select string_agg(r.reason || coalesce(': ' || r.note, ''), ' | ' order by r.created_at)
            from public.community_reports r
           where r.target_type = 'comment' and r.target_id = c.id)
    from public.community_comments c
   where (c.hidden or c.report_count > 0 or c.needs_review) and not c.removed
  order by created_at desc;

-- ---------------------------------------------------------------------------
-- Row Level Security: on, forced, and no policies at all.
-- ---------------------------------------------------------------------------
alter table public.community_posts enable row level security;
alter table public.community_posts force row level security;
alter table public.community_comments enable row level security;
alter table public.community_comments force row level security;
alter table public.community_votes enable row level security;
alter table public.community_votes force row level security;
alter table public.community_reports enable row level security;
alter table public.community_reports force row level security;
alter table public.community_blocks enable row level security;
alter table public.community_blocks force row level security;
alter table public.community_banned_devices enable row level security;
alter table public.community_banned_devices force row level security;

revoke all on public.community_posts from anon, authenticated;
revoke all on public.community_comments from anon, authenticated;
revoke all on public.community_votes from anon, authenticated;
revoke all on public.community_reports from anon, authenticated;
revoke all on public.community_blocks from anon, authenticated;
revoke all on public.community_banned_devices from anon, authenticated;
revoke all on public.community_admin_queue from anon, authenticated;

commit;
