# Morsel extraction backend

Small Fastify service that turns a recipe link into a structured recipe + macros.

Pipeline: `POST /extract` detects the link's origin and picks a scraper:
- **Instagram** → [Apify Instagram Scraper](https://apify.com/apify/instagram-scraper) (caption + image).
- **Any other URL** (recipe blogs/sites) → fetch the page, prefer `schema.org/Recipe` JSON-LD, else page text + `og:image`.

Both feed [Gemini](https://ai.google.dev/) (structured recipe + per-serving macro estimation) → normalized JSON.

The mobile app calls this so API keys never live on the device.

## Setup

```bash
cd server
cp .env.example .env   # fill APIFY_TOKEN and GEMINI_API_KEY; set APP_SHARED_SECRET
                       # in any deployed environment, plus PEXELS_API_KEY / USDA_API_KEY
npm install
npm run dev            # starts on PORT (default 3000)
```

## API

### `POST /extract`

Request:

```json
{ "url": "https://www.instagram.com/reel/XXXX/" }
```

Response `200`:

```json
{
  "sourceUrl": "https://www.instagram.com/reel/XXXX/",
  "sourcePlatform": "instagram",
  "title": "Protein Pancakes",
  "imageRemoteUrl": "https://...",
  "category": "meals",
  "servings": 2,
  "ingredients": ["1 banana", "2 eggs"],
  "steps": ["Blend", "Cook"],
  "macros": { "calories": 300, "carbs": 30, "protein": 20, "fat": 10 },
  "macrosSource": "estimated"
}
```

Errors: `400` invalid/non-http URL · `422` link has no recipe content · `502` Apify/Gemini/page-fetch upstream failure.

### `POST /image-search`

Body `{ "query": "pancakes" }` → `{ "url": "https://…" | null }`. Searches Pexels for a
recipe photo. Returns `null` (not an error) when nothing matches or `PEXELS_API_KEY` is
unset, since the app treats a missing photo as a no-op.

### `POST /nutrition`

Body `{ "query": "plain flour" }` → `{ "macros": { … } | null }`. Best-matching USDA
FoodData Central food's per-100 g macros, or `null` when nothing usable matched. Falls back
to USDA's shared `DEMO_KEY` when `USDA_API_KEY` is unset - that key is rate-limited across
every caller using it worldwide, so set a real one.

Both routes exist so the Pexels and USDA keys stay here. They used to live in the app as
`EXPO_PUBLIC_*` vars, which Expo inlines into the JS bundle at build time - extractable from
the shipped APK by anyone who unzips it. Both are guarded like `/extract`.

### `GET /health`

Returns `{ "status": "ok" }`. Unguarded.

## Abuse & cost controls

Morsel has no user accounts, so the protected routes - `/extract`, `/improve`,
`/image-search` and `/nutrition` - are covered by four layers instead. All of them
are configured through env vars (see `.env.example`).

> **`APP_SHARED_SECRET` must actually be set.** The shared-secret layer is skipped
> entirely when it is empty, and the app only sends the header when its own
> `EXPO_PUBLIC_APP_KEY` is non-empty. If either side is unset the routes are open to
> anyone; a production build shipped in exactly that state once, so check both.

| Layer | Scope | Response when tripped |
| --- | --- | --- |
| Shared secret (`x-morsel-app-key`) | Every call to a protected route | `401 unauthorized` |
| Per-IP rate limit | 30 requests/minute per IP | `429 rate_limited` |
| Per-install monthly quota | 30 AI extractions per install (the free cap) | `429 quota_exceeded` |
| Global daily circuit breaker | 50 AI extractions service-wide | `503 at_capacity` |

Two things shape how these behave:

- **Only Instagram and TikTok links are metered.** Web & blog imports are
  unlimited on every plan, so they skip the quota and the circuit breaker
  entirely. This mirrors `isMeteredExtractionUrl` in the app.
- **The same post is cached for a year, however its link was shared.** A cache
  hit is served without touching Apify or Gemini and costs the caller nothing,
  so it never consumes quota or daily budget. This is the single biggest cost
  reducer once several people save the same viral reel.

  Entries are keyed on the post's **canonical identity**, not the URL text
  (`canonicalCacheKey` in `lib/url.ts`): `ig:<shortcode>` for Instagram,
  `tt:<videoId>` for TikTok, and for web links the host and path with known
  tracking parameters stripped. Without this, `?igsh=…`, `?utm_source=…` and a
  bare link would be three separate paid extractions of one reel - and in
  practice social apps append those parameters to almost every shared link.

  TikTok short links (`vm.tiktok.com/…`) carry no video id, so they cannot be
  canonicalised up front. Instead, after a cold extraction the recipe is also
  written under the id the scraper returns (`ScrapedPost.shortcode`), so the
  next person pasting the full URL still gets a free hit.

  `GET /health` reports this month's `hits`, `misses` and `hitRate`.

The per-install quota is keyed on the `x-morsel-device-id` header, a hash of
`ANDROID_ID` that survives uninstall/reinstall (see `Morsel/lib/device/id.ts`).
It is client-supplied and therefore forgeable: it meters honest users and closes
the reinstall bypass, but Play Integrity attestation is what would stop a
scripted caller. Likewise the shared secret is inlined into the app bundle and
extractable from the APK.

Counters live in Upstash Redis so they survive the cold starts and redeploys of
a free Render instance. **Every store call fails open**: if Upstash is
unreachable the request is allowed and a warning is logged, because an outage
there must not take extraction down. The backstop that cannot fail open is a
vendor-side spend cap, so set both:

- Apify: a maximum monthly spend limit on the account.
- Google AI Studio / Cloud: a quota cap on the Gemini API key.

### Sizing the daily ceiling

On the **free** Apify and Gemini tiers neither vendor can overspend, so the
ceiling exists to stop a fixed monthly allowance being consumed in week one -
an availability guard, not a bill guard.

Known costs (measured July 2026):

- **Apify Instagram Scraper**, Free plan: **$2.70 per 1,000 results**. `resultsLimit: 1`
  in `services/apify.ts` means one result per extraction, so **$0.0027 each**.
  The free $5/month is therefore **~1,850 Instagram extractions/month, ~61/day**.
- **TikTok** uses a free actor, but its compute units draw on the same $5. Cost
  per run is unmeasured - the 50/day default leaves headroom for it.
- **Gemini**: exactly **one `generateContent` call per extraction** (recipe and
  macros come back in a single structured-output response). Not the binding
  constraint; Apify is.

Two consequences worth remembering:

- At the free 30/month per-install cap, **$5 supports roughly 61 fully-active
  users a month**. That, not the code, is the current ceiling on how many people
  Morsel can serve.
- **Plus (200/mo) is not enforceable yet.** The server applies one cap to
  everyone because it cannot tell a subscriber from a free user. Before paid
  tiers go live, check the caller's entitlement with `REVENUECAT_SECRET_API_KEY`
  and choose the cap from that; a client-supplied plan claim is forgeable and
  would hand anyone the higher limit.
- **Cache hits are free.** Once several users save the same viral reel, the
  30-day cache is the single biggest lever on how far the $5 stretches.

On a paid tier the formula is instead:

```
GLOBAL_DAILY_EXTRACTION_LIMIT = monthly_budget / cost_per_extraction / 30
```

### Gemini free-tier gotchas

- **Requests-per-minute is tighter than requests-per-day.** The free tier's RPM
  is low (around 10) and applies **per project, across all users**. The per-IP
  rate limit does not protect it: ten different people extracting in the same
  minute can trip it, surfacing as `502 upstream_error`. Low risk at launch
  scale, but it is the first thing to break under a traffic spike.
- **`/improve` shares the same Gemini quota but is not behind the daily
  breaker.** That is currently harmless because the AI Kitchen Assistant is
  hidden for the free-only launch, so the route sees ~no traffic. Re-enabling
  that feature means revisiting this.
- Free-tier quotas were cut 50-80% in December 2025 and reported figures vary,
  so read the live RPM/RPD for your project in AI Studio rather than trusting a
  number from a blog post.

## Scripts

- `npm run dev` — watch-mode dev server (tsx)
- `npm run build` / `npm start` — compile to `dist/` and run
- `npm test` — unit tests (vitest)
- `npm run typecheck` — type-check only
