import type { VerdictReport } from '../engine/charges.js';
import { getBotAddendum } from '../engine/voice.js';
import { drawFingerprint } from './fingerprint.js';
import type { FontLoader } from './fonts.js';
import { drawMugshot, type AvatarImage, type MugshotOptions } from './mugshot.js';
import {
  PALETTE,
  drawHeaderAndFields,
  drawPaper,
  type CanvasContext2DLike,
} from './paper.js';
import {
  drawStamps,
  getVerdictStampBounds,
  type BoundingBox,
} from './stamps.js';

export interface DrawCardOptions extends MugshotOptions {
  fontLoader?: FontLoader;
}

export type WidthMeasurer = (text: string, font: string) => number;

export interface LayoutTextItem extends BoundingBox {
  kind: 'header' | 'receipt' | 'sting' | 'alibi';
  text: string;
  font: string;
  lines: string[];
  rotateDeg?: number;
}

export interface CardLayout {
  textBoxes: LayoutTextItem[];
  stampBox: BoundingBox;
  bailBox: BoundingBox;
}

const CHARGES_LEFT = 446;
const CHARGES_RIGHT = 1134;
const FULL_WIDTH = CHARGES_RIGHT - CHARGES_LEFT; // 688

// Reserve stamp zone inside bottom-right of charges box so text stays clear of the rotated verdict stamp.
const STAMP_SAFE_LEFT = 820;
const STAMP_SAFE_TOP = 354;
const STAMP_CLEAR_WIDTH = STAMP_SAFE_LEFT - CHARGES_LEFT; // 374

export const CHARGES_BOX: BoundingBox = {
  x: 430,
  y: 194,
  width: 720,
  height: 330,
};

export const INTER_COUNT_GAP = 15;
const BAIL_BOX: BoundingBox = { x: 430, y: 540, width: 360, height: 90 };

function fallbackMeasureWidth(text: string, font: string): number {
  const sizeMatch = /(\d+(?:\.\d+)?)px/.exec(font);
  const px = sizeMatch ? Number(sizeMatch[1]) : 15;
  const isReenie = font.includes('Reenie Beanie');
  const charFactor = isReenie ? 0.42 : 0.61;
  return text.length * px * charFactor;
}

function fitSingleLineWithEllipsis(
  text: string,
  maxWidth: number,
  measure: (s: string) => number,
): string {
  const clean = text.trim();
  if (measure(clean) <= maxWidth) return clean;
  let clipped = clean;
  while (clipped.length > 1 && measure(`${clipped}…`) > maxWidth) {
    clipped = clipped.slice(0, -1).trimEnd();
  }
  return `${clipped}…`;
}

function wrapTextWithWidthBudget(
  text: string,
  maxLines: number,
  getLineMaxWidth: (lineIdx: number) => number,
  measure: (s: string) => number,
): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const lines: string[] = [];
  let wordIdx = 0;

  for (let lineIdx = 0; lineIdx < maxLines && wordIdx < words.length; lineIdx++) {
    const budget = getLineMaxWidth(lineIdx);
    const isLast = lineIdx === maxLines - 1;

    if (isLast) {
      const rest = words.slice(wordIdx).join(' ');
      lines.push(fitSingleLineWithEllipsis(rest, budget, measure));
      break;
    }

    let current = words[wordIdx] ?? '';
    wordIdx++;
    if (measure(current) > budget) {
      lines.push(fitSingleLineWithEllipsis(current, budget, measure));
      continue;
    }

    while (wordIdx < words.length) {
      const next = words[wordIdx] ?? '';
      const candidate = `${current} ${next}`;
      if (measure(candidate) <= budget) {
        current = candidate;
        wordIdx++;
      } else {
        break;
      }
    }
    lines.push(current);
  }

  return lines;
}

function availableWidthAtY(yBottom: number): number {
  return yBottom >= STAMP_SAFE_TOP ? STAMP_CLEAR_WIDTH : FULL_WIDTH;
}

/**
 * Computes deterministic layout boxes for charge text, verdict stamp, and bail box.
 * Used identically by `draw()` and the automated collision test suite.
 */
export function computeCardLayout(
  verdict: VerdictReport,
  measureWidth: WidthMeasurer = fallbackMeasureWidth,
): CardLayout {
  const stampBox = getVerdictStampBounds();
  const textBoxes: LayoutTextItem[] = [];

  if (
    verdict.verdict === 'INSUFFICIENT EVIDENCE' ||
    verdict.verdict === 'RECORD SEALED'
  ) {
    const isSealed = verdict.verdict === 'RECORD SEALED';
    const titleFont = '700 24px "Courier Prime", monospace';
    const titleText =
      verdict.alibi?.title ??
      (isSealed ? 'RECORD SEALED' : 'INSUFFICIENT EVIDENCE');
    const titleFitted = fitSingleLineWithEllipsis(
      titleText,
      availableWidthAtY(274),
      (s) => measureWidth(s, titleFont),
    );
    textBoxes.push({
      kind: 'alibi',
      text: titleFitted,
      font: titleFont,
      lines: [titleFitted],
      x: CHARGES_LEFT,
      y: 246,
      width: measureWidth(titleFitted, titleFont),
      height: 28,
    });

    const receiptFont = '400 15.5px "Courier Prime", monospace';
    const receiptText =
      verdict.alibi?.receipt ??
      (isSealed
        ? 'Dossier expunged upon request. No public exhibits retained.'
        : 'Missing upstream data; record incomplete.');
    const receiptLines = wrapTextWithWidthBudget(
      receiptText,
      2,
      (li) => availableWidthAtY(282 + (li + 1) * 18),
      (s) => measureWidth(s, receiptFont),
    );
    const maxReceiptW = Math.max(
      0,
      ...receiptLines.map((l) => measureWidth(l, receiptFont)),
    );
    textBoxes.push({
      kind: 'alibi',
      text: receiptLines.join(' '),
      font: receiptFont,
      lines: receiptLines,
      x: CHARGES_LEFT,
      y: 282,
      width: maxReceiptW,
      height: receiptLines.length * 18,
    });

    const statusFont = '700 14px "Courier Prime", monospace';
    const statusRaw = isSealed
      ? 'DOCKET STATUS: EXPUNGED — DO NOT DISCLOSE'
      : 'DOCKET STATUS: HELD OPEN — MISSING EXHIBITS';
    const statusFitted = fitSingleLineWithEllipsis(
      statusRaw,
      availableWidthAtY(350),
      (s) => measureWidth(s, statusFont),
    );
    textBoxes.push({
      kind: 'alibi',
      text: statusFitted,
      font: statusFont,
      lines: [statusFitted],
      x: CHARGES_LEFT,
      y: 334,
      width: measureWidth(statusFitted, statusFont),
      height: 18,
    });

    const stingFont = '400 25px "Reenie Beanie", cursive';
    const stingFitted = fitSingleLineWithEllipsis(
      verdict.verdictSting,
      STAMP_CLEAR_WIDTH,
      (s) => measureWidth(s, stingFont),
    );
    textBoxes.push({
      kind: 'sting',
      text: stingFitted,
      font: stingFont,
      lines: [stingFitted],
      x: CHARGES_LEFT,
      y: 446,
      width: measureWidth(stingFitted, stingFont),
      height: 26,
    });

    return { textBoxes, stampBox, bailBox: BAIL_BOX };
  }

  if (verdict.verdict === 'ACQUITTED' || verdict.charges.length === 0) {
    const titleFont = '700 25px "Courier Prime", monospace';
    const titleText = verdict.alibi?.title ?? 'NO CHARGES FILED';
    const titleFitted = fitSingleLineWithEllipsis(
      titleText,
      availableWidthAtY(274),
      (s) => measureWidth(s, titleFont),
    );
    textBoxes.push({
      kind: 'alibi',
      text: titleFitted,
      font: titleFont,
      lines: [titleFitted],
      x: CHARGES_LEFT,
      y: 246,
      width: measureWidth(titleFitted, titleFont),
      height: 28,
    });

    const receiptFont = '400 15.5px "Courier Prime", monospace';
    const receiptText =
      verdict.alibi?.receipt ?? 'Fully redacted, as a courtesy.';
    const receiptLines = wrapTextWithWidthBudget(
      receiptText,
      2,
      (li) => availableWidthAtY(282 + (li + 1) * 18),
      (s) => measureWidth(s, receiptFont),
    );
    const maxReceiptW = Math.max(
      0,
      ...receiptLines.map((l) => measureWidth(l, receiptFont)),
    );
    textBoxes.push({
      kind: 'alibi',
      text: receiptLines.join(' '),
      font: receiptFont,
      lines: receiptLines,
      x: CHARGES_LEFT,
      y: 282,
      width: maxReceiptW,
      height: receiptLines.length * 18,
    });

    const cleanFont = '400 32px "Reenie Beanie", cursive';
    const cleanText = 'suspiciously clean';
    textBoxes.push({
      kind: 'alibi',
      text: cleanText,
      font: cleanFont,
      lines: [cleanText],
      x: CHARGES_LEFT,
      y: 404,
      width: measureWidth(cleanText, cleanFont),
      height: 30,
      rotateDeg: -1.1,
    });

    const stingFont = '400 25px "Reenie Beanie", cursive';
    const stingFitted = fitSingleLineWithEllipsis(
      verdict.verdictSting,
      STAMP_CLEAR_WIDTH,
      (s) => measureWidth(s, stingFont),
    );
    textBoxes.push({
      kind: 'sting',
      text: stingFitted,
      font: stingFont,
      lines: [stingFitted],
      x: CHARGES_LEFT,
      y: 446,
      width: measureWidth(stingFitted, stingFont),
      height: 26,
    });

    return { textBoxes, stampBox, bailBox: BAIL_BOX };
  }

  const counts = verdict.charges.slice(0, 3);
  const headerFont = '700 18.5px "Courier Prime", monospace';
  const receiptFont = '400 15.5px "Courier Prime", monospace';
  const stingFont = '400 25px "Reenie Beanie", cursive';

  let currentY = 225;
  const appendEntryBlock = (
    headerRaw: string,
    receiptRaw: string,
    stingRaw: string,
  ): void => {
    const baseY = currentY;
    const headerW = availableWidthAtY(baseY + 20);
    const headerFitted = fitSingleLineWithEllipsis(headerRaw, headerW, (s) =>
      measureWidth(s, headerFont),
    );
    textBoxes.push({
      kind: 'header',
      text: headerFitted,
      font: headerFont,
      lines: [headerFitted],
      x: CHARGES_LEFT,
      y: baseY,
      width: measureWidth(headerFitted, headerFont),
      height: 20,
    });

    const receiptY = baseY + 22;
    const receiptLines = wrapTextWithWidthBudget(
      receiptRaw,
      2,
      (li) => availableWidthAtY(receiptY + (li + 1) * 16),
      (s) => measureWidth(s, receiptFont),
    );
    const receiptW = Math.max(
      0,
      ...receiptLines.map((l) => measureWidth(l, receiptFont)),
    );
    textBoxes.push({
      kind: 'receipt',
      text: receiptLines.join('\n'),
      font: receiptFont,
      lines: receiptLines,
      x: CHARGES_LEFT,
      y: receiptY,
      width: receiptW,
      height: receiptLines.length * 16,
    });

    const stingY = receiptY + receiptLines.length * 16 + 2;
    const stingHeight = 22;
    const stingBudget = availableWidthAtY(stingY + stingHeight);
    const stingFitted = fitSingleLineWithEllipsis(stingRaw, stingBudget, (s) =>
      measureWidth(s, stingFont),
    );
    textBoxes.push({
      kind: 'sting',
      text: stingFitted,
      font: stingFont,
      lines: [stingFitted],
      x: CHARGES_LEFT,
      y: stingY,
      width: measureWidth(stingFitted, stingFont),
      height: stingHeight,
      rotateDeg: -0.7,
    });

    currentY = stingY + stingHeight + INTER_COUNT_GAP;
  };

  counts.forEach((charge) => {
    appendEntryBlock(
      `${charge.countLabel}: ${charge.label}`,
      charge.receipt,
      charge.sting,
    );
  });

  if (verdict.accountKind === 'Bot' && counts.length === 1) {
    const addendum = getBotAddendum(verdict.handle);
    appendEntryBlock(addendum.header, addendum.receipt, addendum.sting);
  }

  return { textBoxes, stampBox, bailBox: BAIL_BOX };
}

function drawAcquittedExtras(ctx: CanvasContext2DLike): void {
  const x = CHARGES_LEFT;
  ctx.fillStyle = PALETTE.ink;
  ctx.font = '700 14px "Courier Prime", monospace';
  ctx.fillText('PRIORS:', x, 324);
  ctx.fillRect(x + 76, 321, 246, 20);

  ctx.fillText('ALIASES:', x, 354);
  ctx.fillRect(x + 84, 351, 280, 20);
}

function drawInsufficientEvidenceExtras(ctx: CanvasContext2DLike): void {
  const x = CHARGES_LEFT;
  ctx.save();
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, 326);
  ctx.lineTo(CHARGES_RIGHT, 326);
  ctx.stroke();
  ctx.restore();
}

function drawChargesAndBail(
  ctx: CanvasContext2DLike,
  verdict: VerdictReport,
): void {
  const measure: WidthMeasurer = (text, font) => {
    ctx.save();
    ctx.font = font;
    const w = ctx.measureText(text).width;
    ctx.restore();
    return w;
  };

  const layout = computeCardLayout(verdict, measure);

  ctx.save();
  ctx.strokeStyle = PALETTE.ink;
  ctx.fillStyle = PALETTE.ink;
  ctx.lineWidth = 2;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';

  // Charges zone: 430-1150, 194-524
  ctx.font = '700 12.5px "Courier Prime", monospace';
  ctx.fillText('CHARGES (PENDING):', CHARGES_LEFT, 206);

  if (verdict.verdict === 'ACQUITTED') {
    drawAcquittedExtras(ctx);
  } else if (
    verdict.verdict === 'INSUFFICIENT EVIDENCE' ||
    verdict.verdict === 'RECORD SEALED'
  ) {
    drawInsufficientEvidenceExtras(ctx);
  }

  for (const box of layout.textBoxes) {
    ctx.save();
    ctx.font = box.font;
    ctx.fillStyle =
      box.kind === 'sting' ||
      (box.kind === 'alibi' && box.text === 'suspiciously clean')
        ? PALETTE.hand
        : PALETTE.ink;

    if (box.rotateDeg) {
      ctx.translate(box.x, box.y);
      ctx.rotate((box.rotateDeg * Math.PI) / 180);
      box.lines.forEach((line, idx) => {
        ctx.fillText(line, 0, idx * 16);
      });
    } else {
      const lineStep = box.kind === 'receipt' ? 16 : box.kind === 'alibi' ? 18 : 22;
      box.lines.forEach((line, idx) => {
        ctx.fillText(line, box.x, box.y + idx * lineStep);
      });
    }
    ctx.restore();
  }

  // Charges zone border: 430-1150, 194-524
  ctx.strokeRect(
    CHARGES_BOX.x,
    CHARGES_BOX.y,
    CHARGES_BOX.width,
    CHARGES_BOX.height,
  );

  // Bail box: 430-790, 540-630
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = 2;
  ctx.strokeRect(BAIL_BOX.x, BAIL_BOX.y, BAIL_BOX.width, BAIL_BOX.height);
  ctx.fillStyle = PALETTE.ink;
  ctx.font = '700 11px "Courier Prime", monospace';
  ctx.fillText('BAIL STATUS:', BAIL_BOX.x + 12, BAIL_BOX.y + 9);

  ctx.font = '700 28px "Courier Prime", monospace';
  ctx.fillText(`BAIL: ${verdict.bail}`, BAIL_BOX.x + 12, BAIL_BOX.y + 27, 336);

  ctx.font = '400 12px "Courier Prime", monospace';
  ctx.fillText(
    `RECEIVED BY: ${verdict.receivedBy}`,
    BAIL_BOX.x + 12,
    BAIL_BOX.y + 66,
    336,
  );

  // Intake Notes / Partial Record box: 790-1048, 540-630
  ctx.strokeRect(790, 540, 258, 90);
  ctx.font = '700 11px "Courier Prime", monospace';
  ctx.fillText('INTAKE NOTES:', 802, 549);

  // Preserve corporation / automaton tag in INTAKE NOTES on ACQUITTED org/bot cards
  const boxNote =
    verdict.verdict === 'ACQUITTED'
      ? verdict.accountKind === 'Organization'
        ? 'SUSPECT IS A CORPORATION'
        : verdict.accountKind === 'Bot'
          ? 'SUSPECT IS AN AUTOMATON'
          : 'no priors on file'
      : verdict.intakeNotes;

  ctx.fillStyle = PALETTE.hand;
  if (verdict.partialRecord) {
    ctx.font = '400 26px "Reenie Beanie", cursive';
    const partialText = 'partial record on file';
    ctx.fillText(partialText, 802, 566);

    const tw = Math.min(230, ctx.measureText(partialText).width);
    ctx.strokeStyle = PALETTE.hand;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(802, 591);
    ctx.lineTo(802 + tw, 590);
    ctx.stroke();

    ctx.font = '400 20px "Reenie Beanie", cursive';
    const clippedNote = fitSingleLineWithEllipsis(boxNote, 234, (s) =>
      ctx.measureText(s).width,
    );
    ctx.fillText(clippedNote, 802, 598);
  } else {
    ctx.font = '400 24px "Reenie Beanie", cursive';
    const noteLines = wrapTextWithWidthBudget(
      boxNote,
      2,
      () => 234,
      (s) => ctx.measureText(s).width,
    );
    noteLines.forEach((line, idx) => {
      ctx.fillText(line, 802, 567 + idx * 23);
    });
  }

  ctx.restore();
}

/**
 * Single render function for both the browser preview/export and server OG renderer.
 * Draws the complete 1200x675 Form 14-B rap sheet onto any 2D canvas context.
 */
export async function draw(
  ctx: CanvasContext2DLike,
  verdict: VerdictReport,
  avatar: AvatarImage | null,
  options: DrawCardOptions = {},
): Promise<void> {
  if (options.fontLoader) {
    await options.fontLoader();
  }
  const safeAvatar = verdict.verdict === 'RECORD SEALED' ? null : avatar;
  drawPaper(ctx, verdict.handle);
  drawHeaderAndFields(ctx, verdict);
  drawMugshot(ctx, verdict, safeAvatar, options);
  drawChargesAndBail(ctx, verdict);
  drawFingerprint(ctx, verdict.handle);
  drawStamps(ctx, verdict);
}
