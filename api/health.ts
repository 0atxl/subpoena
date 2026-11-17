import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';

const MODULE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const REQUIRED_FONTS = [
  'CourierPrime-Regular.ttf',
  'CourierPrime-Bold.ttf',
  'ReenieBeanie-Regular.ttf',
];

export interface HealthCheckResult {
  status: number;
  body: {
    ok: boolean;
    environment: string;
    hasGitHubToken: boolean;
    fontsPresent: boolean;
    error?: string;
  };
}

export function evaluateHealth(
  env: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): HealthCheckResult {
  const isProd =
    env.VERCEL_ENV === 'production' || env.NODE_ENV === 'production';
  const hasGitHubToken = Boolean(env.GITHUB_TOKEN && env.GITHUB_TOKEN.trim().length > 0);
  const environment = env.VERCEL_ENV ?? env.NODE_ENV ?? 'development';

  const roots = cwd !== undefined ? [cwd] : [process.cwd(), MODULE_ROOT];
  const fontsPresent = roots.some((root) => {
    const fontsDir = path.resolve(root, 'public/fonts');
    return REQUIRED_FONTS.every((f) => fs.existsSync(path.join(fontsDir, f)));
  });

  if (isProd && !hasGitHubToken) {
    return {
      status: 500,
      body: {
        ok: false,
        environment,
        hasGitHubToken: false,
        fontsPresent,
        error: 'GITHUB_TOKEN is required in production.',
      },
    };
  }

  if (!fontsPresent) {
    return {
      status: 500,
      body: {
        ok: false,
        environment,
        hasGitHubToken,
        fontsPresent: false,
        error: 'Required bundled font files are missing from public/fonts/.',
      },
    };
  }

  return {
    status: 200,
    body: {
      ok: true,
      environment,
      hasGitHubToken,
      fontsPresent,
    },
  };
}

export async function handleHealthRequest(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Response> {
  const res = evaluateHealth(env);
  return new Response(JSON.stringify(res.body), {
    status: res.status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export default async function handler(
  req: IncomingMessage | Request,
  res?: ServerResponse,
): Promise<Response | void> {
  if (typeof Request !== 'undefined' && req instanceof Request) {
    return handleHealthRequest();
  }
  const webResp = await handleHealthRequest();
  if (!res) return webResp;
  res.statusCode = webResp.status;
  webResp.headers.forEach((v, k) => res.setHeader(k, v));
  res.end(await webResp.text());
}
