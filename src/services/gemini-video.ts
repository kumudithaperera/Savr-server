/**
 * Gemini video-understanding recipe parser.
 *
 * Uses Gemini 2.5 Flash's multimodal capabilities to extract recipe information
 * from video content when the primary text-based extraction is insufficient.
 * Analyzes:
 * - Spoken audio (ingredients and instructions)
 * - On-screen text (measurements, temperatures, timings)
 * - Visual cooking actions (to infer missing steps)
 */

import type { Config } from '../config.js';
import { upstreamError, unprocessable } from '../lib/errors.js';
import { generateContentWithRetry } from '../lib/geminiFetch.js';
import { CATEGORIES, type ParsedRecipe } from '../lib/types.js';
import { validateParsedRecipe } from '../lib/validate.js';

export interface VideoRecipeParser {
  /**
   * Analyzes a video to extract recipe information.
   * @param videoUrl URL of the video to analyze
   * @param caption Existing caption text (for context)
   * @param partialRecipe Incomplete recipe from primary extraction (for context)
   */
  parseVideo(
    videoUrl: string,
    caption?: string,
    partialRecipe?: Partial<ParsedRecipe>,
  ): Promise<ParsedRecipe>;
}

/** Gemini structured-output schema describing the ParsedRecipe shape. */
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    isRecipe: { type: 'boolean' },
    title: { type: 'string' },
    servings: { type: 'integer' },
    ingredients: { type: 'array', items: { type: 'string' } },
    steps: { type: 'array', items: { type: 'string' } },
    macros: {
      type: 'object',
      properties: {
        calories: { type: 'number' },
        carbs: { type: 'number' },
        protein: { type: 'number' },
        fat: { type: 'number' },
      },
      required: ['calories', 'carbs', 'protein', 'fat'],
    },
    macrosStatedInCaption: { type: 'boolean' },
    suggestedCategory: { type: 'string', enum: [...CATEGORIES] },
  },
  required: [
    'isRecipe',
    'title',
    'ingredients',
    'steps',
    'macros',
    'macrosStatedInCaption',
    'suggestedCategory',
  ],
} as const;

const VIDEO_SYSTEM_PROMPT = `You extract a single cooking recipe from the provided video content.

Analyze ALL sources of information in the video:
1. SPOKEN AUDIO: Listen for ingredients, quantities, and instructions being spoken
2. ON-SCREEN TEXT: Read any text overlays showing measurements, temperatures, timings
3. VISUAL ACTIONS: Observe cooking techniques and ingredients being used
4. CAPTIONS/SUBTITLES: Use any embedded text in the video

Return JSON only, matching the provided schema.

Rules:
- isRecipe: true only when the video actually demonstrates or describes a recipe
  - If no recipe content is found, set isRecipe=false with empty arrays
  - NEVER invent a recipe. Do not guess ingredients not shown or mentioned.
- title: a short, human-friendly recipe name based on what is being prepared
- ingredients: one item per array entry, including quantity when stated/shown
  - Extract quantities from both spoken words AND on-screen text
  - If a quantity is clearly shown (e.g., measuring cup being filled) include it
  - If quantity cannot be determined, omit it rather than guessing
- steps: ordered preparation steps, one per array entry
  - Include timings and temperatures when shown or mentioned
  - Describe actions observed in the video
- servings: integer number of servings if stated. If unknown, assume 1.
- macros: per-serving calories (kcal), carbs (g), protein (g), fat (g)
  - If stated in video, use those values with macrosStatedInCaption=true
  - Otherwise estimate from ingredients with macrosStatedInCaption=false
- suggestedCategory: one of meals, drinks, snacks, desserts

Language preservation:
- Write title, ingredients and steps in the SAME language spoken in the video
- Keep ingredient names exactly as spoken (e.g., "haldi" not "turmeric")
- Keep local units and measures as stated

Uncertainty handling:
- If audio is unclear, use visual context to verify
- If conflicting information exists, prefer what is clearly shown/written
- Mark quantities as "approximately" when not precisely stated
- Do not fabricate information not present in the video`;

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  error?: { message?: string; code?: number };
}

interface GeminiFileUploadResponse {
  file?: {
    name?: string;
    uri?: string;
    mimeType?: string;
    state?: string;
  };
  error?: { message?: string; code?: number };
}

/**
 * Downloads video from URL and returns as base64 with mime type.
 */
async function downloadVideo(
  videoUrl: string,
  fetchImpl: typeof fetch,
): Promise<{ data: string; mimeType: string }> {
  const response = await fetchImpl(videoUrl);
  if (!response.ok) {
    throw upstreamError(`Failed to download video: HTTP ${response.status}`);
  }

  const contentType = response.headers.get('content-type') ?? 'video/mp4';
  const buffer = await response.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');

  return { data: base64, mimeType: contentType };
}

/**
 * Uploads video to Gemini File API for processing.
 * Required for videos over ~20MB or longer than ~1 minute.
 */
async function uploadToGeminiFiles(
  videoData: string,
  mimeType: string,
  config: Pick<Config, 'geminiApiKey'>,
  fetchImpl: typeof fetch,
): Promise<string> {
  const uploadEndpoint =
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${encodeURIComponent(config.geminiApiKey)}`;

  const metadata = JSON.stringify({
    file: { displayName: 'recipe_video' },
  });

  const boundary = '----GeminiFileBoundary' + Date.now();
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=utf-8\r\n\r\n` +
    `${metadata}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType}\r\n` +
    `Content-Transfer-Encoding: base64\r\n\r\n` +
    `${videoData}\r\n` +
    `--${boundary}--`;

  const response = await fetchImpl(uploadEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });

  if (!response.ok) {
    throw upstreamError(`Gemini file upload failed: HTTP ${response.status}`);
  }

  const result = (await response.json()) as GeminiFileUploadResponse;
  if (!result.file?.uri) {
    throw upstreamError('Gemini file upload returned no URI');
  }

  return result.file.uri;
}

/**
 * Creates a video recipe parser backed by Gemini's multimodal API.
 * `fetchImpl` is injectable for testing.
 */
export function createGeminiVideoParser(
  config: Pick<Config, 'geminiApiKey' | 'geminiVideoModel'>,
  fetchImpl: typeof fetch = fetch,
): VideoRecipeParser {
  return {
    async parseVideo(
      videoUrl: string,
      caption?: string,
      partialRecipe?: Partial<ParsedRecipe>,
    ): Promise<ParsedRecipe> {
      // Download the video
      let videoData: { data: string; mimeType: string };
      try {
        videoData = await downloadVideo(videoUrl, fetchImpl);
      } catch (err) {
        throw upstreamError(`Could not download video: ${(err as Error).message}`);
      }

      // Build context from caption and partial recipe
      const contextParts: string[] = [];
      if (caption) {
        contextParts.push(`Original caption:\n${caption}`);
      }
      if (partialRecipe) {
        if (partialRecipe.title) {
          contextParts.push(`Partial title from caption: ${partialRecipe.title}`);
        }
        if (partialRecipe.ingredients?.length) {
          contextParts.push(
            `Partial ingredients from caption:\n${partialRecipe.ingredients.join('\n')}`,
          );
        }
        if (partialRecipe.steps?.length) {
          contextParts.push(`Partial steps from caption:\n${partialRecipe.steps.join('\n')}`);
        }
      }

      const userPrompt = contextParts.length > 0
        ? `Analyze this cooking video and extract the complete recipe. Use the following context from the caption to help, but prioritize what you see and hear in the video:\n\n${contextParts.join('\n\n')}`
        : 'Analyze this cooking video and extract the complete recipe.';

      // For larger videos, upload to File API first
      const videoSizeBytes = (videoData.data.length * 3) / 4;
      const VIDEO_SIZE_THRESHOLD = 15 * 1024 * 1024; // 15MB

      let videoPart: Record<string, unknown>;
      if (videoSizeBytes > VIDEO_SIZE_THRESHOLD) {
        const fileUri = await uploadToGeminiFiles(
          videoData.data,
          videoData.mimeType,
          config,
          fetchImpl,
        );
        videoPart = {
          fileData: {
            mimeType: videoData.mimeType,
            fileUri,
          },
        };
      } else {
        videoPart = {
          inlineData: {
            mimeType: videoData.mimeType,
            data: videoData.data,
          },
        };
      }

      const endpoint =
        `https://generativelanguage.googleapis.com/v1beta/models/` +
        `${config.geminiVideoModel}:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`;

      const response = await generateContentWithRetry(
        endpoint,
        JSON.stringify({
          systemInstruction: { parts: [{ text: VIDEO_SYSTEM_PROMPT }] },
          contents: [
            {
              role: 'user',
              parts: [
                videoPart,
                { text: userPrompt },
              ],
            },
          ],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: RESPONSE_SCHEMA,
            temperature: 0.2,
          },
        }),
        fetchImpl,
      );

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw upstreamError(`Gemini returned HTTP ${response.status}: ${errorBody}`);
      }

      const data = (await response.json()) as GeminiResponse;

      if (data.error) {
        throw upstreamError(`Gemini error: ${data.error.message ?? 'Unknown error'}`);
      }

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        throw unprocessable('Gemini video analysis returned no recipe content.');
      }

      let parsed: ParsedRecipe;
      try {
        parsed = JSON.parse(text) as ParsedRecipe;
      } catch {
        throw unprocessable('Gemini returned malformed recipe JSON from video analysis.');
      }

      const validated = validateParsedRecipe(parsed);
      if (!validated.success) {
        throw unprocessable('Gemini returned a malformed recipe response from video analysis.');
      }
      return validated.data;
    },
  };
}
