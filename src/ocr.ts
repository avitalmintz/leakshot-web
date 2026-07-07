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
import { scanLine, type Finding } from "./detectors";

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

/**
 * Run OCR on an image source and return findings with pixel boxes. `source` is
 * anything tesseract accepts (an image URL / File / HTMLImageElement / canvas).
 */
export async function scanImage(
  source: string | File | HTMLImageElement | HTMLCanvasElement,
): Promise<OcrFinding[]> {
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
  for (const line of lines) {
    // Build the line text the way we track word offsets: join words by a single
    // space. This matches boxForSpan's cursor math and is close to line.text.
    const words: WordBox[] = (line.words ?? []).map((w) => ({
      text: w.text,
      bbox: w.bbox,
    }));
    const lineText = words.map((w) => w.text).join(" ");
    const textToScan = lineText || line.text || "";
    const findings = scanLine(textToScan);
    for (const f of findings) {
      const box = boxForSpan(words, f.start, f.end);
      if (box) {
        results.push({ ...f, box });
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
