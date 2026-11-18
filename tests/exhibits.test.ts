import fs from 'node:fs';
import path from 'node:path';
import { GlobalFonts, createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { evaluateCharges } from '../src/engine/charges.js';
import {
  buildDetailReport,
  detailInputFromBundle,
  type CalendarDay,
  type DetailInput,
} from '../src/engine/details.js';
import { createRng, hashHandle } from '../src/engine/hash.js';
import type { CanvasContext2DLike } from '../src/canvas/paper.js';
import { PRESETS } from '../api/presets.js';
import { renderExhibit } from '../src/exhibits/draw-exhibits.js';
import {
  EXHIBIT_IDS,
  isDocketPartial,
  isExhibitWithheld,
  type ExhibitDossier,
} from '../src/exhibits/frame.js';

const fontsDir = path.resolve(process.cwd(), 'public/fonts');
if (fs.existsSync(path.join(fontsDir, 'CourierPrime-Regular.ttf'))) {
  GlobalFonts.registerFromPath(
    path.join(fontsDir, 'CourierPrime-Regular.ttf'),
    'Courier Prime',
  );
  GlobalFonts.registerFromPath(
    path.join(fontsDir, 'CourierPrime-Bold.ttf'),
    'Courier Prime',
  );
  GlobalFonts.registerFromPath(
    path.join(fontsDir, 'ReenieBeanie-Regular.ttf'),
    'Reenie Beanie',
  );
}

function makeSyntheticCalendar(seedKey: string): CalendarDay[] {
  const rng = createRng(hashHandle(seedKey, 'syn-cal'));
  const days: CalendarDay[] = [];
  const end = Date.UTC(2026, 10, 15);
  const start = end - 370 * 86_400_000;
  for (let t = start; t <= end; t += 86_400_000) {
    const d = new Date(t);
    const iso = d.toISOString().slice(0, 10);
    const r = rng();
    const count = r < 0.25 ? 0 : r < 0.65 ? Math.ceil(rng() * 4) : Math.ceil(rng() * 14);
    days.push({ date: iso, count });
  }
  return days;
}

function makeRichDossier(): ExhibitDossier {
  const now = new Date('2026-11-16T12:00:00Z');
  const input: DetailInput = {
    user: {
      login: 'heavy-tester',
      type: 'User',
      created_at: '2016-03-10T00:00:00Z',
      followers: 4200,
      public_repos: 3,
    },
    repos: [
      {
        name: 'kernel-core',
        fork: false,
        archived: false,
        stargazers_count: 2400,
        language: 'C',
        license: { spdx_id: 'GPL-2.0' },
        created_at: '2019-04-01T00:00:00Z',
        pushed_at: '2026-11-14T10:00:00Z',
      },
      {
        name: 'rust-tools',
        fork: false,
        archived: true,
        stargazers_count: 680,
        language: 'Rust',
        license: { spdx_id: 'MIT' },
        created_at: '2022-07-12T00:00:00Z',
        pushed_at: '2023-02-01T00:00:00Z',
      },
      {
        name: 'ts-scripts',
        fork: false,
        archived: false,
        stargazers_count: 140,
        language: 'TypeScript',
        license: null,
        created_at: '2024-09-20T00:00:00Z',
        pushed_at: '2026-11-01T00:00:00Z',
      },
    ],
    commits: Array.from({ length: 12 }, (_, idx) => ({
      commit: {
        message: idx % 3 === 0 ? 'wip' : `implement module ${idx}`,
        author: {
          date:
            idx % 4 === 0
              ? `2026-11-13T17:15:00+02:00`
              : `2026-11-12T02:10:00-05:00`,
        },
      },
    })),
    events: [
      { type: 'PushEvent', created_at: '2026-11-14T10:00:00Z' },
      { type: 'DeleteEvent', created_at: '2026-11-13T11:00:00Z' },
    ],
    searchIncomplete: false,
    calendarDays: makeSyntheticCalendar('heavy-tester'),
    now,
  };
  const report = buildDetailReport(input);
  return {
    ...report,
    calendarUnit: 'contributions',
  };
}

describe('Phase 3B Exhibits A-F', () => {
  it('renders all 6 exhibits cleanly on a complete dossier with valid 1200x675 output', () => {
    const dossier = makeRichDossier();
    expect(isDocketPartial(dossier)).toBe(false);

    for (const id of EXHIBIT_IDS) {
      const canvas = createCanvas(1200, 675);
      const ctx = canvas.getContext('2d') as unknown as CanvasContext2DLike;
      const res = renderExhibit(ctx, id, dossier, {
        now: new Date('2026-11-16T12:00:00Z'),
      });
      expect(res.id).toBe(id);
      expect(res.withheld).toBe(false);
      expect(res.partial).toBe(false);
      const buf = canvas.toBuffer('image/png');
      expect(buf.byteLength).toBeGreaterThan(20_000);
    }
  });

  it('handles presets lacking language and archived data without crashing', () => {
    const presetBundle = PRESETS.torvalds;
    const now = new Date('2026-11-16T12:00:00Z');
    const detailIn = detailInputFromBundle(presetBundle, null, now);
    expect(detailIn).not.toBeNull();
    const report = buildDetailReport(detailIn!);
    const verdict = evaluateCharges(presetBundle, now);
    const dossier: ExhibitDossier = {
      ...report,
      verdict,
      missing: { calendar: 503 },
    };

    expect(dossier.languages.length).toBe(0);
    expect(dossier.repoShape.archived).toBeNull();
    expect(isDocketPartial(dossier)).toBe(true);

    const results = EXHIBIT_IDS.map((id) => {
      const canvas = createCanvas(1200, 675);
      const ctx = canvas.getContext('2d') as unknown as CanvasContext2DLike;
      return renderExhibit(ctx, id, dossier, { now });
    });

    expect(results[0]!.withheld).toBe(true); // Exhibit A withheld without calendar
    expect(results[1]!.withheld).toBe(false); // Exhibit B has commits
    expect(results[2]!.withheld).toBe(false); // Exhibit C radar
    expect(results[3]!.withheld).toBe(false); // Exhibit D time served
    expect(results[4]!.withheld).toBe(true); // Exhibit E withheld without languages
    expect(results[5]!.withheld).toBe(false); // Exhibit F prints NOT ON FILE for archived
  });

  it('handles empty / sparse dossiers with null punchCard, null calendar, and n<5 radar axes', () => {
    const now = new Date('2026-11-16T12:00:00Z');
    const report = buildDetailReport({
      user: {
        login: 'sparse-account',
        type: 'User',
        created_at: '2026-06-01T00:00:00Z',
        followers: 0,
        public_repos: 1,
      },
      repos: [
        {
          name: 'hello',
          fork: false,
          archived: false,
          stargazers_count: 0,
          language: null,
          license: null,
          created_at: '2026-06-02T00:00:00Z',
          pushed_at: null,
        },
      ],
      commits: null,
      events: null,
      calendarDays: null,
      now,
    });
    const dossier: ExhibitDossier = { ...report };
    expect(dossier.punchCard).toBeNull();
    expect(dossier.calendar).toBeNull();
    expect(dossier.radar.every((ax) => !ax.reliable)).toBe(true);

    for (const id of EXHIBIT_IDS) {
      const canvas = createCanvas(1200, 675);
      const ctx = canvas.getContext('2d') as unknown as CanvasContext2DLike;
      const res = renderExhibit(ctx, id, dossier, { now });
      if (id === 'A' || id === 'B') {
        expect(res.withheld).toBe(true);
      }
      expect(canvas.toBuffer('image/png').byteLength).toBeGreaterThan(20_000);
    }
  });

  it('produces identical PNG bytes for repeated deterministic renders under active TZ', () => {
    const dossier = makeRichDossier();
    const now = new Date('2026-11-16T12:00:00Z');
    for (const id of EXHIBIT_IDS) {
      const c1 = createCanvas(1200, 675);
      const c2 = createCanvas(1200, 675);
      renderExhibit(c1.getContext('2d') as unknown as CanvasContext2DLike, id, dossier, { now });
      renderExhibit(c2.getContext('2d') as unknown as CanvasContext2DLike, id, dossier, { now });
      expect(Buffer.compare(c1.toBuffer('image/png'), c2.toBuffer('image/png'))).toBe(0);
    }
  });

  it('contains zero competence/legitimacy/authenticity wording across exhibits, UI, and detail files and no commits label in Exhibit A', () => {
    const root = process.cwd();
    const forbidden = /\b(competence|legitimacy|authenticity)\b/i;
    const dirs = ['src/exhibits', 'src/ui', 'src/canvas', 'dev'];
    const singleFiles = ['src/engine/details.ts', 'api/detail.ts', 'index.html'];

    const scanDir = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'out' || entry.name === 'fixtures') continue;
          scanDir(full);
        } else if (/\.(ts|js|html|css)$/.test(entry.name)) {
          const text = fs.readFileSync(full, 'utf8');
          expect(forbidden.test(text), `Forbidden wording in ${full}`).toBe(false);
        }
      }
    };

    for (const d of dirs) {
      scanDir(path.join(root, d));
    }
    for (const f of singleFiles) {
      const full = path.join(root, f);
      expect(forbidden.test(fs.readFileSync(full, 'utf8')), `Forbidden wording in ${full}`).toBe(false);
    }

    // Ensure drawExhibitA uses the updated contribution breakdown subtitle cleanly
    // and never labels calendar units as "public commits" or "public + indexed units"
    const exhibitsSrc = fs.readFileSync(
      path.join(root, 'src/exhibits/draw-exhibits.ts'),
      'utf8',
    );
    const fnStart = exhibitsSrc.indexOf('function drawExhibitA');
    const fnEnd = exhibitsSrc.indexOf('function drawExhibitB');
    const exhibitASlice = exhibitsSrc.slice(fnStart, fnEnd);
    expect(exhibitASlice).toContain('commits, PRs, issues, reviews');
    expect(exhibitASlice).not.toContain('public + indexed units');
    expect(/\b(recent public|total) commits\b/i.test(exhibitASlice)).toBe(false);
    expect(exhibitsSrc).not.toContain('DEAD FORKS');
    expect(exhibitsSrc).not.toContain("'DELETES'");
  });

  it('keeps exhibits code isolated in its lazy-loaded chunk when built', () => {
    const appPath = path.resolve(process.cwd(), 'dist/assets/app.js');
    const exhibitsPath = path.resolve(process.cwd(), 'dist/assets/exhibits.js');
    if (!fs.existsSync(appPath) || !fs.existsSync(exhibitsPath)) {
      return; // Checked explicitly after npm run build
    }
    const appCode = fs.readFileSync(appPath, 'utf8');
    const exCode = fs.readFileSync(exhibitsPath, 'utf8');

    expect(appCode).not.toContain('SHARE OF EACH STATUTE');
    expect(appCode).not.toContain('EXHIBIT WITHHELD');
    expect(appCode).not.toContain('EVIDENCE LEDGER');
    expect(exCode).toContain('SHARE OF EACH STATUTE');
    expect(exCode).toContain('NO OCCURRENCES ON ');
    expect(exCode).toContain('Untouched forks');
    expect(exCode).toContain('Branch deleter');
    expect(exCode).toContain('EXHIBIT WITHHELD');
    expect(exCode).toContain('BAR SCALE: SQUARE-ROOT');
    expect(exCode).toContain('commits, PRs, issues, reviews');
    expect(exCode).not.toContain('CLEAN ON ');
  });

  it('marks docket PARTIAL on searchIncomplete or missing calendar/language and renders all real captured /api/detail fixtures', () => {
    const rich = makeRichDossier();
    expect(isDocketPartial(rich)).toBe(false);
    expect(isDocketPartial({ ...rich, sample: { ...rich.sample, searchIncomplete: true } })).toBe(true);
    expect(isDocketPartial({ ...rich, calendar: null })).toBe(true);
    expect(isDocketPartial({ ...rich, languages: [] })).toBe(true);

    expect(isExhibitWithheld('A', { ...rich, calendar: null })).toBe(true);
    expect(isExhibitWithheld('B', { ...rich, punchCard: null })).toBe(true);
    expect(isExhibitWithheld('E', { ...rich, languages: [] })).toBe(true);
    expect(isExhibitWithheld('C', rich)).toBe(false);
    expect(isExhibitWithheld('D', rich)).toBe(false);
    expect(isExhibitWithheld('F', rich)).toBe(false);

    const detailDir = path.resolve(process.cwd(), 'dev/fixtures/detail');
    const slugs = ['torvalds', 'dependabot-bot', 'vercel', 'sindresorhus', 'octocat', 'ghost'];
    for (const slug of slugs) {
      const detPath = path.join(detailDir, `${slug}.json`);
      const ghPath = path.join(detailDir, `${slug}.gh.json`);
      expect(fs.existsSync(detPath), `Missing live capture ${detPath}`).toBe(true);
      const det = JSON.parse(fs.readFileSync(detPath, 'utf8')) as ExhibitDossier;
      const gh = fs.existsSync(ghPath)
        ? (JSON.parse(fs.readFileSync(ghPath, 'utf8')) as { repos?: ExhibitDossier['repos'] })
        : undefined;
      const dossier: ExhibitDossier = { ...det, repos: gh?.repos };
      expect(isDocketPartial(dossier)).toBe(true);

      const c = createCanvas(1200, 675);
      const ctx = c.getContext('2d') as unknown as CanvasContext2DLike;
      const resA = renderExhibit(ctx, 'A', dossier, { now: new Date('2026-11-18T12:00:00Z') });
      const resC = renderExhibit(ctx, 'C', dossier, { now: new Date('2026-11-18T12:00:00Z') });
      const resD = renderExhibit(ctx, 'D', dossier, { now: new Date('2026-11-18T12:00:00Z') });
      const resE = renderExhibit(ctx, 'E', dossier, { now: new Date('2026-11-18T12:00:00Z') });
      const resF = renderExhibit(ctx, 'F', dossier, { now: new Date('2026-11-18T12:00:00Z') });
      expect(resA.withheld).toBe(det.calendar === null);
      expect(resC.withheld).toBe(false);
      expect(resD.withheld).toBe(false);
      expect(resE.withheld).toBe(det.languages.length === 0);
      expect(resF.withheld).toBe(false);
    }
  });
});
