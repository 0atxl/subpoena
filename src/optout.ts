import type { GitHubBundle } from '../api/presets.js';

/** Contact address shown in the page footer for opt-out removal requests. */
export const OPT_OUT_CONTACT = 'hello@atulk.me';

export function getOptOutContactHref(
  contact: string = OPT_OUT_CONTACT,
): string {
  const trimmed = contact.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.includes('@')) return `mailto:${trimmed}`;
  return `https://${trimmed}`;
}

/**
 * Lowercase GitHub handles whose dossiers are permanently sealed.
 * Entries should be stored lowercase without leading "@".
 */
export const OPT_OUT_HANDLES: readonly string[] = ['sealed-suspect'];

const OPT_OUT_SET = new Set(
  OPT_OUT_HANDLES.map((h) => h.trim().replace(/^@+/, '').toLowerCase()).filter(
    Boolean,
  ),
);

function normalizeOptOutKey(rawHandle: string): string {
  return rawHandle.trim().replace(/^@+/, '');
}

export function isOptedOut(rawHandle: string): boolean {
  const normalized = normalizeOptOutKey(rawHandle).toLowerCase();
  return normalized.length > 0 && OPT_OUT_SET.has(normalized);
}

export function makeSealedBundle(
  rawHandle: string,
  now: Date = new Date(),
): GitHubBundle {
  const clean = normalizeOptOutKey(rawHandle) || 'sealed';
  return {
    handle: clean,
    fetchedAt: now.toISOString(),
    preset: false,
    sealed: true,
    user: null,
    repos: [],
    events: [],
    commits: null,
    missing: {},
  };
}
