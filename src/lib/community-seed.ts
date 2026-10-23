import type { PostStatus } from './community-db.js';

/**
 * The ideas the board starts with: everything Morsel already ships, is
 * building, or has planned - lifted from the app's old roadmap
 * (`lib/roadmap/data.ts`) so the Planned and Shipped tabs aren't empty on day
 * one, and so people can vote on what we already plan to build.
 *
 * Posted as the Morsel team (`TEAM_AUTHOR_HASH`), which no device can ever hash
 * to - the route shows these with a "Morsel" tag instead of an anonymous label.
 *
 * Fixed ids make the SQL seed (`supabase/004_seed_roadmap.sql`, generated from
 * this list by `npm run seed:sql`) safe to run twice. Keep them stable.
 */

/** Not a sha256 hex digest, so no device's author hash can ever collide with it. */
export const TEAM_AUTHOR_HASH = 'morsel-team';

export interface SeedPost {
  id: string;
  title: string;
  body: string;
  status: Exclude<PostStatus, 'removed' | 'open'>;
}

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Listed newest-first within each status; the SQL seed stamps times to match. */
export const SEED_POSTS: SeedPost[] = [
  // --- Shipped ---
  {
    id: id(1),
    title: 'Advanced nutrition',
    body: 'Detailed macro and micronutrient breakdowns for every recipe.',
    status: 'shipped',
  },
  {
    id: id(2),
    title: 'Sign in to keep Morsel Plus',
    body: 'Optional account so a Plus subscription follows you to a new phone instead of living on one device. Your recipes stay on your phone either way.',
    status: 'shipped',
  },
  {
    id: id(3),
    title: 'Instagram video recipes',
    body: 'Read recipes straight from Reels - spoken steps and on-screen text - not just the caption.',
    status: 'shipped',
  },
  {
    id: id(4),
    title: 'AI Kitchen Assistant',
    body: 'Smart ingredient swaps and healthier versions of any recipe.',
    status: 'shipped',
  },
  {
    id: id(5),
    title: 'Calorie & water tracker',
    body: 'Log what you eat - by hand or straight from a saved recipe - and what you drink, against daily goals, with a progress card on your home screen.',
    status: 'shipped',
  },
  {
    id: id(6),
    title: 'Backup & restore',
    body: 'Every recipe is mirrored on your device, and you can export your whole library to a file, so reinstalling never loses it.',
    status: 'shipped',
  },
  {
    id: id(7),
    title: 'Cook mode',
    body: 'A full-screen, step-by-step view that keeps your place while you cook.',
    status: 'shipped',
  },
  {
    id: id(8),
    title: 'Folders',
    body: 'Group recipes your own way, and pin the folders you cook from most.',
    status: 'shipped',
  },
  {
    id: id(9),
    title: 'Import from the share sheet',
    body: 'Share a link to Morsel from any app, or paste one straight into the Add tab.',
    status: 'shipped',
  },
  {
    id: id(10),
    title: 'Recipe extraction from links',
    body: 'Paste an Instagram, TikTok, or blog link and get a clean, structured recipe.',
    status: 'shipped',
  },

  // --- In progress ---
  {
    id: id(11),
    title: 'Morsel Plus',
    body: 'A premium plan that unlocks the tracking, AI and nutrition features. Live on Android; the iPhone checkout is still being set up.',
    status: 'in_progress',
  },
  {
    id: id(12),
    title: 'Adjust to Taste',
    body: 'Tell the AI to dial any ingredient up or down - sugar, salt, gluten, dairy, spice, and more - and it rebalances the rest of the recipe to match.',
    status: 'shipped',
  },

  {
    id: id(13),
    title: 'Smart Planner',
    body: 'Plan your week around your calories.',
    status: 'shipped',
  },

  // --- Planned ---
  {
    id: id(14),
    title: 'Grocery lists',
    body: 'Auto-build shopping lists from your recipes and meal plan.',
    status: 'planned',
  },
  {
    id: id(15),
    title: 'Sync across devices',
    body: 'Back up and access your recipes everywhere.',
    status: 'in_progress',
  },
];

/** SQL that inserts `SEED_POSTS`, idempotently. Printed by `npm run seed:sql`. */
export function seedSql(): string {
  const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const rows = SEED_POSTS.map((post, index) => {
    // Earlier in the list = newer, so the tabs read in the order above.
    const at = `now() - interval '${index} minutes'`;
    const shippedAt = post.status === 'shipped' ? at : 'null';
    return `  (${quote(post.id)}, ${quote(TEAM_AUTHOR_HASH)}, ${quote(post.title)}, ${quote(post.body)}, ${quote(post.status)}, ${shippedAt}, ${at})`;
  });
  return [
    '-- Morsel: seed the ideas board with the existing roadmap.',
    '--',
    '-- GENERATED from server/src/lib/community-seed.ts by `npm run seed:sql` - edit that',
    '-- file, not this one. Run once in the Supabase SQL editor after 003_community.sql.',
    '-- Safe to re-run: fixed ids, and existing rows are left alone (so status changes',
    '-- and votes made since are kept).',
    '',
    'insert into public.community_posts',
    '  (id, author_hash, title, body, status, shipped_at, created_at)',
    'values',
    rows.join(',\n'),
    'on conflict (id) do nothing;',
    '',
  ].join('\n');
}
