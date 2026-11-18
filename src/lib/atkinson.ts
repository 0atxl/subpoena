/**
 * Atkinson dithering, CLAHE local contrast normalization, and avatar classification.
 * Produces pure two-ink output (#17150f and #f3efe3) with alpha 255 and zero NaNs.
 */

export const INK_RGB = [23, 21, 15] as const;
export const PAPER_RGB = [230, 218, 192] as const;
export const PRINT_RGB = [243, 239, 227] as const;

export type RGB = readonly [number, number, number];
export type AvatarKind = 'photo' | 'logo' | 'identicon';
export type ContrastMode = 'clahe' | 'legacy';

function clamp255(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 255) return 255;
  return value;
}

/**
 * Extracts perceptual luminance (0..255) from RGBA, compositing semi-transparent
 * pixels over the light print paper background.
 */
export function extractLuminance(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  bgRgb: RGB = PRINT_RGB,
): Float32Array {
  const total = Math.max(0, width * height);
  const lum = new Float32Array(total);
  const bgLum = 0.299 * bgRgb[0] + 0.587 * bgRgb[1] + 0.114 * bgRgb[2];

  for (let i = 0; i < total; i++) {
    const k = i * 4;
    const r = rgba[k] ?? bgRgb[0];
    const g = rgba[k + 1] ?? bgRgb[1];
    const b = rgba[k + 2] ?? bgRgb[2];
    const a = (rgba[k + 3] ?? 255) / 255;
    const rawLum = 0.299 * r + 0.587 * g + 0.114 * b;
    const blended = rawLum * a + bgLum * (1 - a);
    lum[i] = clamp255(blended);
  }
  return lum;
}

/**
 * Classifies an avatar into 'photo', 'logo', or 'identicon' using palette size,
 * flat-run density, horizontal symmetry, and diagonal vs orthogonal edge structure.
 */
export function classifyAvatar(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): AvatarKind {
  const total = width * height;
  if (total <= 0) return 'logo';

  const buckets = new Map<number, number>();
  let transparentCount = 0;
  let flatPairs = 0;
  let totalPairs = 0;
  let symMatch = 0;
  let symTotal = 0;
  let orthoEdges = 0;
  let diagOnlyEdges = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const k = (y * width + x) * 4;
      const r = rgba[k] ?? 0;
      const g = rgba[k + 1] ?? 0;
      const b = rgba[k + 2] ?? 0;
      const a = rgba[k + 3] ?? 255;

      if (a < 240) {
        transparentCount++;
      }

      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      buckets.set(key, (buckets.get(key) ?? 0) + 1);

      const curLum = 0.299 * r + 0.587 * g + 0.114 * b;
      const prevLum =
        x > 0
          ? 0.299 * (rgba[k - 4] ?? 0) +
            0.587 * (rgba[k - 3] ?? 0) +
            0.114 * (rgba[k - 2] ?? 0)
          : curLum;
      const upLum =
        y > 0
          ? 0.299 * (rgba[k - width * 4] ?? 0) +
            0.587 * (rgba[k - width * 4 + 1] ?? 0) +
            0.114 * (rgba[k - width * 4 + 2] ?? 0)
          : curLum;

      if (x > 0) {
        totalPairs++;
        if (Math.abs(curLum - prevLum) <= 2) flatPairs++;
        if (Math.abs(curLum - prevLum) > 18) orthoEdges++;
      }
      if (y > 0 && Math.abs(curLum - upLum) > 18) {
        orthoEdges++;
      }
      if (x > 0 && y > 0) {
        const dk = k - width * 4 - 4;
        const diagLum =
          0.299 * (rgba[dk] ?? 0) +
          0.587 * (rgba[dk + 1] ?? 0) +
          0.114 * (rgba[dk + 2] ?? 0);
        if (
          Math.abs(curLum - diagLum) > 18 &&
          Math.abs(curLum - upLum) <= 18 &&
          Math.abs(curLum - prevLum) <= 18
        ) {
          diagOnlyEdges++;
        }
      }

      if (x < width / 2) {
        const mk = (y * width + (width - 1 - x)) * 4;
        symTotal++;
        const diff =
          Math.abs(r - (rgba[mk] ?? 0)) +
          Math.abs(g - (rgba[mk + 1] ?? 0)) +
          Math.abs(b - (rgba[mk + 2] ?? 0));
        if (diff <= 18) symMatch++;
      }
    }
  }

  const counts = Array.from(buckets.values()).sort((a, b) => b - a);
  const top2Share = ((counts[0] ?? 0) + (counts[1] ?? 0)) / total;
  const top3Share =
    ((counts[0] ?? 0) + (counts[1] ?? 0) + (counts[2] ?? 0)) / total;
  const bucketCount = buckets.size;
  const flatRatio = totalPairs > 0 ? flatPairs / totalPairs : 1;
  const transparentRatio = transparentCount / total;
  const symRatio = symTotal > 0 ? symMatch / symTotal : 0;
  const diagRatio = orthoEdges > 0 ? diagOnlyEdges / orthoEdges : 0;

  const isFlat =
    transparentRatio > 0.12 ||
    bucketCount <= 36 ||
    top3Share >= 0.72 ||
    (flatRatio >= 0.68 && bucketCount <= 110);

  if (!isFlat) return 'photo';

  // GitHub identicons have tiny palettes, strong horizontal symmetry, and strictly axis-aligned block edges
  if (
    transparentRatio < 0.05 &&
    bucketCount <= 10 &&
    top2Share >= 0.92 &&
    symRatio >= 0.9 &&
    diagRatio <= 0.015
  ) {
    return 'identicon';
  }

  return 'logo';
}

function buildClippedCdf(
  hist: Uint32Array,
  sampleCount: number,
  clipLimitFactor: number,
): Float32Array {
  const cdf = new Float32Array(256);
  if (sampleCount <= 0) {
    for (let i = 0; i < 256; i++) cdf[i] = i;
    return cdf;
  }

  const clipped = new Float32Array(256);
  const clipLimit = Math.max(1, (sampleCount / 256) * clipLimitFactor);
  let excess = 0;

  for (let b = 0; b < 256; b++) {
    const count = hist[b] ?? 0;
    if (count > clipLimit) {
      excess += count - clipLimit;
      clipped[b] = clipLimit;
    } else {
      clipped[b] = count;
    }
  }

  const redist = excess / 256;
  let running = 0;
  for (let b = 0; b < 256; b++) {
    running += (clipped[b] ?? 0) + redist;
    cdf[b] = clamp255(10 + (running / sampleCount) * 236);
  }
  return cdf;
}

/**
 * CLAHE-style local contrast enhancement with softer clip limits and radial border
 * taper so uniform studio backgrounds stay clean without amplifying into static.
 */
export function equalizeHistogramCLAHE(
  luminance: Float32Array,
  width: number,
  height: number,
): Float32Array {
  const n = luminance.length;
  const out = new Float32Array(n);
  if (n === 0 || width <= 0 || height <= 0) return out;

  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += clamp255(luminance[i] ?? 0);
  }
  const mean = sum / n;
  const liftGamma = mean < 110 ? 0.68 : mean < 142 ? 0.84 : 1.0;

  const lifted = new Uint8Array(n);
  const globalHist = new Uint32Array(256);
  for (let i = 0; i < n; i++) {
    const raw = clamp255(luminance[i] ?? 0);
    const val = liftGamma === 1.0 ? raw : Math.pow(raw / 255, liftGamma) * 255;
    const bin = Math.round(clamp255(val));
    lifted[i] = bin;
    globalHist[bin] = (globalHist[bin] ?? 0) + 1;
  }

  const globalCdf = buildClippedCdf(globalHist, n, 2.0);

  const tilesX = Math.max(1, Math.min(4, Math.floor(width / 16)));
  const tilesY = Math.max(1, Math.min(5, Math.floor(height / 16)));
  const tileCdfs: Float32Array[] = [];
  const tileSpans: number[] = [];

  for (let ty = 0; ty < tilesY; ty++) {
    const y0 = Math.floor((ty * height) / tilesY);
    const y1 = Math.floor(((ty + 1) * height) / tilesY);
    for (let tx = 0; tx < tilesX; tx++) {
      const x0 = Math.floor((tx * width) / tilesX);
      const x1 = Math.floor(((tx + 1) * width) / tilesX);
      const hist = new Uint32Array(256);
      let count = 0;
      let tMin = 255;
      let tMax = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const bin = lifted[y * width + x] ?? 0;
          hist[bin] = (hist[bin] ?? 0) + 1;
          if (bin < tMin) tMin = bin;
          if (bin > tMax) tMax = bin;
          count++;
        }
      }
      tileSpans.push(tMax - tMin);
      tileCdfs.push(buildClippedCdf(hist, count, 1.65));
    }
  }

  const tileW = width / tilesX;
  const tileH = height / tilesY;

  for (let y = 0; y < height; y++) {
    const gy = (y + 0.5) / tileH - 0.5;
    const ty0 = Math.max(0, Math.min(tilesY - 1, Math.floor(gy)));
    const ty1 = Math.max(0, Math.min(tilesY - 1, ty0 + 1));
    const fy = Math.max(0, Math.min(1, gy - ty0));
    const ny = (y / height - 0.5) / 0.48;

    for (let x = 0; x < width; x++) {
      const gx = (x + 0.5) / tileW - 0.5;
      const tx0 = Math.max(0, Math.min(tilesX - 1, Math.floor(gx)));
      const tx1 = Math.max(0, Math.min(tilesX - 1, tx0 + 1));
      const fx = Math.max(0, Math.min(1, gx - tx0));
      const nx = (x / width - 0.5) / 0.45;

      const idx = y * width + x;
      const bin = lifted[idx] ?? 0;

      const c00 = tileCdfs[ty0 * tilesX + tx0]?.[bin] ?? bin;
      const c10 = tileCdfs[ty0 * tilesX + tx1]?.[bin] ?? bin;
      const c01 = tileCdfs[ty1 * tilesX + tx0]?.[bin] ?? bin;
      const c11 = tileCdfs[ty1 * tilesX + tx1]?.[bin] ?? bin;

      const s00 = tileSpans[ty0 * tilesX + tx0] ?? 255;
      const s10 = tileSpans[ty0 * tilesX + tx1] ?? 255;
      const s01 = tileSpans[ty1 * tilesX + tx0] ?? 255;
      const s11 = tileSpans[ty1 * tilesX + tx1] ?? 255;
      const avgSpan = (s00 + s10 + s01 + s11) * 0.25;

      const top = c00 + (c10 - c00) * fx;
      const bot = c01 + (c11 - c01) * fx;
      const localVal = top + (bot - top) * fy;
      const globalVal = globalCdf[bin] ?? bin;

      // Uniform low-span tiles stay closer to global tone instead of amplifying background noise
      const localGain = Math.min(1, Math.max(0.15, (avgSpan - 18) / 56));
      const dist = Math.hypot(nx, ny);
      const borderFade =
        dist > 0.68 ? Math.min(0.75, (dist - 0.68) * 1.35) : 0;

      const eqVal = localVal * (0.62 * localGain) + globalVal * (1 - 0.62 * localGain);
      const softBorder = eqVal * (1 - borderFade) + bin * borderFade;

      out[idx] = clamp255(softBorder);
    }
  }

  return out;
}

/**
 * Legacy global percentile contrast stretch (retained for before/after comparison).
 */
export function legacyNormalizeContrast(luminance: Float32Array): Float32Array {
  const n = luminance.length;
  const out = new Float32Array(n);
  if (n === 0) return out;

  const hist = new Uint32Array(256);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = Math.round(clamp255(luminance[i] ?? 0));
    hist[v] = (hist[v] ?? 0) + 1;
    sum += v;
  }

  const mean = sum / n;
  const liftGamma = mean < 95 ? 0.68 : 1.0;

  const lifted = new Float32Array(n);
  const liftedHist = new Uint32Array(256);
  for (let i = 0; i < n; i++) {
    const raw = clamp255(luminance[i] ?? 0);
    const val = liftGamma === 1.0 ? raw : Math.pow(raw / 255, liftGamma) * 255;
    lifted[i] = val;
    const bin = Math.round(clamp255(val));
    liftedHist[bin] = (liftedHist[bin] ?? 0) + 1;
  }

  const lowTarget = Math.floor(n * 0.04);
  const highTarget = Math.ceil(n * 0.96);
  let cumulative = 0;
  let pLow = 0;
  let pHigh = 255;
  let foundLow = false;

  for (let b = 0; b < 256; b++) {
    cumulative += liftedHist[b] ?? 0;
    if (!foundLow && cumulative >= lowTarget) {
      pLow = b;
      foundLow = true;
    }
    if (cumulative >= highTarget) {
      pHigh = b;
      break;
    }
  }

  const span = pHigh - pLow;
  for (let i = 0; i < n; i++) {
    const v = lifted[i] ?? 0;
    const stretched = span > 8 ? 10 + ((v - pLow) / span) * 236 : v;
    const contrasted = (stretched - 128) * 1.18 + 128;
    out[i] = clamp255(contrasted);
  }

  return out;
}

export function normalizeContrast(
  luminance: Float32Array,
  width?: number,
  height?: number,
): Float32Array {
  if (
    width !== undefined &&
    height !== undefined &&
    width > 0 &&
    height > 0 &&
    width * height === luminance.length
  ) {
    return equalizeHistogramCLAHE(luminance, width, height);
  }
  return legacyNormalizeContrast(luminance);
}

const ATKINSON_KERNEL: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [2, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
  [0, 2],
];

/**
 * Applies CLAHE local contrast normalization (or legacy stretch) and Atkinson
 * error-diffusion dithering. Returns strictly darkRgb and lightRgb with alpha 255.
 */
export function atkinsonDither(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  lightRgb: RGB = PRINT_RGB,
  darkRgb: RGB = INK_RGB,
  options: { contrastMode?: ContrastMode } = {},
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  if (width <= 0 || height <= 0) return out;

  const rawLum = extractLuminance(rgba, width, height, lightRgb);
  const lum =
    options.contrastMode === 'legacy'
      ? legacyNormalizeContrast(rawLum)
      : equalizeHistogramCLAHE(rawLum, width, height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const oldVal = clamp255(lum[idx] ?? 0);
      const isLight = oldVal >= 128;
      const quant = isLight ? 255 : 0;
      const err = (oldVal - quant) / 8;

      for (const [dx, dy] of ATKINSON_KERNEL) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
          const nIdx = ny * width + nx;
          lum[nIdx] = (lum[nIdx] ?? 0) + err;
        }
      }

      const rgb = isLight ? lightRgb : darkRgb;
      const k = idx * 4;
      out[k] = rgb[0];
      out[k + 1] = rgb[1];
      out[k + 2] = rgb[2];
      out[k + 3] = 255;
    }
  }

  return out;
}

function computeOtsuThreshold(lum: Float32Array): number {
  const n = lum.length;
  if (n === 0) return 128;

  const hist = new Uint32Array(256);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const bin = Math.round(clamp255(lum[i] ?? 0));
    hist[bin] = (hist[bin] ?? 0) + 1;
    sum += bin;
  }

  let sumB = 0;
  let wB = 0;
  let maxVar = -1;
  let thresholdSum = 0;
  let thresholdCount = 0;

  for (let t = 0; t < 256; t++) {
    const count = hist[t] ?? 0;
    wB += count;
    if (wB === 0) continue;
    const wF = n - wB;
    if (wF === 0) break;

    sumB += t * count;
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const betweenVar = wB * wF * (mB - mF) * (mB - mF);
    if (betweenVar > maxVar + 1e-6) {
      maxVar = betweenVar;
      thresholdSum = t;
      thresholdCount = 1;
    } else if (Math.abs(betweenVar - maxVar) <= 1e-6) {
      thresholdSum += t;
      thresholdCount++;
    }
  }

  return thresholdCount > 0 ? thresholdSum / thresholdCount : 128;
}

/**
 * Hard binary threshold for flat logos, identicons, and mascots.
 * Returns strictly darkRgb and lightRgb with alpha 255.
 */
export function hardThreshold(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  lightRgb: RGB = PRINT_RGB,
  darkRgb: RGB = INK_RGB,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  if (width <= 0 || height <= 0) return out;

  const lum = extractLuminance(rgba, width, height, lightRgb);
  const threshold = computeOtsuThreshold(lum);

  for (let i = 0; i < width * height; i++) {
    const isLight = (lum[i] ?? 0) >= threshold;
    const rgb = isLight ? lightRgb : darkRgb;
    const k = i * 4;
    out[k] = rgb[0];
    out[k + 1] = rgb[1];
    out[k + 2] = rgb[2];
    out[k + 3] = 255;
  }

  return out;
}

/**
 * Photocopy tone curve: crushes blacks <= 8% to 0, clips whites >= 92% to 255,
 * and boosts midtone contrast by 1.3x.
 */
export function applyPhotocopyToneCurve(luminance: Float32Array): Float32Array {
  const n = luminance.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const u = clamp255(luminance[i] ?? 0) / 255;
    let t = (u - 0.08) / 0.84;
    if (t <= 0) t = 0;
    else if (t >= 1) t = 1;
    let c = 0.5 + (t - 0.5) * 1.3;
    if (c <= 0) c = 0;
    else if (c >= 1) c = 1;
    out[i] = c * 255;
  }
  return out;
}
