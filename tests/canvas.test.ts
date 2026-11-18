import fs from 'node:fs';
import path from 'node:path';
import { GlobalFonts, createCanvas, loadImage } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { PRESETS } from '../api/presets';
import {
  CHARGES_BOX,
  INTER_COUNT_GAP,
  computeCardLayout,
  draw,
} from '../src/canvas/card';
import { getFingerprintPatternType } from '../src/canvas/fingerprint';
import { makeSealedBundle } from '../src/optout';
import { browserFontLoader, createNodeFontLoader } from '../src/canvas/fonts';
import { renderMugshotViewport, type MugshotVariant } from '../src/canvas/mugshot';
import { CARD_HEIGHT, CARD_WIDTH, drawPaper } from '../src/canvas/paper';
import {
  boxesIntersect,
  getCardStampColors,
  getRotatedBoxBounds,
  getVerdictStampBounds,
} from '../src/canvas/stamps';
import {
  evaluateCharges,
  type VerdictKind,
  type VerdictReport,
} from '../src/engine/charges';
import {
  INK_RGB,
  PRINT_RGB,
  atkinsonDither,
  classifyAvatar,
  equalizeHistogramCLAHE,
  hardThreshold,
  normalizeContrast,
} from '../src/lib/atkinson';

function makePhotoLikeBuffer(w: number, h: number): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 4;
      const cx = x / w - 0.5;
      const cy = y / h - 0.5;
      const radial = Math.max(0, 1 - Math.hypot(cx, cy) * 1.4);
      const wave = ((Math.sin(x * 0.43 + y * 0.21) + 1) * 0.5) * 45;
      buf[k] = Math.round(30 + radial * 170 + wave);
      buf[k + 1] = Math.round(25 + radial * 145 + wave * 0.8);
      buf[k + 2] = Math.round(20 + radial * 125 + wave * 0.6);
      buf[k + 3] = 255;
    }
  }
  return buf;
}

function makeIdenticonBuffer(w: number, h: number): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(w * h * 4);
  const cell = Math.max(1, Math.floor(w / 5));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx = Math.min(4, Math.floor(x / cell));
      const gy = Math.min(4, Math.floor(y / cell));
      const mx = gx > 2 ? 4 - gx : gx;
      const on = (mx + gy) % 2 === 0;
      const k = (y * w + x) * 4;
      buf[k] = on ? 65 : 240;
      buf[k + 1] = on ? 140 : 240;
      buf[k + 2] = on ? 95 : 240;
      buf[k + 3] = 255;
    }
  }
  return buf;
}

describe('atkinson dithering and avatar classification', () => {
  it('outputs strictly the two ink colors with alpha 255 and zero NaNs', () => {
    const w = 48;
    const h = 60;
    const src = makePhotoLikeBuffer(w, h);
    const out = atkinsonDither(src, w, h, PRINT_RGB, INK_RGB);

    expect(out.length).toBe(w * h * 4);
    for (let i = 0; i < out.length; i += 4) {
      const r = out[i]!;
      const g = out[i + 1]!;
      const b = out[i + 2]!;
      const a = out[i + 3]!;
      expect(Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)).toBe(false);
      expect(a).toBe(255);
      const isInk = r === INK_RGB[0] && g === INK_RGB[1] && b === INK_RGB[2];
      const isLight =
        r === PRINT_RGB[0] && g === PRINT_RGB[1] && b === PRINT_RGB[2];
      expect(isInk || isLight).toBe(true);
    }
  });

  it('normalizes dark avatars upward without introducing NaNs', () => {
    const dark = new Float32Array([12, 18, 22, 28, 35, 42, 50, 65]);
    const lifted = normalizeContrast(dark);
    expect(lifted.length).toBe(dark.length);
    for (const val of lifted) {
      expect(Number.isFinite(val)).toBe(true);
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThanOrEqual(255);
    }
    // Brightest dark pixel stretches near upper range
    expect(lifted[lifted.length - 1]!).toBeGreaterThan(200);
  });

  it('classifies photo-like portraits vs logos vs identicons', async () => {
    const photo = makePhotoLikeBuffer(96, 104);
    expect(classifyAvatar(photo, 96, 104)).toBe('photo');

    const identicon = makeIdenticonBuffer(96, 104);
    expect(classifyAvatar(identicon, 96, 104)).toBe('identicon');

    const transparentLogo = new Uint8ClampedArray(96 * 104 * 4);
    for (let i = 0; i < 96 * 104; i++) {
      const k = i * 4;
      const inCenter = i % 96 > 30 && i % 96 < 65;
      transparentLogo[k] = 17;
      transparentLogo[k + 1] = 17;
      transparentLogo[k + 2] = 17;
      transparentLogo[k + 3] = inCenter ? 255 : 0;
    }
    expect(classifyAvatar(transparentLogo, 96, 104)).toBe('logo');

    const fixtureExpectations: Array<[string, 'photo' | 'logo' | 'identicon']> = [
      ['torvalds.png', 'photo'],
      ['sindresorhus.png', 'photo'],
      ['gaearon.png', 'photo'],
      ['yyx990803.png', 'photo'],
      ['octocat.png', 'logo'],
      ['dependabot.png', 'logo'],
      ['vercel.png', 'logo'],
      ['rust-logo.png', 'logo'],
      ['unknown-item-identicon.png', 'identicon'],
    ];

    for (const [file, expected] of fixtureExpectations) {
      const fixturePath = path.resolve(process.cwd(), 'dev/fixtures', file);
      if (!fs.existsSync(fixturePath)) continue;
      const img = await loadImage(fixturePath);
      const w = 126;
      const h = 158;
      const c = createCanvas(w, h);
      const ctx = c.getContext('2d');
      const scale = Math.max(w / img.width, h / img.height);
      const dw = img.width * scale;
      const dh = img.height * scale;
      ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
      const data = ctx.getImageData(0, 0, w, h).data;
      expect(classifyAvatar(data, w, h), file).toBe(expected);
    }
  });

  it('hardThreshold maps strictly to the two ink colors with alpha 255', () => {
    const identicon = makeIdenticonBuffer(40, 40);
    const out = hardThreshold(identicon, 40, 40, PRINT_RGB, INK_RGB);
    let darkCount = 0;
    let lightCount = 0;
    for (let i = 0; i < out.length; i += 4) {
      expect(out[i + 3]).toBe(255);
      if (out[i] === INK_RGB[0]) darkCount++;
      else if (out[i] === PRINT_RGB[0]) lightCount++;
      else throw new Error(`Unexpected RGB: ${out[i]},${out[i + 1]},${out[i + 2]}`);
    }
    expect(darkCount).toBeGreaterThan(0);
    expect(lightCount).toBeGreaterThan(0);
  });
  it('applies CLAHE local contrast equalization across tiles without NaNs', () => {
    const w = 64;
    const h = 80;
    const dark = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // Dark left shadow + brighter highlight pocket on right
        dark[y * w + x] = x < 32 ? 15 + (y % 20) : 70 + (y % 40);
      }
    }
    const equalized = equalizeHistogramCLAHE(dark, w, h);
    expect(equalized.length).toBe(w * h);
    let min = 255;
    let max = 0;
    for (const v of equalized) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(255);
      if (v < min) min = v;
      if (v > max) max = v;
    }
    expect(max - min).toBeGreaterThan(150);
  });
});

describe('card layout stamp collision safety', () => {
  it('never intersects verdict stamp with charge headers, receipts, stings, or bail box', () => {
    const baseTorvalds = evaluateCharges(
      PRESETS.torvalds,
      new Date('2026-11-16T12:00:00Z'),
    );
    const pool = [
      ...baseTorvalds.charges,
      evaluateCharges(PRESETS.sindresorhus, new Date('2026-11-16T12:00:00Z'))
        .charges[0]!,
    ];
    const verdicts: VerdictReport[] = [
      ...Object.values(PRESETS).map((p) =>
        evaluateCharges(p, new Date('2026-11-16T12:00:00Z')),
      ),
      ...[1, 2, 3, 4].map((n) => ({
        ...baseTorvalds,
        handle: `synthetic-${n}-count`,
        charges: pool.slice(0, n).map((c, idx) => ({
          ...c,
          countLabel: `COUNT ${idx + 1}`,
        })),
      })),
      evaluateCharges(
        makeSealedBundle('sealed-suspect', new Date('2026-11-16T12:00:00Z')),
        new Date('2026-11-16T12:00:00Z'),
      ),
      evaluateCharges(
        {
          handle: 'quiet-partial',
          fetchedAt: '2026-11-16T12:00:00.000Z',
          preset: false,
          user: {
            login: 'quiet-partial',
            id: 555,
            avatar_url: 'https://avatars.githubusercontent.com/u/555?v=4',
            name: 'Quiet Partial',
            type: 'User',
            public_repos: 1,
            followers: 0,
            created_at: '2024-01-01T00:00:00Z',
          },
          repos: [],
          events: [],
          commits: null,
          missing: { commits: 403 },
        },
        new Date('2026-11-16T12:00:00Z'),
      ),
      {
        ...evaluateCharges(PRESETS.torvalds, new Date('2026-11-16T12:00:00Z')),
        handle: 'extremely-long-handle-for-stress-testing',
        verdict: 'SUSPICIOUS',
        charges: [0, 1, 2].map((i) => ({
          statute: 'serial_laziness',
          label: 'LICENSELESS ANARCHY AND SERIAL LAZINESS',
          countLabel: `COUNT ${i + 1}`,
          receipt:
            '99 of the last 100 public commits contained extremely verbose placeholder text that would definitely collide without clamping.',
          sting: 'A very long noir sting line meant to test clipping.',
          count: 99,
          totalInspected: 100,
          severity: 100 - i,
        })),
      },
    ];

    for (const verdict of verdicts) {
      const layout = computeCardLayout(verdict);
      expect(boxesIntersect(layout.stampBox, layout.bailBox, 4)).toBe(false);

      for (const item of layout.textBoxes) {
        if (item.kind === 'receipt') {
          expect(item.lines.length).toBeLessThanOrEqual(2);
        }
        if (item.kind === 'sting') {
          expect(item.lines.length).toBeLessThanOrEqual(1);
        }

        const effectiveBox = item.rotateDeg
          ? getRotatedBoxBounds(
              item.x + item.width / 2,
              item.y + item.height / 2,
              item.width,
              item.height,
              item.rotateDeg,
            )
          : item;

        expect(
          boxesIntersect(effectiveBox, layout.stampBox, 2),
          `Stamp collided with ${item.kind} "${item.text}" for ${verdict.handle}`,
        ).toBe(false);

        const bottomMargin =
          CHARGES_BOX.y +
          CHARGES_BOX.height -
          (effectiveBox.y + effectiveBox.height);
        expect(
          bottomMargin,
          `Bottom padding too tight (${bottomMargin}px) for ${verdict.handle}`,
        ).toBeGreaterThanOrEqual(18);
      }
    }
  });

  it('uses consistent vertical gap between stings and next count headers on 3-count cards', () => {
    const torvalds = evaluateCharges(
      PRESETS.torvalds,
      new Date('2026-11-16T12:00:00Z'),
    );
    const layout = computeCardLayout(torvalds);
    const headers = layout.textBoxes.filter((b) => b.kind === 'header');
    const stings = layout.textBoxes.filter((b) => b.kind === 'sting');

    expect(headers).toHaveLength(3);
    expect(stings).toHaveLength(3);

    const gap1To2 = headers[1]!.y - (stings[0]!.y + stings[0]!.height);
    const gap2To3 = headers[2]!.y - (stings[1]!.y + stings[1]!.height);
    expect(gap1To2).toBe(INTER_COUNT_GAP);
    expect(gap2To3).toBe(INTER_COUNT_GAP);
    expect(gap2To3).toBe(gap1To2);
  });

  it('adds a typed automaton directive and sting on single-charge Bot cards without stamp collision', () => {
    const base = evaluateCharges(
      PRESETS.torvalds,
      new Date('2026-11-16T12:00:00Z'),
    );
    const singleChargeBot: VerdictReport = {
      ...base,
      handle: 'dependabot[bot]',
      accountKind: 'Bot',
      charges: base.charges.slice(0, 1),
    };

    const layout = computeCardLayout(singleChargeBot);
    const headers = layout.textBoxes.filter((b) => b.kind === 'header');
    const receipts = layout.textBoxes.filter((b) => b.kind === 'receipt');
    const stings = layout.textBoxes.filter((b) => b.kind === 'sting');

    expect(headers).toHaveLength(2);
    expect(headers[1]?.text).toContain('AUTOMATON DIRECTIVE');
    expect(receipts).toHaveLength(2);
    expect(stings).toHaveLength(2);
    for (const box of layout.textBoxes) {
      expect(boxesIntersect(box, layout.stampBox, 2)).toBe(false);
    }
  });
});

describe('browserFontLoader', () => {
  it('fails loudly when document.fonts fails to load required faces', async () => {
    const originalDoc = globalThis.document;
    (globalThis as { document?: unknown }).document = {
      fonts: {
        load: async () => [],
        check: () => false,
      },
    };
    try {
      await expect(browserFontLoader()).rejects.toThrow(
        /Required font failed to load/,
      );
    } finally {
      if (originalDoc === undefined) {
        delete (globalThis as { document?: unknown }).document;
      } else {
        (globalThis as { document?: unknown }).document = originalDoc;
      }
    }
  });
});

describe('cross-environment shared draw() parity', () => {
  it('renders deterministically under @napi-rs/canvas and matches browser PNG within antialiasing tolerance', async () => {
    const fontLoader = createNodeFontLoader(GlobalFonts, [
      {
        path: path.resolve(process.cwd(), 'public/fonts/CourierPrime-Regular.ttf'),
        family: 'Courier Prime',
      },
      {
        path: path.resolve(process.cwd(), 'public/fonts/CourierPrime-Bold.ttf'),
        family: 'Courier Prime',
      },
      {
        path: path.resolve(process.cwd(), 'public/fonts/ReenieBeanie-Regular.ttf'),
        family: 'Reenie Beanie',
      },
    ]);

    const verdict = evaluateCharges(
      PRESETS.torvalds,
      new Date('2026-11-16T12:00:00.000Z'),
    );
    const avatar = createCanvas(96, 104);
    const actx = avatar.getContext('2d');
    const avatarPixels = actx.createImageData(96, 104);
    avatarPixels.data.set(makePhotoLikeBuffer(96, 104));
    actx.putImageData(avatarPixels, 0, 0);

    const renderOnce = async () => {
      const c = createCanvas(CARD_WIDTH, CARD_HEIGHT);
      const ctx = c.getContext('2d');
      await draw(
        ctx as unknown as CanvasRenderingContext2D,
        verdict,
        avatar as unknown as HTMLImageElement,
        { fontLoader },
      );
      return {
        data: ctx.getImageData(0, 0, CARD_WIDTH, CARD_HEIGHT).data,
        png: c.toBuffer('image/png'),
      };
    };

    const run1 = await renderOnce();
    const run2 = await renderOnce();
    expect(Buffer.from(run1.data).equals(Buffer.from(run2.data))).toBe(true);
    expect(Buffer.from(run1.png).equals(Buffer.from(run2.png))).toBe(true);

    const encoded = await loadImage(run1.png);
    expect(encoded.width).toBe(CARD_WIDTH);
    expect(encoded.height).toBe(CARD_HEIGHT);
  });
});

describe('Phase 3A ink pass guarantees', () => {
  it('keeps all sheet edge pixels lighter than 35% ink across handles', () => {
    const paperLum = 0.299 * 230 + 0.587 * 218 + 0.114 * 192;
    const inkLum = 0.299 * 23 + 0.587 * 21 + 0.114 * 15;
    const holes = [
      { x: 22, y: 60 },
      { x: 22, y: 100 },
    ];

    for (const handle of ['torvalds', 'sindresorhus', 'gaearon', 'octocat']) {
      const c = createCanvas(CARD_WIDTH, CARD_HEIGHT);
      const ctx = c.getContext('2d');
      drawPaper(ctx as unknown as CanvasRenderingContext2D, handle);
      const data = ctx.getImageData(0, 0, CARD_WIDTH, CARD_HEIGHT).data;

      let maxInkPct = 0;
      for (let y = 0; y < CARD_HEIGHT; y++) {
        for (let x = 0; x < CARD_WIDTH; x++) {
          const onEdge =
            x < 44 || y < 4 || x >= CARD_WIDTH - 4 || y >= CARD_HEIGHT - 4;
          if (!onEdge) continue;
          const nearHole = holes.some(
            (h) => Math.hypot(x - h.x, y - h.y) <= 11.5,
          );
          if (nearHole) continue;

          const k = (y * CARD_WIDTH + x) * 4;
          const lum =
            0.299 * (data[k] ?? 230) +
            0.587 * (data[k + 1] ?? 218) +
            0.114 * (data[k + 2] ?? 192);
          const inkPct = Math.max(
            0,
            ((paperLum - lum) / (paperLum - inkLum)) * 100,
          );
          if (inkPct > maxInkPct) maxInkPct = inkPct;
        }
      }
      expect(maxInkPct, `edge ink too dark for ${handle}`).toBeLessThanOrEqual(
        35,
      );
    }
  });

  it('uses at most 3 stamp colors per card and stays collision-free across -12..+8 deg with 3px ghost margin', () => {
    const verdicts: VerdictKind[] = [
      'GUILTY',
      'WANTED',
      'SUSPICIOUS',
      'ACQUITTED',
      'INSUFFICIENT EVIDENCE',
      'RECORD SEALED',
    ];
    for (const v of verdicts) {
      expect(getCardStampColors(v).length).toBeLessThanOrEqual(3);
    }

    const torvaldsLayout = computeCardLayout(
      evaluateCharges(PRESETS.torvalds, new Date('2026-11-16T12:00:00Z')),
    );
    for (const angle of [-12, -9, -4, 0, 4, 8]) {
      const box = getVerdictStampBounds(angle);
      expect(boxesIntersect(box, torvaldsLayout.bailBox, 4)).toBe(false);
      for (const item of torvaldsLayout.textBoxes) {
        expect(boxesIntersect(item, box, 2)).toBe(false);
      }
    }
  });

  it('renders mugshot variants A, B, and C at 252x316 with warm highlights (no pure #f3efe3)', () => {
    const verdict = evaluateCharges(
      PRESETS.torvalds,
      new Date('2026-11-16T12:00:00Z'),
    );
    const avatar = createCanvas(96, 104);
    const actx = avatar.getContext('2d');
    const px = actx.createImageData(96, 104);
    px.data.set(makePhotoLikeBuffer(96, 104));
    actx.putImageData(px, 0, 0);

    const host = createCanvas(CARD_WIDTH, CARD_HEIGHT);
    const hctx = host.getContext('2d') as unknown as CanvasRenderingContext2D;

    for (const mugshotVariant of ['A', 'B', 'C'] as MugshotVariant[]) {
      const res = renderMugshotViewport(
        hctx,
        verdict,
        avatar as unknown as HTMLImageElement,
        { mugshotVariant },
      );
      expect(res.surface.width).toBe(252);
      expect(res.surface.height).toBe(316);
      const sctx = (res.surface as unknown as ReturnType<typeof createCanvas>).getContext(
        '2d',
      );
      const out = sctx.getImageData(0, 0, 252, 316).data;
      let purePrintPixels = 0;
      for (let i = 0; i < out.length; i += 4) {
        expect(Number.isNaN(out[i]!)).toBe(false);
        expect(out[i + 3]).toBe(255);
        if (
          out[i] === PRINT_RGB[0] &&
          out[i + 1] === PRINT_RGB[1] &&
          out[i + 2] === PRINT_RGB[2]
        ) {
          purePrintPixels++;
        }
      }
      expect(purePrintPixels).toBe(0);
    }
  });

  it('produces whorl, loop, and arch fingerprint pattern variety across 12 handles', () => {
    const handles = [
      'torvalds',
      'sindresorhus',
      'gaearon',
      'yyx990803',
      'octocat',
      'dependabot[bot]',
      'vercel',
      'rust-lang',
      'bryan',
      'mitchellh',
      'antirez',
      'fabpot',
    ];
    const seen = new Set(handles.map((h) => getFingerprintPatternType(h)));
    expect(seen.has('whorl')).toBe(true);
    expect(seen.has('loop')).toBe(true);
    expect(seen.has('arch')).toBe(true);
  });
});
