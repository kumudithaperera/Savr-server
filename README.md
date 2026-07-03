# Savr extraction backend

Small Fastify service that turns a recipe link into a structured recipe + macros.

Pipeline: `POST /extract` detects the link's origin and picks a scraper:
- **Instagram** → [Apify Instagram Scraper](https://apify.com/apify/instagram-scraper) (caption + image).
- **Any other URL** (recipe blogs/sites) → fetch the page, prefer `schema.org/Recipe` JSON-LD, else page text + `og:image`.

Both feed [Gemini](https://ai.google.dev/) (structured recipe + per-serving macro estimation) → normalized JSON.

The mobile app calls this so API keys never live on the device.

## Setup

```bash
cd server
cp .env.example .env   # fill APIFY_TOKEN and GEMINI_API_KEY
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

### `GET /health`

Returns `{ "status": "ok" }`.

## Scripts

- `npm run dev` — watch-mode dev server (tsx)
- `npm run build` / `npm start` — compile to `dist/` and run
- `npm test` — unit tests (vitest)
- `npm run typecheck` — type-check only
