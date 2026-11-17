/**
 * Deterministic hashing and PRNG utilities for Subpoena.
 * Ensures the same GitHub handle always maps to the same officer, case number, and noir lines.
 */

export function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^@+/, '').toLowerCase();
}

/**
 * FNV-1a 32-bit unsigned hash.
 */
export function hashString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function hashHandle(handle: string, salt = ''): number {
  const normalized = normalizeHandle(handle);
  return hashString(salt ? `${normalized}:${salt}` : normalized);
}

/**
 * Mulberry32 deterministic PRNG returning values in [0, 1).
 */
export function createRng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministically picks one entry from a non-empty array using the handle and optional salt.
 */
export function pickByHandle<T>(items: readonly T[], handle: string, salt = ''): T {
  if (items.length === 0) {
    throw new Error('Cannot pick from an empty array.');
  }
  const idx = hashHandle(handle, salt) % items.length;
  return items[idx] as T;
}
