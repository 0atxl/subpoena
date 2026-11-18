import { createRng, hashHandle } from '../engine/hash.js';
import {
  boxBlurAlpha,
  clamp01,
  createScratchCanvas,
  drawTypewriterText,
  fbmNoise2D,
  hashPixel,
  inkLayer,
  smoothstep,
  valueNoise2D,
  type CanvasContext2DLike,
} from './ink.js';
import { PALETTE } from './paper.js';

export type FingerprintPattern = 'whorl' | 'loop' | 'arch';

const PATTERNS: readonly FingerprintPattern[] = ['whorl', 'loop', 'arch'];

export function getFingerprintPatternType(handle: string): FingerprintPattern {
  const h = hashHandle(handle, 'fp-pat-5');
  const mixed = (Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0) % PATTERNS.length;
  return PATTERNS[mixed] ?? 'loop';
}

export interface FingerprintOptions {
  detailScale?: '1x' | '2x';
}

/**
 * Draws a procedural inked thumbprint seeded from the GitHub handle
 * inside the fingerprint zone (x: 1060-1150, y: 540-630).
 */
export function drawFingerprint(
  ctx: CanvasContext2DLike,
  handle: string,
  options: FingerprintOptions = {},
): void {
  const is2x = options.detailScale === '2x';
  const boxX = 1060;
  const boxY = 540;
  const boxW = 90;
  const boxH = 90;

  // Box border & R. THUMB label through the 'labels' ink preset
  inkLayer(
    ctx,
    (sctx) => {
      sctx.strokeStyle = PALETTE.ink;
      sctx.fillStyle = PALETTE.ink;
      sctx.lineWidth = 2;
      sctx.strokeRect(boxX, boxY, boxW, boxH);
      sctx.font = '700 9.5px "Courier Prime", monospace';
      sctx.textAlign = 'center';
      sctx.textBaseline = 'top';
      drawTypewriterText(
        sctx,
        'R. THUMB',
        boxX + boxW / 2,
        boxY + 4,
        hashHandle(handle, 'fp-label'),
      );
    },
    'labels',
    hashHandle(handle, 'fp-box-ink'),
    { color: PALETTE.ink },
  );

  // Pad viewport inside box
  const padX = boxX + 5;
  const padY = boxY + 15;
  const pw = boxW - 10; // 80
  const ph = boxH - 19; // 71

  const scale = 3;
  const gw = pw * scale; // 240
  const gh = ph * scale; // 213

  const seed = hashHandle(handle, 'fingerprint');
  const rng = createRng(seed);
  const pattern = getFingerprintPatternType(handle);

  const coreDx = (rng() - 0.5) * 10;
  const coreDy = (rng() - 0.5) * 8;
  const tilt = (rng() - 0.5) * 0.44;
  const cosT = Math.cos(tilt);
  const sinT = Math.sin(tilt);

  const kFreq = is2x ? 1.75 + rng() * 0.3 : 1.22 + rng() * 0.16; // fewer, thicker ridges at 1x
  const chirality = rng() > 0.5 ? 1 : -1;
  const spiralArms = rng() > 0.55 ? 2 : 1;
  const archAmplitude = 9 + rng() * 6;
  const archPhase = rng() * Math.PI * 2;

  // Compute scalar ridge phase field at 3x supersampled resolution
  const hiAlpha = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    const dyDisp = gy / scale - ph * 0.5 - coreDy;
    for (let gx = 0; gx < gw; gx++) {
      const dxDisp = gx / scale - pw * 0.5 - coreDx;
      const rx = dxDisp * cosT + dyDisp * sinT;
      const ry = -dxDisp * sinT + dyDisp * cosT;

      // Anisotropic skin coordinates
      const u = rx / 0.86;
      const v = ry / 1.06;

      // Low-frequency ridge flow warp
      const warp =
        2.3 * (fbmNoise2D(u * 0.068, v * 0.068, seed ^ 0x55aa) - 0.5);

      let phi: number;
      if (pattern === 'whorl') {
        const shearU = u + 0.14 * Math.sin(v * 0.09);
        const r = Math.sqrt(shearU * shearU + v * v + 1.4);
        const theta = Math.atan2(v, shearU);
        phi = kFreq * r + spiralArms * chirality * theta + warp;
      } else if (pattern === 'loop') {
        const bend = chirality * 0.014 * Math.max(0, v) * Math.max(0, v);
        const uBent = u - bend;
        const vClamped = Math.min(0, v);
        const dist = Math.sqrt(uBent * uBent + vClamped * vClamped + 0.04);
        phi = kFreq * dist + warp;
      } else {
        // 'arch'
        const archShape =
          archAmplitude *
          Math.exp(-(u * u) / (2 * 13.5 * 13.5)) *
          (1 / (1 + Math.max(0, v) * 0.032));
        const sinWave = 1.9 * Math.sin(u * 0.1 + archPhase);
        const d = v + 38 - archShape + sinWave;
        phi = kFreq * d + warp;
      }

      const ridge = 0.5 + 0.5 * Math.cos(phi);
      hiAlpha[gy * gw + gx] = is2x
        ? smoothstep(0.45, 0.6, ridge)
        : smoothstep(0.32, 0.54, ridge);
    }
  }

  // Downsample 3x3 blocks to display grid + apply pressure, partial roll, and dropout
  const rollShiftX = (rng() - 0.5) * 14;
  const rollShiftY = (rng() - 0.5) * 8;
  const padRx = 27 + rng() * 5;
  const padRy = 31 + rng() * 4;

  // Directional pressure gradient (heavy on one side, lighter on the opposite)
  const pressAng = rng() * Math.PI * 2;
  const pressX = Math.cos(pressAng);
  const pressY = Math.sin(pressAng);

  // Partial thumb roll cutoff on one lateral edge
  const rollSide = rng() > 0.5 ? 1 : -1;
  const rollTilt = (rng() - 0.5) * 0.4;
  const rollLimit = 18 + rng() * 10;

  const displayAlpha = new Float32Array(pw * ph);

  for (let y = 0; y < ph; y++) {
    const dy = y - ph * 0.5;
    for (let x = 0; x < pw; x++) {
      const dx = x - pw * 0.5;

      // Average 3x3 supersampled ridge block
      let sum = 0;
      const gy0 = y * scale;
      const gx0 = x * scale;
      for (let sy = 0; sy < scale; sy++) {
        const row = (gy0 + sy) * gw + gx0;
        sum +=
          (hiAlpha[row] ?? 0) +
          (hiAlpha[row + 1] ?? 0) +
          (hiAlpha[row + 2] ?? 0);
      }
      const rawRidge = sum / (scale * scale);
      const ridgeVal = is2x ? rawRidge : smoothstep(0.18, 0.72, rawRidge);

      // Elliptical pad falloff with irregular edge contour
      const edgeNoise =
        (fbmNoise2D(dx * 0.09, dy * 0.09, seed ^ 0x71b3) - 0.5) * 0.26;
      const rEll = Math.hypot(
        (dx - rollShiftX) / padRx,
        (dy - rollShiftY) / padRy,
      );
      const ellMask = 1 - smoothstep(0.76, 1.04, rEll + edgeNoise);

      // Partial roll edge cutoff (incomplete at rolled edge)
      const rollCoord = rollSide * (dx * Math.cos(rollTilt) + dy * Math.sin(rollTilt));
      const rollMask =
        1 - smoothstep(rollLimit - 4, rollLimit + 3, rollCoord + edgeNoise * 12);

      const nx = dx / (pw * 0.5);
      const ny = dy / (ph * 0.5);
      const sidePressure = is2x
        ? clamp01(0.68 + (nx * pressX + ny * pressY) * 0.34)
        : clamp01(0.78 + (nx * pressX + ny * pressY) * 0.28);
      const pressure = ellMask * rollMask * sidePressure;

      if (pressure < 0.02) continue;

      // Light-area dropout & subtle sweat-pore breaks (lighter touch at 1x to preserve ridge legibility)
      let drop = 1.0;
      const dropThresh = is2x ? 0.72 : 0.6;
      if (pressure < dropThresh) {
        const dropNoise = valueNoise2D(x * 0.55, y * 0.55, seed ^ 0x9e12);
        if (dropNoise < 0.25) {
          drop = (is2x ? 0.22 : 0.34) + hashPixel(x, y, seed + 19) * 0.25;
        }
      } else if (ridgeVal > 0.65 && hashPixel(x, y, seed + 41) < (is2x ? 0.06 : 0.03)) {
        drop = is2x ? 0.35 : 0.55;
      }

      displayAlpha[y * pw + x] = clamp01(ridgeVal * pressure * drop);
    }
  }

  // Light blur so ridges look pressed into paper fibers (tighter at 1x so grooves stay open)
  const organicAlpha = boxBlurAlpha(
    displayAlpha,
    pw,
    ph,
    is2x ? 0.4 : 0.2,
    1,
  );

  // Ink-pad colors: darker deep navy-black or dark violet at 1x for legibility
  const useViolet = (seed & 2) === 2;
  const inkRgb = is2x
    ? useViolet
      ? ([42, 26, 56] as const)
      : ([21, 31, 52] as const)
    : useViolet
      ? ([24, 13, 36] as const)
      : ([12, 17, 32] as const);

  const { canvas: fpCanvas, ctx: fctx } = createScratchCanvas(pw, ph, ctx);
  const img = fctx.createImageData(pw, ph);
  const d = img.data;
  const alphaGain = is2x ? 0.94 : 0.98;

  for (let i = 0; i < pw * ph; i++) {
    const a = clamp01((organicAlpha[i] ?? 0) * alphaGain);
    const k = i * 4;
    d[k] = inkRgb[0];
    d[k + 1] = inkRgb[1];
    d[k + 2] = inkRgb[2];
    d[k + 3] = Math.round(a * 255);
  }
  fctx.putImageData(img, 0, 0);

  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.drawImage(fpCanvas, padX, padY);
  ctx.restore();
}
