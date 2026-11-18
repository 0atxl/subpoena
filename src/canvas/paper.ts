import { createRng, hashHandle } from '../engine/hash.js';
import type { VerdictReport } from '../engine/charges.js';
import {
  createScratchCanvas,
  drawTypewriterText,
  fbmNoise2D,
  hashPixel,
  inkLayer,
  valueNoise2D,
  type CanvasContext2DLike,
  type ScratchSurface,
} from './ink.js';

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

export { createScratchCanvas, type CanvasContext2DLike, type ScratchSurface };

function clampByte(v: number): number {
  if (v <= 0) return 0;
  if (v >= 255) return 255;
  return Math.round(v);
}

function drawPaperPixelsBand(
  ctx: CanvasContext2DLike,
  seed: number,
  yStart: number,
  yEnd: number,
  rng: () => number,
): void {
  const bandH = yEnd - yStart;
  const img = ctx.createImageData(CARD_WIDTH, bandH);
  const data = img.data;

  // Layer 1 & 2 & 4: Base #e6dac0 + low-frequency mottling (±4% lum + warm/cool drift) + 40% weaker fine grain
  for (let y = yStart; y < yEnd; y++) {
    const localRow = (y - yStart) * CARD_WIDTH;
    for (let x = 0; x < CARD_WIDTH; x++) {
      const k = (localRow + x) * 4;

      // Two octaves of low-frequency noise for paper mottling
      const mottle = fbmNoise2D(x * 0.0085, y * 0.0085, seed ^ 0x314159) - 0.5;
      const tintDrift = valueNoise2D(x * 0.006, y * 0.006, seed ^ 0x271828) - 0.5;

      const lumScale = 1 + mottle * 0.08; // ±4%
      let r = 230 * lumScale + tintDrift * 4.5;
      let g = 218 * lumScale + tintDrift * 1.4;
      let b = 192 * lumScale - tintDrift * 4.5;

      // Fine paper grain (~40% weaker than before: 0.60x alpha)
      const n = rng();
      if (n < 0.16) {
        const alpha = ((8 + rng() * 14) / 255) * 0.6;
        r = r * (1 - alpha) + 23 * alpha;
        g = g * (1 - alpha) + 21 * alpha;
        b = b * (1 - alpha) + 15 * alpha;
      } else if (n > 0.88) {
        const alpha = ((10 + rng() * 18) / 255) * 0.6;
        r = r * (1 - alpha) + 243 * alpha;
        g = g * (1 - alpha) + 239 * alpha;
        b = b * (1 - alpha) + 227 * alpha;
      } else {
        const alpha = ((rng() * 10) / 255) * 0.6;
        r = r * (1 - alpha) + 178 * alpha;
        g = g * (1 - alpha) + 164 * alpha;
        b = b * (1 - alpha) + 132 * alpha;
      }

      data[k] = clampByte(r);
      data[k + 1] = clampByte(g);
      data[k + 2] = clampByte(b);
      data[k + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, yStart);
}

function drawPaperFibers(ctx: CanvasContext2DLike, seed: number): void {
  const rng = createRng(seed ^ 0x6c8e9cf5);
  const count = 460 + Math.floor(rng() * 210); // 460..669 fibers (within 400..700)

  ctx.save();
  ctx.lineCap = 'round';

  for (let i = 0; i < count; i++) {
    const x = 6 + rng() * (CARD_WIDTH - 12);
    const y = 6 + rng() * (CARD_HEIGHT - 12);
    const len = 6 + rng() * 16; // 6..22px
    const angle = (rng() - 0.5) * 0.42; // mostly horizontal
    const bend = (rng() - 0.5) * 3.0;
    const opacity = 0.03 + rng() * 0.03; // 3%..6%
    const isLight = rng() > 0.55;

    const dx = Math.cos(angle) * len;
    const dy = Math.sin(angle) * len;
    const mx = x + dx * 0.5 - Math.sin(angle) * bend;
    const my = y + dy * 0.5 + Math.cos(angle) * bend;

    ctx.strokeStyle = isLight
      ? `rgba(248, 243, 229, ${opacity.toFixed(3)})`
      : `rgba(92, 78, 56, ${opacity.toFixed(3)})`;
    ctx.lineWidth = 0.7 + rng() * 0.5;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(mx, my, x + dx, y + dy);
    ctx.stroke();
  }

  ctx.restore();
}

function drawAgeMarks(ctx: CanvasContext2DLike, seed: number): void {
  const rng = createRng(seed ^ 0x4f1bbcdc);
  const count = 3 + Math.floor(rng() * 4); // 3..6 soft blobs

  ctx.save();
  for (let i = 0; i < count; i++) {
    const cx = 80 + rng() * (CARD_WIDTH - 160);
    const cy = 60 + rng() * (CARD_HEIGHT - 120);
    const radius = 42 + rng() * 68;
    const alpha = 0.02 + rng() * 0.025; // <= 4.5% (under 5%)

    const grad = ctx.createRadialGradient(cx, cy, 4, cx, cy, radius);
    grad.addColorStop(0, `rgba(142, 112, 68, ${alpha.toFixed(3)})`);
    grad.addColorStop(0.65, `rgba(142, 112, 68, ${(alpha * 0.45).toFixed(3)})`);
    grad.addColorStop(1, 'rgba(142, 112, 68, 0)');

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawFoldCrease(ctx: CanvasContext2DLike): void {
  // Subtle horizontal fold crease near y = 338: 1px light line over 1px dark line, fading at ends
  const foldY = 338;
  const img = ctx.getImageData(0, foldY, CARD_WIDTH, 2);
  const d = img.data;

  for (let x = 0; x < CARD_WIDTH; x++) {
    const endFade = Math.sin((x / CARD_WIDTH) * Math.PI);
    const lightAmt = 0.052 * endFade;
    const darkAmt = 0.036 * endFade;

    const kTop = x * 4;
    d[kTop] = clampByte((d[kTop] ?? 230) * (1 - lightAmt) + 245 * lightAmt);
    d[kTop + 1] = clampByte((d[kTop + 1] ?? 218) * (1 - lightAmt) + 241 * lightAmt);
    d[kTop + 2] = clampByte((d[kTop + 2] ?? 192) * (1 - lightAmt) + 229 * lightAmt);

    const kBot = (CARD_WIDTH + x) * 4;
    d[kBot] = clampByte((d[kBot] ?? 230) * (1 - darkAmt) + 23 * darkAmt);
    d[kBot + 1] = clampByte((d[kBot + 1] ?? 218) * (1 - darkAmt) + 21 * darkAmt);
    d[kBot + 2] = clampByte((d[kBot + 2] ?? 192) * (1 - darkAmt) + 15 * darkAmt);
  }

  ctx.putImageData(img, 0, foldY);
}

function drawEdgeTreatmentAndGutterShadow(
  ctx: CanvasContext2DLike,
  seed: number,
): void {
  const rng = createRng(seed ^ 0x517cc1b7);
  const gutterW = 32 + Math.floor(rng() * 12); // 32..43px (within 30..44px)

  // Thin vertical bands (1..3px wide, 8..30% opacity) along the copier gutter
  const bandOpacities = new Float32Array(gutterW);
  let bx = 0;
  while (bx < gutterW) {
    const bw = 1 + Math.floor(rng() * 3); // 1..3px
    const op = 0.08 + rng() * 0.22; // 8..30%
    for (let j = 0; j < bw && bx + j < gutterW; j++) {
      bandOpacities[bx + j] = op;
    }
    bx += bw + Math.floor(rng() * 2);
  }

  // At most 40 subtle dropout specks near the left edge
  const speckCount = 24 + Math.floor(rng() * 15); // 24..38 <= 40
  const specks: Array<{ x: number; y: number; r: number; lighten: boolean }> = [];
  for (let i = 0; i < speckCount; i++) {
    specks.push({
      x: 1 + Math.floor(rng() * 18),
      y: 8 + Math.floor(rng() * (CARD_HEIGHT - 16)),
      r: 0.8 + rng() * 1.4,
      lighten: rng() > 0.35,
    });
  }

  // Process only the 4 disjoint border strips that actually receive edge/gutter shading
  const applyStrip = (rx: number, ry: number, rw: number, rh: number): void => {
    if (rw <= 0 || rh <= 0) return;
    const img = ctx.getImageData(rx, ry, rw, rh);
    const data = img.data;

    for (let ly = 0; ly < rh; ly++) {
      const y = ry + ly;
      const distY = Math.min(y, CARD_HEIGHT - 1 - y);
      for (let lx = 0; lx < rw; lx++) {
        const x = rx + lx;
        const distX = Math.min(x, CARD_WIDTH - 1 - x);
        const distEdge = Math.min(distX, distY);

        if (distEdge >= 10 && x >= gutterW) continue;

        let inkBlend = 0;
        if (distEdge === 0) {
          inkBlend += 0.08;
        } else if (distEdge < 10) {
          const t = 1 - distEdge / 10;
          inkBlend += t * t * 0.065;
        }

        if (x < gutterW) {
          const falloff = Math.pow(1 - x / gutterW, 1.65);
          const yMod = 0.82 + 0.36 * valueNoise2D(x * 0.35, y * 0.014, seed ^ 0x19a3);
          const band = bandOpacities[x] ?? 0;
          const bandBoost = band * 0.45 * (0.65 + 0.35 * hashPixel(x, y >> 2, seed + 7));
          const gutter = Math.min(0.24, falloff * (0.16 * yMod + bandBoost));
          inkBlend += gutter;
        }

        const k = (ly * rw + lx) * 4;
        let r = data[k] ?? 230;
        let g = data[k + 1] ?? 218;
        let b = data[k + 2] ?? 192;

        if (inkBlend > 0) {
          const clampedBlend = Math.min(0.31, inkBlend);
          r = r * (1 - clampedBlend) + 23 * clampedBlend;
          g = g * (1 - clampedBlend) + 21 * clampedBlend;
          b = b * (1 - clampedBlend) + 15 * clampedBlend;
        }

        // Hard ceiling: no edge pixel darker than 31% ink (strictly lighter than 35% ink)
        data[k] = Math.max(166, clampByte(r));
        data[k + 1] = Math.max(157, clampByte(g));
        data[k + 2] = Math.max(137, clampByte(b));
      }
    }

    // Apply <= 40 dropout specks inside left gutter strip (x in 1..gutterW-1, y in 1..CARD_HEIGHT-2)
    if (rx === 0 && rw >= gutterW) {
      for (const sp of specks) {
        const rad = Math.ceil(sp.r);
        for (let dy = -rad; dy <= rad; dy++) {
          const py = sp.y + dy;
          if (py < 1 || py >= CARD_HEIGHT - 1) continue;
          const ly = py - ry;
          if (ly < 0 || ly >= rh) continue;
          for (let dx = -rad; dx <= rad; dx++) {
            const px = sp.x + dx;
            if (px < 1 || px >= gutterW) continue;
            if (dx * dx + dy * dy > sp.r * sp.r) continue;
            const k = (ly * rw + px) * 4;
            if (sp.lighten) {
              data[k] = Math.min(230, (data[k] ?? 200) + 14);
              data[k + 1] = Math.min(218, (data[k + 1] ?? 188) + 13);
              data[k + 2] = Math.min(192, (data[k + 2] ?? 165) + 11);
            } else {
              data[k] = Math.max(168, (data[k] ?? 200) - 10);
              data[k + 1] = Math.max(159, (data[k + 1] ?? 188) - 9);
              data[k + 2] = Math.max(139, (data[k + 2] ?? 165) - 8);
            }
          }
        }
      }
    }

    ctx.putImageData(img, rx, ry);
  };

  applyStrip(0, 0, gutterW, CARD_HEIGHT);
  applyStrip(gutterW, 0, CARD_WIDTH - gutterW, 10);
  applyStrip(CARD_WIDTH - 10, 10, 10, CARD_HEIGHT - 20);
  applyStrip(gutterW, CARD_HEIGHT - 10, CARD_WIDTH - 10 - gutterW, 10);
}

function drawPunchHoles(ctx: CanvasContext2DLike): void {
  const holes = [
    { x: 22, y: 60 },
    { x: 22, y: 100 },
  ];
  const radius = 8.5;

  ctx.save();
  for (const hole of holes) {
    // Thin lighter ring for paper thickness
    ctx.beginPath();
    ctx.arc(hole.x, hole.y, radius + 0.75, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(246, 241, 228, 0.72)';
    ctx.lineWidth = 1.25;
    ctx.stroke();

    // Desk color showing through punched hole
    ctx.beginPath();
    ctx.arc(hole.x, hole.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = PALETTE.desk;
    ctx.fill();

    // Top inner shadow inside punch hole
    ctx.beginPath();
    ctx.arc(hole.x, hole.y, radius - 0.75, Math.PI * 0.85, Math.PI * 1.92);
    ctx.strokeStyle = 'rgba(15, 14, 10, 0.72)';
    ctx.lineWidth = 2.1;
    ctx.stroke();
  }
  ctx.restore();
}

export interface NamedRenderStage {
  name: string;
  run: () => void;
}

export function getPaperStages(
  ctx: CanvasContext2DLike,
  handle: string,
): NamedRenderStage[] {
  const seed = hashHandle(handle, 'paper');
  const pixelRng = createRng(seed ^ 0x9e3779b9);

  return [
    {
      name: 'paper-band-0',
      run: () => drawPaperPixelsBand(ctx, seed, 0, 225, pixelRng),
    },
    {
      name: 'paper-band-1',
      run: () => drawPaperPixelsBand(ctx, seed, 225, 450, pixelRng),
    },
    {
      name: 'paper-band-2',
      run: () => drawPaperPixelsBand(ctx, seed, 450, 675, pixelRng),
    },
    {
      name: 'paper-finish',
      run: () => {
        ctx.save();
        drawPaperFibers(ctx, seed);
        drawAgeMarks(ctx, seed);
        drawFoldCrease(ctx);
        drawEdgeTreatmentAndGutterShadow(ctx, seed);
        drawPunchHoles(ctx);
        ctx.restore();
      },
    },
  ];
}

export function drawPaper(ctx: CanvasContext2DLike, handle: string): void {
  for (const stage of getPaperStages(ctx, handle)) {
    stage.run();
  }
}

export function getHeaderStages(
  ctx: CanvasContext2DLike,
  verdict: VerdictReport,
): NamedRenderStage[] {
  const x0 = 80;
  const x1 = 1150;
  const w = x1 - x0;

  return [
    {
      name: 'header-band',
      run: () => {
        inkLayer(
          ctx,
          (sctx) => {
            sctx.fillStyle = PALETTE.ink;
            sctx.fillRect(x0, 30, w, 4);
            sctx.fillRect(x0, 37, w, 1.5);
            sctx.fillRect(x0, 108, w, 1.5);
            sctx.fillRect(x0, 113, w, 4);

            const title = 'SUBPOENA — RAP SHEET';
            sctx.font = '700 44px "Courier Prime", monospace';
            sctx.textBaseline = 'middle';
            sctx.textAlign = 'center';

            const titleX = x0 + w / 2 - 42;
            const titleY = 74;
            drawTypewriterText(
              sctx,
              title,
              titleX,
              titleY,
              hashHandle(verdict.handle, 'header-title'),
            );
          },
          'header',
          hashHandle(verdict.handle, 'header-ink'),
          { color: PALETTE.ink },
        );
      },
    },
    {
      name: 'header-fields',
      run: () => {
        inkLayer(
          ctx,
          (sctx) => {
            const rowY = 124;
            const rowH = 54;
            sctx.strokeStyle = PALETTE.ink;
            sctx.fillStyle = PALETTE.ink;
            sctx.lineWidth = 2;
            sctx.strokeRect(x0, rowY, w, rowH);

            const col1W = Math.round(w * 0.32);
            const col2W = Math.round(w * 0.28);
            const div1X = x0 + col1W;
            const div2X = div1X + col2W;

            sctx.beginPath();
            sctx.moveTo(div1X, rowY);
            sctx.lineTo(div1X, rowY + rowH);
            sctx.moveTo(div2X, rowY);
            sctx.lineTo(div2X, rowY + rowH);
            sctx.stroke();

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

            sctx.textAlign = 'left';
            sctx.textBaseline = 'top';
            fields.forEach((field, idx) => {
              sctx.font = '700 11px "Courier Prime", monospace';
              drawTypewriterText(
                sctx,
                field.label,
                field.x + 10,
                rowY + 6,
                hashHandle(verdict.handle, `field-label-${idx}`),
              );

              sctx.font = '700 20px "Courier Prime", monospace';
              drawTypewriterText(
                sctx,
                field.value,
                field.x + 10,
                rowY + 24,
                hashHandle(verdict.handle, `field-val-${idx}`),
                field.w - 20,
              );
            });
          },
          'labels',
          hashHandle(verdict.handle, 'fields-ink'),
          { color: PALETTE.ink },
        );
      },
    },
  ];
}

export function drawHeaderAndFields(
  ctx: CanvasContext2DLike,
  verdict: VerdictReport,
): void {
  for (const stage of getHeaderStages(ctx, verdict)) {
    stage.run();
  }
}
