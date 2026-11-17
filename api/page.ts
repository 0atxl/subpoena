import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isOptedOut } from '../src/optout.js';
import { cleanGitHubHandle, isValidGitHubHandle } from './gh.js';

export interface OriginHeaderHints {
  host?: string | null;
  forwardedHost?: string | null;
  forwardedProto?: string | null;
}

const SAFE_HOST_RE = /^[A-Za-z0-9._:-]+$/;

export function escapeHtmlAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function resolveRequestOrigin(
  requestUrl: string,
  headers: OriginHeaderHints = {},
): string {
  let parsedUrlHost = '';
  let parsedUrlProto = '';
  try {
    const parsed = new URL(requestUrl, 'http://localhost');
    parsedUrlHost = parsed.host;
    parsedUrlProto = parsed.protocol.replace(':', '');
  } catch {
    parsedUrlHost = 'localhost';
  }

  const rawFwdHost = headers.forwardedHost?.split(',')[0]?.trim() ?? '';
  const rawHost = headers.host?.split(',')[0]?.trim() ?? '';
  const chosenHost =
    (rawFwdHost && SAFE_HOST_RE.test(rawFwdHost) ? rawFwdHost : '') ||
    (rawHost && SAFE_HOST_RE.test(rawHost) ? rawHost : '') ||
    (parsedUrlHost && SAFE_HOST_RE.test(parsedUrlHost)
      ? parsedUrlHost
      : 'localhost');

  const rawProto = headers.forwardedProto?.split(',')[0]?.trim().toLowerCase();
  let proto: 'http' | 'https';
  if (rawProto === 'http' || rawProto === 'https') {
    proto = rawProto;
  } else if (parsedUrlProto === 'http' && !headers.host && !headers.forwardedHost) {
    proto = 'http';
  } else if (
    chosenHost.startsWith('localhost') ||
    chosenHost.startsWith('127.0.0.1') ||
    chosenHost.startsWith('[::1]')
  ) {
    proto = 'http';
  } else {
    proto = 'https';
  }

  return `${proto}://${chosenHost}`;
}

export function injectOgTagsIntoHtml(
  templateHtml: string,
  requestUrl: string,
  headers: OriginHeaderHints = {},
): string {
  const origin = resolveRequestOrigin(requestUrl, headers);
  const reqUrl = new URL(requestUrl, origin);
  const rawU = reqUrl.searchParams.get('u') ?? '';
  const clean = cleanGitHubHandle(rawU);
  const valid = Boolean(clean && isValidGitHubHandle(clean) && !isOptedOut(clean));

  const safeHandle = valid ? escapeHtmlAttr(clean) : '';
  const ogTitle = valid
    ? `Subpoena — @${safeHandle} GitHub Rap Sheet`
    : 'Subpoena — GitHub Rap Sheet';
  const ogDesc = valid
    ? `Form 14-B rap sheet for GitHub user @${safeHandle}.`
    : 'Courtroom noir GitHub intake form and rap sheet.';
  const ogImage = escapeHtmlAttr(
    valid
      ? `${origin}/api/card?u=${encodeURIComponent(clean)}`
      : `${origin}/og-default.png`,
  );

  let html = templateHtml;
  html = html.replace(
    /<meta\s+property="og:title"\s+content="[^"]*"\s*\/?>/i,
    `<meta property="og:title" content="${ogTitle}" />`,
  );
  html = html.replace(
    /<meta\s+property="og:description"\s+content="[^"]*"\s*\/?>/i,
    `<meta property="og:description" content="${ogDesc}" />`,
  );
  html = html.replace(
    /<meta\s+property="og:image"\s+content="[^"]*"\s*\/?>/i,
    `<meta property="og:image" content="${ogImage}" />`,
  );
  html = html.replace(
    /<meta\s+name="twitter:image"\s+content="[^"]*"\s*\/?>/i,
    `<meta name="twitter:image" content="${ogImage}" />`,
  );
  return html;
}

const MODULE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const FALLBACK_PROD_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Subpoena — GitHub Rap Sheet</title>
    <meta property="og:title" content="Subpoena — GitHub Rap Sheet" />
    <meta property="og:description" content="Courtroom noir GitHub intake form and rap sheet." />
    <meta property="og:image" content="/og-default.png" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="675" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:image" content="/og-default.png" />
    <link rel="stylesheet" href="/assets/index.css" />
  </head>
  <body>
    <main id="app" class="desk"></main>
    <script type="module" src="/assets/app.js"></script>
  </body>
</html>
`;

let cachedProdTemplate: string | null = null;

function loadProductionHtmlTemplate(cwd?: string): string {
  const useDefaultRoots = cwd === undefined;
  if (useDefaultRoots && cachedProdTemplate) return cachedProdTemplate;

  const roots = useDefaultRoots ? [process.cwd(), MODULE_ROOT] : [cwd];
  let resolvedHtml: string | null = null;

  for (const root of roots) {
    const distHtmlPath = path.resolve(root, 'dist/index.html');
    if (fs.existsSync(distHtmlPath)) {
      resolvedHtml = fs.readFileSync(distHtmlPath, 'utf-8');
      break;
    }
  }

  if (!resolvedHtml) {
    for (const root of roots) {
      const srcHtmlPath = path.resolve(root, 'index.html');
      if (fs.existsSync(srcHtmlPath)) {
        resolvedHtml = fs
          .readFileSync(srcHtmlPath, 'utf-8')
          .replace('/src/ui/styles.css', '/assets/index.css')
          .replace('/src/ui/app.ts', '/assets/app.js');
        break;
      }
    }
  }

  const finalHtml = resolvedHtml ?? FALLBACK_PROD_HTML;
  if (useDefaultRoots) {
    cachedProdTemplate = finalHtml;
  }
  return finalHtml;
}

export function handlePageRequest(
  request: Request,
  templateOverride?: string,
): Response {
  const htmlTemplate = templateOverride ?? loadProductionHtmlTemplate();
  const rendered = injectOgTagsIntoHtml(htmlTemplate, request.url, {
    host: request.headers.get('host'),
    forwardedHost: request.headers.get('x-forwarded-host'),
    forwardedProto: request.headers.get('x-forwarded-proto'),
  });

  return new Response(rendered, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=3600',
    },
  });
}

type NodeRequest = IncomingMessage & {
  query?: Record<string, string | string[] | undefined>;
};

export default async function handler(
  req: NodeRequest | Request,
  res?: ServerResponse,
): Promise<Response | void> {
  if (typeof Request !== 'undefined' && req instanceof Request) {
    return handlePageRequest(req);
  }

  const nodeReq = req as NodeRequest;
  const fwdHost = Array.isArray(nodeReq.headers['x-forwarded-host'])
    ? nodeReq.headers['x-forwarded-host'][0]
    : nodeReq.headers['x-forwarded-host'];
  const fwdProto = Array.isArray(nodeReq.headers['x-forwarded-proto'])
    ? nodeReq.headers['x-forwarded-proto'][0]
    : nodeReq.headers['x-forwarded-proto'];
  const host = fwdHost ?? nodeReq.headers.host ?? 'localhost';
  const proto = fwdProto === 'http' ? 'http' : 'https';
  const rawUrl = nodeReq.url ?? '/';
  const fullUrl = new URL(rawUrl, `${proto}://${host}`);
  if (!fullUrl.searchParams.has('u') && nodeReq.query?.u) {
    const qVal = Array.isArray(nodeReq.query.u)
      ? nodeReq.query.u[0]
      : nodeReq.query.u;
    if (qVal) fullUrl.searchParams.set('u', qVal);
  }

  const headers = new Headers();
  for (const [k, v] of Object.entries(nodeReq.headers)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v) && v.length > 0) headers.set(k, v[0] ?? '');
  }

  const webResp = handlePageRequest(new Request(fullUrl.toString(), { headers }));
  if (!res) return webResp;

  res.statusCode = webResp.status;
  webResp.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  res.end(await webResp.text());
}
