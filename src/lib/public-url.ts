import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { unsupportedLink } from './errors.js';

/**
 * SSRF guard for fetches of user-supplied links (the generic web scraper).
 *
 * The scraper fetches whatever URL someone pastes, from inside our hosting
 * network. Without this, `http://169.254.169.254/...` (cloud metadata),
 * `http://localhost:6379` or a private-range admin panel are one paste away, and
 * the page text comes straight back to the caller as a "recipe".
 *
 * Every hostname is resolved and *all* of its addresses must be public. This is
 * checked again on every redirect hop, since a public page can 302 to a private
 * one. Residual risk: DNS rebinding between this lookup and the fetch's own
 * lookup. Closing that needs a pinned-address dispatcher; the per-hop check
 * still stops every static private target.
 */

/** Resolves a hostname to every address it answers with. Injectable for tests. */
export type HostResolver = (hostname: string) => Promise<string[]>;

export const dnsResolver: HostResolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);
}

/** [network, prefix length] for every IPv4 range that must never be fetched. */
const BLOCKED_V4: readonly [string, number][] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, incl. cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];

function isBlockedV4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  return BLOCKED_V4.some(([network, bits]) => {
    const size = 2 ** (32 - bits);
    const start = ipv4ToInt(network);
    return value >= start && value < start + size;
  });
}

function isBlockedV6(ip: string): boolean {
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (lower === '::' || lower === '::1') return true;
  // IPv4-mapped / -compatible (::ffff:127.0.0.1) - judge the embedded IPv4.
  const embedded = /^(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower)?.[1];
  if (embedded) return isBlockedV4(embedded);
  // Hex-form IPv4-mapped (::ffff:7f00:1), as the WHATWG URL parser emits it.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (mapped) {
    const hi = parseInt(mapped[1], 16);
    const lo = parseInt(mapped[2], 16);
    return isBlockedV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const first = parseInt(lower.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (lower.startsWith('64:ff9b:')) return true; // NAT64 can reach private v4
  if (lower.startsWith('2001:db8:')) return true; // documentation
  return false;
}

/** Whether an IP literal is safe to connect to (public unicast only). */
export function isPublicAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '');
  const family = isIP(bare);
  if (family === 4) return !isBlockedV4(bare);
  if (family === 6) return !isBlockedV6(bare);
  return false;
}

const refused = () =>
  unsupportedLink("Morsel can't read that link. Paste a link to a public recipe page instead.");

/**
 * Throws unless `url` is http(s) on the default ports and every address its host
 * resolves to is public. Returns the parsed URL.
 */
export async function assertPublicUrl(
  url: string | URL,
  resolve: HostResolver = dnsResolver,
): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw refused();
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw refused();
  // Recipe sites live on 80/443; any other port is an internal-service probe.
  if (parsed.port !== '') throw refused();
  if (parsed.username || parsed.password) throw refused();

  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw refused();
    return parsed;
  }
  const lowerHost = host.toLowerCase();
  if (lowerHost === 'localhost' || lowerHost.endsWith('.localhost') || lowerHost.endsWith('.internal')) {
    throw refused();
  }

  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    throw refused();
  }
  if (addresses.length === 0 || !addresses.every(isPublicAddress)) throw refused();
  return parsed;
}
