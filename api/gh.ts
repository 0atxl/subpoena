import { execSync } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isOptedOut, makeSealedBundle } from '../src/optout.js';
import {
  PRESETS,
  type GitHubBundle,
  type GitHubCommitSearchResult,
  type GitHubEvent,
  type GitHubRepo,
  type GitHubUser,
  type MissingParts,
  type MissingReason,
  type PresetHandle,
} from './presets.js';

export type FetchLike = typeof fetch;

export interface FetchBundleOptions {
  token?: string;
  fetchImpl?: FetchLike;
  now?: Date;
  useFallbackOnError?: boolean;
}

export interface FetchBundleResponse {
  status: number;
  headers: Record<string, string>;
  body: GitHubBundle;
}

const GITHUB_API_BASE = 'https://api.github.com';
export const CACHE_CONTROL_COMPLETE =
  'public, s-maxage=3600, stale-while-revalidate=86400';
export const CACHE_CONTROL_PARTIAL = 'public, s-maxage=60';

const bundleCache = new Map<
  string,
  { expiresAt: number; result: FetchBundleResponse }
>();
let cachedDevToken: string | null | undefined;

export function clearBundleCache(): void {
  bundleCache.clear();
}

export function getCachedBundle(rawHandle: string): FetchBundleResponse | null {
  const cacheKey = cleanGitHubHandle(rawHandle).toLowerCase();
  const cached = bundleCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.result;
  }
  return null;
}

export function resolveGitHubToken(
  tokenOverride?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (tokenOverride !== undefined) return tokenOverride;
  if (env.GITHUB_TOKEN && env.GITHUB_TOKEN.trim().length > 0) {
    return env.GITHUB_TOKEN;
  }
  if (
    env.VERCEL_ENV === 'production' ||
    env.NODE_ENV === 'production' ||
    Boolean(env.VERCEL) ||
    env.NODE_ENV === 'test'
  ) {
    return undefined;
  }
  if (cachedDevToken === undefined) {
    try {
      cachedDevToken = execSync('gh auth token', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      cachedDevToken = null;
    }
  }
  return cachedDevToken ?? undefined;
}

const HANDLE_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}(?:\[bot\])?$/i;

export function isValidGitHubHandle(raw: string): boolean {
  const cleaned = raw.trim().replace(/^@+/, '');
  return HANDLE_PATTERN.test(cleaned);
}

export function cleanGitHubHandle(raw: string): string {
  return raw.trim().replace(/^@+/, '');
}

function isPresetHandle(handle: string): handle is PresetHandle {
  return Object.prototype.hasOwnProperty.call(PRESETS, handle.toLowerCase());
}

export function getPreset(handle: string): GitHubBundle | null {
  const key = handle.toLowerCase();
  if (!isPresetHandle(key)) return null;
  const src = PRESETS[key];
  return {
    ...src,
    repos: [...src.repos],
    events: [...src.events],
    commits: src.commits
      ? { total_count: src.commits.total_count, items: [...src.commits.items] }
      : null,
    missing: { ...src.missing },
  };
}

interface SafeResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
}

async function safeFetchGitHub<T>(
  url: string,
  headers: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<SafeResult<T>> {
  try {
    const res = await fetchImpl(url, { headers });
    if (!res.ok) {
      return { ok: false, status: res.status, data: null };
    }
    const data = (await res.json()) as T;
    return { ok: true, status: res.status, data };
  } catch {
    return { ok: false, status: 502, data: null };
  }
}

function toMissingReason(status: number): MissingReason {
  return status >= 400 ? status : 'error';
}

function slimUser(raw: Record<string, unknown>): GitHubUser {
  return {
    login: String(raw.login ?? ''),
    id: Number(raw.id ?? 0),
    avatar_url: String(raw.avatar_url ?? ''),
    name: raw.name == null ? null : String(raw.name),
    type: String(raw.type ?? 'User'),
    public_repos: Number(raw.public_repos ?? 0),
    followers: Number(raw.followers ?? 0),
    created_at: String(raw.created_at ?? ''),
  };
}

function slimRepo(raw: Record<string, unknown>): GitHubRepo {
  const lic = raw.license as Record<string, unknown> | null | undefined;
  return {
    name: String(raw.name ?? ''),
    full_name: String(raw.full_name ?? ''),
    fork: Boolean(raw.fork),
    ...(raw.archived !== undefined ? { archived: Boolean(raw.archived) } : {}),
    stargazers_count: Number(raw.stargazers_count ?? 0),
    ...(raw.language !== undefined
      ? { language: raw.language == null ? null : String(raw.language) }
      : {}),
    license: lic
      ? {
          spdx_id: lic.spdx_id == null ? null : String(lic.spdx_id),
          name: lic.name == null ? null : String(lic.name),
        }
      : null,
    created_at: String(raw.created_at ?? ''),
    pushed_at: String(raw.pushed_at ?? ''),
  };
}

function slimEvent(raw: Record<string, unknown>): GitHubEvent {
  const repo = raw.repo as Record<string, unknown> | undefined;
  const payload = raw.payload as Record<string, unknown> | undefined;
  return {
    id: String(raw.id ?? ''),
    type: String(raw.type ?? ''),
    created_at: String(raw.created_at ?? ''),
    repo: repo ? { name: String(repo.name ?? '') } : undefined,
    payload: payload
      ? {
          ref: payload.ref == null ? null : String(payload.ref),
          ref_type: payload.ref_type == null ? null : String(payload.ref_type),
        }
      : undefined,
  };
}

function slimCommitItem(raw: Record<string, unknown>) {
  const commit = (raw.commit ?? {}) as Record<string, unknown>;
  const author = (commit.author ?? {}) as Record<string, unknown>;
  const repository = raw.repository as Record<string, unknown> | undefined;
  const fullMessage = String(commit.message ?? '');
  const firstLine = fullMessage.split(/\r?\n/, 1)[0] ?? '';
  return {
    sha: String(raw.sha ?? ''),
    commit: {
      message: firstLine,
      author: {
        date: String(author.date ?? ''),
      },
    },
    repository: repository
      ? { full_name: String(repository.full_name ?? '') }
      : undefined,
  };
}

export function buildCommitSearchQuery(
  handle: string,
  now: Date = new Date(),
): string {
  const tomorrowDate = new Date(now.getTime() + 86_400_000)
    .toISOString()
    .slice(0, 10);
  return `author:${handle} author-date:<=${tomorrowDate}`;
}

export async function fetchGitHubBundle(
  rawHandle: string,
  options: FetchBundleOptions = {},
): Promise<FetchBundleResponse> {
  const handle = cleanGitHubHandle(rawHandle);
  const now = options.now ?? new Date();
  const fetchedAt = now.toISOString();

  if (isOptedOut(handle)) {
    return {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': CACHE_CONTROL_COMPLETE,
      },
      body: makeSealedBundle(handle, now),
    };
  }

  const useMemoryCache =
    options.fetchImpl === undefined &&
    options.now === undefined &&
    options.token === undefined;
  const cacheKey = handle.toLowerCase();
  if (useMemoryCache) {
    const cached = bundleCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.result;
    }
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const token = resolveGitHubToken(options.token);
  const useFallback = options.useFallbackOnError ?? true;

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'subpoena-rap-sheet',
  };
  if (token && token.trim().length > 0) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }

  const encodedHandle = encodeURIComponent(handle);
  const searchQuery = encodeURIComponent(buildCommitSearchQuery(handle, now));

  const [userRes, reposRes, eventsRes] = await Promise.all([
    safeFetchGitHub<Record<string, unknown>>(
      `${GITHUB_API_BASE}/users/${encodedHandle}`,
      headers,
      fetchImpl,
    ),
    safeFetchGitHub<Record<string, unknown>[]>(
      `${GITHUB_API_BASE}/users/${encodedHandle}/repos?sort=pushed&per_page=30&type=owner`,
      headers,
      fetchImpl,
    ),
    safeFetchGitHub<Record<string, unknown>[]>(
      `${GITHUB_API_BASE}/users/${encodedHandle}/events/public?per_page=100`,
      headers,
      fetchImpl,
    ),
  ]);

  const isOrganization =
    userRes.ok && String(userRes.data?.type ?? '') === 'Organization';

  const commitsRes = isOrganization
    ? null
    : await safeFetchGitHub<Record<string, unknown>>(
        `${GITHUB_API_BASE}/search/commits?q=${searchQuery}&sort=author-date&order=desc&per_page=100`,
        headers,
        fetchImpl,
      );

  const missing: MissingParts = {};

  if (!userRes.ok) {
    missing.user = toMissingReason(userRes.status);
  }
  if (!reposRes.ok) {
    missing.repos = toMissingReason(reposRes.status);
  }
  if (!eventsRes.ok) {
    missing.events = toMissingReason(eventsRes.status);
  }

  let commits: GitHubCommitSearchResult | null = null;
  if (!isOrganization && commitsRes) {
    if (!commitsRes.ok) {
      missing.commits = toMissingReason(commitsRes.status);
    } else if (commitsRes.data) {
      const rawItems = Array.isArray(commitsRes.data.items)
        ? (commitsRes.data.items as Record<string, unknown>[])
        : [];
      commits = {
        total_count: Number(commitsRes.data.total_count ?? rawItems.length),
        incomplete_results: Boolean(commitsRes.data.incomplete_results),
        items: rawItems.map(slimCommitItem),
      };
      if (commits.items.length === 0) {
        missing.commits = 'empty';
      }
    }
  }

  // If the core /users/{u} call hit rate-limit/403/5xx, fall back to a bundled preset when available.
  if (!userRes.ok && userRes.status !== 404 && useFallback) {
    const preset = getPreset(handle);
    if (preset) {
      return {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': CACHE_CONTROL_PARTIAL,
        },
        body: {
          ...preset,
          fetchedAt,
          preset: true,
          missing: {
            ...preset.missing,
            user: toMissingReason(userRes.status),
          },
        },
      };
    }
  }

  const user = userRes.ok && userRes.data ? slimUser(userRes.data) : null;
  const repos =
    reposRes.ok && Array.isArray(reposRes.data)
      ? reposRes.data.map(slimRepo)
      : [];
  const events =
    eventsRes.ok && Array.isArray(eventsRes.data)
      ? eventsRes.data.map(slimEvent)
      : [];

  const isPartial = Object.keys(missing).length > 0;
  let responseStatus = 200;
  let cacheControl = isPartial ? CACHE_CONTROL_PARTIAL : CACHE_CONTROL_COMPLETE;
  if (!userRes.ok) {
    responseStatus = userRes.status === 404 ? 404 : userRes.status === 403 ? 403 : 502;
    cacheControl = CACHE_CONTROL_PARTIAL;
  }

  const response: FetchBundleResponse = {
    status: responseStatus,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cacheControl,
    },
    body: {
      handle: user?.login ?? handle,
      fetchedAt,
      preset: false,
      user,
      repos,
      events,
      commits,
      missing,
    },
  };

  if (userRes.ok) {
    const ttlMs = isPartial ? 15_000 : 60_000;
    bundleCache.set(cacheKey, {
      expiresAt: Date.now() + ttlMs,
      result: response,
    });
  }

  return response;
}

export function isProductionMissingToken(
  tokenOverride?: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const isProd =
    env.VERCEL_ENV === 'production' || env.NODE_ENV === 'production';
  const token = tokenOverride ?? env.GITHUB_TOKEN;
  return isProd && (!token || token.trim().length === 0);
}

export async function handleRequest(
  request: Request,
  options: FetchBundleOptions = {},
): Promise<Response> {
  if (isProductionMissingToken(options.token)) {
    return new Response(
      JSON.stringify({
        error: 'Server misconfigured: GITHUB_TOKEN is required in production.',
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      },
    );
  }

  const url = new URL(request.url);
  const rawHandle = url.searchParams.get('u') ?? '';
  const wantFallback = url.searchParams.get('fallback') === '1';

  if (!isValidGitHubHandle(rawHandle)) {
    return new Response(
      JSON.stringify({
        error: 'Invalid or missing GitHub handle (?u=username).',
      }),
      {
        status: 400,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      },
    );
  }

  const handle = cleanGitHubHandle(rawHandle);
  if (isOptedOut(handle)) {
    return new Response(JSON.stringify(makeSealedBundle(handle, options.now)), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': CACHE_CONTROL_COMPLETE,
      },
    });
  }

  if (wantFallback) {
    const preset = getPreset(handle);
    if (preset) {
      const hasMissing = Object.keys(preset.missing).length > 0;
      return new Response(JSON.stringify(preset), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': hasMissing
            ? CACHE_CONTROL_PARTIAL
            : CACHE_CONTROL_COMPLETE,
        },
      });
    }
  }

  const result = await fetchGitHubBundle(handle, options);
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: result.headers,
  });
}

type NodeRequest = IncomingMessage & {
  query?: Record<string, string | string[] | undefined>;
};

type NodeResponse = ServerResponse & {
  status?: (code: number) => NodeResponse;
  json?: (payload: unknown) => void;
};

export default async function handler(
  req: NodeRequest | Request,
  res?: NodeResponse,
): Promise<Response | void> {
  if (typeof Request !== 'undefined' && req instanceof Request) {
    return handleRequest(req);
  }

  const nodeReq = req as NodeRequest;
  const host = nodeReq.headers.host ?? 'localhost';
  const rawUrl = nodeReq.url ?? '/';
  const fullUrl = new URL(rawUrl, `https://${host}`);
  if (!fullUrl.searchParams.has('u') && nodeReq.query?.u) {
    const qVal = Array.isArray(nodeReq.query.u)
      ? nodeReq.query.u[0]
      : nodeReq.query.u;
    if (qVal) fullUrl.searchParams.set('u', qVal);
  }

  const webResp = await handleRequest(new Request(fullUrl.toString()));
  if (!res) {
    return webResp;
  }

  res.statusCode = webResp.status;
  webResp.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  const text = await webResp.text();
  res.end(text);
}
