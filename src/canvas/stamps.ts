import { createRng, hashHandle } from '../engine/hash.js';
import type { VerdictKind, VerdictReport } from '../engine/charges.js';
import {
  createScratchCanvas,
  drawTypewriterText,
  inkLayer,
  type CanvasContext2DLike,
} from './ink.js';
import { PALETTE } from './paper.js';

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const STAMP_COLORS = {
  GUILTY: '#a3322a',
  WANTED: '#b4552b',
  SUSPICIOUS: '#5a3d6e',
  ACQUITTED: '#3f6a4a',
  'INSUFFICIENT EVIDENCE': '#2f4a7a',
  'RECORD SEALED': '#2a2a28',
  form14B: '#a3322a',
  date: '#2f4a7a',
  exhibitTag: '#2a2a28',
} as const;

export const VERDICT_STAMP_SPEC = {
  cx: 976,
  cy: 438,
  width: 272,
  height: 92,
  angleDeg: -9,
  ghostMarginPx: 3,
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

/**
 * Computes verdict stamp bounds including the 3px second-impression ghost margin.
 */
export function getVerdictStampBounds(
  angleDeg: number = VERDICT_STAMP_SPEC.angleDeg,
): BoundingBox {
  const margin = VERDICT_STAMP_SPEC.ghostMarginPx * 2;
  return getRotatedBoxBounds(
    VERDICT_STAMP_SPEC.cx,
    VERDICT_STAMP_SPEC.cy,
    VERDICT_STAMP_SPEC.width + margin,
    VERDICT_STAMP_SPEC.height + margin,
    angleDeg,
  );
}

/**
 * Seeded verdict stamp rotation between -12° and +8°.
 */
export function getSeededVerdictStampAngle(handle: string): number {
  const rng = createRng(hashHandle(handle, 'verdict-stamp-angle'));
  return -12 + rng() * 20;
}

/**
 * Returns the distinct stamp colors used on a card (enforcing at most 3 colors).
 */
export function getCardStampColors(verdict: VerdictKind): string[] {
  const verdictColor = STAMP_COLORS[verdict];
  const colors = new Set<string>([
    STAMP_COLORS.form14B,
    verdictColor,
    STAMP_COLORS.date,
  ]);
  if (colors.size < 3) {
    colors.add(STAMP_COLORS.exhibitTag);
  }
  return Array.from(colors);
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

interface RingBreak {
  edge: number; // 0: top, 1: right, 2: bottom, 3: left
  t0: number;
  t1: number;
}

function generateRingBreaks(rng: () => number, count: number): RingBreak[] {
  const breaks: RingBreak[] = [];
  for (let i = 0; i < count; i++) {
    const edge = Math.floor(rng() * 4);
    const t0 = 0.08 + rng() * 0.72;
    const span = 0.05 + rng() * 0.09;
    breaks.push({ edge, t0, t1: Math.min(0.95, t0 + span) });
  }
  return breaks;
}

function isInBreak(breaks: RingBreak[], edge: number, t: number): boolean {
  for (const br of breaks) {
    if (br.edge === edge && t >= br.t0 && t <= br.t1) return true;
  }
  return false;
}

function drawUnevenBrokenRect(
  ctx: CanvasContext2DLike,
  x: number,
  y: number,
  w: number,
  h: number,
  baseLineWidth: number,
  rng: () => number,
  breakCount: number,
): void {
  const breaks = generateRingBreaks(rng, breakCount);
  const edges: ReadonlyArray<{
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    steps: number;
  }> = [
    { x0: x, y0: y, x1: x + w, y1: y, steps: Math.max(8, Math.round(w / 10)) },
    { x0: x + w, y0: y, x1: x + w, y1: y + h, steps: Math.max(4, Math.round(h / 10)) },
    { x0: x + w, y0: y + h, x1: x, y1: y + h, steps: Math.max(8, Math.round(w / 10)) },
    { x0: x, y0: y + h, x1: x, y1: y, steps: Math.max(4, Math.round(h / 10)) },
  ];

  ctx.save();
  ctx.lineCap = 'round';
  for (let eIdx = 0; eIdx < edges.length; eIdx++) {
    const edge = edges[eIdx]!;
    for (let s = 0; s < edge.steps; s++) {
      const t0 = s / edge.steps;
      const t1 = (s + 1) / edge.steps;
      const tm = (t0 + t1) * 0.5;
      if (isInBreak(breaks, eIdx, tm)) {
        rng();
        continue;
      }
      const jitterW = baseLineWidth * (0.78 + rng() * 0.44);
      const sx0 = edge.x0 + (edge.x1 - edge.x0) * t0;
      const sy0 = edge.y0 + (edge.y1 - edge.y0) * t0;
      const sx1 = edge.x0 + (edge.x1 - edge.x0) * t1;
      const sy1 = edge.y0 + (edge.y1 - edge.y0) * t1;

      ctx.lineWidth = jitterW;
      ctx.beginPath();
      ctx.moveTo(sx0, sy0);
      ctx.lineTo(sx1, sy1);
      ctx.stroke();
    }
  }

  // Ink pooling at corners
  const corners = [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ] as const;
  for (const [cx, cy] of corners) {
    const r = baseLineWidth * (0.55 + rng() * 0.35);
    ctx.beginPath();
    ctx.arc(cx + (rng() - 0.5) * 1.2, cy + (rng() - 0.5) * 1.2, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawStampBlotSpecks(
  ctx: CanvasContext2DLike,
  ox: number,
  oy: number,
  w: number,
  h: number,
  rng: () => number,
  count: number,
): void {
  ctx.save();
  for (let i = 0; i < count; i++) {
    const edge = Math.floor(rng() * 4);
    const band = 2 + rng() * 8;
    let sx: number;
    let sy: number;
    if (edge === 0) {
      sx = ox + 4 + rng() * (w - 8);
      sy = oy + band;
    } else if (edge === 1) {
      sx = ox + w - band;
      sy = oy + 4 + rng() * (h - 8);
    } else if (edge === 2) {
      sx = ox + 4 + rng() * (w - 8);
      sy = oy + h - band;
    } else {
      sx = ox + band;
      sy = oy + 4 + rng() * (h - 8);
    }
    const r = 0.7 + rng() * 1.1;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function makePressureMap(seed: number): (nx: number, ny: number) => number {
  const rng = createRng(seed ^ 0x7f4a7c15);
  const ang = rng() * Math.PI * 2;
  const gx = Math.cos(ang);
  const gy = Math.sin(ang);
  const bias = 0.72 + (rng() - 0.5) * 0.1;

  return (nx: number, ny: number): number => {
    const centeredX = nx * 2 - 1;
    const centeredY = ny * 2 - 1;
    const raw = bias + (centeredX * gx + centeredY * gy) * 0.34;
    return Math.max(0.42, Math.min(1.0, raw));
  };
}

function makeVerdictCorePressureMap(
  seed: number,
): (nx: number, ny: number) => number {
  const rng = createRng(seed ^ 0x7f4a7c15);
  const ang = rng() * Math.PI * 2;
  const gx = Math.cos(ang);
  const gy = Math.sin(ang);

  return (nx: number, ny: number): number => {
    const dx = nx - 0.5;
    const dy = ny - 0.5;
    const radial = Math.hypot(dx, dy);
    const directional = dx * 2 * gx + dy * 2 * gy;
    if (radial <= 0.35) {
      return Math.max(0.85, Math.min(1.0, 0.94 + directional * 0.08));
    }
    const edgeFactor = Math.min(1, (radial - 0.35) / 0.35);
    const edgeRaw = 0.9 - edgeFactor * 0.14 + directional * 0.18;
    return Math.max(0.62, Math.min(1.0, edgeRaw));
  };
}

function makeSecondImpression(
  seed: number,
): { offsetX: number; offsetY: number; opacity: number } | null {
  const rng = createRng(seed ^ 0x94d049bb);
  if (rng() >= 0.3) return null; // ~30% of stamps get a faint second impression
  const ang = rng() * Math.PI * 2;
  const dist = 1.6 + rng() * 1.4; // up to 3px offset
  return {
    offsetX: Math.cos(ang) * dist,
    offsetY: Math.sin(ang) * dist,
    opacity: 0.18 + rng() * 0.08,
  };
}

function compositeStamp(
  ctx: CanvasContext2DLike,
  stampSurface: HTMLCanvasElement | OffscreenCanvas,
  cx: number,
  cy: number,
  angleDeg: number,
  skewXDeg: number,
  skewYDeg: number,
  alpha: number,
): void {
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = alpha;
  ctx.translate(cx, cy);
  ctx.rotate((angleDeg * Math.PI) / 180);
  ctx.transform(
    1,
    Math.tan((skewYDeg * Math.PI) / 180),
    Math.tan((skewXDeg * Math.PI) / 180),
    1,
    0,
    0,
  );
  ctx.drawImage(
    stampSurface,
    -stampSurface.width / 2,
    -stampSurface.height / 2,
  );
  ctx.restore();
}

function drawForm14BStamp(ctx: CanvasContext2DLike, seed: number): void {
  const w = 132;
  const h = 34;
  const pad = 8;
  const sw = w + pad * 2;
  const sh = h + pad * 2;
  const { canvas: stamp, ctx: sctx } = createScratchCanvas(sw, sh, ctx);
  const rng = createRng(seed ^ 0x13579bdf);
  const pressureMap = makePressureMap(seed ^ 0x13579bdf);
  const secondImpression = makeSecondImpression(seed ^ 0x13579bdf);

  inkLayer(
    sctx,
    (ictx) => {
      ictx.strokeStyle = PALETTE.ink;
      ictx.fillStyle = PALETTE.ink;
      drawUnevenBrokenRect(ictx, pad + 2, pad + 2, w - 4, h - 4, 2.8, rng, 3);
      ictx.font = '700 17px "Courier Prime", monospace';
      ictx.textAlign = 'center';
      ictx.textBaseline = 'middle';
      drawTypewriterText(
        ictx,
        'FORM 14-B',
        pad + w / 2,
        pad + h / 2 + 1,
        seed ^ 0x111,
      );
      drawStampBlotSpecks(ictx, pad, pad, w, h, rng, 6);
    },
    'stamp',
    seed ^ 0x13579bdf,
    {
      color: STAMP_COLORS.form14B,
      pressureMap,
      secondImpression,
    },
  );

  const angleDeg = 1.5 + (rng() - 0.5) * 2.2;
  const skewX = (rng() - 0.5) * 3.4; // up to ±1.7°
  const skewY = (rng() - 0.5) * 2.4;
  compositeStamp(ctx, stamp, 1076, 52, angleDeg, skewX, skewY, 0.7);
}

function drawExhibitDateStamp(
  ctx: CanvasContext2DLike,
  date: string,
  verdict: VerdictKind,
  seed: number,
): void {
  const w = 230;
  const h = 30;
  const pad = 8;
  const sw = w + pad * 2;
  const sh = h + pad * 2;
  const { canvas: stamp, ctx: sctx } = createScratchCanvas(sw, sh, ctx);
  const rng = createRng(seed ^ 0x2468ace0);
  const pressureMap = makePressureMap(seed ^ 0x2468ace0);
  const secondImpression = makeSecondImpression(seed ^ 0x2468ace0);

  // Enforce <= 3 stamp colors on the entire card:
  // Use charcoal EXHIBIT tag + blue date when verdict doesn't add a 4th color.
  const verdictColor = STAMP_COLORS[verdict];
  const usesOwnVerdictColor =
    verdictColor !== STAMP_COLORS.form14B &&
    verdictColor !== STAMP_COLORS.date &&
    verdictColor !== STAMP_COLORS.exhibitTag;

  const leftTag = 'EXHIBIT A';
  const rightDate = `•  ${date}`;

  if (usesOwnVerdictColor) {
    inkLayer(
      sctx,
      (ictx) => {
        ictx.strokeStyle = PALETTE.ink;
        ictx.fillStyle = PALETTE.ink;
        drawUnevenBrokenRect(ictx, pad + 2, pad + 2, w - 4, h - 4, 2.0, rng, 3);
        ictx.font = '700 12.5px "Courier Prime", monospace';
        ictx.textAlign = 'center';
        ictx.textBaseline = 'middle';
        drawTypewriterText(
          ictx,
          `EXHIBIT A  •  ${date}`,
          pad + w / 2,
          pad + h / 2 + 0.5,
          seed ^ 0x222,
        );
        drawStampBlotSpecks(ictx, pad, pad, w, h, rng, 6);
      },
      'stamp',
      seed ^ 0x2468ace0,
      {
        color: STAMP_COLORS.date,
        pressureMap,
        secondImpression,
      },
    );
  } else {
    // Charcoal EXHIBIT tag + Blue border & date
    sctx.font = '700 12.5px "Courier Prime", monospace';
    const fullText = `${leftTag}  ${rightDate}`;
    const fullW = sctx.measureText(fullText).width;
    const tagW = sctx.measureText(`${leftTag}  `).width;
    const startX = pad + (w - fullW) / 2;

    inkLayer(
      sctx,
      (ictx) => {
        ictx.fillStyle = PALETTE.ink;
        ictx.font = '700 12.5px "Courier Prime", monospace';
        ictx.textAlign = 'left';
        ictx.textBaseline = 'middle';
        drawTypewriterText(
          ictx,
          leftTag,
          startX,
          pad + h / 2 + 0.5,
          seed ^ 0x221,
        );
      },
      'stamp',
      seed ^ 0x2468ace1,
      {
        color: STAMP_COLORS.exhibitTag,
        pressureMap,
        secondImpression,
      },
    );

    inkLayer(
      sctx,
      (ictx) => {
        ictx.strokeStyle = PALETTE.ink;
        ictx.fillStyle = PALETTE.ink;
        drawUnevenBrokenRect(ictx, pad + 2, pad + 2, w - 4, h - 4, 2.0, rng, 3);
        ictx.font = '700 12.5px "Courier Prime", monospace';
        ictx.textAlign = 'left';
        ictx.textBaseline = 'middle';
        drawTypewriterText(
          ictx,
          rightDate,
          startX + tagW,
          pad + h / 2 + 0.5,
          seed ^ 0x222,
        );
        drawStampBlotSpecks(ictx, pad, pad, w, h, rng, 6);
      },
      'stamp',
      seed ^ 0x2468ace0,
      {
        color: STAMP_COLORS.date,
        pressureMap,
        secondImpression,
      },
    );
  }

  const angleDeg = -1.8 + (rng() - 0.5) * 2.0;
  const skewX = (rng() - 0.5) * 3.4;
  const skewY = (rng() - 0.5) * 2.2;
  compositeStamp(ctx, stamp, 1018, 214, angleDeg, skewX, skewY, 0.88);
}

function drawVerdictStamp(
  ctx: CanvasContext2DLike,
  verdict: VerdictReport,
  seed: number,
): void {
  const label = verdict.verdict;
  const color = STAMP_COLORS[label];
  const { cx, cy, width: w, height: h } = VERDICT_STAMP_SPEC;
  const pad = 10;
  const sw = w + pad * 2;
  const sh = h + pad * 2;
  const { canvas: stamp, ctx: sctx } = createScratchCanvas(sw, sh, ctx);
  const rng = createRng(seed ^ 0xdeadbeef);
  const pressureMap = makeVerdictCorePressureMap(seed ^ 0xdeadbeef);
  const secondImpression = makeSecondImpression(seed ^ 0xdeadbeef);

  const breakOuter = 3 + Math.floor(rng() * 4); // 3..6 breaks
  const breakInner = 3 + Math.floor(rng() * 3); // 3..5 breaks

  inkLayer(
    sctx,
    (ictx) => {
      ictx.strokeStyle = PALETTE.ink;
      ictx.fillStyle = PALETTE.ink;

      // Double ring with uneven thickness, 3-6 breaks, and corner ink pooling
      drawUnevenBrokenRect(
        ictx,
        pad + 3,
        pad + 3,
        w - 6,
        h - 6,
        4.6,
        rng,
        breakOuter,
      );
      drawUnevenBrokenRect(
        ictx,
        pad + 10,
        pad + 10,
        w - 20,
        h - 20,
        2.0,
        rng,
        breakInner,
      );

      ictx.textAlign = 'center';
      ictx.textBaseline = 'middle';

      if (label.includes(' ')) {
        const parts = label.split(/\s+/);
        let fontSize = 28;
        ictx.font = `700 ${fontSize}px "Courier Prime", monospace`;
        const longest = parts.reduce(
          (a, b) => (a.length >= b.length ? a : b),
          '',
        );
        while (ictx.measureText(longest).width > w - 34 && fontSize > 22) {
          fontSize -= 1;
          ictx.font = `700 ${fontSize}px "Courier Prime", monospace`;
        }
        const topLine = parts[0] ?? label;
        const bottomLine = parts.slice(1).join(' ');
        drawTypewriterText(
          ictx,
          topLine,
          pad + w / 2,
          pad + h / 2 - 13,
          seed ^ 0x331,
        );
        drawTypewriterText(
          ictx,
          bottomLine,
          pad + w / 2,
          pad + h / 2 + 15,
          seed ^ 0x332,
        );
      } else {
        let fontSize = 48;
        ictx.font = `700 ${fontSize}px "Courier Prime", monospace`;
        while (ictx.measureText(label).width > w - 38 && fontSize > 26) {
          fontSize -= 2;
          ictx.font = `700 ${fontSize}px "Courier Prime", monospace`;
        }
        drawTypewriterText(
          ictx,
          label,
          pad + w / 2,
          pad + h / 2 + 2,
          seed ^ 0x333,
        );
      }

      drawStampBlotSpecks(ictx, pad, pad, w, h, rng, 10);
    },
    {
      spread: 1.0,
      ghost: null,
      densityMin: 0.82,
      densityMax: 1.0,
      dropout: 0.08,
    },
    seed ^ 0xdeadbeef,
    {
      color,
      pressureMap,
      secondImpression,
    },
  );

  const angleDeg = getSeededVerdictStampAngle(verdict.handle);
  const skewX = (rng() - 0.5) * 4.0; // up to ±2°
  const skewY = (rng() - 0.5) * 3.0; // up to ±1.5°
  compositeStamp(ctx, stamp, cx, cy, angleDeg, skewX, skewY, 0.96);
}

export function drawStamps(
  ctx: CanvasContext2DLike,
  verdict: VerdictReport,
): void {
  const seed = hashHandle(verdict.handle, 'stamps');
  drawForm14BStamp(ctx, seed);
  drawExhibitDateStamp(ctx, verdict.date, verdict.verdict, seed);
  drawVerdictStamp(ctx, verdict, seed);
}
