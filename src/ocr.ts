/**
 * In-browser OCR + finding-to-box mapping.
 *
 * Uses tesseract.js (WebAssembly) so images NEVER leave the device. The only
 * network traffic is tesseract downloading its engine and language model to run
 * locally. We keep a single shared worker for the whole session.
 *
 * The OCR output gives us, per line, the text and the word bounding boxes. The
 * detector engine (detectors.ts) works purely on text and returns char spans
 * per line. Here we map each finding's char span back to the covering word
 * boxes and produce a pixel rectangle for redaction.
 */

import { createWorker } from "tesseract.js";
import type { Worker } from "tesseract.js";
import { scanLine, ssnContextByLine, type Finding } from "./detectors";

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface WordBox {
  text: string;
  bbox: Box;
}

export interface OcrFinding extends Finding {
  box: Box; // pixel rectangle covering the secret's words
}

let workerPromise: Promise<Worker> | null = null;

/** Lazily create (and reuse) a single tesseract worker. */
export function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = createWorker("eng");
  }
  return workerPromise;
}

export async function terminateWorker(): Promise<void> {
  if (workerPromise) {
    const w = await workerPromise;
    await w.terminate();
    workerPromise = null;
  }
}

/**
 * Given a line's text, its word boxes, and a detector char span [start, end),
 * return the bounding box covering the words overlapping that span.
 *
 * We reconstruct the same "words joined by single spaces" text tesseract gives
 * us for a line, track each word's char offset in that text, and union the
 * boxes of words whose char range intersects the finding span.
 */
export function boxForSpan(
  words: WordBox[],
  start: number,
  end: number,
): Box | null {
  let cursor = 0;
  const covering: Box[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const wStart = cursor;
    const wEnd = cursor + w.text.length;
    // Overlap test between [wStart, wEnd) and [start, end).
    if (!(wEnd <= start || wStart >= end)) {
      covering.push(w.bbox);
    }
    cursor = wEnd + 1; // +1 for the single space separator
  }
  if (covering.length === 0) return null;
  return covering.reduce((acc, b) => ({
    x0: Math.min(acc.x0, b.x0),
    y0: Math.min(acc.y0, b.y0),
    x1: Math.max(acc.x1, b.x1),
    y1: Math.max(acc.y1, b.y1),
  }));
}

interface TesseractWord {
  text: string;
  bbox: Box;
}
interface TesseractLine {
  text: string;
  words: TesseractWord[];
}

// Retina screenshots are commonly 2880-3456px wide; tesseract at that size can
// take minutes per image. Text is still cleanly readable to the engine around
// this width, and OCR time drops to seconds.
const MAX_OCR_DIM = 1500;

/** Load an object/blob URL into an HTMLImageElement. */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load image"));
    img.src = url;
  });
}

/**
 * If the image exceeds MAX_OCR_DIM, draw it onto a smaller canvas for OCR.
 * Returns the OCR source plus the factor to scale boxes back to natural pixels.
 */
function downscaleForOcr(img: HTMLImageElement): {
  source: HTMLImageElement | HTMLCanvasElement;
  scaleBack: number;
} {
  const maxDim = Math.max(img.naturalWidth, img.naturalHeight);
  if (maxDim <= MAX_OCR_DIM) return { source: img, scaleBack: 1 };
  const scale = MAX_OCR_DIM / maxDim;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return { source: img, scaleBack: 1 };
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return { source: canvas, scaleBack: 1 / scale };
}

/**
 * Run OCR on an image URL and return findings with pixel boxes in the image's
 * natural resolution. Large images are downscaled before OCR (huge speedup)
 * and boxes are scaled back up.
 */
export async function scanImage(url: string): Promise<OcrFinding[]> {
  const img = await loadImage(url);
  const { source, scaleBack } = downscaleForOcr(img);
  const worker = await getWorker();
  const { data } = await worker.recognize(
    source as never,
    {},
    { blocks: true },
  );

  // tesseract.js v7 exposes lines under data.blocks[].paragraphs[].lines[] and
  // also a flat data.lines in some builds. Normalize to a flat line list.
  const lines: TesseractLine[] = collectLines(data);

  const results: OcrFinding[] = [];
  // Precompute each line's scan text so SSN keyword context can look across
  // neighboring lines (forms put "Social Security Number" and the value on
  // separate lines).
  const lineData = lines.map((line) => {
    const words: WordBox[] = (line.words ?? []).map((w) => ({
      text: w.text,
      bbox: w.bbox,
    }));
    // Join words by a single space. This matches boxForSpan's cursor math and
    // is close to line.text.
    const lineText = words.map((w) => w.text).join(" ");
    return { words, textToScan: lineText || line.text || "" };
  });
  const ssnContext = ssnContextByLine(lineData.map((l) => l.textToScan));

  for (let i = 0; i < lineData.length; i++) {
    const { words, textToScan } = lineData[i];
    const findings = scanLine(textToScan, { ssnContext: ssnContext[i] });
    for (const f of findings) {
      const box = boxForSpan(words, f.start, f.end);
      if (box) {
        results.push({
          ...f,
          box: {
            x0: box.x0 * scaleBack,
            y0: box.y0 * scaleBack,
            x1: box.x1 * scaleBack,
            y1: box.y1 * scaleBack,
          },
        });
      }
    }
  }
  return results;
}

// Walk the tesseract result structure to a flat list of lines with words.
function collectLines(data: unknown): TesseractLine[] {
  const out: TesseractLine[] = [];
  const d = data as {
    lines?: TesseractLine[];
    blocks?: {
      paragraphs?: { lines?: TesseractLine[] }[];
    }[];
  };
  if (Array.isArray(d.lines) && d.lines.length) {
    return d.lines;
  }
  if (Array.isArray(d.blocks)) {
    for (const block of d.blocks) {
      for (const para of block.paragraphs ?? []) {
        for (const line of para.lines ?? []) {
          out.push(line);
        }
      }
    }
  }
  return out;
}
