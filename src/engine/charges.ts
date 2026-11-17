import type {
  GitHubBundle,
  GitHubCommitSearchItem,
  GitHubEvent,
  GitHubRepo,
  MissingParts,
} from '../../api/presets.js';
import { isOptedOut } from '../optout.js';
import { hashHandle, normalizeHandle } from './hash.js';
import {
  STATUTE_LABELS,
  getOfficer,
  getReceivingDesk,
  getSentence,
  getStingLine,
  type StatuteId,
} from './voice.js';

export interface ParsedLocalTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday ... 5 = Friday ... 6 = Saturday in the author's local date */
  dayOfWeek: number;
  offset: string;
  hasExplicitOffset: boolean;
  epochMs: number;
}

export interface Charge {
  statute: StatuteId;
  label: string;
  countLabel: string;
  receipt: string;
  sting: string;
  count: number;
  totalInspected: number;
  severity: number;
}

export type VerdictKind =
  | 'GUILTY'
  | 'WANTED'
  | 'SUSPICIOUS'
  | 'ACQUITTED'
  | 'INSUFFICIENT EVIDENCE'
  | 'RECORD SEALED';

export interface AlibiEntry {
  title: string;
  receipt: string;
  sting: string;
}

export interface VerdictReport {
  handle: string;
  caseNumber: string;
  date: string;
  officer: string;
  receivedBy: string;
  verdict: VerdictKind;
  verdictSting: string;
  charges: Charge[];
  allCharges: Charge[];
  alibi: AlibiEntry | null;
  bailAmount: number;
  bail: string;
  menaceScore: number;
  intakeNotes: string;
  sentence: string | null;
  accountKind: 'User' | 'Organization' | 'Bot';
  isPreset: boolean;
  partialRecord: boolean;
  searchIncomplete: boolean;
  missing: MissingParts;
  priorsYears: number | null;
  knownAssociate: string | null;
}

const ISO_WITH_TZ =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Parses an ISO-8601 timestamp using the embedded author timezone offset
 * (e.g. "2026-11-16T03:14:00+05:30" -> hour 3) regardless of runtime TZ.
 */
export function parseAuthorLocalTime(isoString: string): ParsedLocalTime | null {
  const match = ISO_WITH_TZ.exec(isoString.trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const rawOffset = match[7] ?? 'Z';

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    return null;
  }

  const epochMs = Date.parse(isoString);
  if (Number.isNaN(epochMs)) return null;

  // Date.UTC using the already-local (year, month, day) yields the local weekday independent of host TZ.
  const localCalendar = new Date(Date.UTC(year, month - 1, day));
  if (
    localCalendar.getUTCFullYear() !== year ||
    localCalendar.getUTCMonth() !== month - 1 ||
    localCalendar.getUTCDate() !== day
  ) {
    return null;
  }

  const normalizedOffset =
    rawOffset.toUpperCase() === 'Z'
      ? 'Z'
      : rawOffset.includes(':')
        ? rawOffset
        : `${rawOffset.slice(0, 3)}:${rawOffset.slice(3)}`;

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    dayOfWeek: localCalendar.getUTCDay(),
    offset: normalizedOffset,
    hasExplicitOffset: normalizedOffset !== 'Z',
    epochMs,
  };
}

const VAGUE_EXACT_MESSAGES = new Set([
  'wip',
  'fix',
  'fixed',
  'fixes',
  'fixing',
  'bugfix',
  'hotfix',
  'quick fix',
  'small fix',
  'minor fix',
  'fix bug',
  'fix bugs',
  'fix it',
  'fix this',
  'fix typo',
  'wip fix',
  'update',
  'updates',
  'updated',
  'updating',
  'up',
  'test',
  'testing',
  'tests',
  'tmp',
  'temp',
  'oops',
  'whoops',
  'sorry',
  'asdf',
  'qwerty',
  'foo',
  'bar',
  'baz',
  'lint',
  'format',
  'fmt',
  'typo',
  'typos',
  'nit',
  'minor',
  'stuff',
  'things',
  'changes',
  'change',
  'commit',
  'initial commit',
  'first commit',
  'init',
  'readme',
  'update readme',
  'update readme.md',
  'edit',
  'edits',
  'cleanup',
  'clean up',
  'clean',
  'refactor',
  'misc',
  'todo',
  'tbd',
  'idk',
  'hm',
  'hmm',
  'ok',
  'done',
  'save',
  'checkpoint',
  'push',
  'deploy',
  'bump',
  'link',
  'twk',
  'debug',
  'debugging',
  'work',
  'working',
  'more',
  'again',
  'try',
  'trying',
  'retry',
  'please',
  'pls',
  'work pls',
  'broken',
  'uh',
  'ah',
  'lol',
  'yolo',
]);

const MERGE_OR_REVERT_RE =
  /^(?:merge\s+(?:branch|pull request|tag|remote-tracking|commit)\b|revert\s+")/i;
const SEMVER_RE = /^v?\d+(?:\.\d+){1,2}(?:[-+][\w.-]+)?$/i;
const CONVENTIONAL_RE = /^([a-z][a-z0-9_-]*)(?:\([^)]+\))?!?:\s*(.+)$/i;
const NO_ALNUM_RE = /^[^\p{L}\p{N}]+$/u;

/**
 * Flags low-effort / uninformative commit subject lines ("wip", "fix", "...")
 * while preserving descriptive conventional commits, merges, and version tags.
 */
export function isVagueCommitMessage(message: string): boolean {
  const firstLine = (message.split(/\r?\n/, 1)[0] ?? '').trim();
  if (!firstLine) return true;

  if (MERGE_OR_REVERT_RE.test(firstLine)) return false;
  if (SEMVER_RE.test(firstLine)) return false;
  if (NO_ALNUM_RE.test(firstLine)) return true;

  const conventional = CONVENTIONAL_RE.exec(firstLine);
  if (conventional) {
    const rest = (conventional[2] ?? '').trim();
    const restNormalized = rest.toLowerCase().replace(/[.!?,;:]+$/g, '').trim();
    if (
      !restNormalized ||
      NO_ALNUM_RE.test(rest) ||
      VAGUE_EXACT_MESSAGES.has(restNormalized) ||
      restNormalized.length <= 3
    ) {
      return true;
    }
    const wordCount = restNormalized.split(/\s+/).length;
    if (wordCount >= 2 || restNormalized.length >= 10) {
      return false;
    }
  }

  const cleaned = firstLine
    .toLowerCase()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[.!?,;:]+$/g, '')
    .trim();

  if (!cleaned || NO_ALNUM_RE.test(cleaned)) return true;
  if (VAGUE_EXACT_MESSAGES.has(cleaned)) return true;
  if (cleaned.length <= 4 && !SEMVER_RE.test(cleaned)) return true;

  return false;
}

const EVENT_STATUTES = new Set<StatuteId>(['direct_to_main', 'trigger_happy']);
const ROMAN_COUNTS = ['COUNT I', 'COUNT II', 'COUNT III', 'COUNT IV'] as const;

function formatDateGB(date: Date): string {
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = String(date.getUTCFullYear());
  return `${dd}.${mm}.${yyyy}`;
}

function getAccountKind(
  handle: string,
  userType?: string,
): 'User' | 'Organization' | 'Bot' {
  if (userType === 'Organization') return 'Organization';
  if (userType === 'Bot' || normalizeHandle(handle).endsWith('[bot]')) {
    return 'Bot';
  }
  return 'User';
}

function hasNoLicense(repo: GitHubRepo): boolean {
  return !repo.license || (!repo.license.spdx_id && !repo.license.name);
}

function isUntouchedFork(repo: GitHubRepo): boolean {
  if (!repo.fork) return false;
  const createdMs = Date.parse(repo.created_at);
  const pushedMs = Date.parse(repo.pushed_at);
  if (Number.isNaN(createdMs) || Number.isNaN(pushedMs)) return false;
  return pushedMs <= createdMs + 60_000;
}

function formatSnippet(msg: string): string {
  const first = (msg.split(/\r?\n/, 1)[0] ?? '').trim();
  const clipped = first.length > 16 ? `${first.slice(0, 15)}…` : first;
  return `'${clipped}'`;
}

function describeMissingEvidence(missing: MissingParts): string {
  if (missing.commits === 'empty') {
    return 'No public commits on file; commit search returned 0 results.';
  }
  if (missing.commits !== undefined) {
    return 'Commit search index unavailable; cannot verify commit history.';
  }
  if (missing.events !== undefined) {
    return 'Public events log unavailable; activity record incomplete.';
  }
  if (missing.repos !== undefined) {
    return 'Repository listing unavailable; property record incomplete.';
  }
  return 'Upstream GitHub record incomplete; exhibits missing from file.';
}

export function evaluateCharges(
  bundle: GitHubBundle,
  now: Date = new Date(),
): VerdictReport {
  const handle = bundle.user?.login || bundle.handle;
  const seed = hashHandle(handle);
  const caseNumber = `GH-26-${String((seed % 9000) + 1000)}`;
  const date = formatDateGB(now);
  const officer = getOfficer(handle);
  const receivedBy = getReceivingDesk(handle);
  const accountKind = getAccountKind(handle, bundle.user?.type);

  if (bundle.sealed || isOptedOut(handle)) {
    const sealedSting = 'File sealed by order of the precinct.';
    return {
      handle: bundle.handle || handle,
      caseNumber,
      date,
      officer,
      receivedBy,
      verdict: 'RECORD SEALED',
      verdictSting: sealedSting,
      charges: [],
      allCharges: [],
      alibi: {
        title: 'RECORD SEALED',
        receipt: 'Dossier expunged upon request. No public exhibits retained.',
        sting: sealedSting,
      },
      bailAmount: 0,
      bail: '—',
      menaceScore: 0,
      intakeNotes: 'sealed by request',
      sentence: null,
      accountKind: 'User',
      isPreset: false,
      partialRecord: false,
      searchIncomplete: false,
      missing: {},
      priorsYears: null,
      knownAssociate: null,
    };
  }

  const skipPersonalHabits = accountKind !== 'User';
  const searchIncomplete = Boolean(bundle.commits?.incomplete_results);

  const maxCommitEpoch = now.getTime() + 86_400_000;
  const parsedCommits: Array<{
    item: GitHubCommitSearchItem;
    local: ParsedLocalTime;
  }> = [];

  for (const item of bundle.commits?.items ?? []) {
    const local = parseAuthorLocalTime(item.commit.author.date);
    if (!local) continue;
    if (local.epochMs > maxCommitEpoch) continue;
    parsedCommits.push({ item, local });
  }

  const commitTotal = parsedCommits.length;
  const commitScope = searchIncomplete
    ? `of ${commitTotal} recent public commits found`
    : `of the last ${commitTotal} public commits`;
  const events: GitHubEvent[] = bundle.events ?? [];
  const eventTotal = events.length;
  const ownedNonForks = (bundle.repos ?? []).filter((r) => !r.fork);
  const ownedCount = ownedNonForks.length;
  const forks = (bundle.repos ?? []).filter((r) => r.fork);
  const forkCount = forks.length;

  const rawCharges: Omit<Charge, 'countLabel'>[] = [];

  const pushCharge = (
    statute: StatuteId,
    count: number,
    totalInspected: number,
    receipt: string,
    severity: number,
  ) => {
    rawCharges.push({
      statute,
      label: STATUTE_LABELS[statute],
      receipt,
      sting: getStingLine(handle, statute),
      count,
      totalInspected,
      severity: Math.max(1, Math.min(100, Math.round(severity))),
    });
  };

  // 1. Serial laziness (vague commit messages)
  if (!skipPersonalHabits && commitTotal >= 5) {
    const vagueCommits = parsedCommits.filter(({ item }) =>
      isVagueCommitMessage(item.commit.message),
    );
    const threshold = commitTotal <= 10 ? 2 : 3;
    if (vagueCommits.length >= threshold) {
      const examples = Array.from(
        new Set(vagueCommits.map((v) => formatSnippet(v.item.commit.message))),
      ).slice(0, 2);
      const sampleSuffix =
        examples.length > 0 ? ` (${examples.join(', ')})` : '';
      const ratio = vagueCommits.length / commitTotal;
      const severity = Math.max(
        20,
        ratio * 140 + Math.min(25, vagueCommits.length * 2),
      );
      pushCharge(
        'serial_laziness',
        vagueCommits.length,
        commitTotal,
        `${vagueCommits.length} ${commitScope} had vague messages${sampleSuffix}.`,
        severity,
      );
    }
  }

  // 2. Unlawful hours (1:00 AM - 4:59 AM in author's own timezone offset, or UTC if Z-only)
  if (!skipPersonalHabits && commitTotal >= 5) {
    const lateCommits = parsedCommits.filter(
      ({ local }) => local.hour >= 1 && local.hour < 5,
    );
    const threshold = commitTotal <= 10 ? 2 : 3;
    if (lateCommits.length >= threshold) {
      const ratio = lateCommits.length / commitTotal;
      const severity = Math.max(
        22,
        ratio * 150 + Math.min(25, lateCommits.length * 3),
      );
      const tzLabel = lateCommits.every(({ local }) => local.hasExplicitOffset)
        ? ', local time'
        : ' UTC';
      pushCharge(
        'unlawful_hours',
        lateCommits.length,
        commitTotal,
        `${lateCommits.length} ${commitScope} clocked between 1 and 5 AM${tzLabel}.`,
        severity,
      );
    }
  }

  // 3. Friday deployer (Friday >= 16:00 local from commits, or UTC fallback from PushEvent)
  if (!skipPersonalHabits) {
    if (commitTotal >= 5) {
      const fridayCommits = parsedCommits.filter(
        ({ local }) => local.dayOfWeek === 5 && local.hour >= 16,
      );
      const threshold = commitTotal <= 10 ? 2 : 3;
      if (fridayCommits.length >= threshold) {
        const ratio = fridayCommits.length / commitTotal;
        const severity = Math.max(
          20,
          ratio * 135 + Math.min(20, fridayCommits.length * 3),
        );
        const receipt = fridayCommits.every(({ local }) => local.hasExplicitOffset)
          ? `${fridayCommits.length} ${commitScope} landed after 4 PM Friday, local time.`
          : `${fridayCommits.length} ${commitScope} landed after 4 PM UTC on Friday.`;
        pushCharge(
          'friday_deployer',
          fridayCommits.length,
          commitTotal,
          receipt,
          severity,
        );
      }
    } else if (commitTotal === 0 && eventTotal >= 5) {
      const fridayPushes = events.filter((e) => {
        if (e.type !== 'PushEvent') return false;
        const parsed = parseAuthorLocalTime(e.created_at);
        return parsed !== null && parsed.dayOfWeek === 5 && parsed.hour >= 16;
      });
      const threshold = eventTotal <= 10 ? 2 : 3;
      if (fridayPushes.length >= threshold) {
        const ratio = fridayPushes.length / eventTotal;
        const severity = Math.max(
          18,
          ratio * 125 + Math.min(20, fridayPushes.length * 3),
        );
        pushCharge(
          'friday_deployer',
          fridayPushes.length,
          eventTotal,
          `${fridayPushes.length} of the last ${eventTotal} public events pushed after 4 PM UTC on a Friday.`,
          severity,
        );
      }
    }
  }

  // 4. Direct to main (PushEvent targeting refs/heads/main or refs/heads/master)
  if (eventTotal >= 5) {
    const directPushes = events.filter(
      (e) =>
        e.type === 'PushEvent' &&
        (e.payload?.ref === 'refs/heads/main' ||
          e.payload?.ref === 'refs/heads/master'),
    );
    if (directPushes.length >= 2) {
      const ratio = directPushes.length / eventTotal;
      const severity = Math.max(
        22,
        ratio * 110 + Math.min(30, directPushes.length * 2),
      );
      pushCharge(
        'direct_to_main',
        directPushes.length,
        eventTotal,
        `${directPushes.length} of the last ${eventTotal} public events pushed directly to main or master.`,
        severity,
      );
    }
  }

  // 5. Graveyard (owned non-fork repos with zero stars: >= 5 inspected and strict majority)
  if (ownedCount >= 5) {
    const zeroStarRepos = ownedNonForks.filter((r) => r.stargazers_count === 0);
    if (zeroStarRepos.length >= 5 && zeroStarRepos.length * 2 > ownedCount) {
      const severity = 24 + zeroStarRepos.length * 4;
      pushCharge(
        'graveyard',
        zeroStarRepos.length,
        ownedCount,
        `${zeroStarRepos.length} of ${ownedCount} inspected owned repos have zero stars.`,
        severity,
      );
    }
  }

  // 6. Licenseless anarchy (owned non-fork repos without license: >= 5 inspected and strict majority)
  if (ownedCount >= 5) {
    const unlicensed = ownedNonForks.filter(hasNoLicense);
    if (unlicensed.length * 2 > ownedCount) {
      const ratio = unlicensed.length / ownedCount;
      const severity = ratio * 70 + unlicensed.length * 4;
      pushCharge(
        'licenseless_anarchy',
        unlicensed.length,
        ownedCount,
        `${unlicensed.length} of ${ownedCount} inspected owned repos shipped without a license.`,
        severity,
      );
    }
  }

  // 7. Trigger happy (DeleteEvent in recent public activity, >= 5 events)
  if (eventTotal >= 5) {
    const deletions = events.filter((e) => e.type === 'DeleteEvent');
    if (deletions.length >= 3) {
      const severity = 20 + deletions.length * 6;
      pushCharge(
        'trigger_happy',
        deletions.length,
        eventTotal,
        `${deletions.length} of the last ${eventTotal} public events deleted a branch or tag.`,
        severity,
      );
    }
  }

  // 8. Abandoned forks (forks never touched after creation: >= 5 forks and strict majority)
  if (forkCount >= 5) {
    const untouched = forks.filter(isUntouchedFork);
    if (untouched.length * 2 > forkCount) {
      const severity = 16 + untouched.length * 10;
      pushCharge(
        'abandoned_forks',
        untouched.length,
        forkCount,
        `${untouched.length} of ${forkCount} inspected forked repos never touched after forking.`,
        severity,
      );
    }
  }

  rawCharges.sort((a, b) => {
    if (b.severity !== a.severity) return b.severity - a.severity;
    const tieA = hashHandle(handle, `tie:${a.statute}`);
    const tieB = hashHandle(handle, `tie:${b.statute}`);
    if (tieA !== tieB) return tieA - tieB;
    return a.statute.localeCompare(b.statute);
  });

  // Cap event-derived statutes (direct_to_main, trigger_happy) at 1 per card
  // unless fewer than 3 other statutes apply.
  const nonEventCount = rawCharges.filter(
    (c) => !EVENT_STATUTES.has(c.statute),
  ).length;
  let orderedCharges = rawCharges;

  if (nonEventCount >= 3) {
    const capped: typeof rawCharges = [];
    let eventCountUsed = false;
    for (const charge of rawCharges) {
      if (EVENT_STATUTES.has(charge.statute)) {
        if (!eventCountUsed) {
          capped.push(charge);
          eventCountUsed = true;
        }
      } else {
        capped.push(charge);
      }
    }
    orderedCharges = capped;
  }

  const allCharges: Charge[] = orderedCharges.map((c, idx) => ({
    ...c,
    countLabel: ROMAN_COUNTS[idx] ?? `COUNT ${idx + 1}`,
  }));

  const topCharges = allCharges.slice(0, 4);

  const rawMenace = topCharges.reduce((sum, c, idx) => {
    const weight = idx === 0 ? 0.55 : idx === 1 ? 0.35 : 0.2;
    return sum + c.severity * weight;
  }, 0);
  const menaceScore = Math.min(100, Math.round(rawMenace));

  const isClean = allCharges.length === 0 || menaceScore < 15;

  let priorsYears: number | null = null;
  if (bundle.user?.created_at) {
    const createdMs = Date.parse(bundle.user.created_at);
    if (!Number.isNaN(createdMs)) {
      priorsYears = Math.max(
        0,
        Math.floor((now.getTime() - createdMs) / (365.25 * 86_400_000)),
      );
    }
  }

  const topFork = [...forks].sort(
    (a, b) => b.stargazers_count - a.stargazers_count,
  )[0];
  const knownAssociate = topFork ? topFork.name : null;

  const missingCommitsFailed =
    bundle.missing.commits !== undefined && bundle.missing.commits !== 'empty';
  const partialRecord = Object.keys(bundle.missing).length > 0;

  if (isClean) {
    if (partialRecord) {
      const verdictSting = getStingLine(handle, 'insufficient_evidence');
      const partialReceipt = describeMissingEvidence(bundle.missing);
      let partialNote: string;
      if (accountKind === 'Organization') {
        partialNote = 'SUSPECT IS A CORPORATION';
      } else if (accountKind === 'Bot') {
        partialNote = 'SUSPECT IS AN AUTOMATON';
      } else if (missingCommitsFailed) {
        partialNote = 'search index unavailable';
      } else if (bundle.missing.commits === 'empty') {
        partialNote = 'zero public commits';
      } else {
        partialNote = 'incomplete upstream record';
      }
      return {
        handle,
        caseNumber,
        date,
        officer,
        receivedBy,
        verdict: 'INSUFFICIENT EVIDENCE',
        verdictSting,
        charges: [],
        allCharges,
        alibi: {
          title: 'INSUFFICIENT EVIDENCE',
          receipt: partialReceipt,
          sting: verdictSting,
        },
        bailAmount: 0,
        bail: '$0',
        menaceScore,
        intakeNotes: partialNote,
        sentence: null,
        accountKind,
        isPreset: bundle.preset,
        partialRecord,
        searchIncomplete,
        missing: { ...bundle.missing },
        priorsYears,
        knownAssociate,
      };
    }

    const orgPrefix =
      accountKind === 'Organization'
        ? 'SUSPECT IS A CORPORATION — '
        : accountKind === 'Bot'
          ? 'SUSPECT IS AN AUTOMATON — '
          : '';
    const verdictSting = getStingLine(handle, 'acquitted');
    return {
      handle,
      caseNumber,
      date,
      officer,
      receivedBy,
      verdict: 'ACQUITTED',
      verdictSting,
      charges: [],
      allCharges,
      alibi: {
        title: 'NO CHARGES FILED',
        receipt: 'Fully redacted, as a courtesy.',
        sting: verdictSting,
      },
      bailAmount: 0,
      bail: '$0',
      menaceScore,
      intakeNotes: `${orgPrefix}suspiciously clean`,
      sentence: null,
      accountKind,
      isPreset: bundle.preset,
      partialRecord,
      searchIncomplete,
      missing: { ...bundle.missing },
      priorsYears,
      knownAssociate,
    };
  }

  const verdict: VerdictKind =
    menaceScore >= 70
      ? 'GUILTY'
      : menaceScore >= 40
        ? 'WANTED'
        : 'SUSPICIOUS';

  const bailAmount = Math.max(5000, menaceScore * 1000);
  const bail = `$${bailAmount.toLocaleString('en-US')}`;

  let intakeNotes: string;
  if (accountKind === 'Organization') {
    intakeNotes = 'SUSPECT IS A CORPORATION';
  } else if (accountKind === 'Bot') {
    intakeNotes = 'SUSPECT IS AN AUTOMATON';
  } else if (missingCommitsFailed) {
    intakeNotes = 'search index unavailable';
  } else if (commitTotal === 0) {
    intakeNotes = 'zero public commits';
  } else if (allCharges.length > 3 && allCharges[3]) {
    intakeNotes = `also cited: ${allCharges[3].label.toLowerCase()}`;
  } else if (priorsYears !== null) {
    intakeNotes = `${priorsYears} yrs on file, ${bundle.user?.public_repos ?? 0} repos`;
  } else {
    intakeNotes = `priors booked on ${topCharges[0]?.label.toLowerCase() ?? 'record'}`;
  }

  return {
    handle,
    caseNumber,
    date,
    officer,
    receivedBy,
    verdict,
    verdictSting: topCharges[0]?.sting ?? getStingLine(handle, 'acquitted'),
    charges: topCharges,
    allCharges,
    alibi: null,
    bailAmount,
    bail,
    menaceScore,
    intakeNotes,
    sentence: getSentence(handle),
    accountKind,
    isPreset: bundle.preset,
    partialRecord,
    searchIncomplete,
    missing: { ...bundle.missing },
    priorsYears,
    knownAssociate,
  };
}
