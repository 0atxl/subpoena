import { describe, expect, it } from 'vitest';
import { PRESETS, type GitHubBundle } from '../api/presets';
import {
  evaluateCharges,
  isVagueCommitMessage,
  parseAuthorLocalTime,
} from '../src/engine/charges';
import { hashHandle, normalizeHandle } from '../src/engine/hash';
import { OFFICERS, VOICE_BANKS, type VoiceCategory } from '../src/engine/voice';
import {
  OPT_OUT_CONTACT,
  isOptedOut,
  makeSealedBundle,
} from '../src/optout';

const FIXED_NOW = new Date('2026-11-16T12:00:00.000Z');

function makeCleanBundle(overrides: Partial<GitHubBundle> = {}): GitHubBundle {
  return {
    handle: 'clean-dev',
    fetchedAt: FIXED_NOW.toISOString(),
    preset: false,
    user: {
      login: 'clean-dev',
      id: 424242,
      avatar_url: 'https://avatars.githubusercontent.com/u/424242?v=4',
      name: 'Clean Developer',
      type: 'User',
      public_repos: 6,
      followers: 120,
      created_at: '2020-01-15T10:00:00Z',
    },
    repos: Array.from({ length: 6 }, (_, i) => ({
      name: `clean-lib-${i}`,
      full_name: `clean-dev/clean-lib-${i}`,
      fork: false,
      stargazers_count: 15 + i,
      license: { spdx_id: 'MIT', name: 'MIT License' },
      created_at: '2022-03-01T10:00:00Z',
      pushed_at: '2026-11-10T10:00:00Z',
    })),
    events: Array.from({ length: 12 }, (_, i) => ({
      id: String(1000 + i),
      type: 'PushEvent',
      created_at: '2026-11-10T14:00:00Z',
      repo: { name: 'clean-dev/clean-lib-0' },
      payload: { ref: `refs/heads/feat/issue-${i}`, ref_type: null },
    })),
    commits: {
      total_count: 20,
      items: Array.from({ length: 20 }, (_, i) => ({
        sha: `abc${i}`,
        commit: {
          message: `feat(core): implement deterministic check #${i}`,
          author: { date: '2026-11-11T10:30:00+02:00' },
        },
        repository: { full_name: 'clean-dev/clean-lib-0' },
      })),
    },
    missing: {},
    ...overrides,
  };
}

describe('parseAuthorLocalTime', () => {
  it('extracts local hour regardless of test runner timezone', () => {
    const ist = parseAuthorLocalTime('2026-11-16T03:14:00+05:30');
    expect(ist).not.toBeNull();
    expect(ist?.hour).toBe(3);
    expect(ist?.minute).toBe(14);
    expect(ist?.offset).toBe('+05:30');
    expect(ist?.hasExplicitOffset).toBe(true);

    const pst = parseAuthorLocalTime('2026-11-16T23:45:10-08:00');
    expect(pst?.hour).toBe(23);
    expect(pst?.day).toBe(16);
    expect(pst?.dayOfWeek).toBe(1); // Monday in -08:00, even though Tuesday in UTC
    expect(pst?.offset).toBe('-08:00');
    expect(pst?.hasExplicitOffset).toBe(true);

    const utc = parseAuthorLocalTime('2026-11-16T12:10:21.000Z');
    expect(utc?.hour).toBe(12);
    expect(utc?.offset).toBe('Z');
    expect(utc?.hasExplicitOffset).toBe(false);
  });

  it('computes Friday local weekday across UTC date boundaries', () => {
    // 2026-11-13 is Friday; at 17:30-07:00 it is already Saturday 00:30 UTC
    const fridayLatePdt = parseAuthorLocalTime('2026-11-13T17:30:00.000-07:00');
    expect(fridayLatePdt?.dayOfWeek).toBe(5);
    expect(fridayLatePdt?.hour).toBe(17);

    // 2026-11-14 is Saturday; at 02:00+05:30 it is still Friday 20:30 UTC
    const saturdayEarlyIst = parseAuthorLocalTime('2026-11-14T02:00:00+05:30');
    expect(saturdayEarlyIst?.dayOfWeek).toBe(6);
    expect(saturdayEarlyIst?.hour).toBe(2);
  });

  it('returns null for malformed or impossible timestamps', () => {
    expect(parseAuthorLocalTime('not-a-timestamp')).toBeNull();
    expect(parseAuthorLocalTime('2026-02-30T12:00:00Z')).toBeNull();
    expect(parseAuthorLocalTime('2026-11-16T25:00:00Z')).toBeNull();
  });
});

describe('isVagueCommitMessage', () => {
  it('flags vague commit messages', () => {
    for (const msg of [
      'wip',
      'WIP',
      'fix',
      'fix!',
      '...',
      'update',
      'asdf',
      'tmp',
      'fix bug',
      'changes',
      'feat: wip',
      'fix: tmp',
      '',
      '   ',
    ]) {
      expect(isVagueCommitMessage(msg), `expected vague: ${msg}`).toBe(true);
    }
  });

  it('does not flag descriptive commits, conventional commits, merges, or semver tags', () => {
    for (const msg of [
      'fix(parser): handle empty token',
      'feat(auth): validate JWT audience before expiry check',
      'Merge pull request #42 from org/feature-branch',
      "Merge tag 'arm64-fixes' of git://git.kernel.org/pub/scm/linux/kernel/git/arm64/linux",
      'Revert "cache: avoid stale header"',
      '8.0.0',
      'v2.4.1',
      'Linux 7.4-rc3',
      "Build the inline Flight script from React's strings instead of re-encoding them (#100142)",
    ]) {
      expect(isVagueCommitMessage(msg), `expected non-vague: ${msg}`).toBe(false);
    }
  });
});

describe('voice banks and determinism', () => {
  it('has at least 14 distinct officers in the OFFICERS pool', () => {
    expect(OFFICERS.length).toBeGreaterThanOrEqual(14);
    expect(new Set(OFFICERS).size).toBe(OFFICERS.length);
  });

  it('provides 15 to 20 unique short noir lines (<= 42 chars) per category', () => {
    const categories = Object.keys(VOICE_BANKS) as VoiceCategory[];
    expect(categories).toHaveLength(10);
    for (const category of categories) {
      const lines = VOICE_BANKS[category];
      expect(lines.length, category).toBeGreaterThanOrEqual(15);
      expect(lines.length, category).toBeLessThanOrEqual(20);
      const unique = new Set(lines.map((l) => l.trim()));
      expect(unique.size, `${category} has duplicate lines`).toBe(lines.length);
      for (const line of lines) {
        expect(line.trim().length).toBeGreaterThan(10);
        expect(line.trim().length, `${category}: "${line}"`).toBeLessThanOrEqual(42);
      }
    }
  });

  it('normalizes handles and produces deterministic reports', () => {
    expect(normalizeHandle('  @Gaearon ')).toBe('gaearon');
    expect(hashHandle('@gaearon')).toBe(hashHandle('GAEARON'));

    const r1 = evaluateCharges(PRESETS.gaearon, FIXED_NOW);
    const r2 = evaluateCharges(
      { ...PRESETS.gaearon, handle: '  @GAEARON ' },
      FIXED_NOW,
    );
    expect(r1).toEqual(r2);
  });
});

describe('evaluateCharges', () => {
  it('acquits an ultra-clean profile with the alibi variant', () => {
    const report = evaluateCharges(makeCleanBundle(), FIXED_NOW);

    expect(report.verdict).toBe('ACQUITTED');
    expect(report.charges).toEqual([]);
    expect(report.alibi).not.toBeNull();
    expect(report.alibi?.title).toBe('NO CHARGES FILED');
    expect(report.alibi?.receipt).toBe('Fully redacted, as a courtesy.');
    expect(report.bailAmount).toBe(0);
    expect(report.bail).toBe('$0');
    expect(report.intakeNotes).toBe('suspiciously clean');
    expect(report.sentence).toBeNull();
    expect(VOICE_BANKS.acquitted).toContain(report.verdictSting);
  });

  it('still produces repo and event charges when search returns empty or 403', () => {
    const base = makeCleanBundle({
      handle: 'partial-dev',
      user: {
        login: 'partial-dev',
        id: 111,
        avatar_url: 'https://avatars.githubusercontent.com/u/111?v=4',
        name: 'Partial',
        type: 'User',
        public_repos: 8,
        followers: 2,
        created_at: '2021-01-01T00:00:00Z',
      },
      repos: Array.from({ length: 7 }, (_, i) => ({
        name: `repo-${i}`,
        full_name: `partial-dev/repo-${i}`,
        fork: false,
        stargazers_count: 0,
        license: null,
        created_at: '2024-01-01T00:00:00Z',
        pushed_at: '2025-01-01T00:00:00Z',
      })),
      events: [
        ...Array.from({ length: 12 }, (_, i) => ({
          id: `p-${i}`,
          type: 'PushEvent',
          created_at: '2026-11-13T18:10:00Z', // Friday 18:10 UTC fallback
          payload: { ref: 'refs/heads/main', ref_type: null },
        })),
        ...Array.from({ length: 4 }, (_, i) => ({
          id: `d-${i}`,
          type: 'DeleteEvent',
          created_at: '2026-11-12T12:00:00Z',
          payload: { ref: `tmp-${i}`, ref_type: 'branch' },
        })),
      ],
    });

    const missing403 = evaluateCharges(
      { ...base, commits: null, missing: { commits: 403 } },
      FIXED_NOW,
    );
    expect(missing403.verdict).not.toBe('ACQUITTED');
    expect(missing403.charges.length).toBeGreaterThanOrEqual(3);
    expect(missing403.charges.some((c) => c.statute === 'direct_to_main')).toBe(
      true,
    );
    expect(
      missing403.charges.some((c) => c.statute === 'licenseless_anarchy'),
    ).toBe(true);
    expect(missing403.allCharges.some((c) => c.statute === 'friday_deployer')).toBe(
      true,
    );
    expect(missing403.intakeNotes).toContain('search index unavailable');

    const emptySearch = evaluateCharges(
      {
        ...base,
        commits: { total_count: 0, items: [] },
        missing: { commits: 'empty' },
      },
      FIXED_NOW,
    );
    expect(emptySearch.verdict).not.toBe('ACQUITTED');
    expect(emptySearch.charges.length).toBeGreaterThanOrEqual(3);
  });

  it('ignores spoofed future-dated commits in search results', () => {
    const bundle = makeCleanBundle({
      commits: {
        total_count: 10,
        items: [
          ...Array.from({ length: 5 }, (_, i) => ({
            sha: `future-${i}`,
            commit: {
              message: 'wip',
              author: { date: '2060-03-30T03:00:00+01:00' },
            },
          })),
          ...Array.from({ length: 5 }, (_, i) => ({
            sha: `real-${i}`,
            commit: {
              message: `feat(engine): add clean validation pass ${i}`,
              author: { date: '2026-11-10T11:00:00+01:00' },
            },
          })),
        ],
      },
    });
    const report = evaluateCharges(bundle, FIXED_NOW);
    expect(report.verdict).toBe('ACQUITTED');
  });

  it('skips personal-habit statutes for Organization and Bot accounts', () => {
    const badHabitsCommits = {
      total_count: 20,
      items: Array.from({ length: 20 }, (_, i) => ({
        sha: `c-${i}`,
        commit: {
          message: 'wip',
          author: { date: '2026-11-13T03:15:00Z' },
        },
      })),
    };

    const orgBundle = makeCleanBundle({
      handle: 'vercel',
      user: {
        login: 'vercel',
        id: 14985020,
        avatar_url: 'https://avatars.githubusercontent.com/u/14985020?v=4',
        name: 'Vercel',
        type: 'Organization',
        public_repos: 10,
        followers: 1000,
        created_at: '2015-10-01T00:00:00Z',
      },
      repos: Array.from({ length: 6 }, (_, i) => ({
        name: `org-repo-${i}`,
        full_name: `vercel/org-repo-${i}`,
        fork: false,
        stargazers_count: 0,
        license: null,
        created_at: '2023-01-01T00:00:00Z',
        pushed_at: '2026-01-01T00:00:00Z',
      })),
      commits: badHabitsCommits,
    });

    const orgReport = evaluateCharges(orgBundle, FIXED_NOW);
    expect(orgReport.accountKind).toBe('Organization');
    expect(orgReport.intakeNotes).toContain('SUSPECT IS A CORPORATION');
    expect(
      orgReport.allCharges.some(
        (c) =>
          c.statute === 'serial_laziness' ||
          c.statute === 'unlawful_hours' ||
          c.statute === 'friday_deployer',
      ),
    ).toBe(false);

    const botBundle = makeCleanBundle({
      handle: 'dependabot[bot]',
      user: {
        login: 'dependabot[bot]',
        id: 49699333,
        avatar_url: 'https://avatars.githubusercontent.com/in/29110?v=4',
        name: null,
        type: 'Bot',
        public_repos: 0,
        followers: 0,
        created_at: '2019-04-16T00:00:00Z',
      },
      repos: [],
      events: Array.from({ length: 10 }, (_, i) => ({
        id: `b-${i}`,
        type: 'PushEvent',
        created_at: '2026-11-15T12:00:00Z',
        payload: { ref: 'refs/heads/main', ref_type: null },
      })),
      commits: badHabitsCommits,
    });

    const botReport = evaluateCharges(botBundle, FIXED_NOW);
    expect(botReport.accountKind).toBe('Bot');
    expect(botReport.intakeNotes).toContain('SUSPECT IS AN AUTOMATON');
    expect(
      botReport.allCharges.some(
        (c) =>
          c.statute === 'serial_laziness' ||
          c.statute === 'unlawful_hours' ||
          c.statute === 'friday_deployer',
      ),
    ).toBe(false);
  });

  it('measures receipts explicitly and ranks at most 4 charges across presets', () => {
    for (const preset of Object.values(PRESETS)) {
      const report = evaluateCharges(preset, FIXED_NOW);
      expect(report.partialRecord).toBe(false);
      expect(report.charges.length).toBeLessThanOrEqual(4);
      for (let i = 1; i < report.charges.length; i++) {
        expect(report.charges[i - 1]!.severity).toBeGreaterThanOrEqual(
          report.charges[i]!.severity,
        );
      }
      for (const charge of report.allCharges) {
        expect(charge.receipt).not.toMatch(/of your/i);
        expect(charge.receipt).toMatch(
          /(?:of (?:the last )?\d+ (?:last |recent )?public commits(?: found)?|of the last \d+ public events|of \d+ inspected (?:owned|forked) repos)/,
        );
      }
    }
  });

  it('words friday_deployer and unlawful_hours as UTC when timestamps lack offsets or search is missing', () => {
    const utcCommitsBundle = makeCleanBundle({
      commits: {
        total_count: 6,
        items: Array.from({ length: 6 }, (_, i) => ({
          sha: `u-${i}`,
          commit: {
            message: `feat(sync): publish nightly batch ${i}`,
            author: { date: '2026-11-13T18:30:00.000Z' },
          },
        })),
      },
    });
    const utcReport = evaluateCharges(utcCommitsBundle, FIXED_NOW);
    const utcFriday = utcReport.allCharges.find(
      (c) => c.statute === 'friday_deployer',
    );
    expect(utcFriday).toBeDefined();
    expect(utcFriday?.receipt).toContain('UTC');
    expect(utcFriday?.receipt).not.toContain('local time');

    const missingSearchBundle = makeCleanBundle({
      events: Array.from({ length: 6 }, (_, i) => ({
        id: `fe-${i}`,
        type: 'PushEvent',
        created_at: '2026-11-13T18:15:00Z',
        payload: { ref: 'refs/heads/feat/a', ref_type: null },
      })),
      commits: null,
      missing: { commits: 403 },
    });
    const fallbackReport = evaluateCharges(missingSearchBundle, FIXED_NOW);
    const fallbackFriday = fallbackReport.allCharges.find(
      (c) => c.statute === 'friday_deployer',
    );
    expect(fallbackFriday).toBeDefined();
    expect(fallbackFriday?.receipt).toContain('UTC');
    expect(fallbackFriday?.receipt).not.toContain('local time');
  });

  it('exposes partialRecord flag when any key is present in missing', () => {
    expect(evaluateCharges(makeCleanBundle(), FIXED_NOW).partialRecord).toBe(
      false,
    );
    expect(
      evaluateCharges(
        makeCleanBundle({ missing: { commits: 'empty' } }),
        FIXED_NOW,
      ).partialRecord,
    ).toBe(true);
    expect(
      evaluateCharges(
        makeCleanBundle({ missing: { events: 403 } }),
        FIXED_NOW,
      ).partialRecord,
    ).toBe(true);
  });

  it('caps event-derived statutes at 1 when >= 3 other statutes apply and tie-breaks deterministically by handle', () => {
    const multiBundle = makeCleanBundle({
      handle: 'alpha-suspect',
      repos: Array.from({ length: 8 }, (_, i) => ({
        name: `r-${i}`,
        full_name: `alpha-suspect/r-${i}`,
        fork: i < 2,
        stargazers_count: 0,
        license: null,
        created_at: '2024-01-01T00:00:00Z',
        pushed_at: i < 2 ? '2024-01-01T00:00:00Z' : '2025-01-01T00:00:00Z',
      })),
      events: [
        ...Array.from({ length: 15 }, (_, i) => ({
          id: `p-${i}`,
          type: 'PushEvent',
          created_at: '2026-11-12T10:00:00Z',
          payload: { ref: 'refs/heads/main', ref_type: null },
        })),
        ...Array.from({ length: 5 }, (_, i) => ({
          id: `d-${i}`,
          type: 'DeleteEvent',
          created_at: '2026-11-12T10:00:00Z',
          payload: { ref: `tmp-${i}`, ref_type: 'branch' },
        })),
      ],
      commits: {
        total_count: 20,
        items: Array.from({ length: 20 }, (_, i) => ({
          sha: `m-${i}`,
          commit: {
            message: 'wip',
            author: { date: '2026-11-13T03:00:00+02:00' },
          },
        })),
      },
    });

    const report = evaluateCharges(multiBundle, FIXED_NOW);
    const eventCount = report.charges.filter(
      (c) => c.statute === 'direct_to_main' || c.statute === 'trigger_happy',
    ).length;
    expect(eventCount).toBeLessThanOrEqual(1);

    // Seeded tie-breaking produces varied ordering for equal-severity charges across handles
    const firstChoices = new Set<string>();
    for (const h of ['tie-a', 'tie-b', 'tie-c', 'tie-d', 'tie-e', 'tie-f']) {
      const r = evaluateCharges({ ...multiBundle, handle: h, user: { ...multiBundle.user!, login: h } }, FIXED_NOW);
      if (r.charges[0]) firstChoices.add(r.charges[0].statute);
    }
    expect(firstChoices.size).toBeGreaterThanOrEqual(2);
  });

  it('produces varied COUNT I statutes across presets and fixture archetypes', () => {
    const fixtures: GitHubBundle[] = [
      PRESETS.torvalds,
      PRESETS.sindresorhus,
      PRESETS.gaearon,
      PRESETS.octocat,
      makeCleanBundle({
        handle: 'night-owl',
        commits: {
          total_count: 10,
          items: Array.from({ length: 10 }, (_, i) => ({
            sha: `n-${i}`,
            commit: {
              message: `chore: run script ${i}`,
              author: { date: '2026-11-13T18:00:00-05:00' },
            },
          })),
        },
      }),
      makeCleanBundle({
        handle: 'bot[bot]',
        user: { ...makeCleanBundle().user!, login: 'bot[bot]', type: 'Bot' },
        events: Array.from({ length: 10 }, (_, i) => ({
          id: `b-${i}`,
          type: 'DeleteEvent',
          created_at: '2026-11-12T10:00:00Z',
          payload: { ref: `b-${i}`, ref_type: 'branch' },
        })),
      }),
    ];

    const count1Dist: Record<string, number> = {};
    for (const bundle of fixtures) {
      const v = evaluateCharges(bundle, FIXED_NOW);
      const first = v.charges[0]?.statute ?? 'ACQUITTED';
      count1Dist[first] = (count1Dist[first] ?? 0) + 1;
    }

    expect(Object.keys(count1Dist).length).toBeGreaterThanOrEqual(4);
  });

  it('does not fire abandoned_forks or ratio statutes below 5 items or without majority', () => {
    const smallSample = makeCleanBundle({
      handle: 'small-sample',
      repos: [
        // 4 owned non-forks (all unlicensed, 0 stars) -> below 5 inspected
        ...Array.from({ length: 4 }, (_, i) => ({
          name: `owned-${i}`,
          full_name: `small-sample/owned-${i}`,
          fork: false,
          stargazers_count: 0,
          license: null,
          created_at: '2024-01-01T00:00:00Z',
          pushed_at: '2025-01-01T00:00:00Z',
        })),
        // 4 untouched forks -> below 5 inspected
        ...Array.from({ length: 4 }, (_, i) => ({
          name: `fork-${i}`,
          full_name: `small-sample/fork-${i}`,
          fork: true,
          stargazers_count: 1,
          license: { spdx_id: 'MIT', name: 'MIT License' },
          created_at: '2024-01-01T00:00:00Z',
          pushed_at: '2024-01-01T00:00:00Z',
        })),
      ],
      events: Array.from({ length: 4 }, (_, i) => ({
        id: `se-${i}`,
        type: 'PushEvent',
        created_at: '2026-11-12T10:00:00Z',
        payload: { ref: 'refs/heads/main', ref_type: null },
      })),
      commits: {
        total_count: 4,
        items: Array.from({ length: 4 }, (_, i) => ({
          sha: `sc-${i}`,
          commit: {
            message: 'wip',
            author: { date: '2026-11-13T03:00:00+02:00' },
          },
        })),
      },
    });
    const smallReport = evaluateCharges(smallSample, FIXED_NOW);
    expect(smallReport.allCharges).toEqual([]);
    expect(smallReport.verdict).toBe('ACQUITTED');

    // 6 forks with exactly 3 untouched (50%, not strict majority) & 6 owned with 3 unlicensed (50%)
    const tieMajority = makeCleanBundle({
      handle: 'half-only',
      repos: [
        ...Array.from({ length: 6 }, (_, i) => ({
          name: `owned-${i}`,
          full_name: `half-only/owned-${i}`,
          fork: false,
          stargazers_count: i < 3 ? 0 : 10,
          license: i < 3 ? null : { spdx_id: 'MIT', name: 'MIT License' },
          created_at: '2024-01-01T00:00:00Z',
          pushed_at: '2025-01-01T00:00:00Z',
        })),
        ...Array.from({ length: 6 }, (_, i) => ({
          name: `fork-${i}`,
          full_name: `half-only/fork-${i}`,
          fork: true,
          stargazers_count: 1,
          license: { spdx_id: 'MIT', name: 'MIT License' },
          created_at: '2024-01-01T00:00:00Z',
          pushed_at: i < 3 ? '2024-01-01T00:00:00Z' : '2026-01-01T00:00:00Z',
        })),
      ],
    });
    const tieReport = evaluateCharges(tieMajority, FIXED_NOW);
    expect(tieReport.allCharges.some((c) => c.statute === 'abandoned_forks')).toBe(
      false,
    );
    expect(
      tieReport.allCharges.some((c) => c.statute === 'licenseless_anarchy'),
    ).toBe(false);
    expect(tieReport.allCharges.some((c) => c.statute === 'graveyard')).toBe(
      false,
    );

    // 6 forks with 4 untouched (>50%) and 6 owned with 4 unlicensed (>50%) DO fire
    const clearMajority = makeCleanBundle({
      handle: 'clear-majority',
      repos: [
        ...Array.from({ length: 6 }, (_, i) => ({
          name: `owned-${i}`,
          full_name: `clear-majority/owned-${i}`,
          fork: false,
          stargazers_count: 10,
          license: i < 4 ? null : { spdx_id: 'MIT', name: 'MIT License' },
          created_at: '2024-01-01T00:00:00Z',
          pushed_at: '2025-01-01T00:00:00Z',
        })),
        ...Array.from({ length: 6 }, (_, i) => ({
          name: `fork-${i}`,
          full_name: `clear-majority/fork-${i}`,
          fork: true,
          stargazers_count: 1,
          license: { spdx_id: 'MIT', name: 'MIT License' },
          created_at: '2024-01-01T00:00:00Z',
          pushed_at: i < 4 ? '2024-01-01T00:00:00Z' : '2026-01-01T00:00:00Z',
        })),
      ],
    });
    const majReport = evaluateCharges(clearMajority, FIXED_NOW);
    expect(majReport.allCharges.some((c) => c.statute === 'abandoned_forks')).toBe(
      true,
    );
    expect(
      majReport.allCharges.some((c) => c.statute === 'licenseless_anarchy'),
    ).toBe(true);
  });

  it('requires a complete record for ACQUITTED and uses INSUFFICIENT EVIDENCE when partialRecord is true', () => {
    const completeClean = evaluateCharges(makeCleanBundle(), FIXED_NOW);
    expect(completeClean.partialRecord).toBe(false);
    expect(completeClean.verdict).toBe('ACQUITTED');

    const cases: Array<[GitHubBundle['missing'], string]> = [
      [{ commits: 'empty' }, 'No public commits on file'],
      [{ commits: 403 }, 'Commit search index unavailable'],
      [{ events: 403 }, 'Public events log unavailable'],
      [{ repos: 500 }, 'Repository listing unavailable'],
    ];

    for (const [missing, expectedSnippet] of cases) {
      const report = evaluateCharges(
        makeCleanBundle({
          handle: 'clean-partial',
          commits: missing.commits === 403 ? null : makeCleanBundle().commits,
          missing,
        }),
        FIXED_NOW,
      );
      expect(report.partialRecord).toBe(true);
      expect(report.verdict).toBe('INSUFFICIENT EVIDENCE');
      expect(report.verdict).not.toBe('ACQUITTED');
      expect(report.charges).toEqual([]);
      expect(report.bail).toBe('$0');
      expect(report.sentence).toBeNull();
      expect(report.alibi?.title).toBe('INSUFFICIENT EVIDENCE');
      expect(report.alibi?.receipt).toContain(expectedSnippet);
      expect(VOICE_BANKS.insufficient_evidence).toContain(report.verdictSting);
    }
  });

  it('seals opted-out handles case-insensitively with neutral RECORD SEALED verdict', () => {
    expect(OPT_OUT_CONTACT.trim().length).toBeGreaterThan(0);
    expect(isOptedOut('sealed-suspect')).toBe(true);
    expect(isOptedOut('SEALED-SUSPECT')).toBe(true);
    expect(isOptedOut('  @Sealed-Suspect ')).toBe(true);
    expect(isOptedOut('torvalds')).toBe(false);

    const sealedReport = evaluateCharges(
      makeCleanBundle({
        handle: ' @Sealed-Suspect ',
        user: {
          ...makeCleanBundle().user!,
          login: 'Sealed-Suspect',
        },
        commits: {
          total_count: 20,
          items: Array.from({ length: 20 }, (_, i) => ({
            sha: `s-${i}`,
            commit: {
              message: 'wip',
              author: { date: '2026-11-13T03:00:00Z' },
            },
          })),
        },
      }),
      FIXED_NOW,
    );
    expect(sealedReport.verdict).toBe('RECORD SEALED');
    expect(sealedReport.charges).toEqual([]);
    expect(sealedReport.allCharges).toEqual([]);
    expect(sealedReport.bail).toBe('—');
    expect(sealedReport.intakeNotes).toBe('sealed by request');
    expect(sealedReport.partialRecord).toBe(false);
    expect(sealedReport.alibi?.title).toBe('RECORD SEALED');

    const emptySealed = makeSealedBundle('@Sealed-Suspect', FIXED_NOW);
    expect(emptySealed.sealed).toBe(true);
    expect(emptySealed.user).toBeNull();
    expect(emptySealed.repos).toEqual([]);
    expect(emptySealed.events).toEqual([]);
    expect(emptySealed.commits).toBeNull();
  });

  it('treats search incomplete_results as a soft flag and rewords commit receipts', () => {
    const incompleteBundle = makeCleanBundle({
      handle: 'incomplete-search-user',
      commits: {
        total_count: 50000,
        incomplete_results: true,
        items: Array.from({ length: 12 }, (_, i) => ({
          sha: `inc-${i}`,
          commit: {
            message: i < 6 ? 'wip' : `feat: solid commit ${i}`,
            author: {
              date:
                i < 6
                  ? '2026-11-13T18:30:00-05:00'
                  : '2026-11-13T03:15:00-05:00',
            },
          },
        })),
      },
    });

    const report = evaluateCharges(incompleteBundle, FIXED_NOW);
    expect(report.partialRecord).toBe(false);
    expect(report.searchIncomplete).toBe(true);
    const commitCharges = report.allCharges.filter((c) =>
      ['serial_laziness', 'unlawful_hours', 'friday_deployer'].includes(
        c.statute,
      ),
    );
    expect(commitCharges.length).toBeGreaterThanOrEqual(2);
    for (const c of commitCharges) {
      expect(c.receipt).toContain('of 12 recent public commits found');
      expect(c.receipt).not.toMatch(/of the last 12/);
    }
  });
});
