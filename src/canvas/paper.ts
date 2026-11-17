import { createRng, hashHandle } from '../engine/hash.js';
import type { VerdictReport } from '../engine/charges.js';

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 675;

export const PALETTE = {
  ink: '#17150f',
  paper: '#e6dac0',
  print: '#f3efe3',
  red: '#a3322a',
  hand: '#243a6b',
  desk: '#292927',
  tape: '#d9c99c',
} as const;

export type CanvasContext2DLike =
  | CanvasRenderingContext2D
  | OffscreenCanvasRenderingContext2D;

export interface ScratchSurface {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  ctx: CanvasContext2DLike;
}

/**
 * Creates a scratch 2D canvas strictly from the host context's canvas ownerDocument
 * or constructor — no global `document` or `OffscreenCanvas` references inside draw().
 */
export function createScratchCanvas(
  width: number,
  height: number,
  referenceCtx: CanvasContext2DLike,
): ScratchSurface {
  const hostCanvas = referenceCtx.canvas as unknown as {
    ownerDocument?: { createElement: (tag: string) => HTMLCanvasElement };
    constructor?: new (w: number, h: number) => HTMLCanvasElement;
  };

  if (hostCanvas.ownerDocument?.createElement) {
    const canvas = hostCanvas.ownerDocument.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to acquire 2D context for scratch canvas.');
    }
    return { canvas, ctx };
  }

  if (hostCanvas.constructor) {
    const canvas = new hostCanvas.constructor(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to acquire 2D context from host canvas constructor.');
    }
    return { canvas, ctx };
  }

  throw new Error('Host 2D context does not provide a scratch canvas factory.');
}

function drawPaperBaseWithGrainAndCrease(
  ctx: CanvasContext2DLike,
  seed: number,
): void {
  const img = ctx.createImageData(CARD_WIDTH, CARD_HEIGHT);
  const data = img.data;
  const rng = createRng(seed ^ 0x9e3779b9);

  // Base #e6dac0 = (230, 218, 192), blended procedurally with deterministic paper grain
  const foldY = Math.floor(CARD_HEIGHT / 2);

  for (let y = 0; y < CARD_HEIGHT; y++) {
    const foldDark = y === foldY ? 0.045 : 0;
    const foldLight = y === foldY + 1 ? 0.075 : 0;

    for (let x = 0; x < CARD_WIDTH; x++) {
      const k = (y * CARD_WIDTH + x) * 4;
      let r = 230;
      let g = 218;
      let b = 192;

      const n = rng();
      if (n < 0.16) {
        const alpha = (8 + rng() * 14) / 255;
        r = r * (1 - alpha) + 23 * alpha;
        g = g * (1 - alpha) + 21 * alpha;
        b = b * (1 - alpha) + 15 * alpha;
      } else if (n > 0.88) {
        const alpha = (10 + rng() * 18) / 255;
        r = r * (1 - alpha) + 243 * alpha;
        g = g * (1 - alpha) + 239 * alpha;
        b = b * (1 - alpha) + 227 * alpha;
      } else {
        const alpha = (rng() * 10) / 255;
        r = r * (1 - alpha) + 178 * alpha;
        g = g * (1 - alpha) + 164 * alpha;
        b = b * (1 - alpha) + 132 * alpha;
      }

      if (foldDark > 0) {
        r = r * (1 - foldDark) + 23 * foldDark;
        g = g * (1 - foldDark) + 21 * foldDark;
        b = b * (1 - foldDark) + 15 * foldDark;
      } else if (foldLight > 0) {
        r = r * (1 - foldLight) + 243 * foldLight;
        g = g * (1 - foldLight) + 239 * foldLight;
        b = b * (1 - foldLight) + 227 * foldLight;
      }

      data[k] = Math.round(r);
      data[k + 1] = Math.round(g);
      data[k + 2] = Math.round(b);
      data[k + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
}

function valueNoise2D(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;

  const h = (ix: number, iy: number): number => {
    let v = (ix * 374761393 + iy * 668265263 + seed * 1442695041) | 0;
    v = Math.imul(v ^ (v >>> 13), 1274126177);
    return ((v ^ (v >>> 16)) >>> 0) / 4294967296;
  };

  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = h(xi, yi);
  const b = h(xi + 1, yi);
  const c = h(xi, yi + 1);
  const d = h(xi + 1, yi + 1);

  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function drawTonerStreak(ctx: CanvasContext2DLike, seed: number): void {
  const w = 48;
  const h = CARD_HEIGHT;
  const { canvas: streak, ctx: sctx } = createScratchCanvas(w, h, ctx);
  const img = sctx.createImageData(w, h);
  const data = img.data;
  const rng = createRng(seed ^ 0x517cc1b7);

  const colBias = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    colBias[x] = (rng() - 0.5) * 0.14;
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const falloff = Math.max(0, 1 - x / w);
      const n1 = valueNoise2D(x * 0.28, y * 0.08, seed);
      const n2 = valueNoise2D(x * 0.72, y * 0.36, seed + 17);
      const density =
        falloff * 1.12 +
        (n1 * 0.65 + n2 * 0.35 - 0.45) * 0.85 +
        (colBias[x] ?? 0);

      const k = (y * w + x) * 4;
      if (density > 0.46) {
        data[k] = 23;
        data[k + 1] = 21;
        data[k + 2] = 15;
        const alpha = Math.min(255, Math.floor((density - 0.44) * 420));
        data[k + 3] = alpha;
      } else {
        data[k] = 23;
        data[k + 1] = 21;
        data[k + 2] = 15;
        data[k + 3] = 0;
      }
    }
  }

  sctx.putImageData(img, 0, 0);
  ctx.drawImage(streak, 0, 0);
}

function drawPunchHoles(ctx: CanvasContext2DLike): void {
  const holes = [
    { x: 22, y: 60 },
    { x: 22, y: 100 },
  ];
  const radius = 8.5;

  ctx.save();
  for (const hole of holes) {
    ctx.beginPath();
    ctx.arc(hole.x, hole.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = PALETTE.desk;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(hole.x, hole.y, radius - 0.8, Math.PI * 0.9, Math.PI * 1.85);
    ctx.strokeStyle = 'rgba(23, 21, 15, 0.75)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.restore();
}

export function drawPaper(ctx: CanvasContext2DLike, handle: string): void {
  const seed = hashHandle(handle, 'paper');

  ctx.save();
  drawPaperBaseWithGrainAndCrease(ctx, seed);
  drawTonerStreak(ctx, seed);
  drawPunchHoles(ctx);
  ctx.restore();
}

export function drawHeaderAndFields(
  ctx: CanvasContext2DLike,
  verdict: VerdictReport,
): void {
  const x0 = 80;
  const x1 = 1150;
  const w = x1 - x0;

  ctx.save();
  ctx.fillStyle = PALETTE.ink;
  ctx.strokeStyle = PALETTE.ink;

  // Header band: shifted down slightly (y 30..117) so 1.91:1 (1200x628) center crop leaves safe top margin
  ctx.fillRect(x0, 30, w, 4);
  ctx.fillRect(x0, 37, w, 1.5);
  ctx.fillRect(x0, 108, w, 1.5);
  ctx.fillRect(x0, 113, w, 4);

  const title = 'SUBPOENA — RAP SHEET';
  ctx.font = '700 44px "Courier Prime", monospace';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';

  const titleX = x0 + w / 2 - 42;
  const titleY = 74;
  ctx.fillStyle = 'rgba(23, 21, 15, 0.25)';
  ctx.fillText(title, titleX + 1, titleY + 1);
  ctx.fillText(title, titleX - 0.6, titleY);
  ctx.fillStyle = PALETTE.ink;
  ctx.fillText(title, titleX, titleY);

  // Fields row: 80-1150, 124-178
  const rowY = 124;
  const rowH = 54;
  ctx.lineWidth = 2;
  ctx.strokeRect(x0, rowY, w, rowH);

  const col1W = Math.round(w * 0.32);
  const col2W = Math.round(w * 0.28);
  const div1X = x0 + col1W;
  const div2X = div1X + col2W;

  ctx.beginPath();
  ctx.moveTo(div1X, rowY);
  ctx.lineTo(div1X, rowY + rowH);
  ctx.moveTo(div2X, rowY);
  ctx.lineTo(div2X, rowY + rowH);
  ctx.stroke();

  const fields: ReadonlyArray<{
    x: number;
    w: number;
    label: string;
    value: string;
  }> = [
    { x: x0, w: col1W, label: 'CASE NO.', value: verdict.caseNumber },
    { x: div1X, w: col2W, label: 'DATE:', value: verdict.date },
    { x: div2X, w: x1 - div2X, label: 'OFFICER:', value: verdict.officer },
  ];

  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  for (const field of fields) {
    ctx.font = '700 11px "Courier Prime", monospace';
    ctx.fillStyle = PALETTE.ink;
    ctx.fillText(field.label, field.x + 10, rowY + 6);

    ctx.font = '700 20px "Courier Prime", monospace';
    ctx.fillText(field.value, field.x + 10, rowY + 24, field.w - 20);
  }

  ctx.restore();
}
