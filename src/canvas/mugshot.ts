import { createRng, hashHandle } from '../engine/hash.js';
import type { VerdictReport } from '../engine/charges.js';
import {
  INK_RGB,
  PRINT_RGB,
  applyPhotocopyToneCurve,
  classifyAvatar,
  equalizeHistogramCLAHE,
  extractLuminance,
  hardThreshold,
  legacyNormalizeContrast,
  type AvatarKind,
  type ContrastMode,
} from '../lib/atkinson.js';
import {
  boxBlurAlpha,
  clamp01,
  createScratchCanvas,
  drawHandwrittenText,
  drawTypewriterText,
  fbmNoise2D,
  hashPixel,
  inkLayer,
  smoothstep,
  valueNoise2D,
  type CanvasContext2DLike,
} from './ink.js';
import { PALETTE } from './paper.js';

export type AvatarImage =
  | HTMLImageElement
  | HTMLCanvasElement
  | ImageBitmap
  | OffscreenCanvas;

export type FlatAvatarMode = 'bordered-box' | 'silhouette';
export type MugshotVariant = 'A' | 'B' | 'C';

export interface MugshotOptions {
  flatAvatarMode?: FlatAvatarMode;
  contrastMode?: ContrastMode;
  mugshotVariant?: MugshotVariant;
}

const LOW_W = 126;
const LOW_H = 158;
const NATIVE_W = 252;
const NATIVE_H = 316;

// Warm photocopy highlight base (distinctly warmer/tinted than pure #f3efe3)
const WARM_PAPER_RGB = [235, 224, 201] as const;

const ATKINSON_KERNEL: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [2, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
  [0, 2],
];

function getImageDimensions(
  img: AvatarImage,
): { width: number; height: number } | null {
  if ('naturalWidth' in img) {
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      return { width: img.naturalWidth, height: img.naturalHeight };
    }
    return null;
  }
  if (img.width > 0 && img.height > 0) {
    return { width: img.width, height: img.height };
  }
  return null;
}

function drawHeightChartWall(
  ctx: CanvasContext2DLike,
  w: number,
  h: number,
): void {
  ctx.fillStyle = PALETTE.print;
  ctx.fillRect(0, 0, w, h);

  // Thin, light height lines (~35% ink for major, ~16% ink for minor) behind the subject
  for (let y = 24; y < h - 48; y += 24) {
    const isMajor = (y - 24) % 48 === 0;
    ctx.fillStyle = isMajor
      ? 'rgba(23, 21, 15, 0.35)'
      : 'rgba(23, 21, 15, 0.16)';
    ctx.fillRect(0, y, w, 1);

    ctx.fillStyle = 'rgba(23, 21, 15, 0.35)';
    const tickLen = isMajor ? 12 : 7;
    ctx.fillRect(0, y, tickLen, 1);
    ctx.fillRect(w - tickLen, y, tickLen, 1);
  }
}

function drawProceduralSilhouette(
  ctx: CanvasContext2DLike,
  w: number,
  h: number,
  seed: number,
): void {
  const rng = createRng(seed);
  const headShift = Math.round((rng() - 0.5) * 8);
  const hasGlasses = (seed & 1) === 1;
  const hasHat = (seed & 2) === 2;

  // Shoulders (modeled gradient for halftone/photocopy midtones)
  const shoulderGrad = ctx.createLinearGradient(0, 190, 0, h - 44);
  shoulderGrad.addColorStop(0, '#3e3a30');
  shoulderGrad.addColorStop(0.5, '#29261f');
  shoulderGrad.addColorStop(1, '#1a1813');
  ctx.fillStyle = shoulderGrad;
  ctx.beginPath();
  ctx.moveTo(24, h - 44);
  ctx.quadraticCurveTo(32, 200, w / 2, 192);
  ctx.quadraticCurveTo(w - 32, 200, w - 24, h - 44);
  ctx.closePath();
  ctx.fill();

  // Neck
  const neckGrad = ctx.createLinearGradient(w / 2 - 18, 156, w / 2 + 18, 200);
  neckGrad.addColorStop(0, '#726b5c');
  neckGrad.addColorStop(0.5, '#9d9582');
  neckGrad.addColorStop(1, '#615a4d');
  ctx.fillStyle = neckGrad;
  ctx.fillRect(w / 2 - 18, 156, 36, 44);

  // Head
  const grad = ctx.createRadialGradient(
    w / 2 - 14,
    98 + headShift,
    18,
    w / 2,
    112 + headShift,
    104,
  );
  grad.addColorStop(0, '#d2cab6');
  grad.addColorStop(0.55, '#827a69');
  grad.addColorStop(1, '#2d2a22');

  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.ellipse(w / 2, 112 + headShift, 50, 64, 0, 0, Math.PI * 2);
  ctx.fill();

  // Hair or fedora
  ctx.fillStyle = '#1b1914';
  if (hasHat) {
    ctx.fillRect(48, 62 + headShift, w - 96, 10);
    ctx.beginPath();
    ctx.ellipse(w / 2, 62 + headShift, 40, 28, 0, Math.PI, 0);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.ellipse(w / 2, 66 + headShift, 52, 28, 0, Math.PI, 0);
    ctx.fill();
    ctx.fillRect(w / 2 - 52, 64 + headShift, 10, 32);
    ctx.fillRect(w / 2 + 42, 64 + headShift, 10, 32);
  }

  // Features
  ctx.fillStyle = '#2b2820';
  ctx.fillRect(w / 2 - 22, 106 + headShift, 10, 6);
  ctx.fillRect(w / 2 + 12, 106 + headShift, 10, 6);
  ctx.fillRect(w / 2 - 6, 140 + headShift, 12, 4);

  if (hasGlasses) {
    ctx.strokeStyle = '#17150f';
    ctx.lineWidth = 3;
    ctx.strokeRect(w / 2 - 32, 98 + headShift, 28, 20);
    ctx.strokeRect(w / 2 + 4, 98 + headShift, 28, 20);
    ctx.beginPath();
    ctx.moveTo(w / 2 - 4, 108 + headShift);
    ctx.lineTo(w / 2 + 4, 108 + headShift);
    ctx.stroke();
  }
}

/**
 * Prevents dark-background flat logos (e.g. Vercel, Dependabot) from rendering as
 * heavy solid black blocks inside the bordered flat-avatar box.
 */
function ensureLightGroundIcon(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
): Uint8ClampedArray {
  let darkTotal = 0;
  let darkBorder = 0;
  let borderTotal = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 4;
      const isDark = rgba[k] === INK_RGB[0];
      if (isDark) darkTotal++;
      if (x < 6 || x >= w - 6 || y < 6 || y >= h - 6) {
        borderTotal++;
        if (isDark) darkBorder++;
      }
    }
  }

  const totalRatio = darkTotal / (w * h);
  const borderRatio = borderTotal > 0 ? darkBorder / borderTotal : 0;

  if (totalRatio > 0.52 || borderRatio > 0.58) {
    const inverted = new Uint8ClampedArray(rgba.length);
    for (let i = 0; i < rgba.length; i += 4) {
      const isDark = rgba[i] === INK_RGB[0];
      const rgb = isDark ? PRINT_RGB : INK_RGB;
      inverted[i] = rgb[0];
      inverted[i + 1] = rgb[1];
      inverted[i + 2] = rgb[2];
      inverted[i + 3] = 255;
    }
    return inverted;
  }

  return rgba;
}

/**
 * Renders an ink mask (0 = paper, 1 = full ink) into a warm-tinted photocopy surface
 * with faint border bleed so highlights are never pure #f3efe3.
 */
function compositePhotocopyPrint(
  targetCtx: CanvasContext2DLike,
  inkMask: Float32Array,
  w: number,
  h: number,
  seed: number,
): void {
  const out = targetCtx.createImageData(w, h);
  const d = out.data;

  for (let y = 0; y < h; y++) {
    const distY = Math.min(y, h - 1 - y);
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const distX = Math.min(x, w - 1 - x);
      const edgeDist = Math.min(distX, distY);

      let ink = clamp01(inkMask[idx] ?? 0);

      // Subtle border bleed around the print viewport
      if (edgeDist < 6) {
        const bleedNoise =
          0.65 + 0.7 * valueNoise2D(x * 0.22, y * 0.22, seed ^ 0x5c3a);
        const bleed = Math.pow(1 - edgeDist / 6, 1.8) * 0.1 * bleedNoise;
        ink = clamp01(ink + bleed * (1 - ink));
      }

      // Warm paper highlight tint (multiplied over #f3efe3 with subtle mottling)
      const paperTone = valueNoise2D(x * 0.04, y * 0.04, seed ^ 0x72b1) - 0.5;
      const pr = WARM_PAPER_RGB[0] + paperTone * 5;
      const pg = WARM_PAPER_RGB[1] + paperTone * 4;
      const pb = WARM_PAPER_RGB[2] - paperTone * 3;

      const k = idx * 4;
      d[k] = Math.round(pr * (1 - ink) + INK_RGB[0] * ink);
      d[k + 1] = Math.round(pg * (1 - ink) + INK_RGB[1] * ink);
      d[k + 2] = Math.round(pb * (1 - ink) + INK_RGB[2] * ink);
      d[k + 3] = 255;
    }
  }

  targetCtx.putImageData(out, 0, 0);
}

function renderPhotoMask(
  curvedLum: Float32Array,
  w: number,
  h: number,
  variant: MugshotVariant,
  seed: number,
): Float32Array {
  const len = w * h;

  if (variant === 'B') {
    // Variant B: Atkinson dither at native 252x316 + 0.5px ink spread so dots merge
    const work = new Float32Array(curvedLum);
    const rawMask = new Float32Array(len);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        const oldVal = Math.max(0, Math.min(255, work[idx] ?? 0));
        const isLight = oldVal >= 128;
        const quant = isLight ? 255 : 0;
        const err = (oldVal - quant) / 8;

        for (const [dx, dy] of ATKINSON_KERNEL) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
            const nIdx = ny * w + nx;
            work[nIdx] = (work[nIdx] ?? 0) + err;
          }
        }
        rawMask[idx] = isLight ? 0 : 1;
      }
    }

    const spread = boxBlurAlpha(rawMask, w, h, 0.5, 2);
    const merged = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      merged[i] = clamp01((rawMask[i] ?? 0) * 0.78 + (spread[i] ?? 0) * 0.46);
    }
    return merged;
  }

  if (variant === 'C') {
    // Variant C: Tone-curved grayscale quantized to ~5 ink levels + light grain, no dither
    const levels = new Float32Array(len);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        const darkness = 1 - (curvedLum[idx] ?? 0) / 255;
        const grain = (hashPixel(x, y, seed ^ 0x4b1d) - 0.5) * 0.05;
        const d = clamp01(darkness + grain);
        const q = (Math.round(d * 4) / 4) * 0.96;
        levels[idx] = clamp01(q * 0.8 + d * 0.2);
      }
    }
    return boxBlurAlpha(levels, w, h, 0.35, 1);
  }

  // Variant A (Default): halftone below ~70% luminance, clean highlights, softened midtone grid
  const rawMask = new Float32Array(len);
  const cos45 = Math.SQRT1_2;
  const period = 3.0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const lum01 = (curvedLum[idx] ?? 0) / 255;
      // Keep highlights >= ~70% luminance clean without halftone dot noise
      const highlightGate = 1 - smoothstep(0.58, 0.72, lum01);
      if (highlightGate <= 0.001) {
        rawMask[idx] = 0;
        continue;
      }

      // Organic phase warp & micro-grain to soften midtone grid moiré
      const warpU = (fbmNoise2D(x * 0.14, y * 0.14, seed ^ 0x31a7) - 0.5) * 0.65;
      const warpV =
        (fbmNoise2D(x * 0.14 + 9.3, y * 0.14 - 4.1, seed ^ 0x84c2) - 0.5) *
        0.65;
      const micro = (hashPixel(x, y, seed ^ 0x227b) - 0.5) * 0.12;

      const u = (((x - y) * cos45) / period) * Math.PI + warpU;
      const v = (((x + y) * cos45) / period) * Math.PI + warpV;
      const screen = 0.5 + 0.25 * (Math.cos(2 * u) + Math.cos(2 * v)) + micro;
      const darkness = 1 - lum01;
      const dot = smoothstep(screen - 0.18, screen + 0.18, darkness);
      rawMask[idx] = (dot * 0.58 + darkness * 0.42) * highlightGate;
    }
  }

  const spread = boxBlurAlpha(rawMask, w, h, 0.7, 2);
  const out = new Float32Array(len);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const base = (rawMask[idx] ?? 0) * 0.58 + (spread[idx] ?? 0) * 0.52;
      if (base <= 0.015) {
        out[idx] = 0;
      } else {
        const tonerNoise = (hashPixel(x, y, seed ^ 0x91e7) - 0.5) * 0.035;
        out[idx] = clamp01(base + tonerNoise);
      }
    }
  }
  return out;
}

function renderSilhouettePhotocopyMask(
  wctx: CanvasContext2DLike,
  w: number,
  h: number,
  variant: MugshotVariant,
  seed: number,
): Float32Array {
  const raw = wctx.getImageData(0, 0, w, h);
  const lum = extractLuminance(raw.data, w, h, PRINT_RGB);
  const wallBgLum = 0.299 * PRINT_RGB[0] + 0.587 * PRINT_RGB[1] + 0.114 * PRINT_RGB[2];
  const shaped = new Float32Array(lum.length);

  for (let i = 0; i < lum.length; i++) {
    const v = lum[i] ?? wallBgLum;
    // Keep wall highlights above 72% luminance clean while running subject & wall lines through photocopy curve
    shaped[i] = v >= wallBgLum - 2 ? 255 : Math.max(0, Math.min(255, (v / wallBgLum) * 238));
  }

  return renderPhotoMask(shaped, w, h, variant, seed);
}

export interface MugshotRenderResult {
  surface: HTMLCanvasElement | OffscreenCanvas;
  kind: AvatarKind | 'missing';
}

export function renderMugshotViewport(
  ctx: CanvasContext2DLike,
  verdict: VerdictReport,
  avatar: AvatarImage | null,
  options: MugshotOptions = {},
): MugshotRenderResult {
  const seed = hashHandle(verdict.handle, 'mugshot');
  const variant: MugshotVariant = options.mugshotVariant ?? 'A';
  const { canvas: wallCanvas, ctx: wctx } = createScratchCanvas(
    NATIVE_W,
    NATIVE_H,
    ctx,
  );

  const dims = avatar ? getImageDimensions(avatar) : null;
  if (!avatar || !dims) {
    drawHeightChartWall(wctx, NATIVE_W, NATIVE_H);
    drawProceduralSilhouette(
      wctx,
      NATIVE_W,
      NATIVE_H,
      hashHandle(verdict.handle, 'silhouette'),
    );
    const mask = renderSilhouettePhotocopyMask(
      wctx,
      NATIVE_W,
      NATIVE_H,
      variant,
      seed,
    );
    compositePhotocopyPrint(wctx, mask, NATIVE_W, NATIVE_H, seed);
    return { surface: wallCanvas, kind: 'missing' };
  }

  // Probe 126x158 cover crop so classification matches exact avatar semantics
  const { ctx: pctx } = createScratchCanvas(LOW_W, LOW_H, ctx);
  const probeScale = Math.max(LOW_W / dims.width, LOW_H / dims.height);
  const pdw = dims.width * probeScale;
  const pdh = dims.height * probeScale;
  pctx.clearRect(0, 0, LOW_W, LOW_H);
  pctx.drawImage(avatar, (LOW_W - pdw) / 2, (LOW_H - pdh) / 2, pdw, pdh);
  const probeData = pctx.getImageData(0, 0, LOW_W, LOW_H);
  const kind = classifyAvatar(probeData.data, LOW_W, LOW_H);

  if (kind === 'photo') {
    const coverScale = Math.max(NATIVE_W / dims.width, NATIVE_H / dims.height);
    const cdw = dims.width * coverScale;
    const cdh = dims.height * coverScale;
    const cdx = (NATIVE_W - cdw) / 2;
    const cdy = (NATIVE_H - cdh) / 2;

    wctx.fillStyle = PALETTE.print;
    wctx.fillRect(0, 0, NATIVE_W, NATIVE_H);
    wctx.drawImage(avatar, cdx, cdy, cdw, cdh);
    const fullPhoto = wctx.getImageData(0, 0, NATIVE_W, NATIVE_H);

    const rawLum = extractLuminance(
      fullPhoto.data,
      NATIVE_W,
      NATIVE_H,
      PRINT_RGB,
    );
    let softLum: Float32Array;
    if (options.contrastMode === 'legacy') {
      softLum = legacyNormalizeContrast(rawLum);
    } else {
      const clahe = equalizeHistogramCLAHE(rawLum, NATIVE_W, NATIVE_H);
      softLum = new Float32Array(rawLum.length);
      for (let i = 0; i < rawLum.length; i++) {
        softLum[i] = (clahe[i] ?? 0) * 0.72 + (rawLum[i] ?? 0) * 0.28;
      }
    }

    const curvedLum = applyPhotocopyToneCurve(softLum);
    const inkMask = renderPhotoMask(
      curvedLum,
      NATIVE_W,
      NATIVE_H,
      variant,
      seed,
    );
    compositePhotocopyPrint(wctx, inkMask, NATIVE_W, NATIVE_H, seed);
    return { surface: wallCanvas, kind: 'photo' };
  }

  // Flat / identicon / logo mode
  const flatMode: FlatAvatarMode =
    options.flatAvatarMode ??
    (kind === 'identicon' ? 'silhouette' : 'bordered-box');
  drawHeightChartWall(wctx, NATIVE_W, NATIVE_H);

  if (flatMode === 'silhouette') {
    drawProceduralSilhouette(
      wctx,
      NATIVE_W,
      NATIVE_H,
      hashHandle(verdict.handle, 'silhouette'),
    );
    const mask = renderSilhouettePhotocopyMask(
      wctx,
      NATIVE_W,
      NATIVE_H,
      variant,
      seed,
    );
    compositePhotocopyPrint(wctx, mask, NATIVE_W, NATIVE_H, seed);
    return { surface: wallCanvas, kind };
  }

  // 'bordered-box': render flat glyph inside a clean thin-bordered paper box at native 252x316
  const boxSize = 144;
  const innerSize = 124;
  const boxX = Math.round((NATIVE_W - boxSize) / 2);
  const boxY = 36;
  const innerX = boxX + 10;
  const innerY = boxY + 10;

  const { ctx: ictx } = createScratchCanvas(innerSize, innerSize, ctx);
  ictx.fillStyle = PALETTE.print;
  ictx.fillRect(0, 0, innerSize, innerSize);
  const fitScale = Math.min(innerSize / dims.width, innerSize / dims.height);
  const idw = dims.width * fitScale;
  const idh = dims.height * fitScale;
  ictx.drawImage(
    avatar,
    (innerSize - idw) / 2,
    (innerSize - idh) / 2,
    idw,
    idh,
  );
  const iconData = ictx.getImageData(0, 0, innerSize, innerSize);
  const thresh = ensureLightGroundIcon(
    hardThreshold(iconData.data, innerSize, innerSize, PRINT_RGB, INK_RGB),
    innerSize,
    innerSize,
  );

  wctx.fillStyle = PALETTE.print;
  wctx.fillRect(boxX, boxY, boxSize, boxSize);
  wctx.strokeStyle = PALETTE.ink;
  wctx.lineWidth = 1.5;
  wctx.strokeRect(boxX + 0.75, boxY + 0.75, boxSize - 1.5, boxSize - 1.5);

  const iconImg = wctx.createImageData(innerSize, innerSize);
  iconImg.data.set(thresh);
  wctx.putImageData(iconImg, innerX, innerY);

  // Convert bordered-box composite into an ink mask with light photocopy spread + warm tint
  const compositeData = wctx.getImageData(0, 0, NATIVE_W, NATIVE_H);
  const compLum = extractLuminance(
    compositeData.data,
    NATIVE_W,
    NATIVE_H,
    PRINT_RGB,
  );
  const rawMask = new Float32Array(NATIVE_W * NATIVE_H);
  for (let i = 0; i < rawMask.length; i++) {
    rawMask[i] = clamp01((243 - (compLum[i] ?? 243)) / (243 - 23));
  }
  const spread = boxBlurAlpha(rawMask, NATIVE_W, NATIVE_H, 0.45, 1);
  const merged = new Float32Array(rawMask.length);
  for (let i = 0; i < rawMask.length; i++) {
    merged[i] = clamp01((rawMask[i] ?? 0) * 0.75 + (spread[i] ?? 0) * 0.35);
  }
  compositePhotocopyPrint(wctx, merged, NATIVE_W, NATIVE_H, seed);

  return { surface: wallCanvas, kind };
}

function drawTornTape(ctx: CanvasContext2DLike, cx: number, topY: number): void {
  ctx.save();
  ctx.translate(cx, topY + 2);
  ctx.rotate((-3.5 * Math.PI) / 180);

  ctx.beginPath();
  ctx.moveTo(-48, -11);
  ctx.lineTo(44, -12);
  ctx.lineTo(48, -3);
  ctx.lineTo(45, 5);
  ctx.lineTo(49, 11);
  ctx.lineTo(-46, 12);
  ctx.lineTo(-49, 3);
  ctx.lineTo(-45, -4);
  ctx.closePath();

  ctx.fillStyle = 'rgba(217, 201, 156, 0.86)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(23, 21, 15, 0.2)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

function drawMarginHeightOverlay(
  ctx: CanvasContext2DLike,
  imgX: number,
  imgY: number,
  imgW: number,
  imgH: number,
  handle: string,
): void {
  const marks: ReadonlyArray<[number, string]> = [
    [0.12, "6'8\""],
    [0.31, "6'2\""],
    [0.5, "5'8\""],
    [0.69, "5'2\""],
  ];

  // Thin, lighter tick marks (~35% ink) along left and right edges
  ctx.save();
  ctx.fillStyle = 'rgba(23, 21, 15, 0.35)';
  for (let i = 0; i <= 9; i++) {
    const frac = 0.12 + i * 0.0633;
    const ty = imgY + Math.round(imgH * frac);
    const tickW = i % 3 === 0 ? 11 : 6;
    ctx.fillRect(imgX, ty, tickW, 1);
    ctx.fillRect(imgX + imgW - tickW, ty, tickW, 1);
  }

  ctx.font = '700 11px "Courier Prime", monospace';
  for (const [frac, label] of marks) {
    const my = imgY + Math.round(imgH * frac);
    const labelW = Math.ceil(ctx.measureText(label).width) + 6;
    ctx.fillStyle = 'rgba(235, 224, 201, 0.78)';
    ctx.fillRect(imgX + 10, my - 7, labelW, 14);
  }
  ctx.restore();

  // Height labels rendered through body ('receipts') ink preset
  inkLayer(
    ctx,
    (sctx) => {
      sctx.fillStyle = PALETTE.ink;
      sctx.font = '700 11px "Courier Prime", monospace';
      sctx.textBaseline = 'middle';
      sctx.textAlign = 'left';
      marks.forEach(([frac, label], idx) => {
        const my = imgY + Math.round(imgH * frac);
        sctx.fillRect(imgX, my, 9, 1);
        drawTypewriterText(
          sctx,
          label,
          imgX + 13,
          my + 0.5,
          hashHandle(handle, `height-mark-${idx}`),
        );
      });
    },
    'receipts',
    hashHandle(handle, 'height-labels-ink'),
    { color: PALETTE.ink },
  );
}

/**
 * Renders the rotated mugshot print inside x: 80-400, y: 200-630.
 */
export function drawMugshot(
  ctx: CanvasContext2DLike,
  verdict: VerdictReport,
  avatar: AvatarImage | null,
  options: MugshotOptions = {},
): void {
  const { surface, kind } = renderMugshotViewport(ctx, verdict, avatar, options);
  const useCompositeCaption = kind !== 'photo';

  const printW = 278;
  const printH = 388;
  const centerX = 240;
  const centerY = 416;

  ctx.save();
  ctx.translate(centerX, centerY);
  ctx.rotate((2.1 * Math.PI) / 180);

  const px = -printW / 2;
  const py = -printH / 2;

  // Hard paper shadow (no blur)
  ctx.fillStyle = 'rgba(23, 21, 15, 0.45)';
  ctx.fillRect(px + 5, py + 6, printW, printH);

  // Warm-tinted photo print card (not pure #f3efe3)
  ctx.fillStyle = '#efe8d6';
  ctx.fillRect(px, py, printW, printH);
  ctx.strokeStyle = 'rgba(23, 21, 15, 0.72)';
  ctx.lineWidth = 1.25;
  ctx.strokeRect(px, py, printW, printH);

  // Native 252x316 viewport (no chunky upscale)
  const imgX = px + 13;
  const imgY = py + 12;
  const imgW = NATIVE_W;
  const imgH = NATIVE_H;

  ctx.drawImage(surface, imgX, imgY, imgW, imgH);

  // Height-chart ruler ticks & inked labels
  drawMarginHeightOverlay(ctx, imgX, imgY, imgW, imgH, verdict.handle);

  // Photo viewport frame
  ctx.strokeStyle = 'rgba(23, 21, 15, 0.8)';
  ctx.lineWidth = 1.25;
  ctx.strokeRect(imgX, imgY, imgW, imgH);

  // Black name plaque at bottom of mugshot frame
  const plaqueH = 42;
  const plaqueY = imgY + imgH - plaqueH - 4;
  ctx.fillStyle = PALETTE.ink;
  ctx.fillRect(imgX + 16, plaqueY, imgW - 32, plaqueH);
  ctx.strokeStyle = '#e7dec9';
  ctx.lineWidth = 1;
  ctx.strokeRect(imgX + 19, plaqueY + 3, imgW - 38, plaqueH - 6);

  ctx.fillStyle = '#eee6d4';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '700 13.5px "Courier Prime", monospace';
  ctx.fillText(
    `@${verdict.handle.toUpperCase()}`,
    0,
    plaqueY + 14,
    imgW - 46,
  );
  ctx.font = '400 10px "Courier Prime", monospace';
  ctx.fillText(
    `PD  •  ${verdict.caseNumber}`,
    0,
    plaqueY + 29,
    imgW - 46,
  );

  // Tape strip across top border
  drawTornTape(ctx, 0, py);

  // Caption area through ink pipeline
  const capTop = imgY + imgH;
  if (verdict.verdict === 'RECORD SEALED' || useCompositeCaption) {
    const captionText =
      verdict.verdict === 'RECORD SEALED'
        ? 'RECORD SEALED - NO PHOTO ON FILE'
        : 'COMPOSITE SKETCH - NO PHOTO ON FILE';

    inkLayer(
      ctx,
      (sctx) => {
        sctx.fillStyle = PALETTE.ink;
        sctx.font = '700 11.5px "Courier Prime", monospace';
        sctx.textAlign = 'center';
        sctx.textBaseline = 'top';
        drawTypewriterText(
          sctx,
          captionText,
          0,
          capTop + 6,
          hashHandle(verdict.handle, 'mugshot-caption'),
        );
      },
      'labels',
      hashHandle(verdict.handle, 'mugshot-caption-ink'),
      { color: PALETTE.ink },
    );

    inkLayer(
      ctx,
      (sctx) => {
        sctx.fillStyle = PALETTE.hand;
        sctx.font = '400 26px "Reenie Beanie", cursive';
        sctx.textAlign = 'center';
        sctx.textBaseline = 'middle';
        drawHandwrittenText(
          sctx,
          `@${verdict.handle}`,
          0,
          capTop + 38,
          hashHandle(verdict.handle, 'mugshot-sig'),
          { maxWidth: printW - 18 },
        );
      },
      'handwriting',
      hashHandle(verdict.handle, 'mugshot-sig-ink'),
      { color: PALETTE.hand },
    );
  } else {
    inkLayer(
      ctx,
      (sctx) => {
        sctx.fillStyle = PALETTE.hand;
        sctx.font = '400 32px "Reenie Beanie", cursive';
        sctx.textAlign = 'center';
        sctx.textBaseline = 'middle';
        drawHandwrittenText(
          sctx,
          `@${verdict.handle}`,
          0,
          capTop + 29,
          hashHandle(verdict.handle, 'mugshot-sig'),
          { maxWidth: printW - 18 },
        );
      },
      'handwriting',
      hashHandle(verdict.handle, 'mugshot-sig-ink'),
      { color: PALETTE.hand },
    );
  }

  ctx.restore();
}
