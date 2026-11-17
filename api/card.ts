import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { GlobalFonts, createCanvas, loadImage } from '@napi-rs/canvas';
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  createNodeFontLoader,
  draw,
  type AvatarImage,
  type CanvasContext2DLike,
} from '../src/canvas/index.js';
import { evaluateCharges } from '../src/engine/charges.js';
import { isOptedOut, makeSealedBundle } from '../src/optout.js';
import {
  CACHE_CONTROL_COMPLETE,
  CACHE_CONTROL_PARTIAL,
  cleanGitHubHandle,
  fetchGitHubBundle,
  isProductionMissingToken,
  isValidGitHubHandle,
  type FetchBundleOptions,
} from './gh.js';

const MODULE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

function resolveAssetPath(relPath: string): string {
  const fromCwd = path.resolve(process.cwd(), relPath);
  if (fs.existsSync(fromCwd)) return fromCwd;
  const fromModule = path.resolve(MODULE_ROOT, relPath);
  if (fs.existsSync(fromModule)) return fromModule;
  return fromCwd;
}

export const CACHE_CONTROL_FALLBACK = 'public, s-maxage=30';
export const DEFAULT_RENDER_TIMEOUT_MS = 4000;
export const DEFAULT_CARD_RATE_LIMIT_MAX = 20;
export const DEFAULT_CARD_RATE_LIMIT_WINDOW_MS = 60_000;

export interface CardRequestOptions extends FetchBundleOptions {
  timeoutMs?: number;
  rateLimitMax?: number;
  rateLimitWindowMs?: number;
  disableRateLimit?: boolean;
}

const ipHits = new Map<string, { count: number; resetAt: number }>();
let cachedDefaultOgPng: Buffer | null = null;

export function resetCardRateLimiter(): void {
  ipHits.clear();
}

export function getDefaultOgPngBuffer(): Buffer {
  if (!cachedDefaultOgPng) {
    const defaultPath = resolveAssetPath('public/og-default.png');
    cachedDefaultOgPng = fs.readFileSync(defaultPath);
  }
  return cachedDefaultOgPng;
}

function getClientIp(headers: Headers): string {
  const xff = headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const realIp = headers.get('x-real-ip')?.trim();
  return realIp || '127.0.0.1';
}

/**
 * Best-effort per-instance in-memory fixed-window IP limiter.
 * Note: serverless cold starts or multiple warm instances each hold independent counters.
 */
function consumeCardRateLimit(
  ip: string,
  max: number,
  windowMs: number,
): boolean {
  const now = Date.now();
  const entry = ipHits.get(ip);
  if (!entry || now >= entry.resetAt) {
    ipHits.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= max) {
    return false;
  }
  entry.count += 1;
  return true;
}

function makeFallbackCardResponse(reason: string): Response {
  console.error(`[api/card] Returning og-default.png fallback: ${reason}`);
  try {
    const buf = getDefaultOgPngBuffer();
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': CACHE_CONTROL_FALLBACK,
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: err instanceof Error ? err.message : 'Card fallback unavailable',
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
}

const serverFontLoader = createNodeFontLoader(GlobalFonts, [
  {
    path: resolveAssetPath('public/fonts/CourierPrime-Regular.ttf'),
    family: 'Courier Prime',
  },
  {
    path: resolveAssetPath('public/fonts/CourierPrime-Bold.ttf'),
    family: 'Courier Prime',
  },
  {
    path: resolveAssetPath('public/fonts/ReenieBeanie-Regular.ttf'),
    family: 'Reenie Beanie',
  },
]);

async function loadAvatarFromUrl(
  url: string | undefined,
  fetchImpl: typeof fetch,
  timeoutMs = 2500,
): Promise<AvatarImage | null> {
  if (!url) return null;
  try {
    const res = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': 'subpoena-rap-sheet' },
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const img = await loadImage(buf);
    return img as unknown as AvatarImage;
  } catch {
    return null;
  }
}

export async function renderCardPng(
  rawHandle: string,
  options: CardRequestOptions = {},
): Promise<{ status: number; png: Buffer; cacheControl: string }> {
  const handle = cleanGitHubHandle(rawHandle);
  const fetchImpl = options.fetchImpl ?? fetch;

  if (isOptedOut(handle)) {
    const sealedBundle = makeSealedBundle(handle, options.now);
    const sealedVerdict = evaluateCharges(sealedBundle, options.now);
    const canvas = createCanvas(CARD_WIDTH, CARD_HEIGHT);
    const ctx = canvas.getContext('2d') as unknown as CanvasContext2DLike;
    await draw(ctx, sealedVerdict, null, { fontLoader: serverFontLoader });
    return {
      status: 200,
      png: canvas.toBuffer('image/png'),
      cacheControl: CACHE_CONTROL_COMPLETE,
    };
  }

  const bundleRes = await fetchGitHubBundle(handle, options);
  if (
    !bundleRes.body.user &&
    !bundleRes.body.preset &&
    !bundleRes.body.sealed
  ) {
    throw new Error(`Upstream GitHub lookup failed (status ${bundleRes.status})`);
  }

  const verdict = evaluateCharges(bundleRes.body, options.now);
  const avatarBudget = Math.min(2500, Math.max(250, (options.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS) - 400));
  const avatar = await loadAvatarFromUrl(
    bundleRes.body.user?.avatar_url,
    fetchImpl,
    avatarBudget,
  );

  const canvas = createCanvas(CARD_WIDTH, CARD_HEIGHT);
  const ctx = canvas.getContext('2d') as unknown as CanvasContext2DLike;
  await draw(ctx, verdict, avatar, { fontLoader: serverFontLoader });

  const isPartial =
    verdict.partialRecord || Object.keys(bundleRes.body.missing).length > 0;

  return {
    status: 200,
    png: canvas.toBuffer('image/png'),
    cacheControl: isPartial ? CACHE_CONTROL_PARTIAL : CACHE_CONTROL_COMPLETE,
  };
}

export async function handleCardRequest(
  request: Request,
  options: CardRequestOptions = {},
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

  if (!rawHandle.trim()) {
    try {
      const buf = getDefaultOgPngBuffer();
      return new Response(new Uint8Array(buf), {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': CACHE_CONTROL_COMPLETE,
        },
      });
    } catch {
      const { png } = await renderCardPng('torvalds', options);
      return new Response(new Uint8Array(png), {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': CACHE_CONTROL_COMPLETE,
        },
      });
    }
  }

  if (!isValidGitHubHandle(rawHandle)) {
    return new Response(
      JSON.stringify({ error: 'Invalid GitHub handle (?u=username).' }),
      {
        status: 400,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      },
    );
  }

  if (!options.disableRateLimit) {
    const ip = getClientIp(request.headers);
    const max = options.rateLimitMax ?? DEFAULT_CARD_RATE_LIMIT_MAX;
    const windowMs =
      options.rateLimitWindowMs ?? DEFAULT_CARD_RATE_LIMIT_WINDOW_MS;
    if (!consumeCardRateLimit(ip, max, windowMs)) {
      return makeFallbackCardResponse(`rate limit exceeded (${max}/${windowMs}ms) for IP ${ip}`);
    }
  }

  const budgetMs = options.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const rendered = await Promise.race([
      renderCardPng(rawHandle, options),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`render timeout exceeded ${budgetMs}ms budget`));
        }, budgetMs);
      }),
    ]);

    return new Response(new Uint8Array(rendered.png), {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': rendered.cacheControl,
      },
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return makeFallbackCardResponse(reason);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

type NodeRequest = IncomingMessage & {
  query?: Record<string, string | string[] | undefined>;
};

export default async function handler(
  req: NodeRequest | Request,
  res?: ServerResponse,
): Promise<Response | void> {
  if (typeof Request !== 'undefined' && req instanceof Request) {
    return handleCardRequest(req);
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

  const headers = new Headers();
  for (const [k, v] of Object.entries(nodeReq.headers)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v) && v.length > 0) headers.set(k, v.join(', '));
  }

  const webResp = await handleCardRequest(
    new Request(fullUrl.toString(), { headers }),
  );
  if (!res) return webResp;

  res.statusCode = webResp.status;
  webResp.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  const buf = Buffer.from(await webResp.arrayBuffer());
  res.end(buf);
}
