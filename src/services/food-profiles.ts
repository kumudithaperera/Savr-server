import type { Config } from '../config.js';
import { unprocessable, upstreamError } from '../lib/errors.js';
import { generateContentWithRetry, thinkingOff } from '../lib/geminiFetch.js';

/**
 * Shopping weights for foods the app's built-in table doesn't know, so the
 * grocery list can say "500 g" instead of "3 cups". Mirrors `FoodProfile` in
 * the app's `lib/grocery/food-profile.ts`.
 */
export interface FoodProfileDto {
  /** Grams in one cup, chopped or as recipes usually measure it. */
  gPerCup?: number;
  /** Grams in one medium piece. */
  gPerPiece?: number;
  sold: 'weight' | 'piece' | 'pack';
}

export interface FoodProfiler {
  /** One answer per key; null when it isn't a food or can't be weighed. */
  profile(keys: readonly string[]): Promise<Record<string, FoodProfileDto | null>>;
}

const SCHEMA = {
  type: 'object',
  properties: {
    foods: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          isFood: { type: 'boolean' },
          gramsPerCup: { type: 'number', nullable: true },
          gramsPerPiece: { type: 'number', nullable: true },
          sold: { type: 'string', enum: ['weight', 'piece', 'pack'] },
        },
        required: ['name', 'isFood', 'sold'],
      },
    },
  },
  required: ['foods'],
} as const;

const PROMPT = `You help a grocery list turn recipe amounts into what to buy. For each food name given, return typical weights.

Return JSON only, matching the provided schema, with one entry per name, echoing the name exactly.

Rules:
- isFood: false for anything that isn't a food you'd buy (equipment, instructions, gibberish). Then leave the weights null.
- gramsPerCup: grams in one US cup (240 ml) of it, chopped or prepared the way recipes usually measure it. Null if it's never measured by the cup.
- gramsPerPiece: grams in one medium whole piece, for foods bought or counted one at a time (a carrot, a mango). Null if it doesn't come in pieces (rice, flour, minced meat).
- sold: "weight" for loose produce and fresh food weighed at the shop, "piece" for produce bought one at a time, "pack" for things sold in packs or bags by weight (grains, cheese, nuts, frozen food).
- Give realistic typical values; don't invent precision.`;

/** Plausible weights only: a bad answer is dropped, never shown as "40 kg". */
function grams(value: unknown, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > max) return undefined;
  return Math.round(value);
}

/** Validates one model answer. Exported for tests. */
export function cleanProfile(raw: unknown): FoodProfileDto | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Record<string, unknown>;
  if (entry.isFood !== true) return null;
  const sold = entry.sold === 'weight' || entry.sold === 'piece' || entry.sold === 'pack' ? entry.sold : null;
  if (!sold) return null;
  const gPerCup = grams(entry.gramsPerCup, 1000);
  const gPerPiece = grams(entry.gramsPerPiece, 5000);
  if (gPerCup === undefined && gPerPiece === undefined) return null;
  // Bought by the piece needs a piece weight; otherwise it's sold by weight.
  return { gPerCup, gPerPiece, sold: sold === 'piece' && !gPerPiece ? 'weight' : sold };
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
}

/** Backed by the light Gemini model: a short lookup, not a recipe rewrite. */
export function createGeminiFoodProfiler(
  config: Pick<Config, 'geminiApiKey' | 'geminiLightModel'>,
  fetchImpl: typeof fetch = fetch,
  retryDelayMs?: number,
): FoodProfiler {
  return {
    async profile(keys) {
      const endpoint =
        `https://generativelanguage.googleapis.com/v1beta/models/` +
        `${config.geminiLightModel}:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`;
      const response = await generateContentWithRetry(
        endpoint,
        JSON.stringify({
          systemInstruction: { parts: [{ text: PROMPT }] },
          contents: [{ role: 'user', parts: [{ text: keys.map((key) => `- ${key}`).join('\n') }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: SCHEMA,
            temperature: 0,
            ...thinkingOff(config.geminiLightModel),
          },
        }),
        fetchImpl,
        retryDelayMs,
      );
      if (!response.ok) throw upstreamError(`Gemini returned HTTP ${response.status}.`);

      const data = (await response.json()) as GeminiResponse;
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw unprocessable('Gemini returned no content.');
      let parsed: { foods?: unknown };
      try {
        parsed = JSON.parse(text) as { foods?: unknown };
      } catch {
        throw unprocessable('Gemini returned malformed JSON.');
      }

      const byName = new Map<string, unknown>();
      for (const entry of Array.isArray(parsed.foods) ? parsed.foods : []) {
        const name = (entry as { name?: unknown })?.name;
        if (typeof name === 'string') byName.set(name.trim().toLowerCase(), entry);
      }
      // A key the model skipped is answered null, so it isn't asked again.
      return Object.fromEntries(keys.map((key) => [key, cleanProfile(byName.get(key))]));
    },
  };
}
