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
-- the 200/month cap for free. That closed door applies to the app, to Postman and
-- to any `authenticated` session - none of them can create the row a tester needs.
--
-- Two Supabase-specific facts about how this script gets around that, both
-- verified against a live project on 2026-08-06:
--
--   * `postgres` (what the SQL editor and the MCP server connect as) has
--     rolbypassrls = true. BYPASSRLS outranks `force row level security`, so the
--     editor is NOT actually contained by 001's forced RLS. The `set local role
--     service_role` below is therefore about writing as the role that legitimately
--     owns these tables, not about escaping a lock the editor was subject to.
--
--   * `service_role` has NO grant on `auth.users` - only `postgres` does. So the
--     email lookup MUST happen before the role switch. An earlier version of this
--     file resolved the id inside a CTE after `set local role service_role` and
--     failed with "42501: permission denied for table users". That is why the body
--     below is a plpgsql block that reads the id first, then switches role for the
--     write alone.
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

do $$
declare
  -- -------------------------------------------------------------------------
  -- EDIT THIS: the email of the user you created in Authentication -> Users.
  -- -------------------------------------------------------------------------
  target_email text := 'tester@morsel.app';
  uid uuid;
begin
  -- Read as postgres, BEFORE the role switch - service_role cannot see auth.users.
  select id into uid from auth.users where email = target_email;

  -- Fail loudly rather than inserting nothing and looking like it worked. The old
  -- CTE form silently affected zero rows when the email did not match.
  if uid is null then
    raise exception 'No auth user with email %. Check the spelling in Authentication -> Users.', target_email;
  end if;

  -- The service role is the only writer these tables have. `local` scopes it to
  -- this transaction, so the editor session goes back to normal at commit.
  set local role service_role;

  insert into public.subscriptions (
    user_id,
    plan,
    -- Must match REVENUECAT_ENTITLEMENT_ID / ENTITLEMENTS.plus. Nothing gates on
    -- it - the cap decision uses plan + expires_at only - but a wrong value here
    -- makes support reads misleading.
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
  ) values (
    uid,
    'plus',
    'Morsel Plus',
    'test',
    'test.manual.grant',
    'normal',
    null,
    false,
    0,
    'MANUAL_TEST_GRANT'
  )
  on conflict (user_id) do update set
    plan = 'plus',
    expires_at = null,
    last_event_type = 'MANUAL_TEST_GRANT',
    updated_at = now();

  reset role;
end $$;

commit;

-- ---------------------------------------------------------------------------
-- Verify. A bad email now raises rather than silently writing nothing, so if the
-- block above committed, the row exists.
-- ---------------------------------------------------------------------------
-- select u.email, s.plan, s.expires_at, s.last_event_type
--   from public.subscriptions s
--   join auth.users u on u.id = s.user_id;
--   -> one row: your tester, 'plus', null, 'MANUAL_TEST_GRANT'

-- ---------------------------------------------------------------------------
-- Verify RLS end to end - that the tester can read their own row through the
-- policy, and that a different signed-in user cannot see it. This is the check
-- that actually mirrors what /entitlement does with the tester's JWT.
-- ---------------------------------------------------------------------------
-- do $$
-- declare uid uuid; n int;
-- begin
--   select id into uid from auth.users where email = 'tester@morsel.app';
--   perform set_config('request.jwt.claims',
--     json_build_object('sub', uid, 'role', 'authenticated')::text, true);
--   set local role authenticated;
--   select count(*) into n from public.subscriptions;
--   raise notice 'tester sees % row(s) - expect 1', n;
--   perform set_config('request.jwt.claims',
--     json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
--   select count(*) into n from public.subscriptions;
--   raise notice 'other user sees % row(s) - expect 0', n;
--   reset role;
-- end $$;

-- ---------------------------------------------------------------------------
-- Revoke it again (back to the free 30/month cap) without deleting the user.
-- Same constraint as above: resolve the id BEFORE switching role, because
-- service_role cannot read auth.users.
-- ---------------------------------------------------------------------------
-- do $$
-- declare uid uuid;
-- begin
--   select id into uid from auth.users where email = 'tester@morsel.app';
--   set local role service_role;
--   update public.subscriptions set plan = 'free', updated_at = now()
--    where user_id = uid;
--   reset role;
-- end $$;
