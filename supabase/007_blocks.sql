-- Morsel: blocking users (MORSE-125, App Store Guideline 1.2).
--
-- Run once in the Supabase SQL editor after 005_discover.sql (006 is
-- independent). Safe to re-run.
--
-- What changes:
--   * community_blocks gets an opaque `id` (the app unblocks by it, so the
--     blocked author's hash never leaves the server) and a `blocked_name`
--     snapshot, so Profile -> Blocked users can say who it is.
--   * community_account_blocks: the same thing keyed on a Supabase user, so a
--     block made while signed in follows the account to every device. The
--     server writes here instead of community_blocks for a signed-in caller,
--     and moves a device's blocks here when it signs in.
--   * Blocking also files a report with reason 'blocked'. It shows in the admin
--     queues as `blocked_count` but does NOT count towards the 3-report
--     auto-hide - one person blocking someone must not hide them for everyone.
--     A 'blocked' row and a real report from the same device can coexist.

begin;

-- ---------------------------------------------------------------------------
-- Device blocks: opaque id + name snapshot.
-- ---------------------------------------------------------------------------
alter table public.community_blocks
  add column if not exists id uuid not null default gen_random_uuid();
alter table public.community_blocks
  add column if not exists blocked_name text
    check (blocked_name is null or char_length(blocked_name) <= 60);
create unique index if not exists community_blocks_id_key on public.community_blocks (id);

-- ---------------------------------------------------------------------------
-- Account blocks - one per (user, blocked author).
-- ---------------------------------------------------------------------------
create table if not exists public.community_account_blocks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  blocked_hash text not null,
  blocked_name text check (blocked_name is null or char_length(blocked_name) <= 60),
  created_at timestamptz not null default now(),
  unique (user_id, blocked_hash)
);

-- ---------------------------------------------------------------------------
-- Reports: allow the 'blocked' signal next to a real report.
-- ---------------------------------------------------------------------------
alter table public.community_reports drop constraint if exists community_reports_reason_check;
alter table public.community_reports add constraint community_reports_reason_check
  check (reason in ('spam', 'offensive', 'harassment', 'personal_info', 'off_topic', 'other', 'blocked'));

-- One report and one block signal per (target, reporter), instead of one row.
alter table public.community_reports
  drop constraint if exists community_reports_target_type_target_id_reporter_hash_key;
create unique index if not exists community_reports_target_reporter_kind_key
  on public.community_reports (target_type, target_id, reporter_hash, (reason = 'blocked'));

-- 005's trigger, now leaving 'blocked' rows out of the count. Threshold matches
-- REPORT_HIDE_THRESHOLD in server/src/lib/community-db.ts.
create or replace function public.community_apply_report() returns trigger
language plpgsql set search_path = public as $$
declare
  reports integer;
begin
  select count(*) into reports from public.community_reports
   where target_type = new.target_type and target_id = new.target_id and reason <> 'blocked';

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
-- Admin queues: same columns as before plus `blocked_count` at the end, and
-- blocked-but-unreported items now show up too.
-- ---------------------------------------------------------------------------
create or replace view public.community_admin_queue
with (security_invoker = true) as
  select 'post'::text as target_type, p.id as target_id, p.id as post_id,
         p.author_hash, p.title as text, p.body as detail,
         p.report_count, p.hidden, p.needs_review, p.created_at,
         (select string_agg(r.reason || coalesce(': ' || r.note, ''), ' | ' order by r.created_at)
            from public.community_reports r
           where r.target_type = 'post' and r.target_id = p.id and r.reason <> 'blocked') as reports,
         (select count(*) from public.community_reports r
           where r.target_type = 'post' and r.target_id = p.id and r.reason = 'blocked') as blocked_count
    from public.community_posts p
   where (p.hidden or p.report_count > 0 or p.needs_review
          or exists (select 1 from public.community_reports r
                      where r.target_type = 'post' and r.target_id = p.id))
     and p.status <> 'removed'
  union all
  select 'comment', c.id, c.post_id, c.author_hash, c.body, null,
         c.report_count, c.hidden, c.needs_review, c.created_at,
         (select string_agg(r.reason || coalesce(': ' || r.note, ''), ' | ' order by r.created_at)
            from public.community_reports r
           where r.target_type = 'comment' and r.target_id = c.id and r.reason <> 'blocked'),
         (select count(*) from public.community_reports r
           where r.target_type = 'comment' and r.target_id = c.id and r.reason = 'blocked')
    from public.community_comments c
   where (c.hidden or c.report_count > 0 or c.needs_review
          or exists (select 1 from public.community_reports r
                      where r.target_type = 'comment' and r.target_id = c.id))
     and not c.removed
  order by created_at desc;

create or replace view public.discover_admin_queue
with (security_invoker = true) as
  select 'recipe_post'::text as target_type, p.id as target_id, p.author_hash,
         coalesce(p.author_name, '') || ': ' || p.title as text, p.note as detail,
         p.report_count, p.hidden, p.needs_review, p.created_at,
         (select string_agg(r.reason || coalesce(': ' || r.note, ''), ' | ' order by r.created_at)
            from public.community_reports r
           where r.target_type = 'recipe_post' and r.target_id = p.id and r.reason <> 'blocked') as reports,
         (select count(*) from public.community_reports r
           where r.target_type = 'recipe_post' and r.target_id = p.id and r.reason = 'blocked') as blocked_count
    from public.recipe_posts p
   where (p.hidden or p.report_count > 0 or p.needs_review
          or exists (select 1 from public.community_reports r
                      where r.target_type = 'recipe_post' and r.target_id = p.id))
     and not p.removed
  union all
  select 'recipe_comment', c.id, c.author_hash, c.body, null,
         c.report_count, c.hidden, c.needs_review, c.created_at,
         (select string_agg(r.reason || coalesce(': ' || r.note, ''), ' | ' order by r.created_at)
            from public.community_reports r
           where r.target_type = 'recipe_comment' and r.target_id = c.id and r.reason <> 'blocked'),
         (select count(*) from public.community_reports r
           where r.target_type = 'recipe_comment' and r.target_id = c.id and r.reason = 'blocked')
    from public.recipe_comments c
   where (c.hidden or c.report_count > 0 or c.needs_review
          or exists (select 1 from public.community_reports r
                      where r.target_type = 'recipe_comment' and r.target_id = c.id))
     and not c.removed
  union all
  select 'recipe_index', i.id, null, i.title, i.source_url,
         i.report_count, i.hidden, false, i.created_at,
         (select string_agg(r.reason || coalesce(': ' || r.note, ''), ' | ' order by r.created_at)
            from public.community_reports r
           where r.target_type = 'recipe_index' and r.target_id = i.id),
         0::bigint
    from public.recipe_index i
   where i.hidden or i.report_count > 0
  order by created_at desc;

-- ---------------------------------------------------------------------------
-- Row Level Security: on, forced, no policies - only the service role.
-- ---------------------------------------------------------------------------
alter table public.community_account_blocks enable row level security;
alter table public.community_account_blocks force row level security;

revoke all on public.community_account_blocks from anon, authenticated;
revoke all on public.community_admin_queue from anon, authenticated;
revoke all on public.discover_admin_queue from anon, authenticated;

commit;
