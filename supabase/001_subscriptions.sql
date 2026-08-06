-- Morsel: subscription state for signed-in users.
--
-- Run this once in the Supabase SQL editor (Dashboard -> SQL Editor -> New query),
-- then confirm in Table Editor that BOTH tables show "RLS enabled".
--
-- The security model in one line: users may READ their own subscription and
-- nothing else; only the service role (the Fastify backend, reached exclusively
-- by RevenueCat's webhook) may WRITE it.
--
-- That asymmetry is the whole point. The Supabase anon key ships inside the app
-- bundle and is extractable from the AAB - that is fine, it is a public key -
-- but it means any user can call PostgREST directly with their own valid JWT. If
-- these tables had an INSERT or UPDATE policy, a user would simply write
-- plan = 'plus' onto their own row and take the 200/month AI extraction cap for
-- free. So no such policy exists, on purpose. See
-- security-reports/supabase-auth-entitlement-preflight.md (finding C1).

begin;

-- ---------------------------------------------------------------------------
-- subscriptions - one row per user, mirroring RevenueCat's view of them.
-- ---------------------------------------------------------------------------
create table if not exists public.subscriptions (
  -- Also the RevenueCat `app_user_id`: the app calls Purchases.logIn() with the
  -- Supabase user id on sign-in, so the two identity spaces are the same value
  -- and the webhook needs no mapping table.
  user_id uuid primary key references auth.users (id) on delete cascade,

  -- 'free' or 'plus'. Kept as a plan name rather than a bare boolean so a future
  -- tier does not require a migration of every consumer.
  plan text not null default 'free' check (plan in ('free', 'plus')),

  -- Straight from the RevenueCat event, for support and debugging. None of these
  -- are read when deciding the cap - that decision uses plan + expires_at only.
  entitlement_id text,
  store text,
  product_id text,
  period_type text,

  -- Null means "no expiry known". A lifetime/promotional entitlement legitimately
  -- has none, so null is treated as "does not expire", never as "expired".
  expires_at timestamptz,
  will_renew boolean not null default false,

  -- The event_timestamp_ms of the event that last wrote this row. RevenueCat
  -- retries on any non-2xx and does not guarantee ordering, so an older event
  -- arriving late must not overwrite a newer state (a CANCELLATION landing after
  -- the RENEWAL that superseded it would otherwise revoke a live subscription).
  -- The webhook's upsert is conditional on the incoming value being greater.
  last_event_ms bigint not null default 0,
  last_event_type text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.subscriptions is
  'RevenueCat subscription state, one row per auth user. Written only by the service role via the /webhooks/revenuecat endpoint; users have SELECT on their own row and no write path at all.';
comment on column public.subscriptions.last_event_ms is
  'Ordering guard: an event older than this is ignored, so webhook retries and out-of-order delivery are no-ops.';

-- Support lookups ("has this person actually got an active sub?") without a scan.
create index if not exists subscriptions_plan_expires_idx
  on public.subscriptions (plan, expires_at);

-- ---------------------------------------------------------------------------
-- revenuecat_events - an append-only log of what RevenueCat told us.
-- ---------------------------------------------------------------------------
-- Two jobs: idempotency (the primary key rejects a replayed event id, so a
-- retried delivery cannot re-apply), and an audit trail for the one part of the
-- system that decides who has paid.
create table if not exists public.revenuecat_events (
  id text primary key,
  type text not null,
  app_user_id text,
  event_timestamp_ms bigint not null,
  -- The raw event, opaque. Nothing reads fields out of here to make a decision;
  -- the columns above and the subscriptions row are what the server trusts. Keeps
  -- an attacker-shaped payload from reaching anything by way of mass assignment.
  payload jsonb not null,
  received_at timestamptz not null default now()
);

comment on table public.revenuecat_events is
  'Append-only RevenueCat webhook log. Primary key on the event id makes redelivery idempotent. No RLS policy exists, so it is unreadable by anon and authenticated - service role only.';

create index if not exists revenuecat_events_user_idx
  on public.revenuecat_events (app_user_id, event_timestamp_ms desc);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
-- `enable` turns RLS on for ordinary roles; `force` extends it to the table
-- owner too, so a future trigger or dashboard query running as the owner cannot
-- quietly sidestep it. The service role holds BYPASSRLS and is unaffected by
-- either - that is how the webhook writes.
alter table public.subscriptions enable row level security;
alter table public.subscriptions force row level security;
alter table public.revenuecat_events enable row level security;
alter table public.revenuecat_events force row level security;

-- Start from nothing rather than trusting whatever the default grants were.
revoke all on public.subscriptions from anon, authenticated;
revoke all on public.revenuecat_events from anon, authenticated;

-- The only privilege any end user gets anywhere in this migration.
grant select on public.subscriptions to authenticated;

drop policy if exists "read own subscription" on public.subscriptions;
create policy "read own subscription"
  on public.subscriptions
  for select
  to authenticated
  using (auth.uid() = user_id);

-- Deliberately absent: any INSERT, UPDATE or DELETE policy on either table, and
-- any policy at all on revenuecat_events. With RLS on, no policy means denied.
-- If you ever add one, re-read finding C1 first.

commit;

-- ---------------------------------------------------------------------------
-- Verify (run after the above; both should return the expected values)
-- ---------------------------------------------------------------------------
-- select relname, relrowsecurity, relforcerowsecurity
--   from pg_class
--  where relname in ('subscriptions', 'revenuecat_events');
--   -> both true, both true
--
-- select tablename, policyname, cmd from pg_policies
--  where schemaname = 'public';
--   -> exactly one row: subscriptions / "read own subscription" / SELECT
