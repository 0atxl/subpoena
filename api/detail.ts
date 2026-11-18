import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  evaluateCharges,
  isVagueCommitMessage,
  type VerdictReport,
} from '../src/engine/charges.js';
import {
  buildDetailReport,
  detailInputFromBundle,
  flattenContributionWeeks,
  type CalendarDay,
  type DetailReport,
} from '../src/engine/details.js';
import { isOptedOut } from '../src/optout.js';
import {
  CACHE_CONTROL_COMPLETE,
  CACHE_CONTROL_PARTIAL,
  cleanGitHubHandle,
  fetchGitHubBundle,
  getCachedBundle,
  getPreset,
  isProductionMissingToken,
  isValidGitHubHandle,
  resolveGitHubToken,
  type FetchBundleOptions,
  type FetchLike,
} from './gh.js';
import type { GitHubBundle, MissingParts } from './presets.js';

const GITHUB_GRAPHQL_URL = 'https://api.github.com/graphql';

const CONTRIBUTION_CALENDAR_QUERY = `
  query($login: String!) {
    user(login: $login) {
      contributionsCollection {
        contributionCalendar {
          weeks {
            contributionDays {
              date
              contributionCount
            }
          }
        }
      }
    }
  }
`;

export interface DetailRequestOptions extends FetchBundleOptions {
  bundle?: GitHubBundle;
  calendarDays?: CalendarDay[] | null;
  fallback?: boolean;
}

export interface DetailResponseBody extends DetailReport {
  calendarUnit: 'contributions';
  verdict: VerdictReport;
  menaceScore: number;
  bail: string;
  bailAmount: number;
  missing: MissingParts;
}

export interface DetailErrorBody {
  error: string;
  verdict?: 'RECORD SEALED';
  sealed?: boolean;
  handle: string;
  missing?: MissingParts;
}

export interface FetchDetailResponse {
  status: number;
  headers: Record<string, string>;
  body: DetailResponseBody | DetailErrorBody;
}

interface GraphQLWeek {
  contributionDays: { date: string; contributionCount: number }[];
}

interface GraphQLResponseShape {
  data?: {
    user?: {
      contributionsCollection?: {
        contributionCalendar?: {
          weeks?: GraphQLWeek[];
        };
      } | null;
    } | null;
  };
  user?: {
    contributionsCollection?: {
      contributionCalendar?: {
        weeks?: GraphQLWeek[];
      };
    } | null;
  } | null;
  errors?: unknown[];
}

function makeSealedResponse(handle: string): FetchDetailResponse {
  return {
    status: 404,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': CACHE_CONTROL_COMPLETE,
    },
    body: {
      error: 'RECORD SEALED',
      verdict: 'RECORD SEALED',
      sealed: true,
      handle,
    },
  };
}

export async function fetchContributionCalendar(
  handle: string,
  options: { token?: string; fetchImpl?: FetchLike } = {},
): Promise<CalendarDay[] | null> {
  const token = resolveGitHubToken(options.token);
  if (!token && !options.fetchImpl) {
    return null;
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'subpoena-rap-sheet',
  };
  if (token && token.trim().length > 0) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }

  try {
    const res = await fetchImpl(GITHUB_GRAPHQL_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query: CONTRIBUTION_CALENDAR_QUERY,
        variables: { login: handle },
      }),
    });
    if (!res.ok) {
      return null;
    }

    const parsed = (await res.json()) as GraphQLResponseShape;
    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      return null;
    }

    const weeks =
      parsed.data?.user?.contributionsCollection?.contributionCalendar?.weeks ??
      parsed.user?.contributionsCollection?.contributionCalendar?.weeks;
    if (!Array.isArray(weeks)) {
      return null;
    }

    return flattenContributionWeeks(weeks);
  } catch {
    return null;
  }
}

export async function fetchDetail(
  rawHandle: string,
  options: DetailRequestOptions = {},
): Promise<FetchDetailResponse> {
  const handle = cleanGitHubHandle(rawHandle);
  const now = options.now ?? new Date();

  if (isOptedOut(handle)) {
    return makeSealedResponse(handle);
  }

  let bundle: GitHubBundle | null = null;
  let bundleStatus = 200;

  if (options.fallback) {
    bundle = getPreset(handle);
  }

  if (!bundle && options.bundle) {
    bundle = options.bundle;
  }

  if (!bundle) {
    const cached = getCachedBundle(handle);
    if (cached) {
      bundle = cached.body;
      bundleStatus = cached.status;
    } else {
      const fetched = await fetchGitHubBundle(handle, options);
      bundle = fetched.body;
      bundleStatus = fetched.status;
    }
  }

  if (
    bundle.sealed ||
    isOptedOut(bundle.handle) ||
    (bundle.user && isOptedOut(bundle.user.login))
  ) {
    return makeSealedResponse(bundle.handle || handle);
  }

  if (!bundle.user) {
    const status = bundleStatus !== 200 ? bundleStatus : 502;
    return {
      status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': CACHE_CONTROL_PARTIAL,
      },
      body: {
        error: status === 404 ? 'User not found.' : 'Upstream GitHub error.',
        handle: bundle.handle,
        missing: { ...bundle.missing },
      },
    };
  }

  let calendarDays: CalendarDay[] | null;
  if (options.calendarDays !== undefined) {
    calendarDays = options.calendarDays;
  } else if (bundle.user.type === 'Organization') {
    calendarDays = null;
  } else {
    calendarDays = await fetchContributionCalendar(bundle.user.login, {
      token: options.token,
      fetchImpl: options.fetchImpl,
    });
  }

  const detailInput = detailInputFromBundle(bundle, calendarDays, now);
  if (!detailInput) {
    return makeSealedResponse(bundle.handle || handle);
  }

  const report = buildDetailReport(detailInput, {
    isVague: isVagueCommitMessage,
  });
  const verdict = evaluateCharges(bundle, now);

  const isPartial =
    Object.keys(bundle.missing).length > 0 || calendarDays === null;
  const cacheControl = isPartial
    ? CACHE_CONTROL_PARTIAL
    : CACHE_CONTROL_COMPLETE;

  return {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cacheControl,
    },
    body: {
      ...report,
      calendarUnit: 'contributions',
      verdict,
      menaceScore: verdict.menaceScore,
      bail: verdict.bail,
      bailAmount: verdict.bailAmount,
      missing: { ...bundle.missing },
    },
  };
}

export async function handleDetailRequest(
  request: Request,
  options: DetailRequestOptions = {},
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

  const result = await fetchDetail(rawHandle, {
    ...options,
    fallback: options.fallback ?? wantFallback,
  });
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: result.headers,
  });
}

export const handleRequest = handleDetailRequest;

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
    return handleDetailRequest(req);
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
  if (!fullUrl.searchParams.has('fallback') && nodeReq.query?.fallback) {
    const fVal = Array.isArray(nodeReq.query.fallback)
      ? nodeReq.query.fallback[0]
      : nodeReq.query.fallback;
    if (fVal) fullUrl.searchParams.set('fallback', fVal);
  }

  const webResp = await handleDetailRequest(new Request(fullUrl.toString()));
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
