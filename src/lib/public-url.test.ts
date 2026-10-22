import { describe, expect, it } from 'vitest';

import { assertPublicUrl, isPublicAddress } from './public-url.js';

describe('isPublicAddress', () => {
  it.each(['8.8.8.8', '93.184.216.34', '2606:4700::1111'])('allows %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });

  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:10.0.0.1',
    '::ffff:7f00:1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'not-an-ip',
  ])('blocks %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it('does not over-block the neighbours of private ranges', () => {
    expect(isPublicAddress('172.15.255.255')).toBe(true);
    expect(isPublicAddress('172.32.0.1')).toBe(true);
    expect(isPublicAddress('100.128.0.1')).toBe(true);
  });
});

describe('assertPublicUrl', () => {
  const publicDns = async () => ['93.184.216.34'];

  it('passes a normal recipe link', async () => {
    const url = await assertPublicUrl('https://example.com/recipes/pasta', publicDns);
    expect(url.hostname).toBe('example.com');
  });

  it.each(['ftp://example.com/x', 'file:///etc/passwd', 'http://foo.internal/x', 'http://a.localhost/x'])(
    'refuses %s',
    async (url) => {
      await expect(assertPublicUrl(url, publicDns)).rejects.toMatchObject({ code: 'unsupported_link' });
    },
  );

  it('refuses a host that does not resolve', async () => {
    const failing = async () => {
      throw new Error('ENOTFOUND');
    };
    await expect(assertPublicUrl('https://nope.example/x', failing)).rejects.toMatchObject({
      code: 'unsupported_link',
    });
  });
});
