import type { VerdictReport } from '../engine/charges.js';
import { createRng, hashHandle } from '../engine/hash.js';
import { getBotAddendum } from '../engine/voice.js';
import { drawFingerprint } from './fingerprint.js';
import type { FontLoader } from './fonts.js';
import {
  drawHandCircle,
  drawHandwrittenText,
  drawTypewriterText,
  inkLayer,
} from './ink.js';
import { drawMugshot, type AvatarImage, type MugshotOptions } from './mugshot.js';
import {
  PALETTE,
  getHeaderStages,
  getPaperStages,
  type CanvasContext2DLike,
  type NamedRenderStage,
} from './paper.js';
import {
  drawStamps,
  getVerdictStampBounds,
  type BoundingBox,
} from './stamps.js';

export interface DrawCardOptions extends MugshotOptions {
  fontLoader?: FontLoader;
  yieldBetweenStages?: boolean;
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

function drawAcquittedExtras(ctx: CanvasContext2DLike, handle: string): void {
  const x = CHARGES_LEFT;
  ctx.fillStyle = PALETTE.ink;
  ctx.font = '700 14px "Courier Prime", monospace';
  drawTypewriterText(ctx, 'PRIORS:', x, 324, hashHandle(handle, 'acq-priors'));
  ctx.fillRect(x + 76, 321, 246, 20);

  drawTypewriterText(ctx, 'ALIASES:', x, 354, hashHandle(handle, 'acq-aliases'));
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

function getChargesAndBailStages(
  ctx: CanvasContext2DLike,
  verdict: VerdictReport,
): NamedRenderStage[] {
  const measure: WidthMeasurer = (text, font) => {
    ctx.save();
    ctx.font = font;
    const w = ctx.measureText(text).width;
    ctx.restore();
    return w;
  };

  const layout = computeCardLayout(verdict, measure);
  const handRng = createRng(hashHandle(verdict.handle, 'hand-accents'));

  const boxNote =
    verdict.verdict === 'ACQUITTED'
      ? verdict.accountKind === 'Organization'
        ? 'SUSPECT IS A CORPORATION'
        : verdict.accountKind === 'Bot'
          ? 'SUSPECT IS AN AUTOMATON'
          : 'no priors on file'
      : verdict.intakeNotes;

  const yearsMatch = !verdict.partialRecord
    ? /^(\d+\s+yrs)\s+(.*)$/i.exec(boxNote.trim())
    : null;
  const circleYears = Boolean(yearsMatch && handRng() < 0.55);
  const circleBail = !circleYears && verdict.bailAmount > 0;

  let bailValX = BAIL_BOX.x + 12;
  let bailValW = 0;
  let bailMaxW = 336;

  // 1. Labels, bold count headers, and rule boxes via 'labels' ink preset
  const labelsStage: NamedRenderStage = {
    name: 'charges-labels',
    run: () =>
      inkLayer(
        ctx,
        (sctx) => {
          sctx.strokeStyle = PALETTE.ink;
          sctx.fillStyle = PALETTE.ink;
          sctx.lineWidth = 2;
          sctx.textAlign = 'left';
          sctx.textBaseline = 'top';

          sctx.font = '700 12.5px "Courier Prime", monospace';
          drawTypewriterText(
            sctx,
            'CHARGES (PENDING):',
            CHARGES_LEFT,
            206,
            hashHandle(verdict.handle, 'charges-hdr'),
          );

          if (verdict.verdict === 'ACQUITTED') {
            drawAcquittedExtras(sctx, verdict.handle);
          } else if (
            verdict.verdict === 'INSUFFICIENT EVIDENCE' ||
            verdict.verdict === 'RECORD SEALED'
          ) {
            drawInsufficientEvidenceExtras(sctx);
          }

          layout.textBoxes.forEach((box, boxIdx) => {
            const isLabelBox =
              box.kind === 'header' ||
              (box.kind === 'alibi' && box.font.startsWith('700'));
            if (!isLabelBox) return;

            sctx.font = box.font;
            const lineStep = box.kind === 'alibi' ? 18 : 22;
            box.lines.forEach((line, idx) => {
              drawTypewriterText(
                sctx,
                line,
                box.x,
                box.y + idx * lineStep,
                hashHandle(verdict.handle, `lbl-${boxIdx}-${idx}`),
              );
            });
          });

          sctx.strokeRect(
            CHARGES_BOX.x,
            CHARGES_BOX.y,
            CHARGES_BOX.width,
            CHARGES_BOX.height,
          );

          sctx.strokeRect(BAIL_BOX.x, BAIL_BOX.y, BAIL_BOX.width, BAIL_BOX.height);
          sctx.font = '700 11px "Courier Prime", monospace';
          drawTypewriterText(
            sctx,
            'BAIL STATUS:',
            BAIL_BOX.x + 12,
            BAIL_BOX.y + 9,
            hashHandle(verdict.handle, 'bail-hdr'),
          );

          sctx.font = '700 26px "Courier Prime", monospace';
          const bailPrefix = 'BAIL:';
          const bailPrefixW = sctx.measureText(bailPrefix).width;
          const bailGap = 22;
          bailValX = BAIL_BOX.x + 12 + bailPrefixW + bailGap;
          bailMaxW = Math.max(80, 336 - bailPrefixW - bailGap);
          bailValW = Math.min(bailMaxW, sctx.measureText(verdict.bail).width);

          drawTypewriterText(
            sctx,
            bailPrefix,
            BAIL_BOX.x + 12,
            BAIL_BOX.y + 28,
            hashHandle(verdict.handle, 'bail-prefix'),
          );
          drawTypewriterText(
            sctx,
            verdict.bail,
            bailValX,
            BAIL_BOX.y + 28,
            hashHandle(verdict.handle, 'bail-val'),
            bailMaxW,
          );

          sctx.strokeRect(790, 540, 258, 90);
          sctx.font = '700 11px "Courier Prime", monospace';
          drawTypewriterText(
            sctx,
            'INTAKE NOTES:',
            802,
            549,
            hashHandle(verdict.handle, 'intake-hdr'),
          );
        },
        'labels',
        hashHandle(verdict.handle, 'card-labels-ink'),
        { color: PALETTE.ink },
      ),
  };

  // 2. Receipts and body text via 'receipts' ink preset
  const receiptsStage: NamedRenderStage = {
    name: 'charges-receipts',
    run: () =>
      inkLayer(
        ctx,
        (sctx) => {
          sctx.fillStyle = PALETTE.ink;
          sctx.textAlign = 'left';
          sctx.textBaseline = 'top';

          layout.textBoxes.forEach((box, boxIdx) => {
            const isReceiptBox =
              box.kind === 'receipt' ||
              (box.kind === 'alibi' &&
                box.font.startsWith('400') &&
                box.text !== 'suspiciously clean');
            if (!isReceiptBox) return;

            sctx.font = box.font;
            const lineStep = box.kind === 'receipt' ? 16 : 18;
            box.lines.forEach((line, idx) => {
              drawTypewriterText(
                sctx,
                line,
                box.x,
                box.y + idx * lineStep,
                hashHandle(verdict.handle, `rcpt-${boxIdx}-${idx}`),
              );
            });
          });

          sctx.font = '400 12px "Courier Prime", monospace';
          drawTypewriterText(
            sctx,
            `RECEIVED BY: ${verdict.receivedBy}`,
            BAIL_BOX.x + 12,
            BAIL_BOX.y + 66,
            hashHandle(verdict.handle, 'bail-recv'),
            336,
          );
        },
        'receipts',
        hashHandle(verdict.handle, 'card-receipts-ink'),
        { color: PALETTE.ink },
      ),
  };

  // 3. Handwritten stings, intake notes, max 1 underline and max 1 padded circle per card
  const hasPartialUnderline = verdict.partialRecord;
  const hasAcquittedUnderline =
    !hasPartialUnderline && verdict.verdict === 'ACQUITTED';
  const stingCount = layout.textBoxes.filter((b) => b.kind === 'sting').length;
  const underlineStingIndex =
    !hasPartialUnderline && !hasAcquittedUnderline && stingCount > 0
      ? Math.floor(handRng() * stingCount)
      : -1;

  const handwritingStage: NamedRenderStage = {
    name: 'charges-handwriting',
    run: () =>
      inkLayer(
        ctx,
        (sctx) => {
          sctx.fillStyle = PALETTE.hand;
          sctx.strokeStyle = PALETTE.hand;
          sctx.textAlign = 'left';
          sctx.textBaseline = 'top';

          let stingCounter = 0;
          layout.textBoxes.forEach((box, boxIdx) => {
            const isHandBox =
              box.kind === 'sting' ||
              (box.kind === 'alibi' && box.text === 'suspiciously clean');
            if (!isHandBox) return;

            const isCleanLine = box.text === 'suspiciously clean';
            const shouldUnderline =
              (hasAcquittedUnderline && isCleanLine) ||
              (box.kind === 'sting' && stingCounter === underlineStingIndex);
            if (box.kind === 'sting') stingCounter++;

            sctx.font = box.font;
            box.lines.forEach((line, idx) => {
              drawHandwrittenText(
                sctx,
                line,
                box.x,
                box.y + idx * 16,
                hashHandle(verdict.handle, `hand-${boxIdx}-${idx}`),
                {
                  baseRotateDeg: box.rotateDeg ?? 0,
                  underline: shouldUnderline && idx === 0,
                },
              );
            });
          });

          if (verdict.partialRecord) {
            sctx.font = '400 26px "Reenie Beanie", cursive';
            drawHandwrittenText(
              sctx,
              'partial record on file',
              802,
              566,
              hashHandle(verdict.handle, 'hand-partial'),
              { underline: true, maxWidth: 234 },
            );

            sctx.font = '400 20px "Reenie Beanie", cursive';
            const clippedNote = fitSingleLineWithEllipsis(boxNote, 234, (s) =>
              sctx.measureText(s).width,
            );
            drawHandwrittenText(
              sctx,
              clippedNote,
              802,
              598,
              hashHandle(verdict.handle, 'hand-partial-note'),
            );
          } else if (circleYears && yearsMatch) {
            const prefix = yearsMatch[1] ?? '';
            const rest = yearsMatch[2] ?? '';
            sctx.font = '400 23px "Reenie Beanie", cursive';
            const prefixX = 812;
            const line0Y = 570;
            const prefixW = sctx.measureText(prefix).width;
            const restX = prefixX + prefixW + 20;
            const restLine0MaxW = Math.max(40, 1038 - restX);

            drawHandwrittenText(
              sctx,
              prefix,
              prefixX,
              line0Y,
              hashHandle(verdict.handle, 'hand-note-prefix'),
              { baseRotateDeg: 0 },
            );

            const restLines = wrapTextWithWidthBudget(
              rest,
              2,
              (li) => (li === 0 ? restLine0MaxW : 234),
              (s) => sctx.measureText(s).width,
            );
            if (restLines[0]) {
              drawHandwrittenText(
                sctx,
                restLines[0],
                restX,
                line0Y,
                hashHandle(verdict.handle, 'hand-note-0'),
              );
            }
            if (restLines[1]) {
              drawHandwrittenText(
                sctx,
                restLines[1],
                802,
                598,
                hashHandle(verdict.handle, 'hand-note-1'),
              );
            }

            drawHandCircle(
              sctx,
              prefixX + prefixW * 0.5,
              line0Y + 11,
              prefixW * 0.5 + 8.5,
              11.5,
              hashHandle(verdict.handle, 'hand-circle-note'),
            );
          } else {
            sctx.font = '400 24px "Reenie Beanie", cursive';
            const noteLines = wrapTextWithWidthBudget(
              boxNote,
              2,
              () => 234,
              (s) => sctx.measureText(s).width,
            );
            noteLines.forEach((line, idx) => {
              drawHandwrittenText(
                sctx,
                line,
                802,
                567 + idx * 23,
                hashHandle(verdict.handle, `hand-note-${idx}`),
              );
            });
          }

          if (circleBail && bailValW > 0) {
            drawHandCircle(
              sctx,
              bailValX + bailValW * 0.5,
              BAIL_BOX.y + 40,
              bailValW * 0.5 + 10.5,
              15.5,
              hashHandle(verdict.handle, 'hand-circle-bail'),
            );
          }
        },
        'handwriting',
        hashHandle(verdict.handle, 'card-hand-ink'),
        { color: PALETTE.hand },
      ),
  };

  return [labelsStage, receiptsStage, handwritingStage];
}

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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
  const stages: NamedRenderStage[] = [
    ...getPaperStages(ctx, verdict.handle),
    ...getHeaderStages(ctx, verdict),
    {
      name: 'mugshot',
      run: () => drawMugshot(ctx, verdict, safeAvatar, options),
    },
    ...getChargesAndBailStages(ctx, verdict),
    {
      name: 'fingerprint',
      run: () => drawFingerprint(ctx, verdict.handle),
    },
    {
      name: 'stamps',
      run: () => drawStamps(ctx, verdict),
    },
  ];

  if (!options.yieldBetweenStages) {
    for (const stage of stages) stage.run();
    return;
  }

  let computeMs = 0;
  let maxStageMs = 0;
  const stageTimings: Array<{ name: string; ms: number }> = [];
  const perf = typeof performance !== 'undefined' ? performance : null;
  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i]!;
    const t0 = perf ? perf.now() : 0;
    stage.run();
    if (perf) {
      const dt = perf.now() - t0;
      computeMs += dt;
      if (dt > maxStageMs) maxStageMs = dt;
      stageTimings.push({ name: stage.name, ms: Number(dt.toFixed(2)) });
    }
    if (i < stages.length - 1) {
      await yieldToMain();
    }
  }
  const canvasHost = ctx.canvas as unknown as {
    __lastComputeMs?: number;
    __maxStageMs?: number;
    __stageTimings?: Array<{ name: string; ms: number }>;
  };
  canvasHost.__lastComputeMs = computeMs;
  canvasHost.__maxStageMs = maxStageMs;
  canvasHost.__stageTimings = stageTimings;
}
