/**
 * Moves an idea on the in-app Ideas & requests board (`community_posts`).
 * Run it whenever a feature lands, so the board's Planned / Shipped tabs match
 * what the app actually does.
 *
 *   npm run board:status                                  # list team posts + status
 *   npm run board:status -- --title "Adjust to Taste" --status shipped
 *   npm run board:status -- --id 00000000-...-000000000012 --status in_progress
 *
 * `--title` matches case-insensitively and must hit exactly one post. A
 * trigger stamps `shipped_at` the first time a post becomes `shipped`.
 * Remember to make the same change in `lib/community-seed.ts` (then
 * `npm run seed:sql`) and the app's `lib/roadmap/data.ts`.
 *
 * Needs: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 */
import 'dotenv/config';

const STATUSES = ['open', 'planned', 'in_progress', 'shipped', 'removed'] as const;
type Status = (typeof STATUSES)[number];

interface Row {
  id: string;
  title: string;
  status: Status;
  shipped_at: string | null;
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const next = process.argv[index + 1];
  return next && !next.startsWith('--') ? next : '';
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

const base = `${env('SUPABASE_URL').replace(/\/$/, '')}/rest/v1`;
const key = env('SUPABASE_SERVICE_ROLE_KEY');
const headers = {
  apikey: key,
  Authorization: `Bearer ${key}`,
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}/${path}`, { ...init, headers });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

async function main(): Promise<void> {
  const id = arg('id');
  const title = arg('title');
  const status = arg('status') as Status | undefined;

  if (!id && !title) {
    const rows = await request<Row[]>(
      'community_posts?select=id,title,status,shipped_at&order=status,created_at.desc',
    );
    for (const row of rows) console.log(`${row.status.padEnd(12)} ${row.id}  ${row.title}`);
    return;
  }

  if (!status || !STATUSES.includes(status)) {
    throw new Error(`--status must be one of: ${STATUSES.join(', ')}`);
  }

  const filter = id
    ? `id=eq.${encodeURIComponent(id)}`
    : `title=ilike.${encodeURIComponent(title!.replace(/[%_*]/g, ''))}`;
  const matches = await request<Row[]>(`community_posts?select=id,title,status,shipped_at&${filter}`);
  if (matches.length !== 1) {
    throw new Error(`Expected one post, found ${matches.length}: ${matches.map((m) => m.title).join(', ')}`);
  }

  const [post] = matches;
  const [updated] = await request<Row[]>(`community_posts?id=eq.${post.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
  console.log(`${updated.title}: ${post.status} -> ${updated.status} (shipped_at ${updated.shipped_at ?? '-'})`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
