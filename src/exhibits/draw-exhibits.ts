import { createRng, hashHandle } from '../engine/hash.js';
import {
  drawHandCircle,
  drawHandwrittenText,
  drawTypewriterText,
  inkLayer,
} from '../canvas/ink.js';
import { PALETTE, type CanvasContext2DLike } from '../canvas/paper.js';
import {
  drawDottedLeader,
  drawExhibitFrame,
  drawExhibitNoirLine,
  drawHatchedInkBar,
  drawWithheldNotice,
  strokeHatchLines,
  type ExhibitDossier,
  type ExhibitId,
  type ExhibitRenderResult,
} from './frame.js';

export interface RenderExhibitOptions {
  now?: Date;
}

const MONTH_ABBR = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
] as const;

const WEEKDAY_ABBR = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;

function pickSeededNoirLine(
  seedKey: string,
  options: readonly string[],
): string {
  const rng = createRng(hashHandle(seedKey, 'noir-bank'));
  const idx = Math.floor(rng() * options.length) % options.length;
  return options[idx] ?? options[0] ?? '';
}

function formatRepoSampleList(
  names: readonly string[],
  maxShow = 5,
): string {
  if (names.length === 0) return '';
  const shown = names.slice(0, maxShow);
  const rest = names.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} (+${rest})` : shown.join(', ');
}

function pctText(share: number): string {
  const val = Math.max(0, share) * 100;
  return `${val >= 10 || val === 0 ? Math.round(val) : val.toFixed(1)}%`;
}

function drawCalendarLevelCell(
  ctx: CanvasContext2DLike,
  x: number,
  y: number,
  size: number,
  level: 0 | 1 | 2 | 3 | 4,
): void {
  ctx.save();
  ctx.strokeStyle = PALETTE.ink;
  ctx.fillStyle = PALETTE.ink;

  if (level === 0) {
    ctx.globalAlpha = 0.42;
    ctx.lineWidth = 0.9;
    ctx.setLineDash([2, 3]);
    ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
    ctx.setLineDash([]);
    ctx.restore();
    return;
  }

  if (level === 4) {
    ctx.fillRect(x, y, size, size);
    ctx.restore();
    return;
  }

  ctx.lineWidth = level === 3 ? 1.25 : 1;
  ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);

  if (level === 1) {
    strokeHatchLines(ctx, x + 1, y + 1, size - 2, size - 2, 5, false, 1.05);
  } else if (level === 2) {
    strokeHatchLines(ctx, x + 1, y + 1, size - 2, size - 2, 5, false, 1.05);
    strokeHatchLines(ctx, x + 1, y + 1, size - 2, size - 2, 5, true, 1.05);
  } else {
    strokeHatchLines(ctx, x + 1, y + 1, size - 2, size - 2, 3, false, 1.35);
    strokeHatchLines(ctx, x + 1, y + 1, size - 2, size - 2, 3, true, 1.35);
  }
  ctx.restore();
}

function drawExhibitA(
  ctx: CanvasContext2DLike,
  dossier: ExhibitDossier,
): ExhibitRenderResult {
  const title = 'CONTRIBUTION RECORD';
  const seedKey = `${dossier.handle}-exhibit-A`;
  const { partial } = drawExhibitFrame(
    ctx,
    'A',
    title,
    dossier,
    'DAILY PUBLIC & INDEXED CONTRIBUTION LEDGER (53 WEEKS)',
  );

  const cal = dossier.calendar;
  if (!cal || cal.weeks.length === 0) {
    drawWithheldNotice(
      ctx,
      seedKey,
      'CONTRIBUTION CALENDAR UNAVAILABLE FOR THIS RECORD.',
    );
    drawExhibitNoirLine(
      ctx,
      seedKey,
      pickSeededNoirLine(seedKey, [
        'calendar page torn from the binder.',
        'no squares returned by the clerk.',
        'alibi blank — nothing stamped on the grid.',
      ]),
      1090,
      584,
      620,
      'right',
    );
    return { id: 'A', title, withheld: true, partial };
  }

  const weeks = cal.weeks.slice(-53);
  const cols = weeks.length;
  const gridX = 132;
  const gridY = 186;
  const cell = 15;
  const gap = 3;
  const pitch = cell + gap;

  let busiestPos: { col: number; row: number; cx: number; cy: number } | null = null;
  let totalDays = 0;
  const monthlyMap = new Map<string, number>();

  for (let c = 0; c < cols; c++) {
    const colCells = weeks[c] ?? [];
    for (let r = 0; r < 7; r++) {
      const cellData = colCells[r] ?? null;
      if (!cellData) continue;
      totalDays++;
      const ym = cellData.date.slice(0, 7);
      monthlyMap.set(ym, (monthlyMap.get(ym) ?? 0) + cellData.count);
      if (
        cal.busiest &&
        cal.busiest.count > 0 &&
        cellData.date === cal.busiest.date
      ) {
        busiestPos = {
          col: c,
          row: r,
          cx: gridX + c * pitch + cell * 0.5,
          cy: gridY + r * pitch + cell * 0.5,
        };
      }
    }
  }

  const monthlyEntries = [...monthlyMap.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .slice(-12);

  // Hatch grid + monthly bar strip in 'labels' inkLayer
  inkLayer(
    ctx,
    (sctx) => {
      sctx.strokeStyle = PALETTE.ink;
      sctx.fillStyle = PALETTE.ink;

      // Grid hatching cells
      for (let c = 0; c < cols; c++) {
        const colCells = weeks[c] ?? [];
        for (let r = 0; r < 7; r++) {
          const item = colCells[r] ?? null;
          if (!item) continue;
          drawCalendarLevelCell(
            sctx,
            gridX + c * pitch,
            gridY + r * pitch,
            cell,
            item.level,
          );
        }
      }

      // Legend (LESS [0..4] MORE)
      const lx0 = 930;
      const ly = 152;
      for (let lvl = 0; lvl <= 4; lvl++) {
        drawCalendarLevelCell(
          sctx,
          lx0 + lvl * 20,
          ly,
          13,
          lvl as 0 | 1 | 2 | 3 | 4,
        );
      }

      // Stat row border box (y = 350..418)
      sctx.lineWidth = 2;
      sctx.strokeRect(110, 350, 995, 68);
      const colWidths = [225, 175, 195, 180, 220];
      let divX = 110;
      for (let i = 0; i < colWidths.length - 1; i++) {
        divX += colWidths[i]!;
        sctx.beginPath();
        sctx.moveTo(divX, 350);
        sctx.lineTo(divX, 418);
        sctx.stroke();
      }

      // 12-bar monthly strip below stats (y = 442..578)
      const stripX = 132;
      const stripW = 954;
      const baseY = 576;
      const maxH = 104;
      sctx.lineWidth = 1.5;
      sctx.beginPath();
      sctx.moveTo(stripX - 6, baseY);
      sctx.lineTo(stripX + stripW, baseY);
      sctx.stroke();

      const maxMonth = Math.max(1, ...monthlyEntries.map(([, v]) => v));
      const slotW = stripW / Math.max(1, monthlyEntries.length);
      const barW = Math.min(48, Math.max(20, Math.floor(slotW * 0.56)));

      monthlyEntries.forEach(([ym, val], idx) => {
        const bx = Math.round(stripX + idx * slotW + (slotW - barW) * 0.5);
        const bh = val > 0 ? Math.max(5, Math.round((val / maxMonth) * maxH)) : 0;
        if (bh > 0) {
          drawHatchedInkBar(sctx, bx, baseY - bh, barW, bh);
        }
        const mNum = Number.parseInt(ym.slice(5, 7), 10);
        const mLabel = MONTH_ABBR[(mNum - 1 + 12) % 12] ?? ym.slice(5, 7);
        sctx.font = '700 11px "Courier Prime", monospace';
        sctx.textAlign = 'center';
        sctx.textBaseline = 'top';
        drawTypewriterText(
          sctx,
          mLabel,
          bx + barW * 0.5,
          baseY + 7,
          hashHandle(seedKey, `m-lbl-${idx}`),
        );
      });
    },
    'labels',
    hashHandle(seedKey, 'cal-shapes-ink'),
    { color: PALETTE.ink },
  );

  // Small typed labels, month headers, stat numbers, and monthly counts in 'receipts'
  inkLayer(
    ctx,
    (sctx) => {
      sctx.fillStyle = PALETTE.ink;

      // Month labels above grid
      sctx.textAlign = 'left';
      sctx.textBaseline = 'bottom';
      sctx.font = '700 11px "Courier Prime", monospace';
      let prevMonth = '';
      let prevLabelX = -100;
      for (let c = 0; c < cols; c++) {
        const firstDay = (weeks[c] ?? []).find(Boolean);
        if (!firstDay) continue;
        const ym = firstDay.date.slice(0, 7);
        if (ym !== prevMonth) {
          const lx = gridX + c * pitch;
          if (lx - prevLabelX >= 36) {
            const mNum = Number.parseInt(firstDay.date.slice(5, 7), 10);
            const label = MONTH_ABBR[(mNum - 1 + 12) % 12] ?? ym.slice(5, 7);
            drawTypewriterText(
              sctx,
              label,
              lx,
              gridY - 8,
              hashHandle(seedKey, `cal-mo-${c}`),
            );
            prevLabelX = lx;
          }
          prevMonth = ym;
        }
      }

      // Legend captions
      sctx.textAlign = 'right';
      sctx.textBaseline = 'middle';
      sctx.font = '700 10.5px "Courier Prime", monospace';
      drawTypewriterText(
        sctx,
        'LESS',
        922,
        158,
        hashHandle(seedKey, 'cal-less'),
      );
      sctx.textAlign = 'left';
      drawTypewriterText(
        sctx,
        'MORE',
        1034,
        158,
        hashHandle(seedKey, 'cal-more'),
      );

      // Weekday labels on left
      sctx.textAlign = 'right';
      sctx.textBaseline = 'middle';
      sctx.font = '700 11px "Courier Prime", monospace';
      for (const row of [1, 3, 5]) {
        drawTypewriterText(
          sctx,
          WEEKDAY_ABBR[row]!,
          gridX - 9,
          gridY + row * pitch + cell * 0.5,
          hashHandle(seedKey, `cal-day-${row}`),
        );
      }

      // Typed stat row at y 350..418
      const stats: ReadonlyArray<{ label: string; value: string; sub?: string }> = [
        {
          label: 'TOTAL CONTRIBUTIONS',
          value: cal.total.toLocaleString('en-US'),
          sub: 'commits, PRs, issues, reviews',
        },
        {
          label: 'ACTIVE DAYS',
          value: `${cal.activeDays} / ${totalDays}`,
          sub: 'days > 0 contributions',
        },
        {
          label: 'LONGEST STREAK',
          value: `${cal.longestStreak} days`,
        },
        {
          label: 'LONGEST GAP',
          value: `${cal.longestGap} days`,
        },
        {
          label: 'BUSIEST DAY',
          value:
            cal.busiest && cal.busiest.count > 0
              ? `${cal.busiest.count} contributions`
              : '0 contributions',
          sub: cal.busiest?.date ?? 'NONE ON FILE',
        },
      ];
      const colWidths = [225, 175, 195, 180, 220];
      let sx = 110;
      stats.forEach((st, idx) => {
        const w = colWidths[idx]!;
        sctx.textAlign = 'left';
        sctx.textBaseline = 'top';
        sctx.font = '700 11px "Courier Prime", monospace';
        drawTypewriterText(
          sctx,
          st.label,
          sx + 12,
          359,
          hashHandle(seedKey, `stat-lbl-${idx}`),
          w - 20,
        );
        sctx.font = '700 18px "Courier Prime", monospace';
        drawTypewriterText(
          sctx,
          st.value,
          sx + 12,
          377,
          hashHandle(seedKey, `stat-val-${idx}`),
          w - 20,
        );
        if (st.sub) {
          sctx.font = '400 10.5px "Courier Prime", monospace';
          drawTypewriterText(
            sctx,
            st.sub,
            sx + 12,
            400,
            hashHandle(seedKey, `stat-sub-${idx}`),
            w - 20,
          );
        }
        sx += w;
      });

      // Monthly strip section title & bar counts
      sctx.textAlign = 'left';
      sctx.textBaseline = 'top';
      sctx.font = '700 11.5px "Courier Prime", monospace';
      drawTypewriterText(
        sctx,
        'MONTHLY CONTRIBUTIONS (12-MONTH STRIP):',
        132,
        436,
        hashHandle(seedKey, 'm-hdr'),
      );

      const stripW = 954;
      const baseY = 576;
      const maxH = 104;
      const maxMonth = Math.max(1, ...monthlyEntries.map(([, v]) => v));
      const slotW = stripW / Math.max(1, monthlyEntries.length);

      monthlyEntries.forEach(([, val], idx) => {
        const cx = 132 + idx * slotW + slotW * 0.5;
        const bh = val > 0 ? Math.max(5, Math.round((val / maxMonth) * maxH)) : 0;
        sctx.textAlign = 'center';
        sctx.textBaseline = 'bottom';
        sctx.font = '700 10.5px "Courier Prime", monospace';
        drawTypewriterText(
          sctx,
          String(val),
          cx,
          baseY - bh - 4,
          hashHandle(seedKey, `m-val-${idx}`),
          Math.max(24, slotW - 4),
        );
      });
    },
    'receipts',
    hashHandle(seedKey, 'cal-text-ink'),
    { color: PALETTE.ink },
  );

  // Handwritten blue circle + busiest-day note (connector stops cleanly above text) + seeded noir line
  if (busiestPos && cal.busiest && cal.busiest.count > 0) {
    const pos = busiestPos;
    const peak = cal.busiest;
    inkLayer(
      ctx,
      (sctx) => {
        sctx.strokeStyle = PALETTE.hand;
        sctx.fillStyle = PALETTE.hand;

        drawHandCircle(
          sctx,
          pos.cx,
          pos.cy,
          12.5,
          12.5,
          hashHandle(seedKey, 'busiest-circle'),
        );

        const noteText = `busiest: ${peak.count} contributions on ${peak.date}`;
        sctx.font = '400 23px "Reenie Beanie", cursive';
        const noteTextW = Math.min(360, sctx.measureText(noteText).width);
        const noteY = 323;
        const noteX = Math.max(
          132,
          Math.min(1080 - noteTextW, pos.cx - noteTextW * 0.5),
        );
        const gridBottom = gridY + 7 * pitch - gap;
        const anchorX = Math.max(
          noteX + 8,
          Math.min(noteX + noteTextW - 8, pos.cx),
        );

        // Pointer exits below the grid and stops at y=319 strictly above text (y=323)
        sctx.lineWidth = 1.4;
        sctx.beginPath();
        sctx.moveTo(pos.cx, gridBottom + 2);
        sctx.lineTo(pos.cx, 315);
        sctx.lineTo(anchorX, 319);
        sctx.stroke();

        sctx.textAlign = 'left';
        sctx.textBaseline = 'top';
        drawHandwrittenText(
          sctx,
          noteText,
          noteX,
          noteY,
          hashHandle(seedKey, 'busiest-note'),
          { baseRotateDeg: -0.3, underline: true, maxWidth: 360 },
        );
      },
      'handwriting',
      hashHandle(seedKey, 'cal-hand-ink'),
      { color: PALETTE.hand },
    );
  }

  drawExhibitNoirLine(
    ctx,
    seedKey,
    pickSeededNoirLine(
      seedKey,
      cal.total === 0
        ? [
            'not a single mark all year — quiet alibi.',
            'ledger sat untouched for twelve months.',
          ]
        : [
            'machine barely cools between shifts.',
            'ink kept flowing long after quitting time.',
            'counts stacked high across every season.',
          ],
    ),
    1086,
    429,
    430,
    'right',
  );

  return { id: 'A', title, withheld: false, partial };
}

function drawExhibitB(
  ctx: CanvasContext2DLike,
  dossier: ExhibitDossier,
): ExhibitRenderResult {
  const title = 'PUNCH CARD';
  const seedKey = `${dossier.handle}-exhibit-B`;
  const { partial } = drawExhibitFrame(
    ctx,
    'B',
    title,
    dossier,
    'WEEKDAY × HOUR DISTRIBUTION FROM RECENT PUBLIC COMMITS',
  );

  const pc = dossier.punchCard;
  if (!pc || pc.sample === 0) {
    drawWithheldNotice(
      ctx,
      seedKey,
      'COMMIT TIMESTAMP DATA UNAVAILABLE TO BUILD PUNCH CARD.',
    );
    drawExhibitNoirLine(
      ctx,
      seedKey,
      pickSeededNoirLine(seedKey, [
        'timeclock empty — no stamped punches on file.',
        'suspect worked off the public clock.',
        'zero timestamps recovered for the night watch.',
      ]),
      1090,
      584,
      640,
      'right',
    );
    return { id: 'B', title, withheld: true, partial };
  }

  const gridX0 = 190;
  const gridX1 = 1100;
  const gridY0 = 178;
  const gridY1 = 472;
  const colW = (gridX1 - gridX0) / 24;
  const rowH = (gridY1 - gridY0) / 7;

  let maxCount = 0;
  let peakDay = 0;
  let peakColCount = -1;
  for (let d = 0; d < 7; d++) {
    const row = pc.grid[d] ?? [];
    for (let h = 0; h < 24; h++) {
      const val = row[h] ?? 0;
      if (val > maxCount) maxCount = val;
      if (pc.peakHour !== null && h === pc.peakHour && val > peakColCount) {
        peakColCount = val;
        peakDay = d;
      }
    }
  }
  const denomMax = Math.max(1, maxCount);

  // Dots and stat box frame via 'labels'
  inkLayer(
    ctx,
    (sctx) => {
      sctx.fillStyle = PALETTE.ink;
      sctx.strokeStyle = PALETTE.ink;

      // Subtle guide hairlines per weekday row & border
      sctx.lineWidth = 1;
      for (let d = 0; d < 7; d++) {
        const cy = gridY0 + (d + 0.5) * rowH;
        sctx.save();
        sctx.globalAlpha = 0.24;
        sctx.setLineDash([2, 4]);
        sctx.beginPath();
        sctx.moveTo(gridX0, cy);
        sctx.lineTo(gridX1, cy);
        sctx.stroke();
        sctx.restore();
      }

      // Ink dots (radius = 2 + 16 * sqrt(count / max))
      for (let d = 0; d < 7; d++) {
        const cy = gridY0 + (d + 0.5) * rowH;
        const row = pc.grid[d] ?? [];
        for (let h = 0; h < 24; h++) {
          const cx = gridX0 + (h + 0.5) * colW;
          const count = row[h] ?? 0;
          if (count <= 0) {
            sctx.save();
            sctx.globalAlpha = 0.35;
            sctx.beginPath();
            sctx.arc(cx, cy, 1.1, 0, Math.PI * 2);
            sctx.fill();
            sctx.restore();
          } else {
            const radius = 2 + 16 * Math.sqrt(count / denomMax);
            sctx.beginPath();
            sctx.arc(cx, cy, radius, 0, Math.PI * 2);
            sctx.fill();
          }
        }
      }

      // Typed stat box below grid
      sctx.lineWidth = 2;
      sctx.strokeRect(110, 496, 995, 72);
      for (const divX of [360, 610, 860]) {
        sctx.beginPath();
        sctx.moveTo(divX, 496);
        sctx.lineTo(divX, 568);
        sctx.stroke();
      }
    },
    'labels',
    hashHandle(seedKey, 'pc-dots-ink'),
    { color: PALETTE.ink },
  );

  // Hour headers, day labels, stats, and timeBasis line via 'receipts'
  inkLayer(
    ctx,
    (sctx) => {
      sctx.fillStyle = PALETTE.ink;

      // Hour labels along top (00..23)
      sctx.textAlign = 'center';
      sctx.textBaseline = 'middle';
      sctx.font = '700 11px "Courier Prime", monospace';
      for (let h = 0; h < 24; h++) {
        const cx = gridX0 + (h + 0.5) * colW;
        drawTypewriterText(
          sctx,
          String(h).padStart(2, '0'),
          cx,
          156,
          hashHandle(seedKey, `pc-hr-${h}`),
        );
      }

      // Day labels on left
      sctx.textAlign = 'right';
      sctx.textBaseline = 'middle';
      sctx.font = '700 12px "Courier Prime", monospace';
      for (let d = 0; d < 7; d++) {
        const cy = gridY0 + (d + 0.5) * rowH;
        drawTypewriterText(
          sctx,
          WEEKDAY_ABBR[d]!,
          gridX0 - 16,
          cy,
          hashHandle(seedKey, `pc-dy-${d}`),
        );
      }

      // Four stats
      const stats: ReadonlyArray<{ x: number; w: number; label: string; value: string }> = [
        {
          x: 110,
          w: 250,
          label: 'NIGHT SHARE (1-5 AM)',
          value: pctText(pc.nightShare),
        },
        {
          x: 360,
          w: 250,
          label: 'WEEKEND SHARE',
          value: pctText(pc.weekendShare),
        },
        {
          x: 610,
          w: 250,
          label: 'FRIDAY-EVENING SHARE',
          value: pctText(pc.fridayEveningShare),
        },
        {
          x: 860,
          w: 245,
          label: 'PEAK HOUR',
          value:
            pc.peakHour !== null
              ? `${String(pc.peakHour).padStart(2, '0')}:00 (${pc.timeBasis.toUpperCase()})`
              : 'NONE',
        },
      ];
      stats.forEach((st, idx) => {
        sctx.textAlign = 'left';
        sctx.textBaseline = 'top';
        sctx.font = '700 11px "Courier Prime", monospace';
        drawTypewriterText(
          sctx,
          st.label,
          st.x + 14,
          506,
          hashHandle(seedKey, `pc-lbl-${idx}`),
          st.w - 24,
        );
        sctx.font = '700 22px "Courier Prime", monospace';
        drawTypewriterText(
          sctx,
          st.value,
          st.x + 14,
          528,
          hashHandle(seedKey, `pc-val-${idx}`),
          st.w - 24,
        );
      });

      const basisLabel =
        pc.timeBasis === 'local'
          ? 'LOCAL AUTHOR TIMEZONE OFFSETS'
          : pc.timeBasis === 'utc'
            ? 'UTC (AUTHOR OFFSETS NOT RECORDED)'
            : 'MIXED (PARTIAL AUTHOR OFFSETS RECORDED)';
      sctx.textAlign = 'left';
      sctx.textBaseline = 'top';
      sctx.font = '700 11.5px "Courier Prime", monospace';
      drawTypewriterText(
        sctx,
        `TIME BASIS: ${basisLabel} — SAMPLE: ${pc.sample} PUBLIC COMMITS`,
        110,
        584,
        hashHandle(seedKey, 'pc-basis'),
        635,
      );
    },
    'receipts',
    hashHandle(seedKey, 'pc-text-ink'),
    { color: PALETTE.ink },
  );

  // Peak hour circled in blue ballpoint (#243a6b)
  if (pc.peakHour !== null) {
    const peakColX = gridX0 + (pc.peakHour + 0.5) * colW;
    const peakRowY = gridY0 + (peakDay + 0.5) * rowH;
    inkLayer(
      ctx,
      (sctx) => {
        sctx.strokeStyle = PALETTE.hand;
        sctx.fillStyle = PALETTE.hand;

        // Generous padded oval around the peak hour top header
        drawHandCircle(
          sctx,
          peakColX,
          156,
          18,
          13,
          hashHandle(seedKey, 'pc-peak-hdr-circle'),
        );

        // Second ring around the heaviest cell inside the peak column
        const cellR = 2 + 16 * Math.sqrt(Math.max(1, peakColCount) / denomMax);
        drawHandCircle(
          sctx,
          peakColX,
          peakRowY,
          Math.max(12, cellR + 7),
          Math.max(12, cellR + 7),
          hashHandle(seedKey, 'pc-peak-cell-circle'),
        );

        const noteX = peakColX > 900 ? peakColX - 110 : peakColX + 24;
        sctx.font = '400 21px "Reenie Beanie", cursive';
        sctx.textAlign = 'left';
        sctx.textBaseline = 'middle';
        drawHandwrittenText(
          sctx,
          'peak hr',
          noteX,
          132,
          hashHandle(seedKey, 'pc-peak-note'),
          { baseRotateDeg: -0.6 },
        );
      },
      'handwriting',
      hashHandle(seedKey, 'pc-hand-ink'),
      { color: PALETTE.hand },
    );
  }

  drawExhibitNoirLine(
    ctx,
    seedKey,
    pickSeededNoirLine(
      seedKey,
      pc.nightShare >= 0.15
        ? [
            'graveyard shift leaves the darkest ink.',
            'midnight oil burns all down the ledger.',
          ]
        : pc.weekendShare >= 0.35
          ? [
              'weekends look busier than Tuesday mornings.',
              'Saturday ink speaks for itself.',
            ]
          : [
              'punches clock in steady daylight hours.',
              'routine hours stamped right on schedule.',
            ],
    ),
    1102,
    581,
    340,
    'right',
  );

  return { id: 'B', title, withheld: false, partial };
}

function drawExhibitC(
  ctx: CanvasContext2DLike,
  dossier: ExhibitDossier,
): ExhibitRenderResult {
  const title = 'SHARE OF EACH STATUTE';
  const seedKey = `${dossier.handle}-exhibit-C`;
  const radar = dossier.radar;
  const allBelow25 = radar.length > 0 && radar.every((a) => a.value < 0.25);
  const scaleMax = allBelow25 ? 0.25 : 1;
  const ringFracs = allBelow25 ? [0.2, 0.4, 0.6, 0.8, 1] : [0.25, 0.5, 0.75, 1];

  const { partial } = drawExhibitFrame(
    ctx,
    'C',
    title,
    dossier,
    allBelow25
      ? 'SHARES, NOT SKILL. NOT A RATING. (SCALE: 0% TO 25% — ALL SHARES < 25%)'
      : 'SHARES, NOT SKILL. NOT A RATING. (FIXED 0% TO 100% SCALE)',
  );

  const cx = 335;
  const cy = 374;
  const radius = 166;
  const nAxes = Math.max(1, radar.length);

  const angles = radar.map((_, i) => -Math.PI / 2 + (i * Math.PI * 2) / nAxes);
  const reliableIndices: number[] = [];
  radar.forEach((ax, i) => {
    if (ax.reliable) reliableIndices.push(i);
  });

  // Radar rings, light dotted spokes, strong hatched polygon & visible points
  inkLayer(
    ctx,
    (sctx) => {
      sctx.strokeStyle = PALETTE.ink;
      sctx.fillStyle = PALETTE.ink;

      // Dotted concentric rings
      for (const frac of ringFracs) {
        sctx.save();
        sctx.globalAlpha = frac === 1 ? 0.58 : 0.36;
        sctx.lineWidth = frac === 1 ? 1.2 : 0.95;
        sctx.setLineDash([2, 4]);
        sctx.beginPath();
        sctx.arc(cx, cy, radius * frac, 0, Math.PI * 2);
        sctx.stroke();
        sctx.restore();
      }

      // Light dotted spokes (dashed wider when sample n<5)
      radar.forEach((ax, i) => {
        const ang = angles[i]!;
        const px = cx + Math.cos(ang) * radius;
        const py = cy + Math.sin(ang) * radius;
        sctx.save();
        sctx.lineWidth = 1;
        sctx.globalAlpha = ax.reliable ? 0.42 : 0.34;
        sctx.setLineDash(ax.reliable ? [2, 4] : [6, 5]);
        sctx.beginPath();
        sctx.moveTo(cx, cy);
        sctx.lineTo(px, py);
        sctx.stroke();
        sctx.restore();
      });

      const pointRadiusFor = (v: number) =>
        Math.min(1, Math.max(0, v) / scaleMax) * radius;

      const reliablePts = reliableIndices.map((idx) => {
        const ax = radar[idx]!;
        const ang = angles[idx]!;
        const r = pointRadiusFor(ax.value);
        return {
          x: cx + Math.cos(ang) * r,
          y: cy + Math.sin(ang) * r,
          idx,
        };
      });

      if (reliablePts.length >= 3) {
        const traceReliablePolygon = () => {
          sctx.beginPath();
          reliablePts.forEach((pt, idx) => {
            if (idx === 0) sctx.moveTo(pt.x, pt.y);
            else sctx.lineTo(pt.x, pt.y);
          });
          sctx.closePath();
        };

        // Light wash + diagonal hatch clipped strictly inside reliable polygon
        sctx.save();
        traceReliablePolygon();
        sctx.clip();
        sctx.globalAlpha = 0.09;
        sctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
        sctx.globalAlpha = 0.62;
        strokeHatchLines(
          sctx,
          cx - radius,
          cy - radius,
          radius * 2,
          radius * 2,
          6,
          false,
          1.25,
        );
        sctx.restore();

        // Strong outer polygon border
        sctx.save();
        traceReliablePolygon();
        sctx.lineWidth = 2.6;
        sctx.lineJoin = 'round';
        sctx.stroke();
        sctx.restore();
      } else if (reliablePts.length === 2) {
        sctx.save();
        sctx.lineWidth = 2.6;
        sctx.beginPath();
        sctx.moveTo(reliablePts[0]!.x, reliablePts[0]!.y);
        sctx.lineTo(reliablePts[1]!.x, reliablePts[1]!.y);
        sctx.stroke();
        sctx.restore();
      }

      // Prominent vertex points (filled dot for reliable, heavy open circle for n<5)
      radar.forEach((ax, i) => {
        const ang = angles[i]!;
        const r = pointRadiusFor(ax.value);
        const px = cx + Math.cos(ang) * r;
        const py = cy + Math.sin(ang) * r;
        sctx.save();
        if (ax.reliable) {
          sctx.fillStyle = PALETTE.ink;
          sctx.beginPath();
          sctx.arc(px, py, 4.6, 0, Math.PI * 2);
          sctx.fill();
        } else {
          sctx.fillStyle = PALETTE.paper;
          sctx.lineWidth = 2.1;
          sctx.beginPath();
          sctx.arc(px, py, 4.4, 0, Math.PI * 2);
          sctx.fill();
          sctx.stroke();
        }
        sctx.restore();
      });

      // Summary box border below right table
      sctx.lineWidth = 2;
      sctx.strokeRect(620, 514, 480, 62);
    },
    'labels',
    hashHandle(seedKey, 'radar-shapes-ink'),
    { color: PALETTE.ink },
  );

  // Vertex labels matching table names, ring ticks, right table, and NO OCCURRENCES banner
  const zeroOccurrencesCount = radar.filter(
    (a) => a.reliable && a.numerator === 0,
  ).length;
  const unreliableCount = radar.filter((a) => !a.reliable).length;

  inkLayer(
    ctx,
    (sctx) => {
      sctx.fillStyle = PALETTE.ink;

      // Ring percentage markers along upper-right ray
      sctx.textAlign = 'left';
      sctx.textBaseline = 'middle';
      sctx.font = '700 10px "Courier Prime", monospace';
      for (const frac of ringFracs) {
        const ang = -Math.PI / 2 + 0.14;
        const px = cx + Math.cos(ang) * radius * frac + 3;
        const py = cy + Math.sin(ang) * radius * frac;
        const pctLabel = Math.round(frac * scaleMax * 100);
        drawTypewriterText(
          sctx,
          `${pctLabel}%`,
          px,
          py,
          hashHandle(seedKey, `ring-${frac}`),
        );
      }

      // Axis labels identical to table names (no mismatched abbreviations)
      radar.forEach((ax, i) => {
        const ang = angles[i]!;
        const cos = Math.cos(ang);
        const sin = Math.sin(ang);
        const labelR = radius + 16;
        const lx = cx + cos * labelR;
        const ly = cy + sin * labelR;
        const baseName = ax.label.toUpperCase();
        const tag = ax.reliable ? '' : ' (n<5)';
        const fullText = `${baseName}${tag}`;

        sctx.textAlign =
          Math.abs(cos) < 0.2 ? 'center' : cos > 0 ? 'left' : 'right';
        sctx.textBaseline =
          Math.abs(sin) < 0.25 ? 'middle' : sin < 0 ? 'bottom' : 'top';
        sctx.font = '700 10.5px "Courier Prime", monospace';

        const maxW =
          cos < -0.2
            ? Math.max(92, lx - 54)
            : cos > 0.2
              ? Math.max(82, 608 - lx)
              : 145;
        if (fullText.length > 15 && Math.abs(cos) > 0.25) {
          const line1 = baseName;
          const line2 = ax.reliable ? '' : '(n<5)';
          const dy = sin > 0 ? 12 : -12;
          drawTypewriterText(
            sctx,
            line1,
            Math.max(54, lx),
            ly + (line2 && sin > 0 ? 0 : line2 ? dy : 0),
            hashHandle(seedKey, `r-ax-${i}-0`),
            maxW,
          );
          if (line2) {
            drawTypewriterText(
              sctx,
              line2,
              Math.max(54, lx),
              ly + (sin > 0 ? 12 : 0),
              hashHandle(seedKey, `r-ax-${i}-1`),
              maxW,
            );
          }
        } else {
          drawTypewriterText(
            sctx,
            fullText,
            Math.max(54, lx),
            ly,
            hashHandle(seedKey, `r-ax-${i}`),
            maxW,
          );
        }
      });

      sctx.textAlign = 'center';
      sctx.textBaseline = 'top';
      sctx.font = '700 10.5px "Courier Prime", monospace';
      drawTypewriterText(
        sctx,
        allBelow25
          ? 'ZOOMED SCALE: 0% TO 25% (ALL SHARES < 25%)'
          : 'SCALE: 0% TO 100%',
        cx,
        578,
        hashHandle(seedKey, 'r-scale-note'),
        480,
      );
      sctx.font = '400 10.5px "Courier Prime", monospace';
      drawTypewriterText(
        sctx,
        'DASHED SPOKES: SAMPLE n < 5 (EXCLUDED FROM POLYGON FILL)',
        cx,
        594,
        hashHandle(seedKey, 'r-dash-note'),
        480,
      );

      // Right-hand typed table at x 620..1100
      sctx.textAlign = 'left';
      sctx.textBaseline = 'top';
      sctx.font = '700 13px "Courier Prime", monospace';
      drawTypewriterText(
        sctx,
        'STATUTE',
        620,
        166,
        hashHandle(seedKey, 'tbl-h1'),
      );
      sctx.textAlign = 'right';
      drawTypewriterText(
        sctx,
        'NUM / SAMPLE (SHARE)',
        1100,
        166,
        hashHandle(seedKey, 'tbl-h2'),
      );

      radar.forEach((ax, idx) => {
        const ry = 202 + idx * 42;
        const leftText = `${ax.label.toUpperCase()}${ax.reliable ? '' : ' (n<5)'}`;
        const pct = `${Math.round(ax.value * 100)}%`;
        const rightText =
          ax.denominator > 0
            ? `${ax.numerator} / ${ax.denominator} (${pct})`
            : `0 / 0 (0%, n<5)`;

        sctx.font = '700 13px "Courier Prime", monospace';
        const leftW = Math.min(275, sctx.measureText(leftText).width);
        const rightW = Math.min(185, sctx.measureText(rightText).width);

        sctx.textAlign = 'left';
        sctx.textBaseline = 'top';
        drawTypewriterText(
          sctx,
          leftText,
          620,
          ry,
          hashHandle(seedKey, `t-lbl-${idx}`),
          275,
        );

        drawDottedLeader(sctx, 620 + leftW + 16, 1100 - rightW - 18, ry + 11);

        sctx.textAlign = 'right';
        sctx.font = '400 13px "Courier Prime", monospace';
        drawTypewriterText(
          sctx,
          rightText,
          1100,
          ry,
          hashHandle(seedKey, `t-val-${idx}`),
          190,
        );

        sctx.textAlign = 'left';
        sctx.font = '400 10.5px "Courier Prime", monospace';
        drawTypewriterText(
          sctx,
          ax.basis,
          620,
          ry + 17,
          hashHandle(seedKey, `t-bas-${idx}`),
          470,
        );
      });

      // Boxed NO OCCURRENCES banner on right
      const summaryMain = `NO OCCURRENCES ON ${zeroOccurrencesCount} OF ${radar.length} STATUTES`;
      const summarySub =
        unreliableCount > 0
          ? `${unreliableCount} STATUTE(S) HAD SAMPLE n < 5 — SHARES ONLY, NOT A RATING.`
          : 'ALL 7 STATUTES MET MINIMUM SAMPLE SIZE (n >= 5) — SHARES ONLY, NOT A RATING.';
      sctx.textAlign = 'left';
      sctx.textBaseline = 'top';
      sctx.font = '700 14.5px "Courier Prime", monospace';
      drawTypewriterText(
        sctx,
        summaryMain,
        634,
        524,
        hashHandle(seedKey, 'r-sum-1'),
        452,
      );
      sctx.font = '400 10.5px "Courier Prime", monospace';
      drawTypewriterText(
        sctx,
        summarySub,
        634,
        548,
        hashHandle(seedKey, 'r-sum-2'),
        452,
      );
    },
    'receipts',
    hashHandle(seedKey, 'radar-text-ink'),
    { color: PALETTE.ink },
  );

  drawExhibitNoirLine(
    ctx,
    seedKey,
    pickSeededNoirLine(
      seedKey,
      zeroOccurrencesCount >= 4
        ? [
            'mostly clean lines across this bench sheet.',
            'hard to pin a pattern with zeroes this wide.',
          ]
        : unreliableCount >= 5
          ? [
              'too little tape to draw a full ring.',
              'thin sample leaves half the chart dotted.',
            ]
          : [
              'numbers tell the whole alibi in plain ink.',
              'proportions plotted straight off the ledger.',
            ],
    ),
    620,
    588,
    480,
    'left',
  );

  return { id: 'C', title, withheld: false, partial };
}

function drawTallyMarks(
  ctx: CanvasContext2DLike,
  cx: number,
  yBottom: number,
  count: number,
  groupsPerRow = 2,
): void {
  if (count <= 0) return;
  const visualCount = Math.min(20, count);
  const fullGroups = Math.floor(visualCount / 5);
  const rem = visualCount % 5;
  const totalGroups = fullGroups + (rem > 0 ? 1 : 0);
  const strokeGap = 7;
  const groupW = 3 * strokeGap + 6; // 27px
  const rowH = 34;
  const strokeH = 28;

  ctx.save();
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = 2.2;
  ctx.lineCap = 'round';

  for (let g = 0; g < totalGroups; g++) {
    const strokesInGroup = g < fullGroups ? 5 : rem;
    const row = Math.floor(g / groupsPerRow);
    const col = g % groupsPerRow;
    const isPartialLastRow =
      groupsPerRow === 2 &&
      col === 0 &&
      g === totalGroups - 1 &&
      totalGroups % 2 === 1;
    const gx =
      groupsPerRow === 1 || isPartialLastRow
        ? cx
        : cx + (col - 0.5) * (groupW + 10);
    const gyBottom = yBottom - row * rowH;
    const gyTop = gyBottom - strokeH;

    const verticals = Math.min(4, strokesInGroup);
    const leftEdge = gx - ((verticals - 1) * strokeGap) * 0.5;
    for (let s = 0; s < verticals; s++) {
      const sx = leftEdge + s * strokeGap;
      ctx.beginPath();
      ctx.moveTo(sx, gyTop);
      ctx.lineTo(sx - 0.8, gyBottom);
      ctx.stroke();
    }
    if (strokesInGroup === 5) {
      ctx.beginPath();
      ctx.moveTo(leftEdge - 4, gyBottom - 3);
      ctx.lineTo(leftEdge + 3 * strokeGap + 4, gyTop + 3);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function truncateTimelineName(name: string, maxChars: number): string {
  if (name.length <= maxChars) return name;
  return `${name.slice(0, Math.max(4, maxChars - 2))}..`;
}

function groupOwnedReposByYear(
  dossier: ExhibitDossier,
): Map<number, string[]> {
  const map = new Map<number, Array<{ name: string; stars: number }>>();
  for (const r of dossier.repos ?? []) {
    if (r.fork || !r.created_at) continue;
    const yr = Number.parseInt(r.created_at.slice(0, 4), 10);
    if (!Number.isFinite(yr)) continue;
    const list = map.get(yr) ?? [];
    list.push({ name: r.name, stars: r.stargazers_count });
    map.set(yr, list);
  }
  const out = new Map<number, string[]>();
  for (const [yr, list] of map.entries()) {
    list.sort((a, b) => b.stars - a.stars || (a.name < b.name ? -1 : 1));
    out.set(yr, list.map((it) => it.name));
  }
  return out;
}

function drawExhibitD(
  ctx: CanvasContext2DLike,
  dossier: ExhibitDossier,
  options: RenderExhibitOptions,
): ExhibitRenderResult {
  const title = 'TIME SERVED';
  const seedKey = `${dossier.handle}-exhibit-D`;
  const { partial } = drawExhibitFrame(
    ctx,
    'D',
    title,
    dossier,
    'ACCOUNT TENURE, YEARLY ORIGINAL REPO TALLIES & DORMANT RECORD CHECK',
  );

  const years = dossier.years;
  const rs = dossier.repoShape;
  const nowYear = (options.now ?? new Date()).getUTCFullYear();
  const createdYears = Object.keys(years.reposCreatedByYear)
    .map((k) => Number.parseInt(k, 10))
    .filter((y) => Number.isFinite(y));

  const endYear = Math.max(nowYear, ...(createdYears.length ? createdYears : [nowYear]));
  const inferredStart = endYear - Math.max(1, Math.round(years.accountAgeYears));
  const startYear = Math.min(inferredStart, ...(createdYears.length ? createdYears : [inferredStart]));
  const spanYears = Math.max(1, endYear - startYear);

  const lineX0 = 110;
  const lineX1 = 1090;
  const tickX0 = 152;
  const tickX1 = 1048;
  const timelineY = 294;
  const reposByYear = groupOwnedReposByYear(dossier);
  const slotStep = (tickX1 - tickX0) / spanYears;
  const tallyGroupsPerRow = slotStep < 68 ? 1 : 2;

  // Headline, timeline at y=294, larger tallies above, stagger stems if dense, and lower stat boxes
  inkLayer(
    ctx,
    (sctx) => {
      sctx.fillStyle = PALETTE.ink;
      sctx.strokeStyle = PALETTE.ink;

      sctx.textAlign = 'left';
      sctx.textBaseline = 'top';
      sctx.font = '700 32px "Courier Prime", monospace';
      drawTypewriterText(
        sctx,
        `TIME SERVED: ${years.accountAgeYears.toFixed(1)} YEARS`,
        110,
        142,
        hashHandle(seedKey, 'ts-headline'),
        560,
      );

      // Horizontal timeline bar
      sctx.lineWidth = 2.5;
      sctx.beginPath();
      sctx.moveTo(lineX0, timelineY);
      sctx.lineTo(lineX1, timelineY);
      sctx.stroke();

      // Endcaps
      sctx.beginPath();
      sctx.moveTo(lineX0, timelineY - 6);
      sctx.lineTo(lineX0, timelineY + 6);
      sctx.moveTo(lineX1, timelineY - 6);
      sctx.lineTo(lineX1, timelineY + 6);
      sctx.stroke();

      // Yearly ticks & larger tally marks above line
      let activeIdx = 0;
      for (let yr = startYear; yr <= endYear; yr++) {
        const tx = tickX0 + ((yr - startYear) / spanYears) * (tickX1 - tickX0);
        sctx.lineWidth = 1.6;
        sctx.beginPath();
        sctx.moveTo(tx, timelineY - 5);
        sctx.lineTo(tx, timelineY + 6);
        sctx.stroke();

        const count = years.reposCreatedByYear[String(yr)] ?? 0;
        if (count > 0) {
          drawTallyMarks(sctx, tx, timelineY - 12, count, tallyGroupsPerRow);
          const names = reposByYear.get(yr) ?? [];
          if (names.length > 0 && slotStep < 86 && activeIdx % 2 === 1) {
            sctx.save();
            sctx.globalAlpha = 0.35;
            sctx.lineWidth = 1;
            sctx.setLineDash([2, 2]);
            sctx.beginPath();
            sctx.moveTo(tx, timelineY + 26);
            sctx.lineTo(tx, timelineY + 80);
            sctx.stroke();
            sctx.restore();
          }
          activeIdx++;
        }
      }

      // Lower stat boxes (y = 456..558)
      sctx.lineWidth = 2;
      sctx.strokeRect(110, 456, 470, 102);
      sctx.strokeRect(620, 456, 470, 102);
    },
    'labels',
    hashHandle(seedKey, 'ts-shapes-ink'),
    { color: PALETTE.ink },
  );

  // Small text labels, tally counts, repo names under years, & stat readouts via 'receipts'
  inkLayer(
    ctx,
    (sctx) => {
      sctx.fillStyle = PALETTE.ink;

      sctx.textAlign = 'left';
      sctx.textBaseline = 'top';
      sctx.font = '700 12px "Courier Prime", monospace';
      drawTypewriterText(
        sctx,
        'ORIGINAL REPOSITORIES CREATED PER YEAR (TALLY MARKS ABOVE, REPO NAMES BELOW):',
        110,
        182,
        hashHandle(seedKey, 'ts-sub'),
        960,
      );

      let prevLabelX = -100;
      let activeIdx = 0;
      for (let yr = startYear; yr <= endYear; yr++) {
        const tx = tickX0 + ((yr - startYear) / spanYears) * (tickX1 - tickX0);
        const count = years.reposCreatedByYear[String(yr)] ?? 0;

        if (count > 0) {
          const visual = Math.min(20, count);
          const totalGroups = Math.floor(visual / 5) + (visual % 5 > 0 ? 1 : 0);
          const rows = Math.max(1, Math.ceil(totalGroups / tallyGroupsPerRow));
          const labelY = timelineY - 12 - (rows - 1) * 34 - 28 - 4;
          sctx.textAlign = 'center';
          sctx.textBaseline = 'bottom';
          sctx.font = '700 11px "Courier Prime", monospace';
          drawTypewriterText(
            sctx,
            count > 20 ? `20+ (${count})` : String(count),
            tx,
            labelY,
            hashHandle(seedKey, `ts-cnt-${yr}`),
          );
        }

        const isEdge = yr === startYear || yr === endYear;
        const farEnough =
          tx - prevLabelX >= 42 && (yr === endYear || tickX1 - tx >= 32);
        if (isEdge || farEnough || count > 0) {
          // Ensure active years always show their year if not colliding tightly
          if (isEdge || tx - prevLabelX >= 34) {
            sctx.textAlign = 'center';
            sctx.textBaseline = 'top';
            sctx.font = '700 11px "Courier Prime", monospace';
            drawTypewriterText(
              sctx,
              String(yr),
              tx,
              timelineY + 10,
              hashHandle(seedKey, `ts-yr-${yr}`),
            );
            prevLabelX = tx;
          }
        }

        const names = reposByYear.get(yr) ?? [];
        if (count > 0 && names.length > 0) {
          const staggerRow = slotStep < 86 ? activeIdx % 2 : 0;
          const baseNameY = timelineY + (staggerRow === 1 ? 82 : 28);
          const colMaxW = Math.min(126, Math.max(66, slotStep * 1.45));
          const maxChars = slotStep < 62 ? 12 : slotStep < 80 ? 14 : 18;
          const shown = names.slice(0, 3);
          const remaining = names.length - shown.length;

          sctx.textAlign = 'center';
          sctx.textBaseline = 'top';
          sctx.font = '400 10.5px "Courier Prime", monospace';

          shown.forEach((repoName, nIdx) => {
            const clipped = truncateTimelineName(repoName, maxChars);
            const suffix =
              nIdx === shown.length - 1 && remaining > 0
                ? ` (+${remaining})`
                : '';
            drawTypewriterText(
              sctx,
              `${clipped}${suffix}`,
              Math.max(125, Math.min(1040, tx)),
              baseNameY + nIdx * 13,
              hashHandle(seedKey, `ts-rp-${yr}-${nIdx}`),
              colMaxW,
            );
          });
          activeIdx++;
        } else if (count > 0) {
          activeIdx++;
        }
      }

      // Dormant repos card
      sctx.textAlign = 'left';
      sctx.textBaseline = 'top';
      sctx.font = '700 12px "Courier Prime", monospace';
      drawTypewriterText(
        sctx,
        'DORMANT REPOS (UNTOUCHED 2+ YRS)',
        128,
        468,
        hashHandle(seedKey, 'ts-dormant-lbl'),
        435,
      );
      sctx.font = '700 32px "Courier Prime", monospace';
      drawTypewriterText(
        sctx,
        `${years.dormantRepos}`,
        128,
        490,
        hashHandle(seedKey, 'ts-dormant-val'),
        435,
      );
      sctx.font = '400 11.5px "Courier Prime", monospace';
      drawTypewriterText(
        sctx,
        `out of ${rs.ownedOriginal} inspected original repos`,
        128,
        529,
        hashHandle(seedKey, 'ts-dormant-sub'),
        435,
      );

      // Days since last push card
      sctx.font = '700 12px "Courier Prime", monospace';
      drawTypewriterText(
        sctx,
        'DAYS SINCE LAST PUSH',
        638,
        468,
        hashHandle(seedKey, 'ts-push-lbl'),
        435,
      );
      sctx.font = '700 32px "Courier Prime", monospace';
      drawTypewriterText(
        sctx,
        years.daysSinceLastPush !== null
          ? `${years.daysSinceLastPush} DAYS`
          : 'NOT ON FILE',
        638,
        490,
        hashHandle(seedKey, 'ts-push-val'),
        435,
      );
      sctx.font = '400 11.5px "Courier Prime", monospace';
      drawTypewriterText(
        sctx,
        `latest pushed_at across ${rs.inspected} inspected repos`,
        638,
        529,
        hashHandle(seedKey, 'ts-push-sub'),
        435,
      );
    },
    'receipts',
    hashHandle(seedKey, 'ts-text-ink'),
    { color: PALETTE.ink },
  );

  drawExhibitNoirLine(
    ctx,
    seedKey,
    pickSeededNoirLine(
      seedKey,
      years.dormantRepos > 0
        ? [
            'old projects gather dust while new ink dries.',
            'long rap sheet; half the cabinet sits dormant.',
          ]
        : years.accountAgeYears >= 10
          ? [
              'over a decade on the precinct roll.',
              'long service — shelf still active.',
            ]
          : [
              'fresh file compared to the precinct veterans.',
              'short sentence on record so far.',
            ],
    ),
    1090,
    148,
    410,
    'right',
  );

  return { id: 'D', title, withheld: false, partial };
}

function groupOwnedReposByLanguage(
  dossier: ExhibitDossier,
  shownLangs: readonly string[],
): Map<string, string[]> {
  const byLang = new Map<string, Array<{ name: string; stars: number }>>();
  for (const r of dossier.repos ?? []) {
    if (r.fork || r.language === undefined) continue;
    const lang = r.language ?? 'Unlabelled';
    const arr = byLang.get(lang) ?? [];
    arr.push({ name: r.name, stars: r.stargazers_count });
    byLang.set(lang, arr);
  }

  const out = new Map<string, string[]>();
  const primarySet = new Set(shownLangs.filter((l) => l !== 'Other'));
  const otherRepos: Array<{ name: string; stars: number }> = [];

  for (const [lang, items] of byLang.entries()) {
    items.sort((a, b) => b.stars - a.stars || (a.name < b.name ? -1 : 1));
    if (primarySet.has(lang)) {
      out.set(lang, items.map((i) => i.name));
    } else if (shownLangs.includes('Other')) {
      otherRepos.push(...items);
    }
  }
  if (otherRepos.length > 0) {
    otherRepos.sort((a, b) => b.stars - a.stars || (a.name < b.name ? -1 : 1));
    out.set('Other', otherRepos.map((i) => i.name));
  }
  return out;
}

function drawExhibitE(
  ctx: CanvasContext2DLike,
  dossier: ExhibitDossier,
): ExhibitRenderResult {
  const title = 'LANGUAGES';
  const seedKey = `${dossier.handle}-exhibit-E`;
  const { partial } = drawExhibitFrame(
    ctx,
    'E',
    title,
    dossier,
    'PRIMARY REPOSITORY LANGUAGE SHARE ACROSS OWNED REPOS',
  );

  const langs = dossier.languages.slice(0, 7);
  if (langs.length === 0) {
    drawWithheldNotice(
      ctx,
      seedKey,
      'LANGUAGE METADATA UNAVAILABLE FOR THIS RECORD.',
    );
    drawExhibitNoirLine(
      ctx,
      seedKey,
      pickSeededNoirLine(seedKey, [
        'no language tags returned in the evidence box.',
        'kept mum on what compiler built the alibi.',
      ]),
      1090,
      584,
      620,
      'right',
    );
    return { id: 'E', title, withheld: true, partial };
  }

  const barStartX = 330;
  const maxLen = 640;
  const startY = 170;
  const pitch = 56;
  const reposByLang = groupOwnedReposByLanguage(
    dossier,
    langs.map((l) => l.language),
  );

  // Uniform hatched bars & dotted tracks in 'labels'
  inkLayer(
    ctx,
    (sctx) => {
      sctx.strokeStyle = PALETTE.ink;
      sctx.fillStyle = PALETTE.ink;

      langs.forEach((slice, idx) => {
        const y = startY + idx * pitch;
        sctx.save();
        sctx.globalAlpha = 0.25;
        sctx.lineWidth = 1;
        sctx.setLineDash([3, 4]);
        sctx.strokeRect(barStartX, y, maxLen, 24);
        sctx.restore();

        const barW =
          slice.share <= 0 ? 0 : Math.max(4, Math.round(slice.share * maxLen));
        if (barW > 0) {
          drawHatchedInkBar(sctx, barStartX, y, barW, 24);
        }
      });
    },
    'labels',
    hashHandle(seedKey, 'lang-bars-ink'),
    { color: PALETTE.ink },
  );

  // Left labels, right percentages, and per-language repo names under each bar
  inkLayer(
    ctx,
    (sctx) => {
      sctx.fillStyle = PALETTE.ink;

      langs.forEach((slice, idx) => {
        const y = startY + idx * pitch;
        sctx.textAlign = 'right';
        sctx.textBaseline = 'top';
        sctx.font = '700 17px "Courier Prime", monospace';
        drawTypewriterText(
          sctx,
          slice.language,
          barStartX - 18,
          y,
          hashHandle(seedKey, `lang-nm-${idx}`),
          205,
        );

        sctx.font = '400 11px "Courier Prime", monospace';
        drawTypewriterText(
          sctx,
          `${slice.repos} repo${slice.repos === 1 ? '' : 's'}`,
          barStartX - 18,
          y + 19,
          hashHandle(seedKey, `lang-rc-${idx}`),
          205,
        );

        sctx.textAlign = 'left';
        sctx.textBaseline = 'middle';
        sctx.font = '700 17px "Courier Prime", monospace';
        drawTypewriterText(
          sctx,
          pctText(slice.share),
          barStartX + maxLen + 18,
          y + 12,
          hashHandle(seedKey, `lang-pct-${idx}`),
          145,
        );

        const langRepos = reposByLang.get(slice.language) ?? [];
        if (langRepos.length > 0) {
          sctx.textAlign = 'left';
          sctx.textBaseline = 'top';
          sctx.font = '400 11px "Courier Prime", monospace';
          drawTypewriterText(
            sctx,
            `repos: ${formatRepoSampleList(langRepos, 5)}`,
            barStartX,
            y + 29,
            hashHandle(seedKey, `lang-rps-${idx}`),
            maxLen,
          );
        }
      });

      sctx.textAlign = 'left';
      sctx.textBaseline = 'top';
      sctx.font = '700 11.5px "Courier Prime", monospace';
      drawTypewriterText(
        sctx,
        `COMPUTED ACROSS ${dossier.repoShape.ownedOriginal} INSPECTED ORIGINAL REPOS (BY PRIMARY REPO LANGUAGE).`,
        110,
        580,
        hashHandle(seedKey, 'lang-foot-note'),
        620,
      );
    },
    'receipts',
    hashHandle(seedKey, 'lang-text-ink'),
    { color: PALETTE.ink },
  );

  const topLang = langs[0]?.language ?? 'code';
  drawExhibitNoirLine(
    ctx,
    seedKey,
    pickSeededNoirLine(seedKey, [
      `speaks ${topLang} whenever pressed by the desk.`,
      `prints trace straight back to ${topLang}.`,
      `${topLang} dominates the docket sheet.`,
    ]),
    1112,
    576,
    360,
    'right',
  );

  return { id: 'E', title, withheld: false, partial };
}

function drawExhibitF(
  ctx: CanvasContext2DLike,
  dossier: ExhibitDossier,
): ExhibitRenderResult {
  const title = 'EVIDENCE LOCKER';
  const seedKey = `${dossier.handle}-exhibit-F`;
  const { partial } = drawExhibitFrame(
    ctx,
    'F',
    title,
    dossier,
    'INSPECTED REPOSITORY INVENTORY LEDGER & TOP STARRED EXHIBITS',
  );

  const rs = dossier.repoShape;
  const top3 = rs.topStarred.slice(0, 3);
  const maxStars = Math.max(1, top3[0]?.stars ?? 1);

  // Structural rules, vertical divider & square-root scaled hatched top-starred bars
  inkLayer(
    ctx,
    (sctx) => {
      sctx.strokeStyle = PALETTE.ink;
      sctx.fillStyle = PALETTE.ink;
      sctx.lineWidth = 1.6;

      // Left header underline (x 110..560)
      sctx.beginPath();
      sctx.moveTo(110, 192);
      sctx.lineTo(560, 192);
      sctx.stroke();

      // Vertical divider
      sctx.beginPath();
      sctx.moveTo(600, 160);
      sctx.lineTo(600, 578);
      sctx.stroke();

      // Right header underline (x 640..1090)
      sctx.beginPath();
      sctx.moveTo(640, 192);
      sctx.lineTo(1090, 192);
      sctx.stroke();

      if (top3.length === 0) {
        sctx.setLineDash([4, 4]);
        sctx.strokeRect(640, 234, 450, 280);
        sctx.setLineDash([]);
      } else {
        top3.forEach((repo, idx) => {
          const barY = 258 + idx * 96;
          sctx.save();
          sctx.globalAlpha = 0.25;
          sctx.lineWidth = 1;
          sctx.setLineDash([3, 4]);
          sctx.strokeRect(640, barY, 450, 28);
          sctx.restore();

          const ratioSqrt = Math.sqrt(Math.max(0, repo.stars)) / Math.sqrt(maxStars);
          const w =
            repo.stars <= 0
              ? 4
              : Math.max(12, Math.round(ratioSqrt * 450));
          drawHatchedInkBar(sctx, 640, barY, w, 28);
        });
      }
    },
    'labels',
    hashHandle(seedKey, 'el-shapes-ink'),
    { color: PALETTE.ink },
  );

  // Ledger lines (with clear leader gap) & top-starred text + sqrt scale note via 'receipts'
  inkLayer(
    ctx,
    (sctx) => {
      sctx.fillStyle = PALETTE.ink;

      sctx.textAlign = 'left';
      sctx.textBaseline = 'top';
      sctx.font = '700 15px "Courier Prime", monospace';
      drawTypewriterText(
        sctx,
        'REPOSITORY LEDGER',
        110,
        166,
        hashHandle(seedKey, 'el-hdr-left'),
      );
      drawTypewriterText(
        sctx,
        'TOP STARRED EXHIBITS (OWNED)',
        640,
        166,
        hashHandle(seedKey, 'el-hdr-right'),
      );

      sctx.font = '700 11px "Courier Prime", monospace';
      drawTypewriterText(
        sctx,
        'BAR SCALE: SQUARE-ROOT (SQRT STARS / MAX)',
        640,
        201,
        hashHandle(seedKey, 'el-sqrt-note'),
        450,
      );

      const rows: ReadonlyArray<{ label: string; value: string }> = [
        {
          label: 'INSPECTED',
          value: `${rs.inspected}${rs.truncated ? ' (TRUNCATED)' : ''}`,
        },
        { label: 'ORIGINAL', value: String(rs.ownedOriginal) },
        { label: 'FORKS', value: String(rs.forks) },
        {
          label: 'ARCHIVED',
          value: rs.archived === null ? 'NOT ON FILE' : String(rs.archived),
        },
        { label: 'ZERO-STAR', value: String(rs.zeroStar) },
        { label: 'NO LICENSE', value: String(rs.noLicense) },
        { label: 'TOTAL STARS', value: rs.totalStars.toLocaleString('en-US') },
        { label: 'FOLLOWERS', value: rs.followers.toLocaleString('en-US') },
      ];

      rows.forEach((row, idx) => {
        const y = 216 + idx * 43;
        sctx.font = '700 14px "Courier Prime", monospace';
        const leftW = sctx.measureText(row.label).width;
        sctx.font = '400 14px "Courier Prime", monospace';
        const rightW = sctx.measureText(row.value).width;

        sctx.textAlign = 'left';
        sctx.textBaseline = 'top';
        sctx.font = '700 14px "Courier Prime", monospace';
        drawTypewriterText(
          sctx,
          row.label,
          110,
          y,
          hashHandle(seedKey, `el-r-lbl-${idx}`),
          220,
        );

        drawDottedLeader(sctx, 110 + leftW + 18, 560 - rightW - 22, y + 12);

        sctx.textAlign = 'right';
        sctx.font = '400 14px "Courier Prime", monospace';
        drawTypewriterText(
          sctx,
          row.value,
          560,
          y,
          hashHandle(seedKey, `el-r-val-${idx}`),
          210,
        );
      });

      if (top3.length === 0) {
        sctx.textAlign = 'center';
        sctx.textBaseline = 'middle';
        sctx.font = '700 14px "Courier Prime", monospace';
        drawTypewriterText(
          sctx,
          'NO OWNED REPOSITORIES ON FILE.',
          865,
          374,
          hashHandle(seedKey, 'el-no-top'),
        );
      } else {
        top3.forEach((repo, idx) => {
          const ly = 230 + idx * 96;
          sctx.textAlign = 'left';
          sctx.textBaseline = 'top';
          sctx.font = '700 16px "Courier Prime", monospace';
          drawTypewriterText(
            sctx,
            `#${idx + 1} ${repo.name}`,
            640,
            ly,
            hashHandle(seedKey, `el-t-nm-${idx}`),
            310,
          );

          sctx.textAlign = 'right';
          sctx.font = '700 14px "Courier Prime", monospace';
          drawTypewriterText(
            sctx,
            `${repo.stars.toLocaleString('en-US')} STARS`,
            1090,
            ly + 1,
            hashHandle(seedKey, `el-t-st-${idx}`),
            135,
          );
        });
      }
    },
    'receipts',
    hashHandle(seedKey, 'el-text-ink'),
    { color: PALETTE.ink },
  );

  drawExhibitNoirLine(
    ctx,
    seedKey,
    pickSeededNoirLine(
      seedKey,
      top3.length === 0
        ? [
            'empty locker — nothing checked into property.',
            'no owned exhibits sitting under glass.',
          ]
        : rs.totalStars >= 10000
          ? [
              'one headline exhibit pulls the whole room.',
              'heavy locker — crowds follow the top shelf.',
            ]
          : [
              'modest shelf tagged into evidence.',
              'everything inventoried down to the license.',
            ],
    ),
    640,
    562,
    450,
    'left',
  );

  return { id: 'F', title, withheld: false, partial };
}

/**
 * Draws any single exhibit canvas A..F (1200x675) onto `ctx`.
 */
export function renderExhibit(
  ctx: CanvasContext2DLike,
  id: ExhibitId,
  dossier: ExhibitDossier,
  options: RenderExhibitOptions = {},
): ExhibitRenderResult {
  switch (id) {
    case 'A':
      return drawExhibitA(ctx, dossier);
    case 'B':
      return drawExhibitB(ctx, dossier);
    case 'C':
      return drawExhibitC(ctx, dossier);
    case 'D':
      return drawExhibitD(ctx, dossier, options);
    case 'E':
      return drawExhibitE(ctx, dossier);
    case 'F':
      return drawExhibitF(ctx, dossier);
  }
}

export { type ExhibitDossier, type ExhibitId, type ExhibitRenderResult };
