import type { VerdictReport } from '../engine/charges.js';
import { normalizeHandle } from '../engine/hash.js';
import { canvasToPngBlob } from './export-png.js';

export function buildShareUrl(handle: string, baseHref?: string): string {
  const clean = normalizeHandle(handle);
  const current =
    baseHref ??
    (typeof window !== 'undefined' ? window.location.href : 'http://localhost/');
  const url = new URL(current);
  url.hash = '';
  url.search = '';
  if (clean) {
    url.searchParams.set('u', clean);
  }
  return url.toString();
}

export function canCopyImage(): boolean {
  return (
    typeof ClipboardItem !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.clipboard?.write === 'function'
  );
}

export async function copyCardImage(canvas: HTMLCanvasElement): Promise<void> {
  if (!canCopyImage()) {
    throw new Error('Clipboard image copy is not supported in this browser.');
  }
  const blob = await canvasToPngBlob(canvas);
  const item = new ClipboardItem({ 'image/png': blob });
  await navigator.clipboard.write([item]);
}

export async function copyCardLink(
  handle: string,
  baseHref?: string,
): Promise<string> {
  const url = buildShareUrl(handle, baseHref);
  await navigator.clipboard.writeText(url);
  return url;
}

export function formatXPostText(
  verdict: VerdictReport,
  baseHref?: string,
): string {
  const url = buildShareUrl(verdict.handle, baseHref);
  if (verdict.verdict === 'RECORD SEALED') {
    return `SUBPOENA // @${verdict.handle}: RECORD SEALED.\n${url}`;
  }
  if (verdict.verdict === 'ACQUITTED') {
    return `SUBPOENA // @${verdict.handle}: ACQUITTED (NO CHARGES FILED — bail $0). Suspiciously clean.\n${url}`;
  }
  if (verdict.verdict === 'INSUFFICIENT EVIDENCE') {
    return `SUBPOENA // @${verdict.handle}: INSUFFICIENT EVIDENCE (${verdict.alibi?.receipt ?? 'partial record on file'})\n${url}`;
  }
  const top = verdict.charges[0];
  const topLine = top ? `${top.label} — ${top.receipt}` : 'Priors on file.';
  return `SUBPOENA // @${verdict.handle}: ${verdict.verdict} (BAIL: ${verdict.bail})\n${topLine}\n${url}`;
}

export async function copyXPost(
  verdict: VerdictReport,
  baseHref?: string,
): Promise<string> {
  const text = formatXPostText(verdict, baseHref);
  await navigator.clipboard.writeText(text);
  return text;
}

export function formatReadmeLine(
  verdict: VerdictReport,
  baseHref?: string,
): string {
  const url = buildShareUrl(verdict.handle, baseHref);
  if (verdict.verdict === 'RECORD SEALED') {
    const badgeText = encodeURIComponent('RECORD SEALED');
    return `[![Subpoena: RECORD SEALED](https://img.shields.io/badge/SUBPOENA-${badgeText}-a3322a?style=flat-square&labelColor=17150f)](${url})`;
  }
  if (verdict.verdict === 'ACQUITTED') {
    return `[![Subpoena: ACQUITTED](https://img.shields.io/badge/SUBPOENA-ACQUITTED-a3322a?style=flat-square&labelColor=17150f)](${url})`;
  }
  if (verdict.verdict === 'INSUFFICIENT EVIDENCE') {
    const badgeText = encodeURIComponent('INSUFFICIENT EVIDENCE');
    return `[![Subpoena: INSUFFICIENT EVIDENCE](https://img.shields.io/badge/SUBPOENA-${badgeText}-a3322a?style=flat-square&labelColor=17150f)](${url})`;
  }
  const badgeText = encodeURIComponent(`${verdict.verdict} | BAIL ${verdict.bail}`);
  return `[![Subpoena: ${verdict.verdict}](https://img.shields.io/badge/SUBPOENA-${badgeText}-a3322a?style=flat-square&labelColor=17150f)](${url})`;
}

export async function copyReadmeLine(
  verdict: VerdictReport,
  baseHref?: string,
): Promise<string> {
  const line = formatReadmeLine(verdict, baseHref);
  await navigator.clipboard.writeText(line);
  return line;
}
