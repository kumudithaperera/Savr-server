-- Morsel: seed the ideas board with the existing roadmap.
--
-- GENERATED from server/src/lib/community-seed.ts by `npm run seed:sql` - edit that
-- file, not this one. Run once in the Supabase SQL editor after 003_community.sql.
-- Safe to re-run: fixed ids, and existing rows are left alone (so status changes
-- and votes made since are kept).

insert into public.community_posts
  (id, author_hash, title, body, status, shipped_at, created_at)
values
  ('00000000-0000-4000-8000-000000000001', 'morsel-team', 'Advanced nutrition', 'Detailed macro and micronutrient breakdowns for every recipe.', 'shipped', now() - interval '0 minutes', now() - interval '0 minutes'),
  ('00000000-0000-4000-8000-000000000002', 'morsel-team', 'Sign in to keep Morsel Plus', 'Optional account so a Plus subscription follows you to a new phone instead of living on one device. Your recipes stay on your phone either way.', 'shipped', now() - interval '1 minutes', now() - interval '1 minutes'),
  ('00000000-0000-4000-8000-000000000003', 'morsel-team', 'Instagram video recipes', 'Read recipes straight from Reels - spoken steps and on-screen text - not just the caption.', 'shipped', now() - interval '2 minutes', now() - interval '2 minutes'),
  ('00000000-0000-4000-8000-000000000004', 'morsel-team', 'AI Kitchen Assistant', 'Smart ingredient swaps and healthier versions of any recipe.', 'shipped', now() - interval '3 minutes', now() - interval '3 minutes'),
  ('00000000-0000-4000-8000-000000000005', 'morsel-team', 'Calorie & water tracker', 'Log what you eat - by hand or straight from a saved recipe - and what you drink, against daily goals, with a progress card on your home screen.', 'shipped', now() - interval '4 minutes', now() - interval '4 minutes'),
  ('00000000-0000-4000-8000-000000000006', 'morsel-team', 'Backup & restore', 'Every recipe is mirrored on your device, and you can export your whole library to a file, so reinstalling never loses it.', 'shipped', now() - interval '5 minutes', now() - interval '5 minutes'),
  ('00000000-0000-4000-8000-000000000007', 'morsel-team', 'Cook mode', 'A full-screen, step-by-step view that keeps your place while you cook.', 'shipped', now() - interval '6 minutes', now() - interval '6 minutes'),
  ('00000000-0000-4000-8000-000000000008', 'morsel-team', 'Folders', 'Group recipes your own way, and pin the folders you cook from most.', 'shipped', now() - interval '7 minutes', now() - interval '7 minutes'),
  ('00000000-0000-4000-8000-000000000009', 'morsel-team', 'Import from the share sheet', 'Share a link to Morsel from any app, or paste one straight into the Add tab.', 'shipped', now() - interval '8 minutes', now() - interval '8 minutes'),
  ('00000000-0000-4000-8000-000000000010', 'morsel-team', 'Recipe extraction from links', 'Paste an Instagram, TikTok, or blog link and get a clean, structured recipe.', 'shipped', now() - interval '9 minutes', now() - interval '9 minutes'),
  ('00000000-0000-4000-8000-000000000011', 'morsel-team', 'Morsel Plus', 'A premium plan that unlocks the tracking, AI and nutrition features. Live on Android; the iPhone checkout is still being set up.', 'in_progress', null, now() - interval '10 minutes'),
  ('00000000-0000-4000-8000-000000000012', 'morsel-team', 'Adjust to Taste', 'Tell the AI to dial any ingredient up or down - sugar, salt, gluten, dairy, spice, and more - and it rebalances the rest of the recipe to match.', 'shipped', now() - interval '11 minutes', now() - interval '11 minutes'),
  ('00000000-0000-4000-8000-000000000013', 'morsel-team', 'Smart Planner', 'Plan your week around your calories.', 'shipped', now() - interval '12 minutes', now() - interval '12 minutes'),
  ('00000000-0000-4000-8000-000000000014', 'morsel-team', 'Grocery lists', 'Auto-build shopping lists from your recipes and meal plan.', 'planned', null, now() - interval '13 minutes'),
  ('00000000-0000-4000-8000-000000000015', 'morsel-team', 'Sync across devices', 'Back up and access your recipes everywhere.', 'in_progress', null, now() - interval '14 minutes')
on conflict (id) do nothing;
