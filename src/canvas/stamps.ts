import { createRng, hashHandle } from '../engine/hash.js';
import type { VerdictReport } from '../engine/charges.js';
import {
  PALETTE,
  createScratchCanvas,
  type CanvasContext2DLike,
} from './paper.js';

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const VERDICT_STAMP_SPEC = {
  cx: 976,
  cy: 438,
  width: 272,
  height: 92,
  angleDeg: -9,
} as const;

export function getRotatedBoxBounds(
  cx: number,
  cy: number,
  width: number,
  height: number,
  angleDeg: number,
): BoundingBox {
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const boundW = width * cos + height * sin;
  const boundH = width * sin + height * cos;
  return {
    x: cx - boundW / 2,
    y: cy - boundH / 2,
    width: boundW,
    height: boundH,
  };
}

export function getVerdictStampBounds(): BoundingBox {
  return getRotatedBoxBounds(
    VERDICT_STAMP_SPEC.cx,
    VERDICT_STAMP_SPEC.cy,
    VERDICT_STAMP_SPEC.width,
    VERDICT_STAMP_SPEC.height,
    VERDICT_STAMP_SPEC.angleDeg,
  );
}

export function boxesIntersect(
  a: BoundingBox,
  b: BoundingBox,
  pad = 0,
): boolean {
  return (
    a.x < b.x + b.width + pad &&
    a.x + a.width + pad > b.x &&
    a.y < b.y + b.height + pad &&
    a.y + a.height + pad > b.y
  );
}

/**
 * Applies procedural ink-dropout noise onto an offscreen red stamp canvas
 * without CSS or SVG filters.
 */
function applyStampInkNoise(
  ctx: CanvasContext2DLike,
  w: number,
  h: number,
  seed: number,
): void {
  const img = ctx.getImageData(0, 0, w, h);
  const data = img.data;
  const rng = createRng(seed);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 4;
      const a = data[k + 3] ?? 0;
      if (a === 0) continue;

      const coarse =
        Math.sin(x * 0.19 + seed) * Math.cos(y * 0.23 - seed * 0.5);
      const n = rng();
      if (n < 0.14 || (coarse < -0.52 && n < 0.58)) {
        data[k + 3] = Math.floor(a * (0.12 + rng() * 0.28));
      } else {
        data[k + 3] = Math.floor(a * (0.76 + rng() * 0.24));
      }
    }
  }

  ctx.putImageData(img, 0, 0);
}

function drawForm14BStamp(ctx: CanvasContext2DLike, seed: number): void {
  const w = 132;
  const h = 34;
  const { canvas: stamp, ctx: sctx } = createScratchCanvas(w, h, ctx);

  sctx.strokeStyle = PALETTE.red;
  sctx.fillStyle = PALETTE.red;
  sctx.lineWidth = 3;
  sctx.strokeRect(2, 2, w - 4, h - 4);

  sctx.font = '700 17px "Courier Prime", monospace';
  sctx.textAlign = 'center';
  sctx.textBaseline = 'middle';
  sctx.fillText('FORM 14-B', w / 2, h / 2 + 1);

  applyStampInkNoise(sctx, w, h, seed ^ 0x13579bdf);

  ctx.save();
  ctx.translate(1076, 52);
  ctx.rotate((1.5 * Math.PI) / 180);
  ctx.globalAlpha = 0.86;
  ctx.drawImage(stamp, -w / 2, -h / 2);
  ctx.restore();
}

function drawExhibitDateStamp(
  ctx: CanvasContext2DLike,
  date: string,
  seed: number,
): void {
  const w = 230;
  const h = 30;
  const { canvas: stamp, ctx: sctx } = createScratchCanvas(w, h, ctx);

  sctx.strokeStyle = PALETTE.red;
  sctx.fillStyle = PALETTE.red;
  sctx.lineWidth = 2;
  sctx.strokeRect(2, 2, w - 4, h - 4);

  sctx.font = '700 12.5px "Courier Prime", monospace';
  sctx.textAlign = 'center';
  sctx.textBaseline = 'middle';
  sctx.fillText(`EXHIBIT A  •  ${date}`, w / 2, h / 2 + 0.5);

  applyStampInkNoise(sctx, w, h, seed ^ 0x2468ace0);

  ctx.save();
  ctx.translate(1018, 214);
  ctx.rotate((-1.8 * Math.PI) / 180);
  ctx.globalAlpha = 0.84;
  ctx.drawImage(stamp, -w / 2, -h / 2);
  ctx.restore();
}

function drawVerdictStamp(
  ctx: CanvasContext2DLike,
  verdict: VerdictReport,
  seed: number,
): void {
  const label = verdict.verdict;
  const { cx, cy, width: w, height: h, angleDeg } = VERDICT_STAMP_SPEC;
  const { canvas: stamp, ctx: sctx } = createScratchCanvas(w, h, ctx);

  sctx.strokeStyle = PALETTE.red;
  sctx.fillStyle = PALETTE.red;

  // Double-ring border in red (#a3322a)
  sctx.lineWidth = 5;
  sctx.strokeRect(3, 3, w - 6, h - 6);
  sctx.lineWidth = 2;
  sctx.strokeRect(10, 10, w - 20, h - 20);

  sctx.textAlign = 'center';
  sctx.textBaseline = 'middle';

  if (label.includes(' ')) {
    const parts = label.split(/\s+/);
    let fontSize = 28;
    sctx.font = `700 ${fontSize}px "Courier Prime", monospace`;
    const longest = parts.reduce(
      (a, b) => (a.length >= b.length ? a : b),
      '',
    );
    while (sctx.measureText(longest).width > w - 34 && fontSize > 22) {
      fontSize -= 1;
      sctx.font = `700 ${fontSize}px "Courier Prime", monospace`;
    }
    const topLine = parts[0] ?? label;
    const bottomLine = parts.slice(1).join(' ');
    sctx.fillText(topLine, w / 2, h / 2 - 13);
    sctx.fillText(bottomLine, w / 2, h / 2 + 15);
  } else {
    let fontSize = 48;
    sctx.font = `700 ${fontSize}px "Courier Prime", monospace`;
    while (sctx.measureText(label).width > w - 38 && fontSize > 26) {
      fontSize -= 2;
      sctx.font = `700 ${fontSize}px "Courier Prime", monospace`;
    }
    sctx.fillText(label, w / 2, h / 2 + 2);
  }

  applyStampInkNoise(sctx, w, h, seed ^ 0xdeadbeef);

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((angleDeg * Math.PI) / 180);
  ctx.globalAlpha = 0.88;
  ctx.drawImage(stamp, -w / 2, -h / 2);
  ctx.restore();
}

export function drawStamps(
  ctx: CanvasContext2DLike,
  verdict: VerdictReport,
): void {
  const seed = hashHandle(verdict.handle, 'stamps');
  drawForm14BStamp(ctx, seed);
  drawExhibitDateStamp(ctx, verdict.date, seed);
  drawVerdictStamp(ctx, verdict, seed);
}
