import type { VerdictReport } from '../engine/charges.js';
import {
  buildDetailReport,
  detailInputFromBundle,
  type BundleLike,
} from '../engine/details.js';
import { isOptedOut } from '../optout.js';
import type { CanvasContext2DLike } from '../canvas/paper.js';
import { CARD_HEIGHT, CARD_WIDTH } from '../canvas/paper.js';
import { canvasToPngBlob } from '../lib/export-png.js';
import { renderExhibit } from './draw-exhibits.js';
import {
  EXHIBIT_IDS,
  isExhibitWithheld,
  type ExhibitDossier,
  type ExhibitId,
  type ExhibitRenderResult,
  type ExhibitRepoInfo,
} from './frame.js';

export interface ExhibitsOpenOptions {
  mountEl: HTMLElement;
  verdict: VerdictReport;
  repos?: readonly ExhibitRepoInfo[];
  bundle?: BundleLike;
  getPresetBundle: (handle: string) => BundleLike | null;
  openLightboxWithCanvas: (
    sourceCanvas: HTMLCanvasElement,
    altText: string,
    returnFocusTo?: HTMLElement | null,
  ) => Promise<void>;
  setActionStatus: (msg: string) => void;
  onSoundTick?: () => void;
}

type DetailFetchResult =
  | { kind: 'ok'; dossier: ExhibitDossier; fromFallback?: boolean }
  | { kind: 'sealed'; handle: string }
  | { kind: 'error'; message: string };

const TAB_LABELS: Record<ExhibitId, string> = {
  A: 'A · CONTRIB',
  B: 'B · PUNCH CARD',
  C: 'C · STATUTES',
  D: 'D · TIME SERVED',
  E: 'E · LANGUAGES',
  F: 'F · LOCKER',
};

const sessionDetailCache = new Map<string, Promise<DetailFetchResult>>();

function normalizeKey(raw: string): string {
  return raw.trim().replace(/^@+/, '').toLowerCase();
}

function buildLocalFallbackDossier(
  verdict: VerdictReport,
  bundle: BundleLike,
): ExhibitDossier | null {
  const input = detailInputFromBundle(bundle, null);
  if (!input) return null;
  const report = buildDetailReport(input);
  return {
    ...report,
    calendarUnit: 'contributions',
    verdict,
    menaceScore: verdict.menaceScore,
    bail: verdict.bail,
    bailAmount: verdict.bailAmount,
    missing: { user: 403 },
  };
}

/**
 * Fetches /api/detail?u=handle at most once per normalized handle per session.
 */
function fetchDetailOnce(
  handle: string,
  verdict: VerdictReport,
  getPresetBundle: (handle: string) => BundleLike | null,
): Promise<DetailFetchResult> {
  const key = normalizeKey(handle);
  if (!key || isOptedOut(key)) {
    return Promise.resolve({ kind: 'sealed', handle });
  }

  const cached = sessionDetailCache.get(key);
  if (cached) return cached;

  const task = (async (): Promise<DetailFetchResult> => {
    try {
      const res = await fetch(`/api/detail?u=${encodeURIComponent(handle)}`);
      const text = await res.text();
      let json: Record<string, unknown> | null = null;
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        json = null;
      }

      if (res.status === 404 && json && (json.sealed === true || json.verdict === 'RECORD SEALED')) {
        return { kind: 'sealed', handle };
      }

      if (res.ok && json && typeof json.handle === 'string') {
        const dossier = json as unknown as ExhibitDossier;
        if (!dossier.verdict) {
          dossier.verdict = verdict;
        }
        return { kind: 'ok', dossier };
      }

      if (res.status === 403 || res.status >= 500) {
        const fallbackBundle = getPresetBundle(handle);
        if (fallbackBundle) {
          const dossier = buildLocalFallbackDossier(verdict, fallbackBundle);
          if (dossier) {
            return { kind: 'ok', dossier, fromFallback: true };
          }
        }
      }

      const msg =
        (json && typeof json.error === 'string' && json.error) ||
        'Could not retrieve archived exhibits.';
      return { kind: 'error', message: msg };
    } catch {
      const fallbackBundle = getPresetBundle(handle);
      if (fallbackBundle) {
        const dossier = buildLocalFallbackDossier(verdict, fallbackBundle);
        if (dossier) {
          return { kind: 'ok', dossier, fromFallback: true };
        }
      }
      return {
        kind: 'error',
        message: 'Could not reach detail archive. Try again shortly.',
      };
    }
  })();

  sessionDetailCache.set(key, task);
  return task;
}

async function ensureFontsReady(): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return;
  try {
    await document.fonts.ready;
  } catch {
    // Non-fatal fallback
  }
}

async function downloadExhibitPng(
  canvas: HTMLCanvasElement,
  handle: string,
  id: ExhibitId,
): Promise<void> {
  const blob = await canvasToPngBlob(canvas);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safeName = normalizeKey(handle).replace(/[^a-z0-9-]/gi, '') || 'suspect';
  a.href = url;
  a.download = `subpoena-${safeName}-exhibit-${id}.png`;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let activeOpenSeq = 0;

export async function openExhibitsCaseFile(
  opts: ExhibitsOpenOptions,
): Promise<{ ok: boolean; statusMessage?: string }> {
  const { mountEl, verdict } = opts;

  if (verdict.verdict === 'RECORD SEALED' || isOptedOut(verdict.handle)) {
    closeExhibitsCaseFile(mountEl);
    return { ok: false, statusMessage: 'RECORD SEALED' };
  }

  const seq = ++activeOpenSeq;
  const result = await fetchDetailOnce(
    verdict.handle,
    verdict,
    opts.getPresetBundle,
  );
  if (seq !== activeOpenSeq) {
    return { ok: false };
  }

  if (result.kind === 'sealed') {
    closeExhibitsCaseFile(mountEl);
    return { ok: false, statusMessage: 'RECORD SEALED' };
  }

  if (result.kind === 'error') {
    opts.setActionStatus(result.message);
    return { ok: false, statusMessage: result.message };
  }

  await ensureFontsReady();
  if (seq !== activeOpenSeq) return { ok: false };

  const baseDossier = result.dossier;
  let dossier: ExhibitDossier =
    opts.repos && !baseDossier.repos
      ? { ...baseDossier, repos: opts.repos }
      : baseDossier;
  if (
    !dossier.punchCard &&
    opts.bundle?.commits &&
    opts.bundle.commits.items.length > 0
  ) {
    const recoveredInput = detailInputFromBundle(opts.bundle, null);
    if (recoveredInput) {
      const recovered = buildDetailReport(recoveredInput);
      const filteredNotes = dossier.sample.notes.filter(
        (n) => !/No commit sample available/i.test(n),
      );
      if (
        opts.bundle.commits.incomplete_results &&
        !filteredNotes.some((n) => /incomplete results/i.test(n))
      ) {
        filteredNotes.unshift(
          'GitHub search reported incomplete results; counts are of recent commits found.',
        );
      }
      dossier = {
        ...dossier,
        punchCard: recovered.punchCard,
        radar: recovered.radar,
        sample: {
          ...dossier.sample,
          commits: recovered.sample.commits,
          searchIncomplete:
            dossier.sample.searchIncomplete ||
            recovered.sample.searchIncomplete,
          notes: filteredNotes,
        },
      };
    }
  }
  let activeId: ExhibitId = 'A';

  mountEl.innerHTML = '';
  mountEl.hidden = false;

  const panel = document.createElement('div');
  panel.className = 'exhibits-casefile';

  // Header strip
  const headerBar = document.createElement('div');
  headerBar.className = 'exhibits-bar';
  const titleSpan = document.createElement('span');
  titleSpan.className = 'exhibits-case-label';
  titleSpan.textContent = `CASE FILE: ${verdict.caseNumber} · @${dossier.handle}`;
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'exhibits-close-btn';
  closeBtn.textContent = 'CLOSE FILE';
  closeBtn.addEventListener('click', () => {
    closeExhibitsCaseFile(mountEl);
    opts.onSoundTick?.();
  });
  headerBar.append(titleSpan, closeBtn);

  // Paper index tabs A..F (greyed out with WITHHELD tag when data is missing)
  const tabRow = document.createElement('div');
  tabRow.className = 'exhibit-tabs';
  tabRow.setAttribute('role', 'tablist');
  tabRow.setAttribute('aria-label', 'Docket exhibits A to F');

  const tabButtons = new Map<ExhibitId, HTMLButtonElement>();
  for (const id of EXHIBIT_IDS) {
    const withheld = isExhibitWithheld(id, dossier);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'exhibit-tab';
    btn.setAttribute('role', 'tab');
    btn.id = `exhibit-tab-${id}`;
    btn.dataset.exhibit = id;

    const labelSpan = document.createElement('span');
    labelSpan.textContent = TAB_LABELS[id];
    btn.appendChild(labelSpan);

    if (withheld) {
      btn.classList.add('is-withheld');
      btn.title = `Exhibit ${id} data withheld / unavailable`;
      const tag = document.createElement('span');
      tag.className = 'tab-withheld-tag';
      tag.textContent = 'WITHHELD';
      btn.appendChild(tag);
    }

    btn.setAttribute('aria-selected', id === activeId ? 'true' : 'false');
    if (id === activeId) btn.classList.add('is-active');
    btn.addEventListener('click', () => {
      if (activeId === id) return;
      activeId = id;
      opts.onSoundTick?.();
      updateActiveExhibit();
    });
    tabButtons.set(id, btn);
    tabRow.appendChild(btn);
  }

  // Canvas frame
  const canvasFrame = document.createElement('div');
  canvasFrame.className = 'exhibit-frame';
  canvasFrame.tabIndex = 0;
  canvasFrame.setAttribute('role', 'button');

  const exhibitCanvas = document.createElement('canvas');
  exhibitCanvas.id = 'exhibit-canvas';
  exhibitCanvas.className = 'card-canvas';
  exhibitCanvas.width = CARD_WIDTH;
  exhibitCanvas.height = CARD_HEIGHT;
  canvasFrame.appendChild(exhibitCanvas);

  // Tap hint on mobile (reuses lightbox)
  const tapHint = document.createElement('p');
  tapHint.className = 'tap-hint exhibit-tap-hint';
  tapHint.textContent = 'TAP EXHIBIT TO ENLARGE';

  // Footer controls with own DOWNLOAD PNG slip
  const footerBar = document.createElement('div');
  footerBar.className = 'exhibit-actions';

  const metaEl = document.createElement('span');
  metaEl.className = 'exhibit-meta';
  metaEl.id = 'exhibit-meta';

  const downloadBtn = document.createElement('button');
  downloadBtn.type = 'button';
  downloadBtn.id = 'btn-exhibit-download';
  downloadBtn.className = 'exhibit-download-slip';
  downloadBtn.textContent = 'DOWNLOAD PNG';

  footerBar.append(metaEl, downloadBtn);
  panel.append(headerBar, tabRow, canvasFrame, tapHint, footerBar);
  mountEl.appendChild(panel);

  let lastResult: ExhibitRenderResult | null = null;
  const ctx = exhibitCanvas.getContext('2d') as unknown as CanvasContext2DLike | null;

  const updateActiveExhibit = () => {
    for (const [id, btn] of tabButtons.entries()) {
      const selected = id === activeId;
      btn.classList.toggle('is-active', selected);
      btn.setAttribute('aria-selected', selected ? 'true' : 'false');
    }
    if (!ctx) return;
    lastResult = renderExhibit(ctx, activeId, dossier);
    canvasFrame.setAttribute(
      'aria-label',
      `Enlarge Exhibit ${activeId}: ${lastResult.title} for @${dossier.handle}`,
    );
    metaEl.textContent =
      `EXHIBIT ${activeId} — ${lastResult.title}` +
      (lastResult.withheld ? ' [WITHHELD]' : '');
  };

  downloadBtn.addEventListener('click', async () => {
    try {
      await downloadExhibitPng(exhibitCanvas, dossier.handle, activeId);
      const safe = normalizeKey(dossier.handle).replace(/[^a-z0-9-]/gi, '') || 'suspect';
      opts.setActionStatus(`Downloaded subpoena-${safe}-exhibit-${activeId}.png`);
    } catch {
      opts.setActionStatus('Exhibit PNG export failed.');
    }
  });

  const triggerLightbox = () => {
    const label = lastResult
      ? `Exhibit ${lastResult.id} — ${lastResult.title} for @${dossier.handle}`
      : `Exhibit ${activeId} for @${dossier.handle}`;
    void opts.openLightboxWithCanvas(exhibitCanvas, label, canvasFrame);
  };

  canvasFrame.addEventListener('click', triggerLightbox);
  canvasFrame.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      triggerLightbox();
    }
  });
  tapHint.addEventListener('click', triggerLightbox);

  updateActiveExhibit();

  return {
    ok: true,
    statusMessage: result.fromFallback
      ? 'Exhibits loaded from archived preset dossier (calendar unavailable without token).'
      : `Case file exhibits ready for @${dossier.handle}.`,
  };
}

export function closeExhibitsCaseFile(mountEl: HTMLElement): void {
  activeOpenSeq++;
  mountEl.hidden = true;
  mountEl.innerHTML = '';
}
