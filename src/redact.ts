/**
 * Canvas-based drawing of finding boxes and redaction export. All client-side.
 */

import type { OcrFinding } from "./ocr";

const HIGH_COLOR = "#ef4444"; // red-500
const MEDIUM_COLOR = "#f59e0b"; // amber-500

/**
 * Draw an image into a canvas at natural resolution, then overlay outline boxes
 * for each finding (red for HIGH, amber for MEDIUM). If `highlightIndex` is set,
 * that finding is drawn thicker/filled to show which one is selected.
 */
export function drawOverlay(
  canvas: HTMLCanvasElement,
  img: HTMLImageElement,
  findings: OcrFinding[],
  highlightIndex: number | null,
): void {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.drawImage(img, 0, 0, w, h);

  const pad = Math.max(2, Math.round(w * 0.004));
  findings.forEach((f, i) => {
    const color = f.tier === "high" ? HIGH_COLOR : MEDIUM_COLOR;
    const x = f.box.x0 - pad;
    const y = f.box.y0 - pad;
    const bw = f.box.x1 - f.box.x0 + pad * 2;
    const bh = f.box.y1 - f.box.y0 + pad * 2;
    ctx.lineWidth = i === highlightIndex ? pad * 2.5 : pad;
    ctx.strokeStyle = color;
    if (i === highlightIndex) {
      ctx.fillStyle = color + "33"; // ~20% alpha
      ctx.fillRect(x, y, bw, bh);
    }
    ctx.strokeRect(x, y, bw, bh);
  });
}

/**
 * Paint opaque black boxes over the given findings, flatten, and return a data
 * URL for download. Used by "Redact all HIGH & download".
 */
export function redactToDataUrl(
  img: HTMLImageElement,
  findings: OcrFinding[],
): string {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.drawImage(img, 0, 0, w, h);
  const pad = Math.max(2, Math.round(w * 0.004));
  ctx.fillStyle = "#000000";
  for (const f of findings) {
    ctx.fillRect(
      f.box.x0 - pad,
      f.box.y0 - pad,
      f.box.x1 - f.box.x0 + pad * 2,
      f.box.y1 - f.box.y0 + pad * 2,
    );
  }
  return canvas.toDataURL("image/png");
}

export function triggerDownload(dataUrl: string, filename: string): void {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
