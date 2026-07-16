import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

export interface Config {
  apifyToken: string;
  apifyInstagramActor: string;
  apifyTiktokActor: string;
  /**
   * Whether to ask the TikTok actor for native subtitles (captions) only, with
   * no AI speech-to-text. Native subtitles are billed at the flat per-video rate;
   * AI transcription of subtitle-less videos is billed per audio-minute. Keeping
   * this on avoids that cost wildcard in early access. Flip via env to enable a
   * transcribe-capable actor later.
   */
  apifyTiktokNativeSubtitlesOnly: boolean;
  geminiApiKey: string;
  geminiModel: string;
  port: number;
  /**
   * Shared secret the app sends as `x-morsel-app-key`. When set, the backend
   * rejects `/extract` and `/improve` calls that don't present it — a lightweight
   * guardrail against random callers running up Apify/Gemini spend. Empty disables
   * the check (fine for local dev); set it in any deployed environment.
   */
  appSharedSecret: string;
}

export function loadConfig(): Config {
  return {
    apifyToken: required('APIFY_TOKEN'),
    apifyInstagramActor: process.env.APIFY_INSTAGRAM_ACTOR ?? 'apify~instagram-scraper',
    apifyTiktokActor: process.env.APIFY_TIKTOK_ACTOR ?? 'clockworks~free-tiktok-scraper',
    apifyTiktokNativeSubtitlesOnly: process.env.APIFY_TIKTOK_NATIVE_SUBTITLES_ONLY !== 'false',
    geminiApiKey: required('GEMINI_API_KEY'),
    geminiModel: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
    port: Number(process.env.PORT ?? 3000),
    appSharedSecret: process.env.APP_SHARED_SECRET ?? '',
  };
}
