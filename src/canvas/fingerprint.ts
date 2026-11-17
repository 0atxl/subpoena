import { createRng, hashHandle } from '../engine/hash.js';
import { PALETTE, type CanvasContext2DLike } from './paper.js';

/**
 * Draws a procedural ink fingerprint seeded from the GitHub handle
 * inside the fingerprint zone (x: 1060-1150, y: 540-630).
 */
export function drawFingerprint(
  ctx: CanvasContext2DLike,
  handle: string,
): void {
  const x = 1060;
  const y = 540;
  const w = 90;
  const h = 90;

  ctx.save();
  ctx.strokeStyle = PALETTE.ink;
  ctx.fillStyle = PALETTE.ink;
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);

  ctx.font = '700 9.5px "Courier Prime", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText('R. THUMB', x + w / 2, y + 4);

  const clipPad = 5;
  ctx.beginPath();
  ctx.rect(x + clipPad, y + 15, w - clipPad * 2, h - 19);
  ctx.clip();

  const seed = hashHandle(handle, 'fingerprint');
  const rng = createRng(seed);
  const cx = x + w / 2 + (rng() - 0.5) * 8;
  const cy = y + 54 + (rng() - 0.5) * 6;
  const tilt = (rng() - 0.5) * 0.35;

  ctx.lineWidth = 1.25;
  ctx.lineCap = 'round';

  for (let r = 2.5; r <= 34; r += 2.75) {
    const rx = r * 0.78;
    const ry = r * 1.12;
    const driftX = ((rng() - 0.5) * r) / 14;
    const driftY = ((rng() - 0.5) * r) / 16;

    // Split each loop into 2-3 ridge arcs with authentic ink gaps
    const segments = 2 + (rng() > 0.45 ? 1 : 0);
    const startBase = rng() * Math.PI * 2;
    const step = (Math.PI * 2) / segments;

    for (let s = 0; s < segments; s++) {
      const gap = 0.24 + rng() * 0.36;
      const a0 = startBase + s * step + gap * 0.5;
      const a1 = startBase + (s + 1) * step - gap * 0.5;
      if (a1 <= a0) continue;

      ctx.beginPath();
      ctx.ellipse(cx + driftX, cy + driftY, rx, ry, tilt, a0, a1);
      ctx.strokeStyle =
        rng() > 0.2 ? 'rgba(23, 21, 15, 0.88)' : 'rgba(23, 21, 15, 0.55)';
      ctx.stroke();
    }
  }

  ctx.restore();
}
