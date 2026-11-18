/**
 * src/engine/details.ts
 *
 * Pure, deterministic builders for the "Exhibits" detail view.
 * No network, no env, no DOM. Feed it the data you already fetch.
 *
 * Design rules:
 *  - Evidence, not verdicts. Nothing here ranks or scores a person.
 *  - Every exhibit carries its sample size so the UI can print it.
 *  - Radar axes are raw SHARES (0..1) of the statutes, not skill scores.
 *
 * The input interfaces are minimal structural types. Your own GitHubBundle
 * types should be assignable to them; adjust field names if they differ.
 */

import { isOptedOut } from '../optout.js';
import { isVagueCommitMessage, parseAuthorLocalTime } from './charges.js';

const DAY_MS = 86_400_000;
const MIN_RELIABLE = 5;

// ---------- input shapes ----------

export interface DetailUser {
  login: string;
  type: string; // 'User' | 'Organization' | 'Bot'
  created_at: string;
  followers: number;
  public_repos: number;
}

export interface DetailRepo {
  name: string;
  fork: boolean;
  archived?: boolean; // optional: proxy may not return it yet
  stargazers_count: number;
  language?: string | null; // optional: proxy may not return it yet
  license: unknown | null;
  created_at: string;
  pushed_at: string | null;
}

export interface DetailCommit {
  commit: { message: string; author: { date: string } | null };
}

export interface DetailEvent {
  type: string;
  created_at: string;
}

/** One day from the GraphQL contributionCalendar (fetched in api/detail.ts). */
export interface CalendarDay {
  date: string; // YYYY-MM-DD
  count: number;
}

export interface DetailInput {
  user: DetailUser;
  repos: DetailRepo[];
  commits: DetailCommit[] | null;
  events: DetailEvent[] | null;
  searchIncomplete?: boolean;
  calendarDays?: CalendarDay[] | null;
  now?: Date | undefined; // inject for tests
}

export interface DetailOptions {
  /** Reuse the engine's own rule so charges and exhibits never disagree. */
  isVague: (message: string) => boolean;
  isAbandonedFork?: (repo: DetailRepo) => boolean;
}

// ---------- output shapes ----------

export interface CalendarCell {
  date: string;
  count: number;
  level: 0 | 1 | 2 | 3 | 4;
}

export interface CalendarExhibit {
  weeks: (CalendarCell | null)[][]; // columns of 7, Sunday first
  total: number;
  activeDays: number;
  longestStreak: number;
  longestGap: number;
  busiest: { date: string; count: number } | null;
}

export interface PunchCardExhibit {
  grid: number[][]; // [weekday 0=Sun][hour 0..23]
  sample: number;
  peakHour: number | null;
  nightShare: number; // 01:00-04:59
  weekendShare: number;
  fridayEveningShare: number; // Friday >= 16:00
  timeBasis: 'local' | 'mixed' | 'utc';
}

export interface LanguageSlice {
  language: string;
  repos: number;
  share: number;
}

export interface RepoShapeExhibit {
  inspected: number;
  truncated: boolean;
  ownedOriginal: number;
  forks: number;
  archived: number | null; // null when the data source lacks the field
  zeroStar: number;
  noLicense: number;
  totalStars: number;
  followers: number;
  topStarred: { name: string; stars: number }[];
}

export interface YearsExhibit {
  accountAgeYears: number;
  reposCreatedByYear: Record<string, number>;
  dormantRepos: number; // owned, not pushed for 2+ years
  daysSinceLastPush: number | null;
}

export interface RadarAxis {
  id: string;
  label: string;
  value: number; // share 0..1
  numerator: number;
  denominator: number;
  reliable: boolean; // denominator >= MIN_RELIABLE
  basis: string; // e.g. "recent public commits found"
}

export interface DetailReport {
  handle: string;
  sample: {
    commits: number;
    events: number;
    repos: number;
    searchIncomplete: boolean;
    notes: string[];
  };
  calendar: CalendarExhibit | null;
  punchCard: PunchCardExhibit | null;
  years: YearsExhibit;
  languages: LanguageSlice[];
  repoShape: RepoShapeExhibit;
  radar: RadarAxis[];
}

// ---------- helpers ----------

interface ParsedCommit {
  weekday: number;
  hour: number;
  hasOffset: boolean;
  message: string;
}

function parseCommits(commits: DetailCommit[] | null, now: Date): ParsedCommit[] {
  if (!commits) return [];
  const out: ParsedCommit[] = [];
  for (const c of commits) {
    const iso = c.commit.author?.date;
    if (!iso) continue;
    const p = parseAuthorLocalTime(iso);
    if (!p) continue;
    if (p.epochMs > now.getTime() + DAY_MS) continue; // spoofed future dates
    out.push({
      weekday: p.dayOfWeek,
      hour: p.hour,
      hasOffset: p.hasExplicitOffset,
      message: (c.commit.message ?? '').split('\n')[0] ?? '',
    });
  }
  return out;
}

function ratio(num: number, den: number) {
  return den > 0 ? num / den : 0;
}

function dow(date: string) {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

// ---------- exhibits ----------

export function buildCalendar(days: CalendarDay[] | null | undefined): CalendarExhibit | null {
  if (!days || days.length === 0) return null;
  const sorted = [...days].sort((a, b) => (a.date < b.date ? -1 : 1));

  const nonzero = sorted.map((d) => d.count).filter((n) => n > 0).sort((a, b) => a - b);
  const q = (p: number) => nonzero[Math.min(nonzero.length - 1, Math.floor(nonzero.length * p))] ?? 0;
  const t1 = q(0.25);
  const t2 = q(0.5);
  const t3 = q(0.75);
  const level = (n: number): 0 | 1 | 2 | 3 | 4 => (n <= 0 ? 0 : n <= t1 ? 1 : n <= t2 ? 2 : n <= t3 ? 3 : 4);

  const weeks: (CalendarCell | null)[][] = [];
  let col: (CalendarCell | null)[] = [];
  const first = sorted[0];
  if (!first) return null;
  for (let i = 0; i < dow(first.date); i++) col.push(null);

  let total = 0;
  let activeDays = 0;
  let streak = 0;
  let longestStreak = 0;
  let gap = 0;
  let longestGap = 0;
  let busiest: { date: string; count: number } | null = null;

  for (const d of sorted) {
    col.push({ date: d.date, count: d.count, level: level(d.count) });
    if (col.length === 7) {
      weeks.push(col);
      col = [];
    }
    total += d.count;
    if (d.count > 0) {
      activeDays++;
      streak++;
      gap = 0;
      longestStreak = Math.max(longestStreak, streak);
      if (!busiest || d.count > busiest.count) busiest = { date: d.date, count: d.count };
    } else {
      gap++;
      streak = 0;
      longestGap = Math.max(longestGap, gap);
    }
  }
  if (col.length > 0) weeks.push(col);

  return { weeks, total, activeDays, longestStreak, longestGap, busiest };
}

export function buildPunchCard(parsed: ParsedCommit[]): PunchCardExhibit | null {
  if (parsed.length === 0) return null;
  const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const byHour = new Array<number>(24).fill(0);
  let night = 0;
  let weekend = 0;
  let fridayEve = 0;
  let withOffset = 0;

  for (const c of parsed) {
    const row = grid[c.weekday];
    if (row) row[c.hour] = (row[c.hour] ?? 0) + 1;
    byHour[c.hour] = (byHour[c.hour] ?? 0) + 1;
    if (c.hour >= 1 && c.hour <= 4) night++;
    if (c.weekday === 0 || c.weekday === 6) weekend++;
    if (c.weekday === 5 && c.hour >= 16) fridayEve++;
    if (c.hasOffset) withOffset++;
  }
  const max = Math.max(...byHour);
  const n = parsed.length;
  return {
    grid,
    sample: n,
    peakHour: max > 0 ? byHour.indexOf(max) : null,
    nightShare: night / n,
    weekendShare: weekend / n,
    fridayEveningShare: fridayEve / n,
    timeBasis: withOffset === n ? 'local' : withOffset === 0 ? 'utc' : 'mixed',
  };
}

export function buildLanguages(repos: DetailRepo[]): LanguageSlice[] {
  if (!repos.some((r) => r.language !== undefined)) return []; // field not provided
  const owned = repos.filter((r) => !r.fork);
  const counts = new Map<string, number>();
  for (const r of owned) {
    const k = r.language ?? 'Unlabelled';
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const top = sorted.slice(0, 6);
  const rest = sorted.slice(6).reduce((s, [, n]) => s + n, 0);
  const total = owned.length;
  const out = top.map(([language, n]) => ({ language, repos: n, share: ratio(n, total) }));
  if (rest > 0) out.push({ language: 'Other', repos: rest, share: ratio(rest, total) });
  return out;
}

export function buildRepoShape(user: DetailUser, repos: DetailRepo[]): RepoShapeExhibit {
  const owned = repos.filter((r) => !r.fork);
  return {
    inspected: repos.length,
    truncated: user.public_repos > repos.length,
    ownedOriginal: owned.length,
    forks: repos.length - owned.length,
    archived: repos.some((r) => r.archived !== undefined)
      ? repos.filter((r) => r.archived === true).length
      : null,
    zeroStar: owned.filter((r) => r.stargazers_count === 0).length,
    noLicense: owned.filter((r) => !r.license).length,
    totalStars: owned.reduce((s, r) => s + r.stargazers_count, 0),
    followers: user.followers,
    topStarred: [...owned]
      .sort((a, b) => b.stargazers_count - a.stargazers_count || (a.name < b.name ? -1 : 1))
      .slice(0, 3)
      .map((r) => ({ name: r.name, stars: r.stargazers_count })),
  };
}

export function buildYears(user: DetailUser, repos: DetailRepo[], now: Date): YearsExhibit {
  const owned = repos.filter((r) => !r.fork);
  const byYear: Record<string, number> = {};
  for (const r of owned) {
    const y = r.created_at.slice(0, 4);
    byYear[y] = (byYear[y] ?? 0) + 1;
  }
  const pushes = repos
    .map((r) => (r.pushed_at ? Date.parse(r.pushed_at) : NaN))
    .filter((n) => Number.isFinite(n));
  const lastPush = pushes.length ? Math.max(...pushes) : null;
  const twoYearsAgo = now.getTime() - 2 * 365 * DAY_MS;
  return {
    accountAgeYears: Math.max(0, (now.getTime() - Date.parse(user.created_at)) / (365.25 * DAY_MS)),
    reposCreatedByYear: byYear,
    dormantRepos: owned.filter((r) => !r.pushed_at || Date.parse(r.pushed_at) < twoYearsAgo).length,
    daysSinceLastPush: lastPush === null ? null : Math.floor((now.getTime() - lastPush) / DAY_MS),
  };
}

export function buildRadar(
  input: DetailInput,
  parsed: ParsedCommit[],
  opts: DetailOptions,
): RadarAxis[] {
  const owned = input.repos.filter((r) => !r.fork);
  const forks = input.repos.filter((r) => r.fork);
  const abandoned =
    opts.isAbandonedFork ??
    ((r: DetailRepo) => !r.pushed_at || Date.parse(r.pushed_at) <= Date.parse(r.created_at) + DAY_MS);
  const events = input.events ?? [];

  const axis = (
    id: string,
    label: string,
    num: number,
    den: number,
    basis: string,
  ): RadarAxis => ({
    id,
    label,
    value: Math.min(1, ratio(num, den)),
    numerator: num,
    denominator: den,
    reliable: den >= MIN_RELIABLE,
    basis,
  });

  const commitBasis = input.searchIncomplete
    ? 'recent public commits found'
    : 'of the last public commits';

  return [
    axis('vague', 'Vague messages', parsed.filter((c) => opts.isVague(c.message)).length, parsed.length, commitBasis),
    axis('night', 'Odd hours (1-5 AM)', parsed.filter((c) => c.hour >= 1 && c.hour <= 4).length, parsed.length, commitBasis),
    axis('friday', 'Friday evenings', parsed.filter((c) => c.weekday === 5 && c.hour >= 16).length, parsed.length, commitBasis),
    axis('graveyard', 'Zero-star repos', owned.filter((r) => r.stargazers_count === 0).length, owned.length, 'inspected owned repos'),
    axis('licenseless', 'No license', owned.filter((r) => !r.license).length, owned.length, 'inspected owned repos'),
    axis('forks', 'Untouched forks', forks.filter(abandoned).length, forks.length, 'inspected forks'),
    axis('deletes', 'Branch deleter', events.filter((e) => e.type === 'DeleteEvent').length, events.length, 'recent public events'),
  ];
}

// ---------- entry point ----------

export function buildDetailReport(
  input: DetailInput,
  opts: DetailOptions = { isVague: isVagueCommitMessage },
): DetailReport {
  const now = input.now ?? new Date();
  const parsed = parseCommits(input.commits, now);
  const calendar = buildCalendar(input.calendarDays);
  const punchCard = buildPunchCard(parsed);
  const repoShape = buildRepoShape(input.user, input.repos);

  const notes: string[] = [];
  if (input.commits === null) notes.push('No commit sample available; commit-based exhibits are omitted.');
  if (input.searchIncomplete) notes.push('GitHub search reported incomplete results; counts are of recent commits found.');
  if (repoShape.truncated) notes.push(`Only ${repoShape.inspected} of ${input.user.public_repos} public repos were inspected.`);
  if (punchCard && punchCard.timeBasis !== 'local') {
    notes.push(punchCard.timeBasis === 'utc' ? 'Commit times are UTC, not the author\'s local time.' : 'Some commit times are UTC, not local.');
  }
  if (parsed.length > 0 && parsed.length < 30) notes.push(`Small commit sample (${parsed.length}); treat shapes as rough.`);
  if (!calendar) notes.push('Contribution calendar unavailable.');
  if (!input.repos.some((r) => r.language !== undefined)) notes.push('Language data unavailable.');

  return {
    handle: input.user.login,
    sample: {
      commits: parsed.length,
      events: input.events?.length ?? 0,
      repos: input.repos.length,
      searchIncomplete: Boolean(input.searchIncomplete),
      notes,
    },
    calendar,
    punchCard,
    years: buildYears(input.user, input.repos, now),
    languages: buildLanguages(input.repos),
    repoShape,
    radar: buildRadar(input, parsed, opts),
  };
}

// ---------- adapters for the real bundle shape ----------

/** Structural view of our GitHubBundle (api/presets.ts). */
export interface BundleLike {
  handle: string;
  sealed?: boolean;
  user: DetailUser | null;
  repos: DetailRepo[];
  events: DetailEvent[];
  commits: { items: DetailCommit[]; incomplete_results?: boolean } | null;
}

/** Returns null for sealed (opted-out) handles or when /users failed. */
export function detailInputFromBundle(
  b: BundleLike,
  calendarDays?: CalendarDay[] | null,
  now?: Date,
): DetailInput | null {
  if (b.sealed || isOptedOut(b.handle) || (b.user && isOptedOut(b.user.login)) || !b.user) {
    return null;
  }
  return {
    user: b.user,
    repos: b.repos,
    events: b.events,
    commits: b.commits ? b.commits.items : null,
    searchIncomplete: b.commits?.incomplete_results === true,
    calendarDays: calendarDays ?? null,
    now,
  };
}

/** GraphQL contributionCalendar.weeks -> flat days. */
export function flattenContributionWeeks(
  weeks: { contributionDays: { date: string; contributionCount: number }[] }[],
): CalendarDay[] {
  return weeks.flatMap((w) => w.contributionDays.map((d) => ({ date: d.date, count: d.contributionCount })));
}
