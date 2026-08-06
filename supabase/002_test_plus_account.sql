-- Morsel: give a test account Morsel Plus, without buying anything.
--
-- Run this in the Supabase SQL editor AFTER 001_subscriptions.sql, and after
-- creating the test user by hand in Dashboard -> Authentication -> Users
-- ("Add user" -> "Create new user", tick Auto Confirm User so there is no
-- confirmation email to chase).
--
-- WHY THIS FILE EXISTS. `public.subscriptions` has no INSERT or UPDATE policy on
-- purpose (001_subscriptions.sql, finding C1): the anon key ships inside the app,
-- so if users could write their own row they would write plan = 'plus' and take
-- the 200/month cap for free. That closed door applies to you too - the row a
-- tester needs cannot be created from the app, from Postman, or from the Table
-- Editor's "Insert row" button while RLS is forced. The SQL editor runs as the
-- table owner, which `force row level security` also covers, so this script sets
-- `role` to the service role for the one statement that writes.
--
-- This is the same row the RevenueCat webhook would write for a real purchase,
-- so everything downstream is exercised for real: `/entitlement` reads it back
-- through RLS with the tester's own JWT, `resolveEntitlement` reports
-- source = 'subscription', the extraction cap becomes PLUS_DEVICE_EXTRACTION_LIMIT
-- and the account screen says "Plus - subscription". Nothing is faked but the
-- payment.
--
-- A real webhook delivery for this user will overwrite the row, which is fine and
-- is the point: last_event_ms is left at 0 so any genuine event wins the ordering
-- guard.

begin;

-- The service role is the only writer these tables have. `local` scopes it to
-- this transaction, so the editor session goes back to normal at commit.
set local role service_role;

-- ---------------------------------------------------------------------------
-- EDIT THIS: the email of the user you created in Authentication -> Users.
-- ---------------------------------------------------------------------------
with target as (
  select id from auth.users where email = 'tester@morsel.app'
)
insert into public.subscriptions (
  user_id,
  plan,
  entitlement_id,
  store,
  product_id,
  period_type,
  -- Null = no expiry known, which `activeUntil()` treats as "does not expire"
  -- (lib/entitlement.ts). A date here would work too; null means the test
  -- account does not quietly lapse mid-testing.
  expires_at,
  will_renew,
  last_event_ms,
  last_event_type
)
select
  target.id,
  'plus',
  -- Must match REVENUECAT_ENTITLEMENT_ID / ENTITLEMENTS.plus. Nothing gates on
  -- it - the cap decision uses plan + expires_at only - but a wrong value here
  -- makes support reads misleading.
  'Morsel Plus',
  'test',
  'test.manual.grant',
  'normal',
  null,
  false,
  0,
  'MANUAL_TEST_GRANT'
from target
on conflict (user_id) do update set
  plan = 'plus',
  expires_at = null,
  last_event_type = 'MANUAL_TEST_GRANT',
  updated_at = now();

commit;

-- ---------------------------------------------------------------------------
-- Verify. Zero rows here means the email above matched no user - check the
-- spelling in Authentication -> Users rather than assuming the insert worked.
-- ---------------------------------------------------------------------------
-- select u.email, s.plan, s.expires_at, s.last_event_type
--   from public.subscriptions s
--   join auth.users u on u.id = s.user_id;
--   -> one row: your tester, 'plus', null, 'MANUAL_TEST_GRANT'

-- ---------------------------------------------------------------------------
-- Revoke it again (back to the free 30/month cap) without deleting the user:
-- ---------------------------------------------------------------------------
-- begin;
-- set local role service_role;
-- update public.subscriptions set plan = 'free', updated_at = now()
--  where user_id = (select id from auth.users where email = 'tester@morsel.app');
-- commit;
