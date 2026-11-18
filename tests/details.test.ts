import { beforeEach, describe, expect, it } from 'vitest';
import {
  fetchDetail,
  handleDetailRequest,
  type DetailErrorBody,
  type DetailResponseBody,
} from '../api/detail';
import {
  CACHE_CONTROL_COMPLETE,
  CACHE_CONTROL_PARTIAL,
  clearBundleCache,
  fetchGitHubBundle,
  handleRequest as handleGhRequest,
  type FetchLike,
} from '../api/gh';
import { PRESETS, PRESET_HANDLES, type GitHubBundle } from '../api/presets';
import { evaluateCharges, isVagueCommitMessage } from '../src/engine/charges';
import {
  buildCalendar,
  buildDetailReport,
  buildLanguages,
  buildPunchCard,
  buildRadar,
  buildRepoShape,
  buildYears,
  detailInputFromBundle,
  flattenContributionWeeks,
  type DetailInput,
} from '../src/engine/details';
import { makeSealedBundle } from '../src/optout';

const FIXED_NOW = new Date('2026-11-16T12:00:00.000Z');

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeBaseInput(overrides: Partial<DetailInput> = {}): DetailInput {
  return {
    user: {
      login: 'sample-dev',
      type: 'User',
      created_at: '2021-11-16T12:00:00Z',
      followers: 42,
      public_repos: 6,
    },
    repos: Array.from({ length: 6 }, (_, i) => ({
      name: `repo-${i}`,
      fork: false,
      archived: false,
      stargazers_count: 10 + i,
      language: 'TypeScript',
      license: { spdx_id: 'MIT', name: 'MIT License' },
      created_at: '2024-01-10T00:00:00Z',
      pushed_at: '2026-11-10T10:00:00Z',
    })),
    commits: Array.from({ length: 6 }, (_, i) => ({
      commit: {
        message: `feat(core): add check ${i}`,
        author: { date: '2026-11-10T11:00:00+02:00' },
      },
    })),
    events: Array.from({ length: 6 }, () => ({
      type: 'PushEvent',
      created_at: '2026-11-10T11:00:00Z',
    })),
    searchIncomplete: false,
    calendarDays: [
      { date: '2026-11-09', count: 2 },
      { date: '2026-11-10', count: 5 },
    ],
    now: FIXED_NOW,
    ...overrides,
  };
}

beforeEach(() => {
  clearBundleCache();
});

describe('detailInputFromBundle & GitHubBundle assignability', () => {
  it('accepts real GitHubBundle presets directly without casts and omits unavailable fields cleanly', () => {
    for (const handle of PRESET_HANDLES) {
      const bundle: GitHubBundle = PRESETS[handle];
      const input = detailInputFromBundle(bundle, null, FIXED_NOW);
      expect(input).not.toBeNull();
      const report = buildDetailReport(input!, { isVague: isVagueCommitMessage });

      expect(report.handle).toBe(bundle.user!.login);
      expect(report.languages).toEqual([]);
      expect(report.repoShape.archived).toBeNull();
      expect(report.sample.notes).toContain('Language data unavailable.');
      expect(report.sample.notes).toContain('Contribution calendar unavailable.');
    }
  });

  it('returns null for sealed handles and failed /users lookups', () => {
    expect(detailInputFromBundle(makeSealedBundle('sealed-suspect'))).toBeNull();
    expect(
      detailInputFromBundle({ ...PRESETS.torvalds, sealed: true }),
    ).toBeNull();
    expect(
      detailInputFromBundle({ ...PRESETS.torvalds, handle: ' @Sealed-Suspect ' }),
    ).toBeNull();
    expect(
      detailInputFromBundle({ ...PRESETS.torvalds, user: null }),
    ).toBeNull();
  });
});

describe('details.ts core invariants', () => {
  it('computes weekday and hour in author local time regardless of host TZ', () => {
    const input = makeBaseInput({
      commits: [
        // Friday 17:30-07:00 -> Saturday 00:30 UTC -> must count as Friday (5) hour 17
        {
          commit: {
            message: 'feat: friday evening pdt',
            author: { date: '2026-11-13T17:30:00.000-07:00' },
          },
        },
        // Saturday 02:00+05:30 -> Friday 20:30 UTC -> must count as Saturday (6) hour 2 (night + weekend)
        {
          commit: {
            message: 'feat: saturday early ist',
            author: { date: '2026-11-14T02:00:00+05:30' },
          },
        },
        // Monday 03:14+05:30 -> Sunday 21:44 UTC -> must count as Monday (1) hour 3 (night)
        {
          commit: {
            message: 'feat: monday early ist',
            author: { date: '2026-11-16T03:14:00+05:30' },
          },
        },
      ],
    });

    const report = buildDetailReport(input, { isVague: isVagueCommitMessage });
    expect(report.punchCard).not.toBeNull();
    const pc = report.punchCard!;
    expect(pc.sample).toBe(3);
    expect(pc.timeBasis).toBe('local');
    expect(pc.grid[5]?.[17]).toBe(1);
    expect(pc.grid[6]?.[2]).toBe(1);
    expect(pc.grid[1]?.[3]).toBe(1);
    expect(pc.nightShare).toBeCloseTo(2 / 3);
    expect(pc.weekendShare).toBeCloseTo(1 / 3);
    expect(pc.fridayEveningShare).toBeCloseTo(1 / 3);

    const fridayAxis = report.radar.find((a) => a.id === 'friday');
    const nightAxis = report.radar.find((a) => a.id === 'night');
    expect(fridayAxis?.numerator).toBe(1);
    expect(nightAxis?.numerator).toBe(2);
  });

  it('drops spoofed future commits beyond now + 1 day', () => {
    const input = makeBaseInput({
      commits: [
        {
          commit: {
            message: 'wip',
            author: { date: '2060-01-01T02:00:00+01:00' },
          },
        },
        {
          commit: {
            message: 'wip',
            author: { date: '2026-11-18T02:00:00Z' }, // 2 days after FIXED_NOW -> dropped
          },
        },
        {
          commit: {
            message: 'feat(core): real commit within skew window',
            author: { date: '2026-11-17T10:00:00Z' }, // within +24h -> kept
          },
        },
        {
          commit: {
            message: 'feat(core): normal past commit',
            author: { date: '2026-11-10T10:00:00+02:00' },
          },
        },
      ],
    });

    const report = buildDetailReport(input, { isVague: isVagueCommitMessage });
    expect(report.sample.commits).toBe(2);
    expect(report.punchCard?.sample).toBe(2);
    expect(report.punchCard?.nightShare).toBe(0);
    const vague = report.radar.find((a) => a.id === 'vague');
    expect(vague?.numerator).toBe(0);
    expect(vague?.denominator).toBe(2);
  });

  it('marks radar reliable=false below 5 items and reliable=true at >= 5, reusing isVagueCommitMessage', () => {
    const below5 = buildDetailReport(
      makeBaseInput({
        repos: Array.from({ length: 4 }, (_, i) => ({
          name: `owned-${i}`,
          fork: i === 3, // 3 owned, 1 fork
          stargazers_count: 0,
          language: 'TypeScript',
          license: null,
          created_at: '2024-01-01T00:00:00Z',
          pushed_at: '2024-01-01T00:00:00Z',
        })),
        commits: Array.from({ length: 4 }, () => ({
          commit: {
            message: 'wip',
            author: { date: '2026-11-13T17:00:00+02:00' },
          },
        })),
        events: Array.from({ length: 4 }, () => ({
          type: 'DeleteEvent',
          created_at: '2026-11-13T17:00:00Z',
        })),
      }),
      { isVague: isVagueCommitMessage },
    );

    for (const axis of below5.radar) {
      expect(axis.reliable, axis.id).toBe(false);
    }

    const at5 = buildDetailReport(
      makeBaseInput({
        repos: [
          ...Array.from({ length: 5 }, (_, i) => ({
            name: `owned-${i}`,
            fork: false,
            stargazers_count: 0,
            language: 'TypeScript',
            license: null,
            created_at: '2024-01-01T00:00:00Z',
            pushed_at: '2026-01-01T00:00:00Z',
          })),
          ...Array.from({ length: 5 }, (_, i) => ({
            name: `fork-${i}`,
            fork: true,
            stargazers_count: 0,
            language: 'TypeScript',
            license: null,
            created_at: '2024-01-01T00:00:00Z',
            pushed_at: '2024-01-01T00:00:00Z',
          })),
        ],
        commits: [
          { commit: { message: 'wip', author: { date: '2026-11-13T03:00:00+02:00' } } },
          { commit: { message: 'fix: tmp', author: { date: '2026-11-13T03:00:00+02:00' } } },
          { commit: { message: 'fix(parser): handle empty token', author: { date: '2026-11-13T17:00:00+02:00' } } },
          { commit: { message: 'v1.2.3', author: { date: '2026-11-13T17:00:00+02:00' } } },
          { commit: { message: '...', author: { date: '2026-11-13T17:00:00+02:00' } } },
        ],
        events: Array.from({ length: 5 }, () => ({
          type: 'DeleteEvent',
          created_at: '2026-11-13T17:00:00Z',
        })),
      }),
      { isVague: isVagueCommitMessage },
    );

    for (const axis of at5.radar) {
      expect(axis.reliable, axis.id).toBe(true);
    }
    const vagueAxis = at5.radar.find((a) => a.id === 'vague');
    expect(vagueAxis?.numerator).toBe(3); // 'wip', 'fix: tmp', '...'
    expect(vagueAxis?.denominator).toBe(5);
  });

  it('handles null and empty commits gracefully', () => {
    const nullReport = buildDetailReport(
      makeBaseInput({ commits: null }),
      { isVague: isVagueCommitMessage },
    );
    expect(nullReport.punchCard).toBeNull();
    expect(nullReport.sample.commits).toBe(0);
    expect(nullReport.sample.notes).toContain(
      'No commit sample available; commit-based exhibits are omitted.',
    );
    for (const id of ['vague', 'night', 'friday']) {
      const axis = nullReport.radar.find((a) => a.id === id);
      expect(axis?.numerator).toBe(0);
      expect(axis?.denominator).toBe(0);
      expect(axis?.reliable).toBe(false);
    }

    const emptyReport = buildDetailReport(
      makeBaseInput({ commits: [] }),
      { isVague: isVagueCommitMessage },
    );
    expect(emptyReport.punchCard).toBeNull();
    expect(emptyReport.sample.commits).toBe(0);
    for (const id of ['vague', 'night', 'friday']) {
      const axis = emptyReport.radar.find((a) => a.id === id);
      expect(axis?.numerator).toBe(0);
      expect(axis?.denominator).toBe(0);
      expect(axis?.reliable).toBe(false);
    }
  });
});

describe('one fixture per exhibit', () => {
  it('Calendar exhibit: flattens GraphQL weeks and computes streaks, gaps, quartiles, and Sunday-first columns', () => {
    // 2026-11-04 is Wednesday (day 3 -> 3 leading nulls)
    const days = flattenContributionWeeks([
      {
        contributionDays: [
          { date: '2026-11-04', contributionCount: 1 },
          { date: '2026-11-05', contributionCount: 4 },
          { date: '2026-11-06', contributionCount: 8 },
          { date: '2026-11-07', contributionCount: 0 },
        ],
      },
      {
        contributionDays: [
          { date: '2026-11-08', contributionCount: 0 },
          { date: '2026-11-09', contributionCount: 0 },
          { date: '2026-11-10', contributionCount: 2 },
          { date: '2026-11-11', contributionCount: 12 },
        ],
      },
    ]);

    const cal = buildCalendar(days);
    expect(cal).not.toBeNull();
    expect(cal!.total).toBe(27);
    expect(cal!.activeDays).toBe(5);
    expect(cal!.longestStreak).toBe(3);
    expect(cal!.longestGap).toBe(3);
    expect(cal!.busiest).toEqual({ date: '2026-11-11', count: 12 });
    // First week: 3 nulls (Sun, Mon, Tue) + Wed, Thu, Fri, Sat = 7 cells
    expect(cal!.weeks).toHaveLength(2);
    expect(cal!.weeks[0]?.slice(0, 3)).toEqual([null, null, null]);
    expect(cal!.weeks[0]?.[3]?.level).toBeGreaterThanOrEqual(1);
    expect(cal!.weeks[1]?.[0]?.level).toBe(0);
    expect(cal!.weeks[1]?.[3]?.level).toBe(4);
    expect(buildCalendar([])).toBeNull();
    expect(buildCalendar(null)).toBeNull();
  });

  it('PunchCard exhibit: computes peakHour, shares, and utc/mixed/local timeBasis notes', () => {
    const utcReport = buildDetailReport(
      makeBaseInput({
        commits: [
          { commit: { message: 'feat: a', author: { date: '2026-11-10T14:00:00Z' } } },
          { commit: { message: 'feat: b', author: { date: '2026-11-11T14:30:00Z' } } },
          { commit: { message: 'feat: c', author: { date: '2026-11-13T18:00:00Z' } } },
        ],
      }),
      { isVague: isVagueCommitMessage },
    );
    expect(utcReport.punchCard?.timeBasis).toBe('utc');
    expect(utcReport.punchCard?.peakHour).toBe(14);
    expect(utcReport.sample.notes).toContain(
      "Commit times are UTC, not the author's local time.",
    );
    expect(utcReport.sample.notes).toContain(
      'Small commit sample (3); treat shapes as rough.',
    );

    const mixedReport = buildDetailReport(
      makeBaseInput({
        commits: [
          { commit: { message: 'feat: a', author: { date: '2026-11-10T14:00:00Z' } } },
          { commit: { message: 'feat: b', author: { date: '2026-11-10T14:00:00+02:00' } } },
        ],
      }),
      { isVague: isVagueCommitMessage },
    );
    expect(mixedReport.punchCard?.timeBasis).toBe('mixed');
    expect(mixedReport.sample.notes).toContain(
      'Some commit times are UTC, not local.',
    );
    expect(buildPunchCard([])).toBeNull();
  });

  it('Languages exhibit: counts owned non-forks, labels null as Unlabelled, aggregates >6 into Other, and handles missing field', () => {
    const langs = buildLanguages([
      ...['TS', 'TS', 'TS', 'Py', 'Py', 'Go', 'Rust', 'C', 'Ruby', null].map(
        (language, idx) => ({
          name: `owned-${idx}`,
          fork: false,
          stargazers_count: 1,
          language,
          license: null,
          created_at: '2024-01-01T00:00:00Z',
          pushed_at: '2026-01-01T00:00:00Z',
        }),
      ),
      {
        name: 'fork-ignored',
        fork: true,
        stargazers_count: 100,
        language: 'Java',
        license: null,
        created_at: '2024-01-01T00:00:00Z',
        pushed_at: '2026-01-01T00:00:00Z',
      },
    ]);

    expect(langs).toHaveLength(7); // top 6 + Other
    expect(langs[0]).toEqual({ language: 'TS', repos: 3, share: 0.3 });
    expect(langs[1]).toEqual({ language: 'Py', repos: 2, share: 0.2 });
    expect(langs[6]).toEqual({ language: 'Other', repos: 1, share: 0.1 });
    expect(langs.some((l) => l.language === 'Java')).toBe(false);

    // Missing language field -> unavailable ([])
    expect(
      buildLanguages([
        {
          name: 'no-lang-field',
          fork: false,
          stargazers_count: 1,
          license: null,
          created_at: '2024-01-01T00:00:00Z',
          pushed_at: '2026-01-01T00:00:00Z',
        },
      ]),
    ).toEqual([]);
  });

  it('RepoShape exhibit: counts owned/forks/archived/stars/licenses/topStarred and handles truncation + missing archived', () => {
    const shape = buildRepoShape(
      {
        login: 'shaper',
        type: 'User',
        created_at: '2020-01-01T00:00:00Z',
        followers: 77,
        public_repos: 45,
      },
      [
        {
          name: 'zeta',
          fork: false,
          archived: true,
          stargazers_count: 50,
          license: { spdx_id: 'MIT' },
          created_at: '2024-01-01T00:00:00Z',
          pushed_at: '2026-01-01T00:00:00Z',
        },
        {
          name: 'alpha',
          fork: false,
          archived: false,
          stargazers_count: 50,
          license: null,
          created_at: '2024-01-01T00:00:00Z',
          pushed_at: '2026-01-01T00:00:00Z',
        },
        {
          name: 'zero',
          fork: false,
          archived: false,
          stargazers_count: 0,
          license: null,
          created_at: '2024-01-01T00:00:00Z',
          pushed_at: '2026-01-01T00:00:00Z',
        },
        {
          name: 'forked',
          fork: true,
          archived: true,
          stargazers_count: 999,
          license: null,
          created_at: '2024-01-01T00:00:00Z',
          pushed_at: '2024-01-01T00:00:00Z',
        },
      ],
    );

    expect(shape.inspected).toBe(4);
    expect(shape.truncated).toBe(true);
    expect(shape.ownedOriginal).toBe(3);
    expect(shape.forks).toBe(1);
    expect(shape.archived).toBe(2);
    expect(shape.zeroStar).toBe(1);
    expect(shape.noLicense).toBe(2);
    expect(shape.totalStars).toBe(100); // owned only
    expect(shape.followers).toBe(77);
    expect(shape.topStarred).toEqual([
      { name: 'alpha', stars: 50 },
      { name: 'zeta', stars: 50 },
      { name: 'zero', stars: 0 },
    ]);

    const withoutArchived = buildRepoShape(
      {
        login: 'preset',
        type: 'User',
        created_at: '2020-01-01T00:00:00Z',
        followers: 1,
        public_repos: 1,
      },
      [
        {
          name: 'only',
          fork: false,
          stargazers_count: 1,
          license: null,
          created_at: '2024-01-01T00:00:00Z',
          pushed_at: '2026-01-01T00:00:00Z',
        },
      ],
    );
    expect(withoutArchived.archived).toBeNull();
    expect(withoutArchived.truncated).toBe(false);
  });

  it('Years exhibit: tracks account age, owned creations per year, dormant repos, and daysSinceLastPush', () => {
    const years = buildYears(
      {
        login: 'veteran',
        type: 'User',
        created_at: '2016-11-16T12:00:00Z',
        followers: 10,
        public_repos: 4,
      },
      [
        {
          name: 'ancient',
          fork: false,
          stargazers_count: 0,
          license: null,
          created_at: '2020-05-01T00:00:00Z',
          pushed_at: '2022-01-01T00:00:00Z', // dormant (>2 yrs)
        },
        {
          name: 'never-pushed',
          fork: false,
          stargazers_count: 0,
          license: null,
          created_at: '2020-06-01T00:00:00Z',
          pushed_at: null, // dormant
        },
        {
          name: 'active',
          fork: false,
          stargazers_count: 5,
          license: null,
          created_at: '2025-01-01T00:00:00Z',
          pushed_at: '2026-11-11T12:00:00Z', // 5 days ago
        },
        {
          name: 'fork-ignored-in-year-counts',
          fork: true,
          stargazers_count: 0,
          license: null,
          created_at: '2021-01-01T00:00:00Z',
          pushed_at: '2021-01-01T00:00:00Z',
        },
      ],
      FIXED_NOW,
    );

    expect(years.accountAgeYears).toBeCloseTo(10, 1);
    expect(years.reposCreatedByYear).toEqual({ '2020': 2, '2025': 1 });
    expect(years.dormantRepos).toBe(2);
    expect(years.daysSinceLastPush).toBe(5);
  });

  it('Radar exhibit: emits all 7 raw-share axes and adjusts commit basis on searchIncomplete', () => {
    const input = makeBaseInput({
      searchIncomplete: true,
      repos: [
        ...Array.from({ length: 5 }, (_, i) => ({
          name: `o-${i}`,
          fork: false,
          stargazers_count: i < 2 ? 0 : 10,
          license: i < 3 ? null : { spdx_id: 'MIT' },
          created_at: '2024-01-01T00:00:00Z',
          pushed_at: '2026-01-01T00:00:00Z',
        })),
        ...Array.from({ length: 5 }, (_, i) => ({
          name: `f-${i}`,
          fork: true,
          stargazers_count: 0,
          license: null,
          created_at: '2024-01-01T00:00:00Z',
          pushed_at: i < 4 ? '2024-01-01T00:00:00Z' : '2025-01-01T00:00:00Z',
        })),
      ],
      commits: Array.from({ length: 5 }, (_, i) => ({
        commit: {
          message: i === 0 ? 'wip' : `feat: clean ${i}`,
          author: {
            date:
              i < 2
                ? '2026-11-13T17:00:00+02:00'
                : '2026-11-14T02:00:00+02:00',
          },
        },
      })),
      events: Array.from({ length: 5 }, (_, i) => ({
        type: i < 2 ? 'DeleteEvent' : 'PushEvent',
        created_at: '2026-11-10T10:00:00Z',
      })),
    });

    const radar = buildRadar(
      input,
      Array.from({ length: 5 }, (_, i) => ({
        weekday: i < 2 ? 5 : 6,
        hour: i < 2 ? 17 : 2,
        hasOffset: true,
        message: i === 0 ? 'wip' : `feat: clean ${i}`,
      })),
      { isVague: isVagueCommitMessage },
    );

    expect(radar.map((a) => a.id)).toEqual([
      'vague',
      'night',
      'friday',
      'graveyard',
      'licenseless',
      'forks',
      'deletes',
    ]);
    expect(radar[0]).toMatchObject({
      value: 0.2,
      numerator: 1,
      denominator: 5,
      reliable: true,
      basis: 'recent public commits found',
    });
    expect(radar[1]?.value).toBeCloseTo(0.6);
    expect(radar[2]?.value).toBeCloseTo(0.4);
    expect(radar[3]?.value).toBeCloseTo(0.4);
    expect(radar[4]?.value).toBeCloseTo(0.6);
    expect(radar[5]?.value).toBeCloseTo(0.8);
    expect(radar[6]?.value).toBeCloseTo(0.4);
  });
});

describe('api/gh language & archived preservation and api/detail endpoint', () => {
  const sampleUser = {
    login: 'alice',
    id: 101,
    avatar_url: 'https://avatars.githubusercontent.com/u/101?v=4',
    name: 'Alice',
    type: 'User',
    public_repos: 6,
    followers: 25,
    created_at: '2020-01-01T00:00:00Z',
  };

  const sampleRepos = Array.from({ length: 6 }, (_, i) => ({
    name: `proj-${i}`,
    full_name: `alice/proj-${i}`,
    fork: false,
    archived: i === 0,
    stargazers_count: i === 0 ? 0 : 12 + i,
    language: i === 5 ? null : i % 2 === 0 ? 'TypeScript' : 'Rust',
    license: { spdx_id: 'MIT', name: 'MIT License' },
    created_at: '2024-01-01T00:00:00Z',
    pushed_at: '2026-11-10T10:00:00Z',
  }));

  const sampleEvents = Array.from({ length: 6 }, () => ({
    id: '1',
    type: 'PushEvent',
    created_at: '2026-11-10T10:00:00Z',
    repo: { name: 'alice/proj-1' },
    payload: { ref: 'refs/heads/feat/x', ref_type: null },
  }));

  const sampleCommits = {
    total_count: 6,
    incomplete_results: false,
    items: Array.from({ length: 6 }, (_, i) => ({
      sha: `sha-${i}`,
      commit: {
        message: i < 2 ? 'wip' : `feat(api): add route ${i}`,
        author: { date: '2026-11-13T18:00:00+02:00' },
      },
      repository: { full_name: 'alice/proj-1' },
    })),
  };

  it('api/gh.ts preserves language and archived from GitHub /repos response', async () => {
    const ghFetch: FetchLike = async (input) => {
      const url = String(input);
      if (url.endsWith('/users/alice')) return jsonResponse(sampleUser);
      if (url.includes('/repos?')) return jsonResponse(sampleRepos);
      if (url.includes('/events/public?')) return jsonResponse(sampleEvents);
      return jsonResponse(sampleCommits);
    };

    const res = await fetchGitHubBundle('alice', {
      fetchImpl: ghFetch,
      token: 'ghp_test',
      now: FIXED_NOW,
    });
    expect(res.status).toBe(200);
    expect(res.body.repos[0]?.archived).toBe(true);
    expect(res.body.repos[0]?.language).toBe('TypeScript');
    expect(res.body.repos[5]?.archived).toBe(false);
    expect(res.body.repos[5]?.language).toBeNull();
  });

  it('rejects invalid handles with 400 and fails in production when GITHUB_TOKEN is missing', async () => {
    const badRes = await handleDetailRequest(
      new Request('https://subpoena.test/api/detail?u=bad%20handle!'),
    );
    expect(badRes.status).toBe(400);
    expect(badRes.headers.get('Cache-Control')).toBe('no-store');

    const prevEnv = process.env.VERCEL_ENV;
    const prevTok = process.env.GITHUB_TOKEN;
    try {
      process.env.VERCEL_ENV = 'production';
      delete process.env.GITHUB_TOKEN;
      const prodRes = await handleDetailRequest(
        new Request('https://subpoena.test/api/detail?u=alice'),
      );
      expect(prodRes.status).toBe(500);
      expect(prodRes.headers.get('Cache-Control')).toBe('no-store');
    } finally {
      if (prevEnv === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = prevEnv;
      if (prevTok === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = prevTok;
    }
  });

  it('returns 404 RECORD SEALED for opted-out handles without calling fetch', async () => {
    const spyFetch: FetchLike = async () => {
      throw new Error('fetch should not be called for opted-out handles');
    };

    for (const raw of ['sealed-suspect', '@Sealed-Suspect']) {
      const res = await handleDetailRequest(
        new Request(
          `https://subpoena.test/api/detail?u=${encodeURIComponent(raw)}`,
        ),
        { fetchImpl: spyFetch, token: 'ghp_test' },
      );
      expect(res.status).toBe(404);
      expect(res.headers.get('Cache-Control')).toBe(CACHE_CONTROL_COMPLETE);
      const body = (await res.json()) as DetailErrorBody;
      expect(body.error).toBe('RECORD SEALED');
      expect(body.verdict).toBe('RECORD SEALED');
      expect(body.sealed).toBe(true);
    }
  });

  it('reuses cached bundle from api/gh.ts, fetches GraphQL contributionCalendar, labels contributions, and preserves verdict menace & bail', async () => {
    const ghCalls: string[] = [];
    const ghFetch: FetchLike = async (input) => {
      const url = String(input);
      ghCalls.push(url);
      if (url.endsWith('/users/alice')) return jsonResponse(sampleUser);
      if (url.includes('/repos?')) return jsonResponse(sampleRepos);
      if (url.includes('/events/public?')) return jsonResponse(sampleEvents);
      return jsonResponse(sampleCommits);
    };

    const ghRes = await handleGhRequest(
      new Request('https://subpoena.test/api/gh?u=alice'),
      { fetchImpl: ghFetch, token: 'ghp_test', now: FIXED_NOW },
    );
    expect(ghRes.status).toBe(200);
    const ghBundle = (await ghRes.json()) as GitHubBundle;
    expect(ghCalls).toHaveLength(4);

    const detailCalls: string[] = [];
    let authHeader: string | null = null;
    const detailFetch: FetchLike = async (input, init) => {
      const url = String(input);
      detailCalls.push(url);
      authHeader = new Headers(init?.headers).get('Authorization');
      if (url === 'https://api.github.com/graphql') {
        return jsonResponse({
          data: {
            user: {
              contributionsCollection: {
                contributionCalendar: {
                  weeks: [
                    {
                      contributionDays: [
                        { date: '2026-11-10', contributionCount: 3 },
                        { date: '2026-11-11', contributionCount: 7 },
                      ],
                    },
                  ],
                },
              },
            },
          },
        });
      }
      throw new Error(`Unexpected REST call when bundle cached: ${url}`);
    };

    const detailRes = await handleDetailRequest(
      new Request('https://subpoena.test/api/detail?u=alice'),
      { fetchImpl: detailFetch, token: 'ghp_prod_token', now: FIXED_NOW },
    );

    expect(detailRes.status).toBe(200);
    expect(detailRes.headers.get('Cache-Control')).toBe(CACHE_CONTROL_COMPLETE);
    expect(detailCalls).toEqual(['https://api.github.com/graphql']);
    expect(authHeader).toBe('Bearer ghp_prod_token');

    const body = (await detailRes.json()) as DetailResponseBody;
    expect(body.calendarUnit).toBe('contributions');
    expect(JSON.stringify(body.calendar)).not.toContain('commits');
    expect(body.calendar?.total).toBe(10);
    expect(body.calendar?.activeDays).toBe(2);
    expect(body.languages.length).toBeGreaterThan(0);
    expect(body.repoShape.archived).toBe(1);
    expect(body.sample.commits).toBe(6);

    const expectedVerdict = evaluateCharges(ghBundle, FIXED_NOW);
    expect(body.verdict).toEqual(expectedVerdict);
    expect(body.menaceScore).toBe(expectedVerdict.menaceScore);
    expect(body.bail).toBe(expectedVerdict.bail);
    expect(body.bailAmount).toBe(expectedVerdict.bailAmount);

    // No competence, legitimacy, or authenticity score fields anywhere
    const rawKeys = JSON.stringify(body).toLowerCase();
    expect(rawKeys).not.toContain('competence');
    expect(rawKeys).not.toContain('legitimacy');
    expect(rawKeys).not.toContain('authenticity');
  });

  it('sets calendar to null and emits 60s partial Cache-Control when GraphQL fails', async () => {
    const makeFetchWithGraphqlFailure = (
      graphqlImpl: () => Promise<Response>,
    ): FetchLike => {
      return async (input) => {
        const url = String(input);
        if (url === 'https://api.github.com/graphql') return graphqlImpl();
        if (url.endsWith('/users/bob')) {
          return jsonResponse({ ...sampleUser, login: 'bob' });
        }
        if (url.includes('/repos?')) return jsonResponse(sampleRepos);
        if (url.includes('/events/public?')) return jsonResponse(sampleEvents);
        return jsonResponse(sampleCommits);
      };
    };

    // Case 1: GraphQL HTTP 500
    const res500 = await handleDetailRequest(
      new Request('https://subpoena.test/api/detail?u=bob'),
      {
        fetchImpl: makeFetchWithGraphqlFailure(() =>
          Promise.resolve(jsonResponse({ message: 'GraphQL error' }, 500)),
        ),
        token: 'ghp_test',
        now: FIXED_NOW,
      },
    );
    expect(res500.status).toBe(200);
    expect(res500.headers.get('Cache-Control')).toBe(CACHE_CONTROL_PARTIAL);
    const body500 = (await res500.json()) as DetailResponseBody;
    expect(body500.calendar).toBeNull();
    expect(body500.sample.notes).toContain('Contribution calendar unavailable.');

    // Case 2: GraphQL network throw
    clearBundleCache();
    const resErr = await fetchDetail('bob', {
      fetchImpl: makeFetchWithGraphqlFailure(() =>
        Promise.reject(new Error('network down')),
      ),
      token: 'ghp_test',
      now: FIXED_NOW,
    });
    expect(resErr.status).toBe(200);
    expect(resErr.headers['Cache-Control']).toBe(CACHE_CONTROL_PARTIAL);
    expect((resErr.body as DetailResponseBody).calendar).toBeNull();

    // Case 3: GraphQL 200 with errors payload
    clearBundleCache();
    const resGqlErrors = await fetchDetail('bob', {
      fetchImpl: makeFetchWithGraphqlFailure(() =>
        Promise.resolve(jsonResponse({ errors: [{ message: 'Bad credentials' }] }, 200)),
      ),
      token: 'ghp_test',
      now: FIXED_NOW,
    });
    expect(resGqlErrors.status).toBe(200);
    expect(resGqlErrors.headers['Cache-Control']).toBe(CACHE_CONTROL_PARTIAL);
    expect((resGqlErrors.body as DetailResponseBody).calendar).toBeNull();
  });

  it('mirrors api/gh.ts upstream 404, non-preset 403, and preset rate-limit fallback rules', async () => {
    const mock404: FetchLike = async () => jsonResponse({ message: 'Not Found' }, 404);
    const res404 = await handleDetailRequest(
      new Request('https://subpoena.test/api/detail?u=missing-user-xyz'),
      { fetchImpl: mock404, token: 'ghp_test' },
    );
    expect(res404.status).toBe(404);
    expect(res404.headers.get('Cache-Control')).toBe(CACHE_CONTROL_PARTIAL);

    const mock403: FetchLike = async () => jsonResponse({ message: 'rate limit' }, 403);
    const res403 = await handleDetailRequest(
      new Request('https://subpoena.test/api/detail?u=unknown-rate-limited'),
      { fetchImpl: mock403, token: 'ghp_test' },
    );
    expect(res403.status).toBe(403);
    expect(res403.headers.get('Cache-Control')).toBe(CACHE_CONTROL_PARTIAL);

    const presetFallback = await handleDetailRequest(
      new Request('https://subpoena.test/api/detail?u=torvalds'),
      { fetchImpl: mock403, token: 'ghp_test', now: FIXED_NOW },
    );
    expect(presetFallback.status).toBe(200);
    expect(presetFallback.headers.get('Cache-Control')).toBe(CACHE_CONTROL_PARTIAL);
    const presetBody = (await presetFallback.json()) as DetailResponseBody;
    expect(presetBody.handle).toBe('torvalds');
    expect(presetBody.languages).toEqual([]);
    expect(presetBody.repoShape.archived).toBeNull();
    expect(presetBody.calendar).toBeNull();
    expect(presetBody.sample.notes).toContain('Language data unavailable.');
    expect(presetBody.sample.notes).toContain('Contribution calendar unavailable.');
  });
});
