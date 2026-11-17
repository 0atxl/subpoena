import { CARD_HEIGHT, CARD_WIDTH } from '../canvas/paper.js';
import { normalizeHandle } from '../engine/hash.js';

/** Mobile Safari caps total canvas backing pixel area around 16.7M pixels (4096x4096). */
export const MAX_SAFARI_CANVAS_AREA = 16_777_216;

export function clampCanvasArea(
  width: number,
  height: number,
  maxArea: number = MAX_SAFARI_CANVAS_AREA,
): { width: number; height: number } {
  const area = width * height;
  if (area <= 0 || area <= maxArea) {
    return { width, height };
  }
  const scale = Math.sqrt(maxArea / area);
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}

function createExportSurface(
  sourceCanvas: HTMLCanvasElement,
): HTMLCanvasElement {
  const target = clampCanvasArea(CARD_WIDTH, CARD_HEIGHT);
  if (
    sourceCanvas.width === target.width &&
    sourceCanvas.height === target.height
  ) {
    return sourceCanvas;
  }
  const copy = sourceCanvas.ownerDocument.createElement('canvas');
  copy.width = target.width;
  copy.height = target.height;
  const ctx = copy.getContext('2d');
  if (!ctx) {
    throw new Error('Cannot acquire 2D context for PNG export.');
  }
  ctx.drawImage(sourceCanvas, 0, 0, target.width, target.height);
  return copy;
}

export function canvasToPngBlob(sourceCanvas: HTMLCanvasElement): Promise<Blob> {
  const exportCanvas = createExportSurface(sourceCanvas);
  return new Promise((resolve, reject) => {
    exportCanvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('PNG export failed (canvas may be tainted or empty).'));
        return;
      }
      resolve(blob);
    }, 'image/png');
  });
}

export async function downloadCardPng(
  sourceCanvas: HTMLCanvasElement,
  handle: string,
): Promise<void> {
  const blob = await canvasToPngBlob(sourceCanvas);
  const safeName = normalizeHandle(handle).replace(/[^a-z0-9_-]/g, '') || 'suspect';
  const url = URL.createObjectURL(blob);
  try {
    const a = sourceCanvas.ownerDocument.createElement('a');
    a.href = url;
    a.download = `subpoena-${safeName}.png`;
    sourceCanvas.ownerDocument.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Allow browser click dispatch to resolve before revoking object URL
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
