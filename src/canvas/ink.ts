import { createRng } from '../engine/hash.js';

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

export function clamp01(v: number): number {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x >= edge1 ? 1 : 0;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export function hashPixel(x: number, y: number, seed: number): number {
  let v =
    (Math.imul(x | 0, 374761393) +
      Math.imul(y | 0, 668265263) +
      Math.imul(seed | 0, 1442695041)) |
    0;
  v = Math.imul(v ^ (v >>> 13), 1274126177);
  return ((v ^ (v >>> 16)) >>> 0) / 4294967296;
}

export function valueNoise2D(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;

  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hashPixel(xi, yi, seed);
  const b = hashPixel(xi + 1, yi, seed);
  const c = hashPixel(xi, yi + 1, seed);
  const d = hashPixel(xi + 1, yi + 1, seed);

  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export function fbmNoise2D(x: number, y: number, seed: number): number {
  const n1 = valueNoise2D(x, y, seed);
  const n2 = valueNoise2D(x * 2.13 + 7.1, y * 2.13 - 3.7, seed + 101);
  return n1 * 0.65 + n2 * 0.35;
}

export function parseHexRgb(hex: string): readonly [number, number, number] {
  const clean = hex.trim().replace(/^#/, '');
  if (clean.length === 3) {
    const r = parseInt(clean[0]! + clean[0]!, 16);
    const g = parseInt(clean[1]! + clean[1]!, 16);
    const b = parseInt(clean[2]! + clean[2]!, 16);
    return [r, g, b];
  }
  const r = parseInt(clean.slice(0, 2), 16) || 0;
  const g = parseInt(clean.slice(2, 4), 16) || 0;
  const b = parseInt(clean.slice(4, 6), 16) || 0;
  return [r, g, b];
}

export type InkPresetName =
  | 'header'
  | 'labels'
  | 'receipts'
  | 'handwriting'
  | 'stamp';

export interface InkGhostSpec {
  offsetX: number;
  offsetY: number;
  blur: number;
  opacity: number;
}

export interface InkPreset {
  spread: number;
  ghost: InkGhostSpec | null;
  densityMin: number;
  densityMax: number;
  dropout: number;
}

export const INK_PRESETS: Record<InkPresetName, InkPreset> = {
  header: {
    spread: 1.2,
    ghost: { offsetX: 1.5, offsetY: 2.5, blur: 2.5, opacity: 0.22 },
    densityMin: 0.8,
    densityMax: 1.0,
    dropout: 0.02,
  },
  labels: {
    spread: 0.3,
    ghost: { offsetX: 0.5, offsetY: 0.7, blur: 0.9, opacity: 0.08 },
    densityMin: 0.88,
    densityMax: 1.0,
    dropout: 0.008,
  },
  receipts: {
    spread: 0.28,
    ghost: { offsetX: 0.5, offsetY: 0.7, blur: 0.8, opacity: 0.08 },
    densityMin: 0.9,
    densityMax: 1.0,
    dropout: 0.005,
  },
  handwriting: {
    spread: 0.3,
    ghost: null,
    densityMin: 0.85,
    densityMax: 1.0,
    dropout: 0,
  },
  stamp: {
    spread: 1.0,
    ghost: null,
    densityMin: 0.55,
    densityMax: 1.0,
    dropout: 0.08,
  },
};

/**
 * Separable fractional-radius box blur over a scalar alpha mask [0..1].
 * Pure TypeScript over Float32Array — no ctx.filter for browser/Node parity.
 */
export function boxBlurAlpha(
  mask: Float32Array | Uint8Array,
  w: number,
  h: number,
  radius: number,
  passes = 2,
): Float32Array {
  const len = w * h;
  const src = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    src[i] = mask[i] ?? 0;
  }

  if (len === 0 || w <= 0 || h <= 0 || radius <= 0 || passes <= 0) {
    return src;
  }

  const ri = Math.floor(radius);
  const frac = radius - ri;
  const hasFrac = frac > 1e-4;
  const reach = hasFrac ? ri + 1 : ri;
  const norm = 1 / (1 + 2 * radius);

  let cur = src;
  const tmp = new Float32Array(len);
  const next = new Float32Array(len);

  for (let pass = 0; pass < passes; pass++) {
    // Horizontal pass
    for (let y = 0; y < h; y++) {
      const rowOff = y * w;
      for (let x = 0; x < w; x++) {
        let acc = cur[rowOff + x] ?? 0;
        for (let k = 1; k <= reach; k++) {
          const wt = k <= ri ? 1 : frac;
          const xL = x - k < 0 ? 0 : x - k;
          const xR = x + k >= w ? w - 1 : x + k;
          acc += ((cur[rowOff + xL] ?? 0) + (cur[rowOff + xR] ?? 0)) * wt;
        }
        tmp[rowOff + x] = acc * norm;
      }
    }

    // Vertical pass
    for (let y = 0; y < h; y++) {
      const rowOff = y * w;
      for (let x = 0; x < w; x++) {
        let acc = tmp[rowOff + x] ?? 0;
        for (let k = 1; k <= reach; k++) {
          const wt = k <= ri ? 1 : frac;
          const yU = y - k < 0 ? 0 : y - k;
          const yD = y + k >= h ? h - 1 : y + k;
          acc += ((tmp[yU * w + x] ?? 0) + (tmp[yD * w + x] ?? 0)) * wt;
        }
        next[rowOff + x] = acc * norm;
      }
    }

    cur.set(next);
  }

  return cur;
}

function sampleBilinear(
  buf: Float32Array,
  w: number,
  h: number,
  x: number,
  y: number,
): number {
  if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) {
    const cx = Math.max(0, Math.min(w - 1, Math.round(x)));
    const cy = Math.max(0, Math.min(h - 1, Math.round(y)));
    return buf[cy * w + cx] ?? 0;
  }
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const i00 = y0 * w + x0;
  const v00 = buf[i00] ?? 0;
  const v10 = buf[i00 + 1] ?? 0;
  const v01 = buf[i00 + w] ?? 0;
  const v11 = buf[i00 + w + 1] ?? 0;
  const top = v00 + (v10 - v00) * fx;
  const bot = v01 + (v11 - v01) * fx;
  return top + (bot - top) * fy;
}

export interface InkLayerOptions {
  color?: string | readonly [number, number, number];
  compositeOperation?: GlobalCompositeOperation;
  alpha?: number;
  pressureMap?: (nx: number, ny: number) => number;
  secondImpression?: { offsetX: number; offsetY: number; opacity: number } | null;
}

/**
 * Renders `draw` onto a scratch surface, extracts its alpha mask, and applies
 * physical ink spread, ghost smear, low-frequency density modulation, and edge dropout.
 */
export function inkLayer(
  ctx: CanvasContext2DLike,
  draw: (scratchCtx: CanvasContext2DLike) => void,
  preset: InkPresetName | InkPreset,
  seed: number,
  options: InkLayerOptions = {},
): void {
  const p = typeof preset === 'string' ? INK_PRESETS[preset] : preset;
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  if (w <= 0 || h <= 0) return;

  const { canvas: scratchCanvas, ctx: sctx } = createScratchCanvas(w, h, ctx);

  // Preserve current transform from ctx if caller translated/rotated before calling inkLayer
  const activeTransform =
    typeof ctx.getTransform === 'function' ? ctx.getTransform() : null;
  if (activeTransform && typeof sctx.setTransform === 'function') {
    sctx.setTransform(
      activeTransform.a,
      activeTransform.b,
      activeTransform.c,
      activeTransform.d,
      activeTransform.e,
      activeTransform.f,
    );
  }

  sctx.fillStyle = '#17150f';
  sctx.strokeStyle = '#17150f';
  draw(sctx);

  if (typeof sctx.setTransform === 'function') {
    sctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  const img = sctx.getImageData(0, 0, w, h);
  const data = img.data;

  // Locate tight active ink bounding box so box blurs only touch drawn regions
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < h; y++) {
    const rowOff = y * w * 4;
    for (let x = 0; x < w; x++) {
      if ((data[rowOff + x * 4 + 3] ?? 0) > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) return;

  const ghostPad = p.ghost
    ? Math.ceil(
        Math.max(Math.abs(p.ghost.offsetX), Math.abs(p.ghost.offsetY)) +
          p.ghost.blur * 2,
      )
    : 0;
  const secondPad = options.secondImpression
    ? Math.ceil(
        Math.max(
          Math.abs(options.secondImpression.offsetX),
          Math.abs(options.secondImpression.offsetY),
        ) + 2,
      )
    : 0;
  const pad = Math.ceil(p.spread * 2) + Math.max(ghostPad, secondPad) + 3;

  const bx0 = Math.max(0, minX - pad);
  const by0 = Math.max(0, minY - pad);
  const bx1 = Math.min(w, maxX + pad + 1);
  const by1 = Math.min(h, maxY + pad + 1);
  const bw = bx1 - bx0;
  const bh = by1 - by0;
  const bLen = bw * bh;

  const coreMask = new Float32Array(bLen);
  for (let ly = 0; ly < bh; ly++) {
    const gy = by0 + ly;
    const srcRow = gy * w * 4;
    const dstRow = ly * bw;
    for (let lx = 0; lx < bw; lx++) {
      coreMask[dstRow + lx] = (data[srcRow + (bx0 + lx) * 4 + 3] ?? 0) / 255;
    }
  }

  const spreadBlur = boxBlurAlpha(coreMask, bw, bh, p.spread, 2);
  const ghostBlur = p.ghost
    ? boxBlurAlpha(coreMask, bw, bh, p.ghost.blur, 2)
    : null;

  const rgb =
    typeof options.color === 'string'
      ? parseHexRgb(options.color)
      : options.color ?? ([23, 21, 15] as const);

  const densitySpan = p.densityMax - p.densityMin;
  const contentW = Math.max(1, maxX - minX);
  const contentH = Math.max(1, maxY - minY);

  for (let ly = 0; ly < bh; ly++) {
    const gy = by0 + ly;
    const ny = (gy - minY) / contentH;
    const dstRow = gy * w * 4;
    const lRow = ly * bw;

    for (let lx = 0; lx < bw; lx++) {
      const gx = bx0 + lx;
      const idx = lRow + lx;

      const core = coreMask[idx] ?? 0;
      const sBlur = spreadBlur[idx] ?? 0;
      const spreadMask = smoothstep(0.1, 0.58, sBlur) * 0.34;
      let ink = core + spreadMask * (1 - core * 0.72);

      let ghostVal = 0;
      if (ghostBlur && p.ghost) {
        const gSample = sampleBilinear(
          ghostBlur,
          bw,
          bh,
          lx - p.ghost.offsetX,
          ly - p.ghost.offsetY,
        );
        if (gSample > 0.005) {
          const gMod =
            0.72 + 0.56 * fbmNoise2D(gx * 0.025, gy * 0.025, seed ^ 0x71c3);
          ghostVal = gSample * p.ghost.opacity * gMod;
        }
      }

      if (options.secondImpression) {
        const s2 = sampleBilinear(
          spreadBlur,
          bw,
          bh,
          lx - options.secondImpression.offsetX,
          ly - options.secondImpression.offsetY,
        );
        ghostVal = Math.max(ghostVal, s2 * options.secondImpression.opacity);
      }

      if (ink < 0.002 && ghostVal < 0.002) continue;

      const isSolidInterior = core > 0.75 && sBlur > 0.72;

      if (p.dropout > 0 && ink > 0.01 && !isSolidInterior) {
        const hEdge = hashPixel(gx, gy, seed ^ 0x2d8b);
        const isEdge = (core > 0.04 && core < 0.92) || (core === 0 && sBlur > 0.12);
        if (isEdge && hEdge < p.dropout) {
          ink *= 0.12 + 0.28 * hashPixel(gx, gy, seed + 17);
        } else if (core > 0.7 && sBlur < 0.85 && hEdge < p.dropout * 0.35) {
          ink *= 0.25 + 0.35 * hashPixel(gx, gy, seed + 31);
        } else if (
          core === 0 &&
          sBlur > 0.08 &&
          sBlur < 0.28 &&
          hEdge < p.dropout * 0.18
        ) {
          ink = Math.max(ink, 0.22 + 0.3 * hashPixel(gx, gy, seed + 53));
        }
      }

      const nLow = fbmNoise2D(gx * 0.032, gy * 0.032, seed ^ 0x3b9a);
      const nStreak = valueNoise2D(gx * 0.085, gy * 0.018, seed + 59);
      const rawDensity = p.densityMin + (nLow * 0.75 + nStreak * 0.25) * densitySpan;
      const density = isSolidInterior
        ? Math.max(rawDensity, 0.84 + 0.16 * nLow)
        : rawDensity;
      const pressure = options.pressureMap
        ? options.pressureMap((gx - minX) / contentW, ny)
        : 1;

      const inkFinal = ink * density * pressure;
      const alpha = clamp01(inkFinal + ghostVal * (1 - inkFinal * 0.72));
      const aByte = Math.round(alpha * 255);

      const k = dstRow + gx * 4;
      data[k] = rgb[0];
      data[k + 1] = rgb[1];
      data[k + 2] = rgb[2];
      data[k + 3] = aByte;
    }
  }

  sctx.putImageData(img, 0, 0);

  ctx.save();
  if (typeof ctx.setTransform === 'function') {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  if (options.compositeOperation) {
    ctx.globalCompositeOperation = options.compositeOperation;
  }
  if (options.alpha !== undefined) {
    ctx.globalAlpha = options.alpha;
  }
  ctx.drawImage(scratchCanvas, 0, 0);
  ctx.restore();
}

/**
 * Draws typed text glyph-by-glyph with subtle typewriter baseline jitter (±0.4px),
 * opacity variation (0.88..1.0), and occasional heavier double-struck glyphs.
 * Preserves exact measureText layout width for deterministic collision safety.
 */
export function drawTypewriterText(
  ctx: CanvasContext2DLike,
  text: string,
  x: number,
  y: number,
  seed: number,
  maxWidth?: number,
): void {
  if (!text) return;
  const rng = createRng(seed ^ 0x6a09e667);
  const fullW = ctx.measureText(text).width;
  const scaleX =
    maxWidth !== undefined && fullW > maxWidth && fullW > 0
      ? maxWidth / fullW
      : 1;
  const drawnW = fullW * scaleX;

  let startX = x;
  if (ctx.textAlign === 'center') {
    startX = x - drawnW / 2;
  } else if (ctx.textAlign === 'right' || ctx.textAlign === 'end') {
    startX = x - drawnW;
  }

  ctx.save();
  const baseAlpha = ctx.globalAlpha;
  const sizeMatch = /(\d+(?:\.\d+)?)px/.exec(ctx.font);
  const fontPx = sizeMatch ? Number(sizeMatch[1]) : 14;
  const allowJitter = fontPx >= 10;
  ctx.textAlign = 'left';

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === ' ') {
      rng();
      rng();
      rng();
      continue;
    }
    const offset = ctx.measureText(text.slice(0, i)).width * scaleX;
    const gx = startX + offset;
    const jitterRoll = rng();
    const dy = allowJitter ? (jitterRoll * 2 - 1) * 0.4 : 0;
    const glyphAlpha = 0.88 + rng() * 0.12;
    const heavy = rng() < 0.13;
    const strikeDy = allowJitter ? 0.15 : 0;

    ctx.globalAlpha = baseAlpha * glyphAlpha;
    if (scaleX < 1) {
      const charW = ctx.measureText(ch).width * scaleX;
      ctx.fillText(ch, gx, y + dy, Math.max(1, charW + 1));
      if (heavy) {
        ctx.globalAlpha = baseAlpha * glyphAlpha * 0.5;
        ctx.fillText(ch, gx + 0.4, y + dy + strikeDy, Math.max(1, charW + 1));
      }
    } else {
      ctx.fillText(ch, gx, y + dy);
      if (heavy) {
        ctx.globalAlpha = baseAlpha * glyphAlpha * 0.5;
        ctx.fillText(ch, gx + 0.4, y + dy + strikeDy);
      }
    }
  }

  ctx.restore();
}

/**
 * Draws a quick wobbly ballpoint underline with slight pen taper.
 */
export function drawWobblyUnderline(
  ctx: CanvasContext2DLike,
  x: number,
  y: number,
  width: number,
  seed: number,
): void {
  if (width <= 4) return;
  const rng = createRng(seed ^ 0x85ebca6b);
  const steps = 6;
  const slope = (rng() - 0.5) * 1.6;
  ctx.save();
  ctx.lineWidth = 1.25;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(x, y + (rng() - 0.5) * 0.8);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const px = x + width * t;
    const py = y + slope * t + (rng() - 0.5) * 1.4;
    ctx.lineTo(px, py);
  }
  ctx.stroke();
  ctx.restore();
}

/**
 * Draws a handwritten line in ballpoint ink with seeded per-line rotation (±1.2°),
 * subtle pressure variation across words, and an optional quick wobbly underline.
 */
export function drawHandwrittenText(
  ctx: CanvasContext2DLike,
  text: string,
  x: number,
  y: number,
  seed: number,
  options: {
    baseRotateDeg?: number;
    maxWidth?: number;
    underline?: boolean;
  } = {},
): void {
  if (!text) return;
  const rng = createRng(seed ^ 0xc2b2ae35);
  const rotDeg = (options.baseRotateDeg ?? 0) + (rng() * 2 - 1) * 1.2;

  const fullW = ctx.measureText(text).width;
  const scaleX =
    options.maxWidth !== undefined && fullW > options.maxWidth && fullW > 0
      ? options.maxWidth / fullW
      : 1;
  const drawnW = fullW * scaleX;

  let localStart = 0;
  if (ctx.textAlign === 'center') {
    localStart = -drawnW / 2;
  } else if (ctx.textAlign === 'right' || ctx.textAlign === 'end') {
    localStart = -drawnW;
  }

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((rotDeg * Math.PI) / 180);
  const baseAlpha = ctx.globalAlpha;
  const baseline = ctx.textBaseline;
  ctx.textAlign = 'left';

  const tokens = text.match(/\S+\s*/g) ?? [text];
  let cursor = 0;
  for (const token of tokens) {
    const offset = ctx.measureText(text.slice(0, cursor)).width * scaleX;
    const dy = (rng() * 2 - 1) * 0.45;
    const pressureAlpha = 0.85 + rng() * 0.15;
    ctx.globalAlpha = baseAlpha * pressureAlpha;
    if (scaleX < 1) {
      const tokW = ctx.measureText(token).width * scaleX;
      ctx.fillText(token, localStart + offset, dy, Math.max(1, tokW + 1));
    } else {
      ctx.fillText(token, localStart + offset, dy);
    }
    cursor += token.length;
  }

  if (options.underline) {
    const sizeMatch = /(\d+(?:\.\d+)?)px/.exec(ctx.font);
    const px = sizeMatch ? Number(sizeMatch[1]) : 24;
    const underY =
      baseline === 'middle'
        ? px * 0.42
        : baseline === 'alphabetic'
          ? 3
          : px * 0.9;
    ctx.globalAlpha = baseAlpha * 0.82;
    drawWobblyUnderline(ctx, localStart, underY, drawnW, seed ^ 0x41a2);
  }

  ctx.restore();
}

/**
 * Draws a hand-drawn ballpoint circle made from two overlapping strokes
 * with a small overshoot and organic wobble.
 */
export function drawHandCircle(
  ctx: CanvasContext2DLike,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  seed: number,
): void {
  const rng = createRng(seed ^ 0x27d4eb2f);
  ctx.save();
  const baseAlpha = ctx.globalAlpha;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const exp = 0.7;

  const drawPass = (
    ox: number,
    oy: number,
    a0: number,
    sweep: number,
    lineW: number,
    alphaMul: number,
  ) => {
    const steps = 32;
    ctx.lineWidth = lineW;
    ctx.globalAlpha = baseAlpha * alphaMul;
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const ang = a0 + sweep * t;
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      // Outward-biased wobble so the loop never cuts inward across text
      const wobbleR = 1.0 + rng() * 0.06;
      const sx = Math.sign(c) * Math.pow(Math.abs(c), exp);
      const sy = Math.sign(s) * Math.pow(Math.abs(s), exp);
      const px = cx + ox + sx * rx * wobbleR;
      const py = cy + oy + sy * ry * wobbleR;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  };

  const a0 = -0.35 + rng() * 0.6;
  drawPass(0, 0, a0, Math.PI * (2.08 + rng() * 0.14), 1.4, 0.92);
  drawPass(
    (rng() - 0.5) * 2.0,
    (rng() - 0.5) * 1.4,
    a0 + 0.45 + rng() * 0.5,
    Math.PI * (1.85 + rng() * 0.24),
    1.15,
    0.66,
  );

  ctx.restore();
}
