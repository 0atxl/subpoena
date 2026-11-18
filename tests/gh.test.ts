import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadImage } from '@napi-rs/canvas';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CACHE_CONTROL_FALLBACK,
  getDefaultOgPngBuffer,
  handleCardRequest,
  resetCardRateLimiter,
} from '../api/card';
import {
  CACHE_CONTROL_COMPLETE,
  CACHE_CONTROL_PARTIAL,
  buildCommitSearchQuery,
  clearBundleCache,
  fetchGitHubBundle,
  handleRequest,
  isValidGitHubHandle,
  resolveGitHubToken,
  type FetchLike,
} from '../api/gh';
import { evaluateHealth } from '../api/health';
import { handlePageRequest, injectOgTagsIntoHtml } from '../api/page';
import { PRESETS, PRESET_HANDLES } from '../api/presets';
import { evaluateCharges } from '../src/engine/charges';

beforeEach(() => {
  clearBundleCache();
  resetCardRateLimiter();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('api/presets', () => {
  it('bundles all four preset snapshots and evaluates cleanly', () => {
    expect(PRESET_HANDLES).toEqual([
      'torvalds',
      'sindresorhus',
      'gaearon',
      'octocat',
    ]);
    for (const handle of PRESET_HANDLES) {
      const preset = PRESETS[handle];
      expect(preset.preset).toBe(true);
      expect(preset.user?.login.toLowerCase()).toBe(handle);
      expect(preset.repos.length).toBeGreaterThan(0);
      expect(preset.commits?.items.length).toBeGreaterThan(0);
      const verdict = evaluateCharges(preset, new Date('2026-11-16T12:00:00Z'));
      expect(verdict.handle.toLowerCase()).toBe(handle);
    }
  });
});

describe('api/gh proxy', () => {
  it('builds commit search query with author-date:<=YYYY-MM-DD qualifier syntax', async () => {
    const fixedNow = new Date('2026-11-16T12:00:00Z');
    const query = buildCommitSearchQuery('torvalds', fixedNow);
    expect(query).toBe('author:torvalds author-date:<=2026-11-17');

    let capturedSearchUrl = '';
    const spyFetch: FetchLike = async (input) => {
      const url = String(input);
      if (url.includes('/search/commits')) {
        capturedSearchUrl = url;
        return jsonResponse({ total_count: 0, items: [] });
      }
      if (url.includes('/repos?') || url.includes('/events/public?')) {
        return jsonResponse([]);
      }
      return jsonResponse({
        login: 'torvalds',
        id: 1024025,
        avatar_url: 'https://avatars.githubusercontent.com/u/1024025?v=4',
        name: 'Linus Torvalds',
        type: 'User',
        public_repos: 1,
        followers: 1,
        created_at: '2011-09-03T15:26:22Z',
      });
    };

    await fetchGitHubBundle('torvalds', { fetchImpl: spyFetch, now: fixedNow });
    expect(capturedSearchUrl).toContain('author-date%3A%3C%3D2026-11-17');
    expect(new URL(capturedSearchUrl).searchParams.get('q')).toBe(
      'author:torvalds author-date:<=2026-11-17',
    );
  });

  it('validates GitHub handles including bots', () => {
    expect(isValidGitHubHandle('torvalds')).toBe(true);
    expect(isValidGitHubHandle('@gaearon')).toBe(true);
    expect(isValidGitHubHandle('dependabot[bot]')).toBe(true);
    expect(isValidGitHubHandle('')).toBe(false);
    expect(isValidGitHubHandle('-bad')).toBe(false);
    expect(isValidGitHubHandle('bad handle')).toBe(false);
  });

  it('merges all four GitHub endpoints and emits Cache-Control headers', async () => {
    const seenAuth: Array<string | null> = [];
    const seenUrls: string[] = [];
    const mockFetch: FetchLike = async (input, init) => {
      const url = String(input);
      seenUrls.push(url);
      const headers = new Headers(init?.headers);
      seenAuth.push(headers.get('Authorization'));

      if (url.endsWith('/users/testuser')) {
        return jsonResponse({
          login: 'testuser',
          id: 99,
          avatar_url: 'https://avatars.githubusercontent.com/u/99?v=4',
          name: 'Test User',
          type: 'User',
          public_repos: 1,
          followers: 5,
          created_at: '2022-01-01T00:00:00Z',
        });
      }
      if (url.includes('/repos?')) {
        return jsonResponse([
          {
            name: 'demo',
            full_name: 'testuser/demo',
            fork: false,
            stargazers_count: 3,
            license: { spdx_id: 'MIT', name: 'MIT License' },
            created_at: '2023-01-01T00:00:00Z',
            pushed_at: '2026-11-10T00:00:00Z',
          },
        ]);
      }
      if (url.includes('/events/public?')) {
        return jsonResponse([
          {
            id: '1',
            type: 'PushEvent',
            created_at: '2026-11-10T10:00:00Z',
            repo: { name: 'testuser/demo' },
            payload: { ref: 'refs/heads/main' },
          },
        ]);
      }
      return jsonResponse({
        total_count: 1,
        items: [
          {
            sha: 'deadbeef',
            commit: {
              message: 'wip\n\nmore detail',
              author: { date: '2026-11-10T03:00:00+05:30' },
            },
            repository: { full_name: 'testuser/demo' },
          },
        ],
      });
    };

    const res = await handleRequest(
      new Request('https://subpoena.test/api/gh?u=testuser'),
      {
        token: 'ghp_testtoken_noscopes',
        fetchImpl: mockFetch,
        now: new Date('2026-11-16T12:00:00Z'),
      },
    );

    expect(res.status).toBe(200);
    const cc = res.headers.get('Cache-Control') ?? '';
    expect(cc).toContain('s-maxage=');
    expect(cc).toContain('stale-while-revalidate=');
    expect(seenAuth.every((a) => a === 'Bearer ghp_testtoken_noscopes')).toBe(
      true,
    );
    expect(
      seenUrls.some((u) => {
        const q = new URL(u).searchParams.get('q') ?? '';
        return q.includes('author:testuser') && q.includes('author-date:<=2026-11-17');
      }),
    ).toBe(true);

    const body = (await res.json()) as typeof PRESETS.torvalds;
    expect(body.handle).toBe('testuser');
    expect(body.preset).toBe(false);
    expect(body.missing).toEqual({});
    expect(body.commits?.items[0]?.commit.message).toBe('wip');
  });

  it('handles 403, 422, and empty search results without throwing', async () => {
    const makePartialMock = (searchStatus: number, searchBody: unknown): FetchLike => {
      return async (input) => {
        const url = String(input);
        if (url.endsWith('/users/someuser')) {
          return jsonResponse({
            login: 'someuser',
            id: 77,
            avatar_url: 'https://avatars.githubusercontent.com/u/77?v=4',
            name: null,
            type: 'User',
            public_repos: 2,
            followers: 0,
            created_at: '2023-01-01T00:00:00Z',
          });
        }
        if (url.includes('/repos?')) return jsonResponse([]);
        if (url.includes('/events/public?')) return jsonResponse([]);
        return jsonResponse(searchBody, searchStatus);
      };
    };

    const r403 = await fetchGitHubBundle('someuser', {
      fetchImpl: makePartialMock(403, { message: 'secondary rate limit' }),
    });
    expect(r403.status).toBe(200);
    expect(r403.headers['Cache-Control']).toBe(CACHE_CONTROL_PARTIAL);
    expect(r403.headers['Cache-Control']).not.toContain('stale-while-revalidate');
    expect(r403.body.commits).toBeNull();
    expect(r403.body.missing.commits).toBe(403);
    expect(r403.body.missing.events).toBeUndefined();

    const r422 = await fetchGitHubBundle('someuser', {
      fetchImpl: makePartialMock(422, { message: 'Validation Failed' }),
    });
    expect(r422.status).toBe(200);
    expect(r422.body.commits).toBeNull();
    expect(r422.body.missing.commits).toBe(422);

    const rEmpty = await fetchGitHubBundle('someuser', {
      fetchImpl: makePartialMock(200, { total_count: 0, items: [] }),
    });
    expect(rEmpty.status).toBe(200);
    expect(rEmpty.body.commits?.items).toEqual([]);
    expect(rEmpty.body.missing.commits).toBe('empty');
  });

  it('recovers recent commits from Core REST /repos/{repo}/commits when /search/commits returns 403 and does not cache transient 403 failures', async () => {
    const recoveredFetch: FetchLike = async (input) => {
      const url = String(input);
      if (url.endsWith('/users/0atxl')) {
        return jsonResponse({
          login: '0atxl',
          id: 901,
          avatar_url: 'https://avatars.githubusercontent.com/u/901?v=4',
          name: 'Atul',
          type: 'User',
          public_repos: 1,
          followers: 5,
          created_at: '2022-01-01T00:00:00Z',
        });
      }
      if (url.includes('/users/0atxl/repos?')) {
        return jsonResponse([
          {
            name: 'subpoena',
            full_name: '0atxl/subpoena',
            fork: false,
            stargazers_count: 10,
            language: 'TypeScript',
            license: { spdx_id: 'MIT', name: 'MIT License' },
            created_at: '2026-01-01T00:00:00Z',
            pushed_at: '2026-11-18T12:00:00Z',
          },
        ]);
      }
      if (url.includes('/events/public?')) {
        return jsonResponse([
          {
            id: '10',
            type: 'PushEvent',
            created_at: '2026-11-18T12:00:00Z',
            repo: { name: '0atxl/subpoena' },
            payload: { ref: 'refs/heads/master' },
          },
        ]);
      }
      if (url.includes('/search/commits?')) {
        return jsonResponse({ message: 'secondary rate limit' }, 403);
      }
      if (url.includes('/repos/0atxl/subpoena/commits?author=0atxl')) {
        return jsonResponse([
          {
            sha: 'abc1234',
            commit: {
              message: 'feat: recover commits',
              author: { date: '2026-11-18T18:41:03+05:30' },
            },
          },
        ]);
      }
      return jsonResponse([], 404);
    };

    const res = await fetchGitHubBundle('0atxl', { fetchImpl: recoveredFetch });
    expect(res.status).toBe(200);
    expect(res.body.missing.commits).toBeUndefined();
    expect(res.body.commits?.items).toHaveLength(1);
    expect(res.body.commits?.items[0]?.sha).toBe('abc1234');
    expect(res.body.commits?.incomplete_results).toBe(true);

    // Ensure transient 403 (with no fallback candidates) does not stay pinned in bundleCache
    let attempt = 0;
    const retryFetch: FetchLike = async (input) => {
      const url = String(input);
      if (url.endsWith('/users/retrydev')) {
        return jsonResponse({
          login: 'retrydev',
          id: 902,
          avatar_url: 'https://avatars.githubusercontent.com/u/902?v=4',
          name: 'Retry Dev',
          type: 'User',
          public_repos: 0,
          followers: 1,
          created_at: '2024-01-01T00:00:00Z',
        });
      }
      if (url.includes('/repos?')) return jsonResponse([]);
      if (url.includes('/events/public?')) return jsonResponse([]);
      if (url.includes('/search/commits?')) {
        attempt++;
        if (attempt === 1) return jsonResponse({ message: 'secondary limit' }, 403);
        return jsonResponse({
          total_count: 1,
          incomplete_results: false,
          items: [
            {
              sha: 'def5678',
              commit: {
                message: 'fix: retry ok',
                author: { date: '2026-11-18T10:00:00Z' },
              },
              repository: { full_name: 'retrydev/app' },
            },
          ],
        });
      }
      return jsonResponse([], 404);
    };

    const first = await fetchGitHubBundle('retrydev', { fetchImpl: retryFetch });
    expect(first.body.missing.commits).toBe(403);
    const second = await fetchGitHubBundle('retrydev', { fetchImpl: retryFetch });
    expect(second.body.missing.commits).toBeUndefined();
    expect(second.body.commits?.items[0]?.sha).toBe('def5678');
  });

  it('handles 404 users cleanly without throwing', async () => {
    const mock404: FetchLike = async () => jsonResponse({ message: 'Not Found' }, 404);
    const res = await handleRequest(
      new Request('https://subpoena.test/api/gh?u=no-such-user-xyz'),
      { fetchImpl: mock404 },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as typeof PRESETS.torvalds;
    expect(body.user).toBeNull();
    expect(body.missing.user).toBe(404);
  });

  it('falls back to bundled preset on upstream 403 or network error', async () => {
    const mock403: FetchLike = async () =>
      jsonResponse({ message: 'API rate limit exceeded' }, 403);
    const res = await handleRequest(
      new Request('https://subpoena.test/api/gh?u=torvalds'),
      { fetchImpl: mock403 },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toContain('s-maxage=');
    const body = (await res.json()) as typeof PRESETS.torvalds;
    expect(body.preset).toBe(true);
    expect(body.user?.login).toBe('torvalds');
    expect(body.missing.user).toBe(403);

    const mockNetworkFail: FetchLike = async () => {
      throw new Error('ECONNREFUSED');
    };
    const resErr = await handleRequest(
      new Request('https://subpoena.test/api/gh?u=octocat'),
      { fetchImpl: mockNetworkFail },
    );
    expect(resErr.status).toBe(200);
    const bodyErr = (await resErr.json()) as typeof PRESETS.octocat;
    expect(bodyErr.preset).toBe(true);
    expect(bodyErr.user?.login).toBe('octocat');
  });

  it('returns structured 403 without throwing when a non-preset user is rate-limited', async () => {
    const mock403: FetchLike = async () =>
      jsonResponse({ message: 'API rate limit exceeded' }, 403);
    const res = await handleRequest(
      new Request('https://subpoena.test/api/gh?u=unknown-handle-123'),
      { fetchImpl: mock403 },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as typeof PRESETS.torvalds;
    expect(body.preset).toBe(false);
    expect(body.user).toBeNull();
    expect(body.missing.user).toBe(403);
  });

  it('rejects invalid handle with 400', async () => {
    const res = await handleRequest(
      new Request('https://subpoena.test/api/gh?u=bad%20handle!'),
    );
    expect(res.status).toBe(400);
  });

  it('fails loudly in health check and proxy when GITHUB_TOKEN is missing in production', async () => {
    const badHealth = evaluateHealth({ VERCEL_ENV: 'production' });
    expect(badHealth.status).toBe(500);
    expect(badHealth.body.ok).toBe(false);
    expect(badHealth.body.error).toContain('GITHUB_TOKEN');

    const okHealth = evaluateHealth({
      VERCEL_ENV: 'production',
      GITHUB_TOKEN: 'ghp_test',
    });
    expect(okHealth.status).toBe(200);
    expect(okHealth.body.ok).toBe(true);

    const prevEnv = process.env.VERCEL_ENV;
    const prevTok = process.env.GITHUB_TOKEN;
    try {
      process.env.VERCEL_ENV = 'production';
      delete process.env.GITHUB_TOKEN;
      const res = await handleRequest(
        new Request('https://subpoena.test/api/gh?u=torvalds'),
      );
      expect(res.status).toBe(500);
    } finally {
      if (prevEnv === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = prevEnv;
      if (prevTok === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = prevTok;
    }

    // Confirm gh auth token fallback never runs in production or Vercel runtimes
    expect(
      resolveGitHubToken(undefined, { VERCEL_ENV: 'production' }),
    ).toBeUndefined();
    expect(
      resolveGitHubToken(undefined, { NODE_ENV: 'production' }),
    ).toBeUndefined();
    expect(resolveGitHubToken(undefined, { VERCEL: '1' })).toBeUndefined();
  });

  it('skips /search/commits for Organization accounts so complete org records have partialRecord false', async () => {
    const requestedUrls: string[] = [];
    const orgFetch: FetchLike = async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.endsWith('/users/vercel')) {
        return jsonResponse({
          login: 'vercel',
          id: 14985020,
          avatar_url: 'https://avatars.githubusercontent.com/u/14985020?v=4',
          name: 'Vercel',
          type: 'Organization',
          public_repos: 10,
          followers: 1000,
          created_at: '2015-10-01T00:00:00Z',
        });
      }
      if (url.includes('/repos?')) {
        return jsonResponse(
          Array.from({ length: 6 }, (_, i) => ({
            name: `site-${i}`,
            full_name: `vercel/site-${i}`,
            fork: false,
            stargazers_count: 100,
            license: { spdx_id: 'MIT', name: 'MIT License' },
            created_at: '2022-01-01T00:00:00Z',
            pushed_at: '2026-11-10T00:00:00Z',
          })),
        );
      }
      if (url.includes('/events/public?')) {
        return jsonResponse([]);
      }
      throw new Error(`Unexpected call for org: ${url}`);
    };

    const orgRes = await fetchGitHubBundle('vercel', {
      fetchImpl: orgFetch,
      now: new Date('2026-11-16T12:00:00Z'),
    });
    expect(orgRes.status).toBe(200);
    expect(requestedUrls.some((u) => u.includes('/search/commits'))).toBe(false);
    expect(orgRes.body.missing).toEqual({});
    expect(orgRes.headers['Cache-Control']).toBe(CACHE_CONTROL_COMPLETE);

    const verdict = evaluateCharges(
      orgRes.body,
      new Date('2026-11-16T12:00:00Z'),
    );
    expect(verdict.accountKind).toBe('Organization');
    expect(verdict.partialRecord).toBe(false);
    expect(verdict.verdict).toBe('ACQUITTED');

    // Bots must still call /search/commits
    const botUrls: string[] = [];
    const botFetch: FetchLike = async (input) => {
      const url = String(input);
      botUrls.push(url);
      if (url.endsWith('/users/dependabot%5Bbot%5D')) {
        return jsonResponse({
          login: 'dependabot[bot]',
          id: 49699333,
          avatar_url: '',
          name: null,
          type: 'Bot',
          public_repos: 0,
          followers: 0,
          created_at: '2019-04-16T00:00:00Z',
        });
      }
      if (url.includes('/search/commits')) {
        return jsonResponse({ total_count: 0, items: [] });
      }
      return jsonResponse([]);
    };

    await fetchGitHubBundle('dependabot[bot]', {
      fetchImpl: botFetch,
      now: new Date('2026-11-16T12:00:00Z'),
    });
    expect(botUrls.some((u) => u.includes('/search/commits'))).toBe(true);
  });
});

describe('api/card endpoint', () => {
  it('renders a 1200x675 PNG card with short s-maxage Cache-Control on rate-limit preset fallback', async () => {
    const mockRateLimited: FetchLike = async () =>
      jsonResponse({ message: 'rate limit' }, 403);
    const res = await handleCardRequest(
      new Request('https://subpoena.test/api/card?u=torvalds'),
      { fetchImpl: mockRateLimited, now: new Date('2026-11-16T12:00:00Z') },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Cache-Control')).toBe(CACHE_CONTROL_PARTIAL);
    expect(res.headers.get('Cache-Control')).not.toContain(
      'stale-while-revalidate',
    );
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.byteLength).toBeGreaterThan(50_000);
    const img = await loadImage(buf);
    expect(img.width).toBe(1200);
    expect(img.height).toBe(675);
  });

  it('uses short partial cache without swr on partial records and long cache on complete records', async () => {
    const completeFetch: FetchLike = async (input) => {
      const url = String(input);
      if (url.includes('/users/')) {
        return jsonResponse({
          login: 'cleanuser',
          id: 500,
          avatar_url: '',
          name: 'Clean User',
          type: 'User',
          public_repos: 1,
          followers: 1,
          created_at: '2020-01-01T00:00:00Z',
        });
      }
      if (url.includes('/search/commits')) {
        return jsonResponse({
          total_count: 1,
          items: [
            {
              sha: '111',
              commit: {
                message: 'feat(core): ship release',
                author: { date: '2026-11-10T12:00:00+02:00' },
              },
            },
          ],
        });
      }
      return jsonResponse([]);
    };

    const fullCard = await handleCardRequest(
      new Request('https://subpoena.test/api/card?u=cleanuser'),
      { fetchImpl: completeFetch, now: new Date('2026-11-16T12:00:00Z') },
    );
    expect(fullCard.status).toBe(200);
    expect(fullCard.headers.get('Cache-Control')).toBe(CACHE_CONTROL_COMPLETE);

    const partialFetch: FetchLike = async (input) => {
      const url = String(input);
      if (url.includes('/search/commits')) {
        return jsonResponse({ message: 'rate limit' }, 403);
      }
      return completeFetch(input);
    };

    const partialCard = await handleCardRequest(
      new Request('https://subpoena.test/api/card?u=partialuser'),
      { fetchImpl: partialFetch, now: new Date('2026-11-16T12:00:00Z') },
    );
    expect(partialCard.status).toBe(200);
    expect(partialCard.headers.get('Cache-Control')).toBe(CACHE_CONTROL_PARTIAL);
    expect(partialCard.headers.get('Cache-Control')).not.toContain(
      'stale-while-revalidate',
    );
  });

  it('falls back to og-default.png with s-maxage=30 on slow timeout and upstream failure', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const expectedDefault = getDefaultOgPngBuffer();

      const slowFetch: FetchLike = () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(jsonResponse({}, 200)), 180);
        });

      const timedOut = await handleCardRequest(
        new Request('https://subpoena.test/api/card?u=slow-suspect'),
        { fetchImpl: slowFetch, timeoutMs: 35 },
      );
      expect(timedOut.status).toBe(200);
      expect(timedOut.headers.get('Content-Type')).toBe('image/png');
      expect(timedOut.headers.get('Cache-Control')).toBe(CACHE_CONTROL_FALLBACK);
      expect(Buffer.from(await timedOut.arrayBuffer()).equals(expectedDefault)).toBe(
        true,
      );
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('timeout'),
      );

      errSpy.mockClear();
      const failingFetch: FetchLike = async () => {
        throw new Error('Upstream GitHub 500 boom');
      };
      const failed = await handleCardRequest(
        new Request('https://subpoena.test/api/card?u=failing-suspect'),
        { fetchImpl: failingFetch },
      );
      expect(failed.status).toBe(200);
      expect(failed.headers.get('Content-Type')).toBe('image/png');
      expect(failed.headers.get('Cache-Control')).toBe(CACHE_CONTROL_FALLBACK);
      expect(Buffer.from(await failed.arrayBuffer()).equals(expectedDefault)).toBe(
        true,
      );
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('Returning og-default.png fallback'),
      );
    } finally {
      errSpy.mockRestore();
    }
  });

  it('rate-limits /api/card per IP and gracefully returns og-default.png with HTTP 200', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const expectedDefault = getDefaultOgPngBuffer();
      const opts = {
        rateLimitMax: 2,
        rateLimitWindowMs: 60_000,
        fetchImpl: async () => jsonResponse({ message: 'preset fallback' }, 403),
      };

      const reqA = () =>
        new Request('https://subpoena.test/api/card?u=torvalds', {
          headers: { 'x-forwarded-for': '198.51.100.10' },
        });
      const r1 = await handleCardRequest(reqA(), opts);
      const r2 = await handleCardRequest(reqA(), opts);
      const r3 = await handleCardRequest(reqA(), opts);

      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(r3.status).toBe(200);
      expect(r3.headers.get('Content-Type')).toBe('image/png');
      expect(r3.headers.get('Cache-Control')).toBe(CACHE_CONTROL_FALLBACK);
      expect(Buffer.from(await r3.arrayBuffer()).equals(expectedDefault)).toBe(
        true,
      );

      // Different IP is unaffected
      const otherIp = await handleCardRequest(
        new Request('https://subpoena.test/api/card?u=torvalds', {
          headers: { 'x-forwarded-for': '203.0.113.42' },
        }),
        opts,
      );
      expect(otherIp.status).toBe(200);
      expect(otherIp.headers.get('Cache-Control')).toBe(CACHE_CONTROL_PARTIAL);
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('api/page server OG injection and opt-out protection', () => {
  it('injects absolute OG tags from x-forwarded headers for valid ?u= and strips malicious ?u= values', async () => {
    const template = fs.readFileSync(
      path.resolve(process.cwd(), 'index.html'),
      'utf-8',
    );

    const validResp = handlePageRequest(
      new Request('https://internal.local/?u=torvalds', {
        headers: {
          'x-forwarded-host': 'subpoena.example.org',
          'x-forwarded-proto': 'https',
        },
      }),
      template,
    );
    expect(validResp.status).toBe(200);
    const validHtml = await validResp.text();
    expect(validHtml).toContain(
      '<meta property="og:title" content="Subpoena — @torvalds GitHub Rap Sheet" />',
    );
    expect(validHtml).toContain(
      '<meta property="og:image" content="https://subpoena.example.org/api/card?u=torvalds" />',
    );
    expect(validHtml).toContain(
      '<meta name="twitter:image" content="https://subpoena.example.org/api/card?u=torvalds" />',
    );
    expect(validHtml).toContain(
      '<meta property="og:image:width" content="1200" />',
    );
    expect(validHtml).toContain(
      '<meta property="og:image:height" content="675" />',
    );
    expect(validHtml).toContain(
      '<meta name="twitter:card" content="summary_large_image" />',
    );

    const xssHtml = injectOgTagsIntoHtml(
      template,
      'https://subpoena.example.org/?u=%22%3E%3Cscript%3Ealert(1)%3C/script%3E',
      { host: 'subpoena.example.org', forwardedProto: 'https' },
    );
    expect(xssHtml).not.toContain('alert(1)');
    expect(xssHtml).toContain(
      '<meta property="og:image" content="https://subpoena.example.org/og-default.png" />',
    );
    expect(xssHtml).toContain(
      '<meta property="og:title" content="Subpoena — GitHub Rap Sheet" />',
    );

    // Opted-out handle (mixed case) must use the default OG image and not leak custom metadata
    const optOutHtml = injectOgTagsIntoHtml(
      template,
      'https://subpoena.example.org/?u=Sealed-Suspect',
      { host: 'subpoena.example.org', forwardedProto: 'https' },
    );
    expect(optOutHtml).toContain(
      '<meta property="og:image" content="https://subpoena.example.org/og-default.png" />',
    );
    expect(optOutHtml).not.toContain('/api/card?u=');
  });

  it('returns empty sealed bundle from api/gh and sealed PNG from api/card for mixed-case opted-out handle without fetching GitHub', async () => {
    const spyFetch: FetchLike = async () => {
      throw new Error('GitHub should never be called for opted-out handles');
    };

    const ghRes = await handleRequest(
      new Request('https://subpoena.test/api/gh?u=%40Sealed-Suspect'),
      { fetchImpl: spyFetch },
    );
    expect(ghRes.status).toBe(200);
    const body = (await ghRes.json()) as {
      sealed?: boolean;
      user: unknown;
      repos: unknown[];
      events: unknown[];
      commits: unknown;
    };
    expect(body.sealed).toBe(true);
    expect(body.user).toBeNull();
    expect(body.repos).toEqual([]);
    expect(body.events).toEqual([]);
    expect(body.commits).toBeNull();

    const cardRes = await handleCardRequest(
      new Request('https://subpoena.test/api/card?u=SEALED-SUSPECT'),
      { fetchImpl: spyFetch },
    );
    expect(cardRes.status).toBe(200);
    expect(cardRes.headers.get('Content-Type')).toBe('image/png');
    const img = await loadImage(Buffer.from(await cardRes.arrayBuffer()));
    expect(img.width).toBe(1200);
    expect(img.height).toBe(675);
  });
});

describe('build and bundle isolation', () => {
  it('excludes dev/ and tests/ from Vercel functions and avoids dev imports in src/ and api/', () => {
    const vercelConfig = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), 'vercel.json'), 'utf-8'),
    ) as {
      functions: Record<string, { excludeFiles?: string; includeFiles?: string }>;
    };

    for (const [fnName, fnCfg] of Object.entries(vercelConfig.functions)) {
      expect(fnCfg.excludeFiles, `${fnName} missing excludeFiles`).toContain('dev/**');
      expect(fnCfg.excludeFiles, `${fnName} missing tests excludeFiles`).toContain('tests/**');
    }

    const vercelIgnore = fs.readFileSync(
      path.resolve(process.cwd(), '.vercelignore'),
      'utf-8',
    );
    expect(vercelIgnore).toContain('dev/');

    const scanDir = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(full);
        } else if (entry.name.endsWith('.ts')) {
          const src = fs.readFileSync(full, 'utf-8');
          expect(src, `${full} references dev/`).not.toMatch(/from\s+['"][^'"]*dev\//);
        }
      }
    };

    scanDir(path.resolve(process.cwd(), 'src'));
    scanDir(path.resolve(process.cwd(), 'api'));
  });

  it('loads compiled api/ ESM handlers under native Node ESM with GITHUB_TOKEN unset', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subpoena-esm-'));
    try {
      const tscScript = path.resolve(
        process.cwd(),
        'node_modules/typescript/bin/tsc',
      );
      execFileSync(
        process.execPath,
        [tscScript, '--noEmit', 'false', '--outDir', tmpDir],
        { cwd: process.cwd(), stdio: 'pipe' },
      );

      fs.copyFileSync(
        path.resolve(process.cwd(), 'package.json'),
        path.join(tmpDir, 'package.json'),
      );
      fs.copyFileSync(
        path.resolve(process.cwd(), 'index.html'),
        path.join(tmpDir, 'index.html'),
      );
      fs.cpSync(
        path.resolve(process.cwd(), 'public'),
        path.join(tmpDir, 'public'),
        { recursive: true },
      );
      fs.symlinkSync(
        path.resolve(process.cwd(), 'node_modules'),
        path.join(tmpDir, 'node_modules'),
        'dir',
      );
      fs.rmSync(path.join(tmpDir, 'dev'), { recursive: true, force: true });
      fs.rmSync(path.join(tmpDir, 'tests'), { recursive: true, force: true });

      const cleanEnv = { ...process.env };
      delete cleanEnv.GITHUB_TOKEN;

      const script = `
        const page = await import('./api/page.js');
        const gh = await import('./api/gh.js');
        const detail = await import('./api/detail.js');
        const card = await import('./api/card.js');
        const health = await import('./api/health.js');
        if (typeof page.default !== 'function' || typeof gh.default !== 'function' || typeof detail.default !== 'function' || typeof card.default !== 'function' || typeof health.default !== 'function') {
          throw new Error('Missing default handler export');
        }
        const res = page.handlePageRequest(new Request('https://subpoena.vercel.app/?u=torvalds'));
        const html = await res.text();
        console.log(JSON.stringify({
          status: res.status,
          contentType: res.headers.get('content-type'),
          hasOgTitle: html.includes('Subpoena — @torvalds GitHub Rap Sheet'),
          hasOgImage: html.includes('https://subpoena.vercel.app/api/card?u=torvalds'),
          hasAssets: html.includes('/assets/index.css') && html.includes('/assets/app.js'),
          defaultPngBytes: card.getDefaultOgPngBuffer().byteLength,
          healthStatus: health.evaluateHealth({}).status,
        }));
      `;

      const out = execFileSync(
        process.execPath,
        ['--input-type=module', '-e', script],
        { cwd: tmpDir, env: cleanEnv, encoding: 'utf-8' },
      );
      const parsed = JSON.parse(out.trim()) as {
        status: number;
        contentType: string | null;
        hasOgTitle: boolean;
        hasOgImage: boolean;
        hasAssets: boolean;
        defaultPngBytes: number;
        healthStatus: number;
      };

      expect(parsed.status).toBe(200);
      expect(parsed.contentType).toContain('text/html');
      expect(parsed.hasOgTitle).toBe(true);
      expect(parsed.hasOgImage).toBe(true);
      expect(parsed.hasAssets).toBe(true);
      expect(parsed.defaultPngBytes).toBeGreaterThan(1000);
      expect(parsed.healthStatus).toBe(200);

      // Even if index.html and dist/index.html are missing on disk, api/page.js falls back without ENOENT
      fs.rmSync(path.join(tmpDir, 'index.html'), { force: true });
      const fallbackOut = execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `const page = await import('./api/page.js');
           const res = page.handlePageRequest(new Request('https://subpoena.vercel.app/?u=torvalds'));
           const html = await res.text();
           console.log(JSON.stringify({ status: res.status, hasOgImage: html.includes('https://subpoena.vercel.app/api/card?u=torvalds') }));`,
        ],
        { cwd: tmpDir, env: cleanEnv, encoding: 'utf-8' },
      );
      const fallbackParsed = JSON.parse(fallbackOut.trim()) as {
        status: number;
        hasOgImage: boolean;
      };
      expect(fallbackParsed.status).toBe(200);
      expect(fallbackParsed.hasOgImage).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
