/**
 * The politeness layer.
 *
 * Two things here are promises rather than implementation details, so they get tests:
 * discovery FAILS CLOSED without a contact address, and the User-Agent carries that
 * address. Everything else in this file - the retry classification, Retry-After in
 * both of its formats, the per-host floor - is the difference between a considerate
 * client and one that gets a board blocked.
 *
 * `fetch` is stubbed. No test in this file touches the network.
 */
import { ConfigService } from '@nestjs/config';
import {
  MAX_RETRY_AFTER_MS,
  PER_HOST_MIN_INTERVAL_MS,
} from './discovery.constants';
import {
  DiscoveryHttpClient,
  FetchError,
  parseRetryAfter,
} from './http.client';

function clientWith(
  env: Record<string, string | undefined>,
): DiscoveryHttpClient {
  const config = { get: (key: string) => env[key] } as unknown as ConfigService;
  return new DiscoveryHttpClient(config);
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('DiscoveryHttpClient configuration', () => {
  it('is unconfigured without a contact address', () => {
    expect(clientWith({}).isConfigured()).toBe(false);
    expect(
      clientWith({ DISCOVERY_CONTACT_EMAIL: 'a@b.com' }).isConfigured(),
    ).toBe(true);
  });

  it('refuses to send a single request when unconfigured', async () => {
    // FAILS CLOSED. The alternative - one anonymous request - is the thing this
    // whole file exists to make impossible, so it is asserted rather than trusted.
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const client = clientWith({});

    await expect(
      client.fetchJson('https://example.com/x', 'board'),
    ).rejects.toThrow(/DISCOVERY_CONTACT_EMAIL is not set/);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('never builds an anonymous User-Agent', () => {
    expect(() => clientWith({}).userAgent()).toThrow(/DISCOVERY_CONTACT_EMAIL/);
  });

  it('names the project and a reachable human', () => {
    const ua = clientWith({
      DISCOVERY_CONTACT_EMAIL: 'me@example.com',
    }).userAgent();
    expect(ua).toContain('autopilot-job-discovery/');
    expect(ua).toContain('mailto:me@example.com');
    // No browser token anywhere in it. A UA claiming to be Chrome is exactly the
    // disguise this file rules out.
    expect(ua).not.toMatch(/Mozilla|Chrome|Safari|AppleWebKit/);
  });

  it('sends the honest headers and nothing resembling a browser', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ jobs: [] }));
    const client = clientWith({ DISCOVERY_CONTACT_EMAIL: 'me@example.com' });

    await client.fetchJson('https://example.com/x', 'board');

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['User-Agent']).toContain('mailto:me@example.com');
    expect(headers.Accept).toBe('application/json');
    expect(Object.keys(headers).sort()).toEqual(['Accept', 'User-Agent']);
    fetchSpy.mockRestore();
  });
});

describe('DiscoveryHttpClient.fetchJson', () => {
  let fetchSpy: jest.SpyInstance;
  const client = clientWith({ DISCOVERY_CONTACT_EMAIL: 'me@example.com' });

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    jest.useRealTimers();
    fetchSpy.mockRestore();
  });

  /** Runs a promise to settlement while auto-advancing the fake clock. */
  async function settle<T>(promise: Promise<T>): Promise<T> {
    const drain = (async () => {
      // Each loop lets pending microtasks run, then jumps the clock past any sleep
      // the client is in. Without this a retry test would wait out a real 2s backoff.
      for (let i = 0; i < 200; i++) {
        await Promise.resolve();
        jest.advanceTimersByTime(MAX_RETRY_AFTER_MS);
      }
    })();
    try {
      return await promise;
    } finally {
      await drain;
    }
  }

  it('returns the parsed body', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ jobs: [{ id: 1 }] }));
    await expect(
      settle(
        client.fetchJson<{ jobs: unknown[] }>('https://a.example.com/x', 'b'),
      ),
    ).resolves.toEqual({ jobs: [{ id: 1 }] });
  });

  it('does not retry a 404 - a board that is gone stays gone', async () => {
    fetchSpy.mockResolvedValue(new Response('nope', { status: 404 }));
    await expect(
      settle(client.fetchJson('https://b.example.com/x', 'b')),
    ).rejects.toMatchObject({ status: 404 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not retry a 403 - we are not welcome, and asking again is worse', async () => {
    fetchSpy.mockResolvedValue(new Response('', { status: 403 }));
    await expect(
      settle(client.fetchJson('https://c.example.com/x', 'b')),
    ).rejects.toMatchObject({ status: 403 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('retries a 500 and succeeds on the second attempt', async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    await expect(
      settle(client.fetchJson('https://d.example.com/x', 'b')),
    ).resolves.toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('retries a 429 and gives up after MAX_ATTEMPTS', async () => {
    fetchSpy.mockResolvedValue(
      new Response('', { status: 429, headers: { 'retry-after': '1' } }),
    );
    await expect(
      settle(client.fetchJson('https://e.example.com/x', 'b')),
    ).rejects.toMatchObject({ status: 429 });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('retries a transport failure, which has no status', async () => {
    fetchSpy
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    await expect(
      settle(client.fetchJson('https://f.example.com/x', 'b')),
    ).resolves.toEqual({ ok: true });
  });

  it('reports HTML-instead-of-JSON with a snippet, and does not retry it', async () => {
    // The shape of "the API moved and this is now a marketing page". The snippet is
    // the part that tells you which.
    fetchSpy.mockResolvedValue(
      new Response('<!DOCTYPE html>\n<html><head><title>Careers', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );
    await expect(
      settle(client.fetchJson('https://g.example.com/x', 'b')),
    ).rejects.toThrow(/expected JSON, got <!DOCTYPE html>/);
    // status 200 is neither null, 429, nor >= 500, so this is not retried.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('honours Retry-After over its own backoff', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response('', { status: 429, headers: { 'retry-after': '7' } }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const sleeps: number[] = [];
    const setTimeoutSpy = jest
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((fn: () => void, ms?: number) => {
        // Only the backoff sleeps are interesting; the per-host gate also sleeps.
        if (ms !== undefined && ms > PER_HOST_MIN_INTERVAL_MS) sleeps.push(ms);
        fn();
        return 0 as unknown as NodeJS.Timeout;
      });

    await client.fetchJson('https://h.example.com/x', 'b');
    expect(sleeps).toContain(7000);
    setTimeoutSpy.mockRestore();
  });
});

describe('parseRetryAfter', () => {
  it('reads delta-seconds', () => {
    expect(parseRetryAfter('30')).toBe(30_000);
    expect(parseRetryAfter('  30  ')).toBe(30_000);
    expect(parseRetryAfter('0')).toBe(0);
  });

  it('reads an HTTP date, which is the other legal form', () => {
    const future = new Date(Date.now() + 10_000).toUTCString();
    const parsed = parseRetryAfter(future) ?? 0;
    // Second-resolution header against a millisecond clock, hence the window.
    expect(parsed).toBeGreaterThan(8_000);
    expect(parsed).toBeLessThanOrEqual(10_000);
  });

  it('clamps a past date to zero rather than going negative', () => {
    // A server whose clock is behind ours. A negative delay would become an instant
    // retry against a host that just asked us to slow down.
    expect(parseRetryAfter(new Date(Date.now() - 60_000).toUTCString())).toBe(
      0,
    );
  });

  it('caps an absurd value', () => {
    // Some servers answer "wait a day". Waiting is right; waiting inside a nightly
    // pass is not.
    expect(parseRetryAfter('86400')).toBe(MAX_RETRY_AFTER_MS);
  });

  it('returns undefined for a missing or unparseable header, so backoff applies', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter('-5')).toBeUndefined();
  });
});

describe('FetchError', () => {
  it('carries the status and the tenant-missing distinction', () => {
    // tenantMissing is separate from status ON PURPOSE: Keka, Zoho and Darwinbox all
    // answer 200 for a tenant that does not exist, and Lever answers 200 with
    // `{ok: false}`. Absence is a body fact, not a status fact.
    const missing = new FetchError('no such board', 200, true);
    expect(missing.status).toBe(200);
    expect(missing.tenantMissing).toBe(true);
    expect(new FetchError('boom', 500).tenantMissing).toBe(false);
    expect(missing).toBeInstanceOf(Error);
    expect(missing.name).toBe('FetchError');
  });
});
