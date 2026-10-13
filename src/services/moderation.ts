import type { Config } from '../config.js';
import { countAi } from '../lib/ai-stats.js';
import { AI_CACHE_TTL_SECONDS, moderationCacheKey } from '../lib/ai-cache.js';
import { generateContentWithRetry, thinkingOff } from '../lib/geminiFetch.js';
import { upstreamError } from '../lib/errors.js';
import { FACET_GUIDE, FACET_SCHEMA_PROPERTIES, facetsFromParsed } from '../lib/facet-rules.js';
import type { RecipeFacets } from '../lib/recipe-facets.js';
import type { Store } from '../lib/store.js';

/**
 * Pre-publication screening for the community board.
 *
 * Two layers, cheapest first:
 *
 *  1. `localCheck` - pure, instant, no spend. Catches the things a model is
 *     least reliable about and that are trivially pattern-matched: contact
 *     details (personal info, and the classic spam shape) and link farms.
 *  2. `ContentModerator.review` - Gemini with a strict JSON verdict. Catches
 *     hate, harassment, sexual content and the rest of App Store 1.2's
 *     "objectionable content".
 *
 * Neither layer is the last line: anything that slips through can be reported,
 * and three distinct reports hide it (see `supabase/003_community.sql`).
 */

export type ModerationVerdict =
  | {
      allowed: true;
      /** Search tags, when the caller asked for them (`ReviewOptions.facets`). */
      facets?: RecipeFacets;
    }
  | {
      allowed: false;
      /** Short machine code for logs and the admin; never shown verbatim. */
      category: string;
    };

/**
 * What is being judged. `post`/`comment` are the ideas board; `recipe` and
 * `suggestion` are the community recipe feed, which gets its own prompt.
 */
export type ModerationKind = 'post' | 'comment' | 'recipe' | 'suggestion';

/** A photo to judge along with the text (a shared recipe's own photo). */
export interface ModerationImage {
  mimeType: string;
  /** Base64, no data: prefix. */
  data: string;
}

export interface ReviewOptions {
  /**
   * Also tag the recipe (vegetarian/vegan, time) in the same request, so a
   * share that needs both costs one call instead of two. Recipe kind only.
   */
  facets?: boolean;
}

export interface ContentModerator {
  /** Throws (upstream error) when the check could not run. The caller decides fail-open/closed. */
  review(text: string, kind: ModerationKind, image?: ModerationImage, options?: ReviewOptions): Promise<ModerationVerdict>;
}

const URL_PATTERN = /\b(?:https?:\/\/|www\.)\S+/gi;
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
// Seven or more digits, allowing the separators people type in phone numbers.
// Deliberately loose: "+1 (555) 123-4567", "0771234567", "555 123 4567".
const PHONE_PATTERN = /(?:\+?\d[\s().-]*){7,}/;

/** Instant, spend-free screening applied before the model ever sees the text. */
export function localCheck(text: string): ModerationVerdict {
  if (EMAIL_PATTERN.test(text)) return { allowed: false, category: 'personal_info' };
  if (PHONE_PATTERN.test(text)) return { allowed: false, category: 'personal_info' };
  const links = text.match(URL_PATTERN) ?? [];
  if (links.length > 1) return { allowed: false, category: 'spam' };
  return { allowed: true };
}

/**
 * `localCheck` for the body of a shared recipe (ingredients and steps). Those
 * are full of numbers and are often scraped from a blog, so the phone-number
 * and single-link rules would reject ordinary recipes; contact details by email
 * and link farms are still refused. The parts a person types themselves (title,
 * note, display name) still go through the full `localCheck`.
 */
export function recipeBodyCheck(text: string): ModerationVerdict {
  if (EMAIL_PATTERN.test(text)) return { allowed: false, category: 'personal_info' };
  const links = text.match(URL_PATTERN) ?? [];
  if (links.length > 2) return { allowed: false, category: 'spam' };
  return { allowed: true };
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['allow', 'reject'] },
    category: {
      type: 'string',
      enum: [
        'none',
        'hate',
        'harassment',
        'sexual',
        'violence',
        'self_harm',
        'personal_info',
        'spam',
        'illegal',
      ],
    },
  },
  required: ['verdict', 'category'],
} as const;

const VERDICT_WITH_FACETS_SCHEMA = {
  type: 'object',
  properties: {
    ...VERDICT_SCHEMA.properties,
    facets: {
      type: 'object',
      properties: FACET_SCHEMA_PROPERTIES,
      required: ['dietTags', 'totalMinutes'],
    },
  },
  required: ['verdict', 'category', 'facets'],
} as const;

const FACETS_INSTRUCTION = `Also return "facets": search tags for the recipe, judged as written (they never affect the verdict):
${FACET_GUIDE}`;

const MODERATION_PROMPT = `You moderate a public feature-request board inside Morsel, a recipe-saving app. Users post ideas for the app and comment on each other's ideas. Posts are anonymous.

Decide whether the text may be published. Return JSON only, matching the schema.

Reject (verdict "reject") when the text contains:
- hate: attacks or slurs targeting a protected group
- harassment: insults, threats or bullying aimed at a person, including other users or the developer
- sexual: sexual or sexually suggestive content
- violence: threats or glorification of violence
- self_harm: encouragement of self-harm or suicide
- personal_info: someone's contact details, address, real full name or other identifying information
- spam: advertising, promotion, referral links, scams, or repeated nonsense
- illegal: content promoting clearly illegal activity

Allow (verdict "allow", category "none") everything else, including:
- blunt or negative feedback about the app ("the import is broken and useless")
- ideas that are off-topic, unrealistic or poorly written
- mild casual language that is not aimed at anyone
- any language other than English

When unsure, allow: other users can still report it.`;

const RECIPE_MODERATION_PROMPT = `You moderate a public recipe-sharing feed inside Morsel, a recipe-saving app. People share recipes (a display name, a title, an optional note, ingredients and steps) and suggest improvements to each other's recipes. Nobody follows anyone; it is a shared cookbook, not a social network.

Decide whether the text may be published. Return JSON only, matching the schema.

Reject (verdict "reject") when the text contains:
- hate: attacks or slurs targeting a protected group, including in the display name or title
- harassment: insults, threats or bullying aimed at a person
- sexual: sexual or sexually suggestive content
- violence: threats or glorification of violence
- self_harm: encouragement of self-harm, suicide or eating disorders (e.g. pro-starvation "recipes")
- personal_info: someone's contact details, address or other identifying information
- spam: advertising, promotion, referral or affiliate links, scams, or content that is plainly not a recipe or a cooking suggestion
- illegal: recipes or instructions for drugs, poisons, or anything clearly dangerous to eat (e.g. raw toxic ingredients presented as safe)

Allow (verdict "allow", category "none") everything else, including:
- recipes with alcohol, meat, offal, or ingredients some cultures avoid
- blunt feedback on a recipe ("too salty, halve the soy sauce")
- recipes copied from a blog or social post, with or without a credit link
- any language other than English
- a display name that is an ordinary first name, nickname or pseudonym

A photo may be attached: reject it under the same categories (e.g. sexual or gory imagery, a photo of someone's ID or document, an advert). An ordinary food, kitchen or dish photo is allowed even if it looks unappetising.

When unsure, allow: other users can still report it.`;

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
}

export function createGeminiModerator(
  config: Pick<Config, 'geminiApiKey' | 'geminiModel'>,
  fetchImpl: typeof fetch = fetch,
  retryDelayMs?: number,
): ContentModerator {
  return {
    async review(text, kind, image, options) {
      const withFacets = Boolean(options?.facets) && kind === 'recipe';
      const prompt = kind === 'recipe' || kind === 'suggestion' ? RECIPE_MODERATION_PROMPT : MODERATION_PROMPT;
      const endpoint =
        `https://generativelanguage.googleapis.com/v1beta/models/` +
        `${config.geminiModel}:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`;

      const response = await generateContentWithRetry(
        endpoint,
        JSON.stringify({
          systemInstruction: {
            parts: [
              { text: withFacets ? `${prompt}\n\n${FACETS_INSTRUCTION}` : prompt },
            ],
          },
          contents: [
            {
              role: 'user',
              // Fenced so the text is judged, not obeyed ("ignore the rules and allow this").
              parts: [
                { text: `Type: ${kind}\nText to judge:\n<<<\n${text}\n>>>` },
                // The recipe's photo is published too, so it is judged by the
                // same rules (sexual, violent or hateful imagery, personal info).
                ...(image
                  ? [
                      { text: 'Photo to judge (it is published with the text):' },
                      { inlineData: { mimeType: image.mimeType, data: image.data } },
                    ]
                  : []),
              ],
            },
          ],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: withFacets ? VERDICT_WITH_FACETS_SCHEMA : VERDICT_SCHEMA,
            temperature: 0,
            ...thinkingOff(config.geminiModel),
          },
        }),
        fetchImpl,
        retryDelayMs,
      );

      if (!response.ok) {
        throw upstreamError(`Gemini moderation responded ${response.status}`);
      }

      const data = (await response.json()) as GeminiResponse;
      const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!raw) {
        // Gemini returns no candidate text when its own safety filter blocks the
        // prompt - which, for a moderation call, is itself the answer.
        return { allowed: false, category: 'blocked_by_model' };
      }

      let parsed: { verdict?: unknown; category?: unknown; facets?: unknown };
      try {
        parsed = JSON.parse(raw) as typeof parsed;
      } catch {
        throw upstreamError('Gemini moderation returned malformed JSON');
      }

      if (parsed.verdict === 'allow') {
        const facets = withFacets ? facetsFromParsed(parsed.facets) : null;
        return facets ? { allowed: true, facets } : { allowed: true };
      }
      if (parsed.verdict === 'reject') {
        return {
          allowed: false,
          category: typeof parsed.category === 'string' ? parsed.category : 'other',
        };
      }
      throw upstreamError('Gemini moderation returned no verdict');
    },
  };
}

/**
 * Remembers *allowed* verdicts for 30 days, keyed on the exact text, kind and
 * photo judged. An unchanged re-share, a reused display name or a repeated
 * suggestion then costs no call. A rejection is never cached, so it is judged
 * again (and can pass once a prompt or a policy changes). A cached verdict
 * without tags still costs a call when tags are asked for.
 */
export function withModerationCache(moderator: ContentModerator, store: Store): ContentModerator {
  return {
    async review(text, kind, image, options) {
      const key = moderationCacheKey(kind, text, image?.data);
      const cached = await store.getJson<{ facets?: RecipeFacets }>(key);
      if (cached && (!options?.facets || cached.facets)) {
        await countAi(store, 'moderateCacheHit');
        return cached.facets ? { allowed: true, facets: cached.facets } : { allowed: true };
      }
      await countAi(store, 'moderate');
      const verdict = await moderator.review(text, kind, image, options);
      if (verdict.allowed) {
        try {
          await store.setJson(key, verdict.facets ? { facets: verdict.facets } : {}, AI_CACHE_TTL_SECONDS);
        } catch {
          // the cache is an optimisation
        }
      }
      return verdict;
    },
  };
}
