import { inject } from '@vercel/analytics';
import { PRESETS, type GitHubBundle } from '../../api/presets.js';
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  browserFontLoader,
  draw,
  drawPaper,
  type AvatarImage,
} from '../canvas/index.js';
import { evaluateCharges, type VerdictReport } from '../engine/charges.js';
import { createRng, normalizeHandle } from '../engine/hash.js';
import {
  canCopyImage,
  copyCardImage,
  copyCardLink,
  copyReadmeLine,
  copyXPost,
} from '../lib/copy.js';
import { canvasToPngBlob, downloadCardPng } from '../lib/export-png.js';
import { sfx } from '../lib/sfx.js';
import {
  OPT_OUT_CONTACT,
  getOptOutContactHref,
  isOptedOut,
  makeSealedBundle,
} from '../optout.js';

const VALID_HANDLE_RE =
  /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}(?:\[bot\])?$/i;

const ERR_INVALID_HANDLE =
  'INVALID HANDLE FORMAT: letters, digits and single hyphens';
const ERR_NOT_FOUND = 'NO SUCH SUSPECT ON FILE';

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing required element #${id}`);
  return el;
}

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const sleep = (ms: number): Promise<void> =>
  prefersReducedMotion()
    ? Promise.resolve()
    : new Promise((resolve) => setTimeout(resolve, ms));

const waitForIdleAfterAnimationStart = (): Promise<void> =>
  new Promise((resolve) => {
    const startIdle = () => {
      const ric = (
        window as unknown as {
          requestIdleCallback?: (
            cb: () => void,
            opts?: { timeout: number },
          ) => number;
        }
      ).requestIdleCallback;
      if (typeof ric === 'function') {
        ric(() => resolve(), { timeout: 100 });
      } else {
        setTimeout(resolve, 12);
      }
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => setTimeout(startIdle, 24));
    } else {
      setTimeout(startIdle, 24);
    }
  });

function drawSheetTonerStreak(): void {
  const canvas = document.getElementById(
    'streak-canvas',
  ) as HTMLCanvasElement | null;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;
  const img = ctx.createImageData(w, h);
  const data = img.data;
  const rng = createRng(0x14b014b0);

  const gutterW = Math.min(w, 38);
  const bandOpacities = new Float32Array(gutterW);
  let bx = 0;
  while (bx < gutterW) {
    const bw = 1 + Math.floor(rng() * 3);
    const op = 0.08 + rng() * 0.22;
    for (let j = 0; j < bw && bx + j < gutterW; j++) {
      bandOpacities[bx + j] = op;
    }
    bx += bw + Math.floor(rng() * 2);
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 4;
      data[k] = 23;
      data[k + 1] = 21;
      data[k + 2] = 15;
      if (x >= gutterW) {
        data[k + 3] = 0;
        continue;
      }
      const falloff = Math.pow(1 - x / gutterW, 1.65);
      const yWave = 0.86 + 0.24 * Math.sin(y * 0.019 + x * 0.4);
      const band = bandOpacities[x] ?? 0;
      const alphaFloat = Math.min(0.24, falloff * (0.16 * yWave + band * 0.42));
      data[k + 3] = Math.round(alphaFloat * 255);
    }
  }

  // Up to 40 subtle dropout specks near the edge
  for (let i = 0; i < 32; i++) {
    const sx = 1 + Math.floor(rng() * Math.min(18, gutterW - 2));
    const sy = 6 + Math.floor(rng() * (h - 12));
    const k = (sy * w + sx) * 4;
    data[k + 3] = Math.round((data[k + 3] ?? 0) * 0.45);
  }

  ctx.putImageData(img, 0, 0);
}

function loadCorsAvatar(url: string | undefined): Promise<AvatarImage | null> {
  if (!url) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

async function typeField(
  el: HTMLElement,
  text: string,
  token: number,
  isCurrent: () => boolean,
): Promise<void> {
  if (prefersReducedMotion()) {
    el.textContent = text;
    return;
  }
  el.textContent = '';
  for (const ch of text) {
    if (!isCurrent() || token < 0) return;
    el.textContent += ch;
    sfx.tick();
    await sleep(16 + Math.random() * 22);
  }
}

function updateOgTags(handle: string | null): void {
  const origin = window.location.origin;
  const og = document.querySelector('meta[property="og:image"]');
  const tw = document.querySelector('meta[name="twitter:image"]');
  const ogTitle = document.querySelector('meta[property="og:title"]');
  const ogDesc = document.querySelector('meta[property="og:description"]');

  const useCustom = Boolean(handle && !isOptedOut(handle));
  const imageUrl = useCustom && handle
    ? new URL(`/api/card?u=${encodeURIComponent(handle)}`, origin).href
    : new URL('/og-default.png', origin).href;

  if (og) og.setAttribute('content', imageUrl);
  if (tw) tw.setAttribute('content', imageUrl);
  if (ogTitle) {
    ogTitle.setAttribute(
      'content',
      useCustom && handle
        ? `Subpoena — @${handle} GitHub Rap Sheet`
        : 'Subpoena — GitHub Rap Sheet',
    );
  }
  if (ogDesc) {
    ogDesc.setAttribute(
      'content',
      useCustom && handle
        ? `Form 14-B rap sheet for GitHub user @${handle}.`
        : 'Courtroom noir GitHub intake form and rap sheet.',
    );
  }
}

function makeFallbackBundle(handle: string): GitHubBundle | null {
  const key = normalizeHandle(handle) as keyof typeof PRESETS;
  if (Object.prototype.hasOwnProperty.call(PRESETS, key)) {
    const preset = PRESETS[key];
    return {
      ...preset,
      missing: { ...preset.missing, user: 403 },
    };
  }
  return null;
}

const wrapEl = $('wrap');
const sheetEl = $('sheet');
const formEl = $('form') as HTMLFormElement;
const inputEl = $('h') as HTMLInputElement;
const bookBtn = $('book-btn') as HTMLButtonElement;
const caseEl = $('caseno');
const stripCaseEl = $('strip-case');
const stripCaseNoEl = $('strip-caseno');
const dateEl = $('date');
const officerEl = $('officer');
const noticeEl = $('form-notice');
const cardFrame = $('card-frame');
const cardCanvas = $('card-canvas') as HTMLCanvasElement;
const tapHintEl = $('tap-hint');
const flashEl = $('shutter-flash');
const soundBtn = $('sound-toggle') as HTMLButtonElement;
const actionStatusEl = $('action-status');
const lightboxEl = $('lightbox');
const lightboxImg = $('lightbox-img') as HTMLImageElement;
const lightboxCloseBtn = $('lightbox-close') as HTMLButtonElement;
const optoutContactEl = document.getElementById(
  'optout-contact',
) as HTMLAnchorElement | null;

if (optoutContactEl) {
  optoutContactEl.textContent = OPT_OUT_CONTACT;
  optoutContactEl.href = getOptOutContactHref(OPT_OUT_CONTACT);
}

const btnDownload = $('btn-download') as HTMLButtonElement;
const btnCopyImage = $('btn-copy-image') as HTMLButtonElement;
const btnCopyLink = $('btn-copy-link') as HTMLButtonElement;
const btnCopyX = $('btn-copy-x') as HTMLButtonElement;
const btnCopyReadme = $('btn-copy-readme') as HTMLButtonElement;
const btnExhibits = $('btn-exhibits') as HTMLButtonElement;
const exhibitsRootEl = $('exhibits-root');

if (!canCopyImage()) {
  btnCopyImage.hidden = true;
}

let currentVerdict: VerdictReport | null = null;
let currentBundle: GitHubBundle | null = null;
let bookingSeq = 0;
let lightboxObjectUrl: string | null = null;
let lightboxReturnFocusEl: HTMLElement | null = null;
const prewarmedHandles = new Set<string>();

function prewarmCardPreview(handle: string): void {
  const key = normalizeHandle(handle);
  if (!key || isOptedOut(key) || prewarmedHandles.has(key)) return;
  prewarmedHandles.add(key);
  setTimeout(() => {
    fetch(`/api/card?u=${encodeURIComponent(handle)}`, {
      priority: 'low',
    } as RequestInit).catch(() => {});
  }, 50);
}

function setActionsEnabled(enabled: boolean): void {
  btnDownload.disabled = !enabled;
  btnCopyImage.disabled = !enabled;
  btnCopyLink.disabled = !enabled;
  btnCopyX.disabled = !enabled;
  btnCopyReadme.disabled = !enabled;
}

function resetExhibitsPanel(): void {
  exhibitsRootEl.hidden = true;
  exhibitsRootEl.innerHTML = '';
}

function updateExhibitsButtonForVerdict(verdict: VerdictReport | null): void {
  if (!verdict) {
    btnExhibits.hidden = true;
    btnExhibits.disabled = true;
    btnExhibits.classList.remove('is-sealed');
    btnExhibits.textContent = 'MORE EXHIBITS';
    return;
  }
  btnExhibits.hidden = false;
  const sealed =
    verdict.verdict === 'RECORD SEALED' || isOptedOut(verdict.handle);
  if (sealed) {
    btnExhibits.disabled = true;
    btnExhibits.classList.add('is-sealed');
    btnExhibits.textContent = 'RECORD SEALED';
  } else {
    btnExhibits.disabled = false;
    btnExhibits.classList.remove('is-sealed');
    btnExhibits.textContent = 'MORE EXHIBITS';
  }
}

function setNotice(
  message: string,
  isError = false,
  isSealed = false,
): void {
  noticeEl.textContent = message;
  noticeEl.classList.toggle('is-error', isError);
  noticeEl.classList.toggle('is-sealed', isSealed);
}

function setActionStatus(message: string): void {
  actionStatusEl.textContent = message;
}

function closeLightbox(restoreFocus = true): void {
  const wasOpen = !lightboxEl.hidden;
  if (wasOpen) {
    lightboxEl.hidden = true;
  }
  if (lightboxObjectUrl) {
    URL.revokeObjectURL(lightboxObjectUrl);
    lightboxObjectUrl = null;
  }
  lightboxImg.removeAttribute('src');
  const returnTarget =
    lightboxReturnFocusEl ??
    (cardFrame.classList.contains('is-interactive') ? cardFrame : null);
  lightboxReturnFocusEl = null;
  if (wasOpen && restoreFocus && returnTarget) {
    returnTarget.focus();
  }
}

async function openLightboxWithCanvas(
  sourceCanvas: HTMLCanvasElement,
  altText: string,
  returnFocusTo?: HTMLElement | null,
): Promise<void> {
  try {
    const blob = await canvasToPngBlob(sourceCanvas);
    if (lightboxObjectUrl) {
      URL.revokeObjectURL(lightboxObjectUrl);
    }
    lightboxObjectUrl = URL.createObjectURL(blob);
    lightboxReturnFocusEl = returnFocusTo ?? null;
    lightboxImg.src = lightboxObjectUrl;
    lightboxImg.alt = altText;
    lightboxEl.hidden = false;
    lightboxCloseBtn.focus();
  } catch {
    setActionStatus('Unable to open full-screen view.');
  }
}

async function openLightbox(): Promise<void> {
  if (!currentVerdict) return;
  await openLightboxWithCanvas(
    cardCanvas,
    `Full-size subpoena rap sheet for @${currentVerdict.handle}`,
    cardFrame,
  );
}

function clearCardForError(message: string): void {
  currentVerdict = null;
  currentBundle = null;
  setActionsEnabled(false);
  updateExhibitsButtonForVerdict(null);
  resetExhibitsPanel();
  inputEl.setAttribute('aria-invalid', 'true');
  setNotice(message, true);
  caseEl.textContent = '—';
  stripCaseNoEl.textContent = '—';
  dateEl.textContent = '—';
  officerEl.textContent = '—';
  tapHintEl.hidden = true;
  closeLightbox(false);
  cardFrame.classList.add('is-dimmed');
  cardFrame.classList.remove('is-interactive');
  cardFrame.removeAttribute('tabindex');
  cardFrame.removeAttribute('role');
  const ctx = cardCanvas.getContext('2d');
  if (ctx) {
    cardCanvas.width = CARD_WIDTH;
    cardCanvas.height = CARD_HEIGHT;
    drawPaper(ctx, 'unbooked');
  }
  updateOgTags(null);
}

function triggerShutterFlash(): void {
  if (prefersReducedMotion()) return;
  flashEl.classList.remove('flash');
  void flashEl.offsetWidth;
  flashEl.classList.add('flash');
  sfx.shutter();
}

function triggerCardSlam(): void {
  if (prefersReducedMotion()) return;
  cardFrame.classList.remove('slam');
  void cardFrame.offsetWidth;
  cardFrame.classList.add('slam');
  sfx.thud();
}

async function renderBlankInitialCard(): Promise<void> {
  const ctx = cardCanvas.getContext('2d');
  if (!ctx) return;
  const blankBundle: GitHubBundle = {
    handle: 'suspect',
    fetchedAt: new Date().toISOString(),
    preset: false,
    user: null,
    repos: [],
    events: [],
    commits: null,
    missing: {},
  };
  const blankVerdict = evaluateCharges(blankBundle);
  await draw(ctx, blankVerdict, null, { fontLoader: browserFontLoader });
}

async function bookHandle(rawInput: string, updateUrl = true): Promise<void> {
  const cleaned = rawInput.trim().replace(/^@+/, '');
  if (!cleaned || !VALID_HANDLE_RE.test(cleaned)) {
    clearCardForError(ERR_INVALID_HANDLE);
    return;
  }

  const seq = ++bookingSeq;
  const isCurrent = () => seq === bookingSeq;

  inputEl.setAttribute('aria-invalid', 'false');
  bookBtn.disabled = true;
  setActionsEnabled(false);
  updateExhibitsButtonForVerdict(null);
  resetExhibitsPanel();
  setActionStatus('');
  setNotice(`Pulling rap sheet for @${cleaned}...`);
  triggerShutterFlash();

  let bundle: GitHubBundle | null = null;
  let friendlyNotice = '';

  try {
    if (isOptedOut(cleaned)) {
      bundle = makeSealedBundle(cleaned);
    } else {
      const res = await fetch(`/api/gh?u=${encodeURIComponent(cleaned)}`);
      if (res.status === 404) {
        if (!isCurrent()) return;
        clearCardForError(ERR_NOT_FOUND);
        bookBtn.disabled = false;
        return;
      }

      if (res.status === 403 || res.status >= 500) {
        const fallback = makeFallbackBundle(cleaned);
        if (fallback) {
          bundle = fallback;
          friendlyNotice =
            'GitHub rate limit reached — loaded archived dossier.';
        } else {
          if (!isCurrent()) return;
          clearCardForError(
            'GitHub rate limit reached. Try one of the KNOWN OFFENDERS presets.',
          );
          bookBtn.disabled = false;
          return;
        }
      } else if (!res.ok) {
        if (!isCurrent()) return;
        clearCardForError(ERR_NOT_FOUND);
        bookBtn.disabled = false;
        return;
      } else {
        bundle = (await res.json()) as GitHubBundle;
        if (
          !bundle.sealed &&
          !bundle.user &&
          bundle.missing.user === 404
        ) {
          if (!isCurrent()) return;
          clearCardForError(ERR_NOT_FOUND);
          bookBtn.disabled = false;
          return;
        }
        if (bundle.preset && bundle.missing.user === 403) {
          friendlyNotice =
            'GitHub rate limit reached — loaded archived dossier.';
        }
      }
    }
  } catch {
    const fallback = makeFallbackBundle(cleaned);
    if (fallback) {
      bundle = fallback;
      friendlyNotice = 'Network error — loaded archived dossier.';
    } else {
      if (!isCurrent()) return;
      clearCardForError('Could not reach precinct records. Try again shortly.');
      bookBtn.disabled = false;
      return;
    }
  }

  if (!bundle || !isCurrent()) return;

  const verdict = evaluateCharges(bundle);
  const ctx = cardCanvas.getContext('2d');
  if (!ctx) return;

  // Type case number into the strip/fields in parallel with avatar load & canvas render
  const typingPromise = (async () => {
    await Promise.all([
      typeField(caseEl, verdict.caseNumber, seq, isCurrent),
      typeField(stripCaseNoEl, verdict.caseNumber, seq, isCurrent),
    ]);
    await typeField(dateEl, verdict.date, seq, isCurrent);
    await typeField(officerEl, verdict.officer, seq, isCurrent);
  })();

  const avatar = await loadCorsAvatar(bundle.user?.avatar_url);
  if (!isCurrent()) return;

  // Yield until intake typing/shutter animation begins and browser hits an idle slice
  await waitForIdleAfterAnimationStart();
  if (!isCurrent()) return;

  const stageCanvas = document.createElement('canvas');
  stageCanvas.width = CARD_WIDTH;
  stageCanvas.height = CARD_HEIGHT;
  const stageCtx = stageCanvas.getContext('2d');
  if (!stageCtx) return;

  const renderStart = performance.now();
  await draw(stageCtx, verdict, avatar, {
    fontLoader: browserFontLoader,
    yieldBetweenStages: true,
  });
  const wallMs = performance.now() - renderStart;
  if (!isCurrent()) return;

  const stageMetrics = stageCanvas as unknown as {
    __lastComputeMs?: number;
    __maxStageMs?: number;
    __stageTimings?: Array<{ name: string; ms: number }>;
  };
  const winMetrics = window as unknown as {
    __lastRenderMs?: number;
    __lastRenderWallMs?: number;
    __maxStageMs?: number;
    __stageTimings?: Array<{ name: string; ms: number }>;
  };
  winMetrics.__lastRenderMs = stageMetrics.__lastComputeMs ?? wallMs;
  winMetrics.__lastRenderWallMs = wallMs;
  winMetrics.__maxStageMs = stageMetrics.__maxStageMs ?? wallMs;
  winMetrics.__stageTimings = stageMetrics.__stageTimings ?? [];

  cardCanvas.width = CARD_WIDTH;
  cardCanvas.height = CARD_HEIGHT;
  ctx.drawImage(stageCanvas, 0, 0);
  await typingPromise;

  if (!isCurrent()) return;

  currentVerdict = verdict;
  currentBundle = bundle;
  wrapEl.classList.add('is-booked');
  sheetEl.classList.add('is-booked');
  stripCaseEl.hidden = false;
  stripCaseNoEl.textContent = verdict.caseNumber;
  cardFrame.classList.remove('is-dimmed');
  cardFrame.classList.add('is-interactive');
  cardFrame.tabIndex = 0;
  cardFrame.setAttribute('role', 'button');
  tapHintEl.hidden = false;
  bookBtn.disabled = false;
  setActionsEnabled(true);
  updateExhibitsButtonForVerdict(verdict);
  triggerCardSlam();

  if (friendlyNotice) {
    setNotice(friendlyNotice, false);
  } else if (verdict.verdict === 'RECORD SEALED') {
    setNotice('RECORD SEALED', false, true);
  } else if (verdict.verdict === 'INSUFFICIENT EVIDENCE') {
    setNotice(verdict.alibi?.receipt ?? 'partial record on file — insufficient evidence.');
  } else if (verdict.partialRecord) {
    setNotice('partial record on file — booked with available exhibits.');
  } else {
    setNotice(`Booked @${verdict.handle} — ${verdict.verdict}.`);
  }

  updateOgTags(verdict.verdict === 'RECORD SEALED' ? null : verdict.handle);
  if (updateUrl) {
    const nextUrl = new URL(window.location.href);
    nextUrl.search = '';
    nextUrl.hash = '';
    nextUrl.searchParams.set('u', verdict.handle);
    window.history.replaceState(null, '', nextUrl.toString());
  }
}

formEl.addEventListener('submit', (e) => {
  e.preventDefault();
  const raw = inputEl.value.trim().replace(/^@+/, '');
  inputEl.value = raw;
  if (!raw || !VALID_HANDLE_RE.test(raw)) {
    clearCardForError(ERR_INVALID_HANDLE);
    return;
  }
  inputEl.setAttribute('aria-invalid', 'false');
  void bookHandle(raw);
});

inputEl.addEventListener('input', () => {
  if (inputEl.getAttribute('aria-invalid') === 'true') {
    inputEl.setAttribute('aria-invalid', 'false');
  }
});

cardFrame.addEventListener('click', () => {
  if (currentVerdict) void openLightbox();
});

cardFrame.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && currentVerdict) {
    e.preventDefault();
    void openLightbox();
  }
});

tapHintEl.addEventListener('click', () => {
  if (currentVerdict) void openLightbox();
});

lightboxCloseBtn.addEventListener('click', () => {
  closeLightbox();
});

lightboxEl.addEventListener('click', (e) => {
  if (e.target === lightboxEl) {
    closeLightbox();
  }
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !lightboxEl.hidden) {
    closeLightbox();
  }
});

document.querySelectorAll<HTMLButtonElement>('[data-u]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const handle = btn.dataset.u ?? '';
    if (!handle) return;
    inputEl.value = handle;
    void bookHandle(handle);
  });
});

soundBtn.addEventListener('click', () => {
  const on = sfx.toggle();
  soundBtn.textContent = on ? 'SOUND: ON' : 'SOUND: OFF';
  soundBtn.setAttribute('aria-pressed', String(on));
  if (on) sfx.tick();
});

btnDownload.addEventListener('click', async () => {
  if (!currentVerdict) return;
  try {
    await downloadCardPng(cardCanvas, currentVerdict.handle);
    setActionStatus(`Downloaded subpoena-${normalizeHandle(currentVerdict.handle)}.png`);
  } catch {
    setActionStatus('PNG export failed.');
  }
});

btnExhibits.addEventListener('click', async () => {
  const verdict = currentVerdict;
  if (
    !verdict ||
    verdict.verdict === 'RECORD SEALED' ||
    isOptedOut(verdict.handle)
  ) {
    updateExhibitsButtonForVerdict(verdict);
    return;
  }

  const seqAtClick = bookingSeq;
  btnExhibits.disabled = true;
  btnExhibits.textContent = 'RETRIEVING EXHIBITS...';

  try {
    const mod = await import('../exhibits/exhibits.js');
    if (bookingSeq !== seqAtClick) return;
    const outcome = await mod.openExhibitsCaseFile({
      mountEl: exhibitsRootEl,
      verdict,
      repos: currentBundle?.repos,
      bundle: currentBundle ?? undefined,
      getPresetBundle: (h) => makeFallbackBundle(h),
      openLightboxWithCanvas,
      setActionStatus,
      onSoundTick: () => sfx.tick(),
    });
    if (bookingSeq !== seqAtClick) return;
    if (outcome.statusMessage === 'RECORD SEALED') {
      updateExhibitsButtonForVerdict({
        ...verdict,
        verdict: 'RECORD SEALED',
      });
      setNotice('RECORD SEALED', false, true);
      return;
    }
    if (outcome.statusMessage) {
      setActionStatus(outcome.statusMessage);
    }
  } catch {
    if (bookingSeq !== seqAtClick) return;
    setActionStatus('Could not load exhibits module.');
  } finally {
    if (
      bookingSeq === seqAtClick &&
      currentVerdict &&
      currentVerdict.verdict !== 'RECORD SEALED' &&
      !isOptedOut(currentVerdict.handle) &&
      !btnExhibits.classList.contains('is-sealed')
    ) {
      btnExhibits.disabled = false;
      btnExhibits.textContent = 'MORE EXHIBITS';
    }
  }
});

btnCopyImage.addEventListener('click', async () => {
  if (!currentVerdict) return;
  try {
    await copyCardImage(cardCanvas);
    setActionStatus('Copied card image to clipboard.');
  } catch {
    setActionStatus('Image copy unavailable in this browser.');
  }
});

btnCopyLink.addEventListener('pointerenter', () => {
  if (currentVerdict && currentVerdict.verdict !== 'RECORD SEALED') {
    prewarmCardPreview(currentVerdict.handle);
  }
});

btnCopyLink.addEventListener('click', async () => {
  if (!currentVerdict) return;
  try {
    await copyCardLink(currentVerdict.handle);
    setActionStatus(`Copied link for @${currentVerdict.handle}.`);
  } catch {
    setActionStatus('Copy link failed.');
  }
});

btnCopyX.addEventListener('click', async () => {
  if (!currentVerdict) return;
  try {
    await copyXPost(currentVerdict);
    setActionStatus('Copied X post to clipboard.');
  } catch {
    setActionStatus('Copy X post failed.');
  }
});

btnCopyReadme.addEventListener('click', async () => {
  if (!currentVerdict) return;
  try {
    await copyReadmeLine(currentVerdict);
    setActionStatus('Copied README badge line.');
  } catch {
    setActionStatus('Copy README line failed.');
  }
});

inject();

drawSheetTonerStreak();

const initialParam = new URLSearchParams(window.location.search).get('u');
if (initialParam) {
  const cleaned = initialParam.trim().replace(/^@+/, '');
  inputEl.value = cleaned;
  if (VALID_HANDLE_RE.test(cleaned)) {
    void bookHandle(cleaned, false);
  } else {
    clearCardForError(ERR_INVALID_HANDLE);
  }
} else {
  void renderBlankInitialCard();
}
