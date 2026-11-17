/**
 * Pluggable font-loading adapters so shared `draw()` runs identically in
 * browsers (`document.fonts`) and server functions (`@napi-rs/canvas` `GlobalFonts`).
 */

export type FontLoader = () => Promise<void> | void;

const REQUIRED_BROWSER_FACES: ReadonlyArray<{
  descriptor: string;
  label: string;
}> = [
  { descriptor: '400 16px "Courier Prime"', label: 'Courier Prime Regular' },
  { descriptor: '700 16px "Courier Prime"', label: 'Courier Prime Bold' },
  { descriptor: '400 24px "Reenie Beanie"', label: 'Reenie Beanie' },
];

/**
 * Browser adapter: loads Courier Prime (400, 700) and Reenie Beanie (400) via
 * `document.fonts.load` and throws loudly if any face is unavailable.
 */
export async function browserFontLoader(): Promise<void> {
  if (typeof document === 'undefined' || !('fonts' in document) || !document.fonts) {
    throw new Error('document.fonts API is unavailable; cannot load card fonts.');
  }

  const results = await Promise.all(
    REQUIRED_BROWSER_FACES.map(async ({ descriptor, label }) => {
      const loaded = await document.fonts.load(descriptor);
      const checked = document.fonts.check(descriptor);
      return { descriptor, label, loadedCount: loaded.length, checked };
    }),
  );

  for (const res of results) {
    if (res.loadedCount === 0 || !res.checked) {
      throw new Error(
        `Required font failed to load: ${res.label} (${res.descriptor}).`,
      );
    }
  }
}

export interface FontRegistrationSpec {
  path: string;
  family: string;
}

export interface GlobalFontsLike {
  registerFromPath(path: string, nameAlias?: string): unknown;
}

/**
 * Server adapter for `@napi-rs/canvas`: registers bundled font files via
 * `GlobalFonts.registerFromPath` and throws loudly if any registration fails.
 */
export function createNodeFontLoader(
  globalFonts: GlobalFontsLike,
  specs: ReadonlyArray<FontRegistrationSpec>,
): FontLoader {
  let registered = false;
  return () => {
    if (registered) return;
    for (const spec of specs) {
      const ok = globalFonts.registerFromPath(spec.path, spec.family);
      if (!ok) {
        throw new Error(
          `Failed to register server font "${spec.family}" from ${spec.path}`,
        );
      }
    }
    registered = true;
  };
}
