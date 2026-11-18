import type { VerdictReport } from '../engine/charges.js';
import type { DetailReport } from '../engine/details.js';
import { createRng, hashHandle } from '../engine/hash.js';
import { drawHandwrittenText, drawTypewriterText, inkLayer } from '../canvas/ink.js';
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  PALETTE,
  drawPaper,
  type CanvasContext2DLike,
} from '../canvas/paper.js';

export type ExhibitId = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

export const EXHIBIT_IDS: readonly ExhibitId[] = ['A', 'B', 'C', 'D', 'E', 'F'];

export interface ExhibitRepoInfo {
  name: string;
  fork: boolean;
  stargazers_count: number;
  language?: string | null;
  created_at: string;
}

export interface ExhibitDossier extends DetailReport {
  calendarUnit?: 'contributions';
  verdict?: VerdictReport;
  menaceScore?: number;
  bail?: string;
  bailAmount?: number;
  missing?: Record<string, number>;
  repos?: readonly ExhibitRepoInfo[];
}

export interface ExhibitRenderResult {
  id: ExhibitId;
  title: string;
  withheld: boolean;
  partial: boolean;
}

export function isExhibitWithheld(
  id: ExhibitId,
  dossier: ExhibitDossier,
): boolean {
  switch (id) {
    case 'A':
      return !dossier.calendar || dossier.calendar.weeks.length === 0;
    case 'B':
      return !dossier.punchCard || dossier.punchCard.sample === 0;
    case 'C':
      return !dossier.radar || dossier.radar.length === 0;
    case 'D':
      return false;
    case 'E':
      return !dossier.languages || dossier.languages.length === 0;
    case 'F':
      return false;
  }
}

export function isDocketPartial(dossier: ExhibitDossier): boolean {
  if (
    dossier.sample.searchIncomplete ||
    dossier.verdict?.searchIncomplete ||
    dossier.repoShape.truncated
  ) {
    return true;
  }
  if (
    !dossier.calendar ||
    dossier.calendar.weeks.length === 0 ||
    !dossier.punchCard ||
    dossier.punchCard.sample === 0 ||
    dossier.languages.length === 0 ||
    dossier.repoShape.archived === null
  ) {
    return true;
  }
  if (
    dossier.sample.notes.some((n) =>
      /unavailable|incomplete|omitted/i.test(n),
    )
  ) {
    return true;
  }
  if (dossier.missing && Object.keys(dossier.missing).length > 0) {
    return true;
  }
  if (dossier.verdict?.partialRecord) {
    return true;
  }
  return false;
}

function buildFooterLines(
  dossier: ExhibitDossier,
  id: ExhibitId,
): { primary: string; secondary: string } {
  if (id === 'A') {
    const calPart = dossier.calendar
      ? `53-week calendar (${dossier.calendar.total.toLocaleString('en-US')} contributions)`
      : '53-week contribution calendar withheld';
    const extraNotes = dossier.sample.notes.filter(
      (n) => !/\bcommits?\b/i.test(n) && !/calendar unavailable/i.test(n),
    );
    if (dossier.sample.searchIncomplete && extraNotes.length === 0) {
      extraNotes.push('GitHub search reported incomplete results.');
    }
    const tail = extraNotes.length > 0 ? extraNotes[0] : 'Public activity index.';
    return {
      primary: `SAMPLE: ${calPart} — ${dossier.sample.repos} repos inspected`,
      secondary: tail ?? 'Public activity index.',
    };
  }

  const commitText = dossier.sample.searchIncomplete
    ? `${dossier.sample.commits} recent public commits found (search incomplete)`
    : `${dossier.sample.commits} recent public commits, ${dossier.sample.events} events, ${dossier.sample.repos} repos`;
  const noteParts = dossier.sample.notes.filter(
    (n) => !/incomplete results/i.test(n),
  );
  const secondary =
    noteParts.length > 0
      ? noteParts.slice(0, 2).join(' ')
      : 'Derived solely from public GitHub API responses.';

  return {
    primary: `SAMPLE: ${commitText}`,
    secondary,
  };
}

/**
 * Renders the shared 1200x675 Form 14-B exhibit backdrop, header band (y 30..110),
 * and sample/caveat footer (y 625..655) using the shared paper and ink pipeline.
 */
export function drawExhibitFrame(
  ctx: CanvasContext2DLike,
  id: ExhibitId,
  title: string,
  dossier: ExhibitDossier,
  subtitle?: string,
): { partial: boolean } {
  const handle = dossier.handle;
  const seedKey = `${handle}-exhibit-${id}`;
  const x0 = 80;
  const x1 = 1150;
  const w = x1 - x0;
  const caseNo = dossier.verdict?.caseNumber ?? 'GH-ON-FILE';
  const partial = isDocketPartial(dossier);

  // Layer 1: Shared aged cream paper backdrop
  drawPaper(ctx, seedKey);

  // Layer 2: Heavy header rules and title (y 30..110)
  inkLayer(
    ctx,
    (sctx) => {
      sctx.fillStyle = PALETTE.ink;
      sctx.fillRect(x0, 30, w, 4);
      sctx.fillRect(x0, 37, w, 1.5);
      sctx.fillRect(x0, 105, w, 1.5);
      sctx.fillRect(x0, 110, w, 4);

      sctx.textAlign = 'left';
      sctx.textBaseline = 'middle';
      sctx.font = '700 30px "Courier Prime", monospace';
      drawTypewriterText(
        sctx,
        `EXHIBIT ${id} — ${title}`,
        x0 + 6,
        subtitle ? 64 : 72,
        hashHandle(seedKey, 'ex-title'),
        640,
      );
    },
    'header',
    hashHandle(seedKey, 'ex-header-ink'),
    { color: PALETTE.ink },
  );

  // Layer 2b: Small tilted EXHIBIT stamp in header gap (between title and right handle block)
  const stampRng = createRng(hashHandle(seedKey, 'ex-stamp-tilt'));
  const stampAngle = ((-3.5 + stampRng() * 5.5) * Math.PI) / 180;
  inkLayer(
    ctx,
    (sctx) => {
      sctx.save();
      sctx.translate(822, 68);
      sctx.rotate(stampAngle);
      sctx.strokeStyle = PALETTE.red;
      sctx.fillStyle = PALETTE.red;
      sctx.lineWidth = 2.2;
      sctx.strokeRect(-54, -14, 108, 28);
      sctx.lineWidth = 0.9;
      sctx.strokeRect(-50, -10, 100, 20);
      sctx.textAlign = 'center';
      sctx.textBaseline = 'middle';
      sctx.font = '700 13px "Courier Prime", monospace';
      drawTypewriterText(
        sctx,
        `EXHIBIT ${id}`,
        0,
        1,
        hashHandle(seedKey, 'ex-stamp-txt'),
      );
      sctx.restore();
    },
    'stamp',
    hashHandle(seedKey, 'ex-small-stamp'),
    { color: PALETTE.red },
  );

  // Layer 3: Crisp labels for subtitle, right header docket metadata, and footer
  const footer = buildFooterLines(dossier, id);
  inkLayer(
    ctx,
    (sctx) => {
      sctx.fillStyle = PALETTE.ink;
      sctx.strokeStyle = PALETTE.ink;

      if (subtitle) {
        sctx.textAlign = 'left';
        sctx.textBaseline = 'middle';
        sctx.font = '700 12px "Courier Prime", monospace';
        drawTypewriterText(
          sctx,
          subtitle,
          x0 + 8,
          91,
          hashHandle(seedKey, 'ex-subtitle'),
          640,
        );
      }

      sctx.textAlign = 'right';
      sctx.textBaseline = 'top';
      sctx.font = '700 13px "Courier Prime", monospace';
      drawTypewriterText(
        sctx,
        `CASE NO. ${caseNo}`,
        x1 - 6,
        50,
        hashHandle(seedKey, 'ex-caseno'),
        250,
      );

      sctx.font = '700 19px "Courier Prime", monospace';
      drawTypewriterText(
        sctx,
        `@${handle}`,
        x1 - 6,
        70,
        hashHandle(seedKey, 'ex-handle'),
        250,
      );

      // Footer separator and right-hand status lines (y 625..655)
      sctx.lineWidth = 1.5;
      sctx.beginPath();
      sctx.moveTo(x0, 622);
      sctx.lineTo(x1, 622);
      sctx.stroke();

      sctx.textAlign = 'right';
      sctx.textBaseline = 'top';
      sctx.font = '700 12px "Courier Prime", monospace';
      drawTypewriterText(
        sctx,
        partial ? 'DOCKET: PARTIAL' : 'DOCKET: COMPLETE',
        x1 - 4,
        629,
        hashHandle(seedKey, 'ex-docket'),
        240,
      );

      sctx.font = '700 11px "Courier Prime", monospace';
      drawTypewriterText(
        sctx,
        'NOT A RATING OF SKILL OR CHARACTER',
        x1 - 4,
        645,
        hashHandle(seedKey, 'ex-disclaimer'),
        330,
      );
    },
    'labels',
    hashHandle(seedKey, 'ex-labels-ink'),
    { color: PALETTE.ink },
  );

  // Layer 4: Crisp receipts layer for small sample lines in footer (no heavy smudge)
  inkLayer(
    ctx,
    (sctx) => {
      sctx.fillStyle = PALETTE.ink;
      sctx.textAlign = 'left';
      sctx.textBaseline = 'top';
      sctx.font = '700 11px "Courier Prime", monospace';
      drawTypewriterText(
        sctx,
        footer.primary,
        x0 + 4,
        629,
        hashHandle(seedKey, 'ex-sample-1'),
        740,
      );

      sctx.font = '400 11px "Courier Prime", monospace';
      drawTypewriterText(
        sctx,
        footer.secondary,
        x0 + 4,
        645,
        hashHandle(seedKey, 'ex-sample-2'),
        740,
      );
    },
    'receipts',
    hashHandle(seedKey, 'ex-footer-ink'),
    { color: PALETTE.ink },
  );

  return { partial };
}

/**
 * Draws centered "EXHIBIT WITHHELD" red stamp and explanation when data is absent.
 */
export function drawWithheldNotice(
  ctx: CanvasContext2DLike,
  seedKey: string,
  reasonLine: string,
): void {
  inkLayer(
    ctx,
    (sctx) => {
      sctx.strokeStyle = PALETTE.ink;
      sctx.fillStyle = PALETTE.ink;
      sctx.lineWidth = 1.5;
      sctx.setLineDash([6, 4]);
      sctx.strokeRect(140, 175, 950, 390);
      sctx.setLineDash([]);

      sctx.textAlign = 'center';
      sctx.textBaseline = 'middle';
      sctx.font = '700 15px "Courier Prime", monospace';
      drawTypewriterText(
        sctx,
        reasonLine,
        615,
        435,
        hashHandle(seedKey, 'withheld-reason'),
        880,
      );
    },
    'receipts',
    hashHandle(seedKey, 'withheld-box'),
    { color: PALETTE.ink },
  );

  const rng = createRng(hashHandle(seedKey, 'withheld-angle'));
  const angle = ((-5 + rng() * 6) * Math.PI) / 180;
  inkLayer(
    ctx,
    (sctx) => {
      sctx.save();
      sctx.translate(615, 340);
      sctx.rotate(angle);
      sctx.strokeStyle = PALETTE.red;
      sctx.fillStyle = PALETTE.red;
      sctx.lineWidth = 4;
      sctx.strokeRect(-210, -44, 420, 88);
      sctx.lineWidth = 1.5;
      sctx.strokeRect(-203, -37, 406, 74);

      sctx.textAlign = 'center';
      sctx.textBaseline = 'middle';
      sctx.font = '700 38px "Courier Prime", monospace';
      drawTypewriterText(
        sctx,
        'EXHIBIT WITHHELD',
        0,
        2,
        hashHandle(seedKey, 'withheld-stamp-txt'),
      );
      sctx.restore();
    },
    'stamp',
    hashHandle(seedKey, 'withheld-stamp'),
    { color: PALETTE.red },
  );
}

/**
 * Draws parallel diagonal hatching inside the current clipping region.
 */
export function strokeHatchLines(
  ctx: CanvasContext2DLike,
  x: number,
  y: number,
  w: number,
  h: number,
  spacing: number,
  reverse = false,
  lineWidth = 1.2,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  const diag = w + h;
  for (let d = -h; d <= diag; d += spacing) {
    if (!reverse) {
      ctx.moveTo(x + d, y + h);
      ctx.lineTo(x + d + h, y);
    } else {
      ctx.moveTo(x + d, y);
      ctx.lineTo(x + d + h, y + h);
    }
  }
  ctx.stroke();
  ctx.restore();
}

/**
 * Draws one seeded handwritten blue ballpoint noir observation on an exhibit.
 */
export function drawExhibitNoirLine(
  ctx: CanvasContext2DLike,
  seedKey: string,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  align: CanvasTextAlign = 'left',
): void {
  if (!text) return;
  inkLayer(
    ctx,
    (sctx) => {
      sctx.fillStyle = PALETTE.hand;
      sctx.strokeStyle = PALETTE.hand;
      sctx.textAlign = align;
      sctx.textBaseline = 'top';
      sctx.font = '400 22px "Reenie Beanie", cursive';
      drawHandwrittenText(
        sctx,
        text,
        x,
        y,
        hashHandle(seedKey, 'ex-noir-line'),
        { maxWidth, baseRotateDeg: -0.5 },
      );
    },
    'handwriting',
    hashHandle(seedKey, 'ex-noir-ink'),
    { color: PALETTE.hand },
  );
}

/**
 * Draws a horizontal ink bar using one consistent diagonal hatch fill (no solid black blocks).
 */
export function drawHatchedInkBar(
  ctx: CanvasContext2DLike,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  if (w <= 0 || h <= 0) return;
  ctx.save();
  ctx.fillStyle = PALETTE.ink;
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = 1.5;
  ctx.globalAlpha = 0.08;
  ctx.fillRect(x, y, w, h);
  ctx.globalAlpha = 0.92;
  strokeHatchLines(ctx, x, y, w, h, 4.5, false, 1.35);
  ctx.globalAlpha = 1;
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
}

export function drawDottedLeader(
  ctx: CanvasContext2DLike,
  startX: number,
  endX: number,
  baselineY: number,
): void {
  if (endX - startX < 12) return;
  ctx.save();
  ctx.fillStyle = PALETTE.ink;
  for (let px = Math.ceil(startX); px <= Math.floor(endX); px += 6) {
    ctx.fillRect(px, baselineY - 1, 1.6, 1.6);
  }
  ctx.restore();
}

export { CARD_HEIGHT, CARD_WIDTH };
