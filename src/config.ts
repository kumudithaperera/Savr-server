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
  geminiApiKey: string;
  geminiModel: string;
  port: number;
}

export function loadConfig(): Config {
  return {
    apifyToken: required('APIFY_TOKEN'),
    apifyInstagramActor: process.env.APIFY_INSTAGRAM_ACTOR ?? 'apify~instagram-scraper',
    geminiApiKey: required('GEMINI_API_KEY'),
    geminiModel: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
    port: Number(process.env.PORT ?? 3000),
  };
}
