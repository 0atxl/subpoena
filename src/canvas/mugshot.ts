import { createRng, hashHandle } from '../engine/hash.js';
import type { VerdictReport } from '../engine/charges.js';
import {
  INK_RGB,
  PRINT_RGB,
  atkinsonDither,
  classifyAvatar,
  hardThreshold,
  type AvatarKind,
  type ContrastMode,
} from '../lib/atkinson.js';
import {
  PALETTE,
  createScratchCanvas,
  type CanvasContext2DLike,
} from './paper.js';

export type AvatarImage =
  | HTMLImageElement
  | HTMLCanvasElement
  | ImageBitmap
  | OffscreenCanvas;

export type FlatAvatarMode = 'bordered-box' | 'silhouette';

export interface MugshotOptions {
  flatAvatarMode?: FlatAvatarMode;
  contrastMode?: ContrastMode;
}

const LOW_W = 126;
const LOW_H = 158;

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

  // Horizontal mugshot height lines across the booking wall
  for (let y = 12; y < h - 24; y += 12) {
    const isMajor = (y - 12) % 24 === 0;
    ctx.fillStyle = isMajor ? '#88806f' : '#c6bfae';
    ctx.fillRect(0, y, w, 1);

    ctx.fillStyle = PALETTE.ink;
    ctx.fillRect(0, y, isMajor ? 8 : 5, 1);
    ctx.fillRect(w - (isMajor ? 8 : 5), y, isMajor ? 8 : 5, 1);
  }
}

function drawProceduralSilhouette(
  ctx: CanvasContext2DLike,
  w: number,
  h: number,
  seed: number,
): void {
  const rng = createRng(seed);
  const headShift = Math.round((rng() - 0.5) * 4);
  const hasGlasses = (seed & 1) === 1;
  const hasHat = (seed & 2) === 2;

  // Shoulders
  ctx.fillStyle = '#25231d';
  ctx.beginPath();
  ctx.moveTo(12, h - 22);
  ctx.quadraticCurveTo(16, 100, w / 2, 96);
  ctx.quadraticCurveTo(w - 16, 100, w - 12, h - 22);
  ctx.closePath();
  ctx.fill();

  // Neck
  ctx.fillStyle = '#9d9582';
  ctx.fillRect(w / 2 - 9, 78, 18, 22);

  // Head
  const grad = ctx.createRadialGradient(
    w / 2 - 8,
    48 + headShift,
    5,
    w / 2,
    56 + headShift,
    40,
  );
  grad.addColorStop(0, '#dbd4c1');
  grad.addColorStop(0.55, '#8b8372');
  grad.addColorStop(1, '#2d2a22');

  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.ellipse(w / 2, 56 + headShift, 25, 32, 0, 0, Math.PI * 2);
  ctx.fill();

  // Hair or fedora
  ctx.fillStyle = '#1b1914';
  if (hasHat) {
    ctx.fillRect(24, 31 + headShift, w - 48, 5);
    ctx.beginPath();
    ctx.ellipse(w / 2, 31 + headShift, 20, 14, 0, Math.PI, 0);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.ellipse(w / 2, 33 + headShift, 26, 14, 0, Math.PI, 0);
    ctx.fill();
    ctx.fillRect(w / 2 - 26, 32 + headShift, 5, 16);
    ctx.fillRect(w / 2 + 21, 32 + headShift, 5, 16);
  }

  // Features
  ctx.fillStyle = '#2b2820';
  ctx.fillRect(w / 2 - 11, 53 + headShift, 5, 3);
  ctx.fillRect(w / 2 + 6, 53 + headShift, 5, 3);
  ctx.fillRect(w / 2 - 3, 70 + headShift, 6, 2);

  if (hasGlasses) {
    ctx.strokeStyle = '#17150f';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(w / 2 - 16, 49 + headShift, 14, 10);
    ctx.strokeRect(w / 2 + 2, 49 + headShift, 14, 10);
    ctx.beginPath();
    ctx.moveTo(w / 2 - 2, 54 + headShift);
    ctx.lineTo(w / 2 + 2, 54 + headShift);
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
      if (x < 3 || x >= w - 3 || y < 3 || y >= h - 3) {
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

interface MugshotRenderResult {
  surface: HTMLCanvasElement | OffscreenCanvas;
  kind: AvatarKind | 'missing';
}

function buildLowResMugshot(
  ctx: CanvasContext2DLike,
  verdict: VerdictReport,
  avatar: AvatarImage | null,
  options: MugshotOptions,
): MugshotRenderResult {
  const { canvas: wallCanvas, ctx: wctx } = createScratchCanvas(
    LOW_W,
    LOW_H,
    ctx,
  );

  const dims = avatar ? getImageDimensions(avatar) : null;
  if (!avatar || !dims) {
    drawHeightChartWall(wctx, LOW_W, LOW_H);
    drawProceduralSilhouette(
      wctx,
      LOW_W,
      LOW_H,
      hashHandle(verdict.handle, 'silhouette'),
    );
    const raw = wctx.getImageData(0, 0, LOW_W, LOW_H);
    const dithered = atkinsonDither(
      raw.data,
      LOW_W,
      LOW_H,
      PRINT_RGB,
      INK_RGB,
      { contrastMode: options.contrastMode },
    );
    const outImg = wctx.createImageData(LOW_W, LOW_H);
    outImg.data.set(dithered);
    wctx.putImageData(outImg, 0, 0);
    return { surface: wallCanvas, kind: 'missing' };
  }

  // Probe full-bleed cover crop first so classification sees the real avatar
  const { canvas: probeCanvas, ctx: pctx } = createScratchCanvas(
    LOW_W,
    LOW_H,
    ctx,
  );
  const coverScale = Math.max(LOW_W / dims.width, LOW_H / dims.height);
  const cdw = dims.width * coverScale;
  const cdh = dims.height * coverScale;
  const cdx = (LOW_W - cdw) / 2;
  const cdy = (LOW_H - cdh) / 2;
  pctx.clearRect(0, 0, LOW_W, LOW_H);
  pctx.drawImage(avatar, cdx, cdy, cdw, cdh);
  const probeData = pctx.getImageData(0, 0, LOW_W, LOW_H);
  const kind = classifyAvatar(probeData.data, LOW_W, LOW_H);

  if (kind === 'photo') {
    // Edge-to-edge cover-cropped photo (zero white gaps), composited over #f3efe3 if needed
    wctx.fillStyle = PALETTE.print;
    wctx.fillRect(0, 0, LOW_W, LOW_H);
    wctx.drawImage(probeCanvas, 0, 0);
    const fullPhoto = wctx.getImageData(0, 0, LOW_W, LOW_H);
    const dithered = atkinsonDither(
      fullPhoto.data,
      LOW_W,
      LOW_H,
      PRINT_RGB,
      INK_RGB,
      { contrastMode: options.contrastMode },
    );
    const outImg = wctx.createImageData(LOW_W, LOW_H);
    outImg.data.set(dithered);
    wctx.putImageData(outImg, 0, 0);
    return { surface: wallCanvas, kind: 'photo' };
  }

  // Flat / identicon / logo mode
  // Route identicons to procedural silhouette by default; logos & bots to bordered-box
  const flatMode: FlatAvatarMode =
    options.flatAvatarMode ??
    (kind === 'identicon' ? 'silhouette' : 'bordered-box');
  drawHeightChartWall(wctx, LOW_W, LOW_H);

  if (flatMode === 'silhouette') {
    drawProceduralSilhouette(
      wctx,
      LOW_W,
      LOW_H,
      hashHandle(verdict.handle, 'silhouette'),
    );
    const raw = wctx.getImageData(0, 0, LOW_W, LOW_H);
    const dithered = atkinsonDither(
      raw.data,
      LOW_W,
      LOW_H,
      PRINT_RGB,
      INK_RGB,
      { contrastMode: options.contrastMode },
    );
    const outImg = wctx.createImageData(LOW_W, LOW_H);
    outImg.data.set(dithered);
    wctx.putImageData(outImg, 0, 0);
    return { surface: wallCanvas, kind };
  }

  // 'bordered-box': render flat glyph inside a clean thin-bordered paper box on the wall
  const boxSize = 72;
  const innerSize = 62;
  const boxX = Math.round((LOW_W - boxSize) / 2);
  const boxY = 18;
  const innerX = boxX + 5;
  const innerY = boxY + 5;

  const { ctx: ictx } = createScratchCanvas(
    innerSize,
    innerSize,
    ctx,
  );
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

  // Quantize background wall cleanly before placing bordered box
  const wallImg = wctx.getImageData(0, 0, LOW_W, LOW_H);
  const wd = wallImg.data;
  for (let i = 0; i < LOW_W * LOW_H; i++) {
    const k = i * 4;
    const lum = 0.299 * (wd[k] ?? 0) + 0.587 * (wd[k + 1] ?? 0) + 0.114 * (wd[k + 2] ?? 0);
    const rgb = lum < 175 ? INK_RGB : PRINT_RGB;
    wd[k] = rgb[0];
    wd[k + 1] = rgb[1];
    wd[k + 2] = rgb[2];
    wd[k + 3] = 255;
  }
  wctx.putImageData(wallImg, 0, 0);

  // Thin bordered paper box
  wctx.fillStyle = PALETTE.print;
  wctx.fillRect(boxX, boxY, boxSize, boxSize);
  wctx.strokeStyle = PALETTE.ink;
  wctx.lineWidth = 1;
  wctx.strokeRect(boxX + 0.5, boxY + 0.5, boxSize - 1, boxSize - 1);

  const iconImg = wctx.createImageData(innerSize, innerSize);
  iconImg.data.set(thresh);
  wctx.putImageData(iconImg, innerX, innerY);

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
): void {
  ctx.save();
  ctx.font = '700 11.5px "Courier Prime", monospace';
  ctx.textBaseline = 'middle';

  // Evenly spaced, strictly monotonic descending height labels (6'8" -> 5'2")
  const marks: ReadonlyArray<[number, string]> = [
    [0.12, "6'8\""],
    [0.31, "6'2\""],
    [0.5, "5'8\""],
    [0.69, "5'2\""],
  ];

  // Crisp tick marks on left and right margins with paper halo so ink reads over dark dithering
  for (let i = 0; i <= 9; i++) {
    const frac = 0.12 + i * 0.0633;
    const ty = imgY + Math.round(imgH * frac);
    const tickW = i % 3 === 0 ? 13 : 8;

    ctx.fillStyle = PALETTE.print;
    ctx.fillRect(imgX, ty - 2, tickW + 2, 4);
    ctx.fillRect(imgX + imgW - tickW - 2, ty - 2, tickW + 2, 4);

    ctx.fillStyle = PALETTE.ink;
    ctx.fillRect(imgX, ty - 0.5, tickW, 1.5);
    ctx.fillRect(imgX + imgW - tickW, ty - 0.5, tickW, 1.5);
  }

  for (const [frac, label] of marks) {
    const my = imgY + Math.round(imgH * frac);
    const labelW = Math.ceil(ctx.measureText(label).width) + 8;

    // Paper backing pill + border + ink label on left margin
    ctx.fillStyle = PALETTE.print;
    ctx.fillRect(imgX + 10, my - 8, labelW, 16);
    ctx.strokeStyle = PALETTE.ink;
    ctx.lineWidth = 1;
    ctx.strokeRect(imgX + 10.5, my - 7.5, labelW - 1, 15);

    ctx.fillStyle = PALETTE.ink;
    ctx.fillRect(imgX, my - 1, 10, 2);
    ctx.textAlign = 'left';
    ctx.fillText(label, imgX + 14, my + 0.5);
  }

  ctx.restore();
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
  const { surface, kind } = buildLowResMugshot(ctx, verdict, avatar, options);
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

  // Photo print card
  ctx.fillStyle = PALETTE.print;
  ctx.fillRect(px, py, printW, printH);
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(px, py, printW, printH);

  // Larger edge-to-edge upscaled photo viewport (imageSmoothingEnabled = false)
  const imgX = px + 13;
  const imgY = py + 12;
  const imgW = 252;
  const imgH = 316;

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(surface, imgX, imgY, imgW, imgH);
  ctx.restore();

  // Height-chart ruler ticks & labels drawn as readable ink over margins
  drawMarginHeightOverlay(ctx, imgX, imgY, imgW, imgH);

  // Photo viewport frame
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(imgX, imgY, imgW, imgH);

  // Black name plaque at bottom of mugshot frame
  const plaqueH = 42;
  const plaqueY = imgY + imgH - plaqueH - 4;
  ctx.fillStyle = PALETTE.ink;
  ctx.fillRect(imgX + 16, plaqueY, imgW - 32, plaqueH);
  ctx.strokeStyle = PALETTE.print;
  ctx.lineWidth = 1;
  ctx.strokeRect(imgX + 19, plaqueY + 3, imgW - 38, plaqueH - 6);

  ctx.fillStyle = PALETTE.print;
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

  // Caption area (>= 11px for COMPOSITE SKETCH)
  const capTop = imgY + imgH;
  if (verdict.verdict === 'RECORD SEALED') {
    ctx.fillStyle = PALETTE.ink;
    ctx.font = '700 11.5px "Courier Prime", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('RECORD SEALED - NO PHOTO ON FILE', 0, capTop + 6);

    ctx.fillStyle = PALETTE.hand;
    ctx.font = '400 26px "Reenie Beanie", cursive';
    ctx.textBaseline = 'middle';
    ctx.fillText(`@${verdict.handle}`, 0, capTop + 38, printW - 18);
  } else if (useCompositeCaption) {
    ctx.fillStyle = PALETTE.ink;
    ctx.font = '700 11.5px "Courier Prime", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('COMPOSITE SKETCH - NO PHOTO ON FILE', 0, capTop + 6);

    ctx.fillStyle = PALETTE.hand;
    ctx.font = '400 26px "Reenie Beanie", cursive';
    ctx.textBaseline = 'middle';
    ctx.fillText(`@${verdict.handle}`, 0, capTop + 38, printW - 18);
  } else {
    ctx.fillStyle = PALETTE.hand;
    ctx.font = '400 32px "Reenie Beanie", cursive';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`@${verdict.handle}`, 0, capTop + 29, printW - 18);
  }

  ctx.restore();
}
