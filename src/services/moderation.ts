import type { Config } from '../config.js';
import { generateContentWithRetry } from '../lib/geminiFetch.js';
import { upstreamError } from '../lib/errors.js';

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
  | { allowed: true }
  | {
      allowed: false;
      /** Short machine code for logs and the admin; never shown verbatim. */
      category: string;
    };

export interface ContentModerator {
  /** Throws (upstream error) when the check could not run. The caller decides fail-open/closed. */
  review(text: string, kind: 'post' | 'comment'): Promise<ModerationVerdict>;
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

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
}

export function createGeminiModerator(
  config: Pick<Config, 'geminiApiKey' | 'geminiModel'>,
  fetchImpl: typeof fetch = fetch,
  retryDelayMs?: number,
): ContentModerator {
  return {
    async review(text, kind) {
      const endpoint =
        `https://generativelanguage.googleapis.com/v1beta/models/` +
        `${config.geminiModel}:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`;

      const response = await generateContentWithRetry(
        endpoint,
        JSON.stringify({
          systemInstruction: { parts: [{ text: MODERATION_PROMPT }] },
          contents: [
            {
              role: 'user',
              // Fenced so the text is judged, not obeyed ("ignore the rules and allow this").
              parts: [{ text: `Type: ${kind}\nText to judge:\n<<<\n${text}\n>>>` }],
            },
          ],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: VERDICT_SCHEMA,
            temperature: 0,
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

      let parsed: { verdict?: unknown; category?: unknown };
      try {
        parsed = JSON.parse(raw) as typeof parsed;
      } catch {
        throw upstreamError('Gemini moderation returned malformed JSON');
      }

      if (parsed.verdict === 'allow') return { allowed: true };
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
