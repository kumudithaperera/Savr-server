import { createHash, createHmac } from 'node:crypto';

import type { FastifyRequest } from 'fastify';

import { badRequest } from './errors.js';
import { deviceIdOf } from './grants.js';

/**
 * Pieces shared by every accountless community surface: the ideas board
 * (`routes/community.ts`), the recipe feed (`routes/recipe-feed.ts`) and
 * Discover (`routes/discover.ts`). One identity scheme for all three, so a ban
 * or a block written by one holds in the others.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Trims, normalises newlines, strips control characters, collapses blank runs. */
export function cleanText(raw: unknown, { singleLine }: { singleLine: boolean }): string {
  if (typeof raw !== 'string') return '';
  let text = raw.replace(/\r\n?/g, '\n');
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\u0000-\u0008\u000B-\u001F\u007F​-‏‪-‮]/g, '');
  text = singleLine ? text.replace(/\s+/g, ' ') : text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

export function requireUuid(value: unknown, what: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw badRequest(`Invalid ${what}.`);
  return value.toLowerCase();
}

export function asBody(request: FastifyRequest): Record<string, unknown> {
  const body = request.body;
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
}

export function asQuery(request: FastifyRequest): Record<string, string | undefined> {
  return (request.query ?? {}) as Record<string, string | undefined>;
}

/** Offset cursor, clamped so nobody can ask Postgres to skip a million rows. */
export function offsetOf(cursor: string | undefined): number {
  return Math.max(0, Math.min(10_000, Number.parseInt(cursor ?? '0', 10) || 0));
}

export interface CommunityIdentity {
  /** sha256(pepper:deviceId) - the `author_hash` stored on every row. Never returned. */
  hashOf(deviceId: string): string;
  /** The caller's author hash, or null when the app sent no device id. */
  callerOf(request: FastifyRequest): string | null;
  /**
   * Public fallback name for someone who never set one, e.g. "Cook 4F2A".
   * An HMAC of the author hash under a key derived from the pepper, so it is
   * stable per device but can't be reversed or recomputed from outside.
   */
  handleOf(authorHash: string): string;
}

export function createCommunityIdentity(pepper: string): CommunityIdentity {
  const hashOf = (deviceId: string) => createHash('sha256').update(`${pepper}:${deviceId}`).digest('hex');
  return {
    hashOf,
    callerOf(request) {
      const deviceId = deviceIdOf(request);
      return deviceId === 'unknown' ? null : hashOf(deviceId);
    },
    handleOf(authorHash) {
      const tag = createHmac('sha256', `handle:${pepper}`).update(authorHash).digest('hex');
      return `Cook ${tag.slice(0, 4).toUpperCase()}`;
    },
  };
}

/**
 * A display name someone typed in Profile. Letters (any script), digits,
 * spaces and a little punctuation; anything else means "use the handle".
 * The result still goes through moderation with the rest of the post.
 */
export function cleanDisplayName(raw: unknown): string | null {
  const name = cleanText(raw, { singleLine: true });
  if (name.length < 2 || name.length > 30) return null;
  if (!/^[\p{L}\p{M}\p{N} .'_-]+$/u.test(name)) return null;
  return name;
}

export const REPORT_REASONS = [
  'spam',
  'offensive',
  'harassment',
  'personal_info',
  'off_topic',
  'other',
] as const;
