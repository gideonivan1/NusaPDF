'use client';

// Side-effect import: installs Uint8Array.toBase64/fromBase64, which pdf.js
// uses on the main thread and Chrome below ~140 does not have. Must come before
// pdf.js is loaded. The worker gets the same polyfill prepended at copy time.
import './uint8-polyfill';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import { NusaError } from '@/lib/errors';

/**
 * Rendering strategy (PRD §11 tradeoff, recorded here because it is not obvious):
 *
 * pdf.js already offloads *parsing* — the genuinely expensive part — to its own
 * bundled worker. Rasterisation needs a canvas and is GPU-accelerated, so it
 * stays on the calling thread but is driven one page at a time with an `await`
 * between pages, which yields to the event loop and keeps interaction alive.
 *
 * The operations that would actually freeze the UI (pdf-lib document surgery on
 * multi-hundred-page files) run in our own Comlink worker instead — see
 * `lib/pdf/client.ts`.
 */

/**
 * pdf.js touches DOM globals (`DOMMatrix`, `ImageData`) at module-evaluation
 * time, which crashes Next's prerender pass even inside a client component.
 * Importing it lazily keeps it out of the server bundle entirely; the promise
 * is memoised so the module still evaluates only once per tab.
 */
let pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null;

function loadPdfjs(): Promise<typeof import('pdfjs-dist')> {
  pdfjsPromise ??= import('pdfjs-dist').then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
    return pdfjs;
  });
  return pdfjsPromise;
}

export interface DocumentInfo {
  pageCount: number;
  /** false => scanned document => AI PDF must reject with E_SCANNED_NO_TEXT. */
  hasTextLayer: boolean;
  /** Intrinsic size of page 1 at scale 1, used to pick thumbnail dimensions. */
  firstPageAspect: number;
}

interface CachedDocument {
  doc: PDFDocumentProxy;
  /** In pdfjs v6 only the loading task can tear the parser worker down. */
  task: PDFDocumentLoadingTask;
}

const documentCache = new Map<string, CachedDocument>();

/**
 * pdf.js takes ownership of (and detaches) the buffer it is handed, so every
 * caller gets its own copy. Losing the original would break re-processing.
 */
function cloneBuffer(buffer: ArrayBuffer): Uint8Array {
  return new Uint8Array(buffer.slice(0));
}

export async function openDocument(id: string, file: File): Promise<DocumentInfo> {
  const existing = documentCache.get(id);
  if (existing) {
    const page = await existing.doc.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    return {
      pageCount: existing.doc.numPages,
      hasTextLayer: await detectTextLayer(existing.doc),
      firstPageAspect: viewport.width / viewport.height,
    };
  }

  const { getDocument } = await loadPdfjs();
  const buffer = await file.arrayBuffer();

  const task = getDocument({
    data: cloneBuffer(buffer),
    // Keeping these off avoids network fetches for standard fonts and keeps
    // the "nothing leaves your device" promise literally true.
    disableAutoFetch: true,
    disableStream: true,
  });

  let doc: PDFDocumentProxy;
  try {
    doc = await task.promise;
  } catch (error) {
    const name = (error as { name?: string })?.name;
    if (name === 'PasswordException') throw new NusaError('E_ENCRYPTED');
    if (name === 'InvalidPDFException') throw new NusaError('E_CORRUPT');
    throw new NusaError('E_CORRUPT', (error as Error)?.message);
  }

  documentCache.set(id, { doc, task });

  const page = await doc.getPage(1);
  const viewport = page.getViewport({ scale: 1 });

  return {
    pageCount: doc.numPages,
    hasTextLayer: await detectTextLayer(doc),
    firstPageAspect: viewport.width / viewport.height,
  };
}

/**
 * Samples up to three pages. A single blank page at the front is common in
 * scanned reports, so checking only page 1 produces false negatives.
 */
async function detectTextLayer(doc: PDFDocumentProxy): Promise<boolean> {
  const samples = [1, Math.ceil(doc.numPages / 2), doc.numPages].filter(
    (p, i, arr) => p >= 1 && p <= doc.numPages && arr.indexOf(p) === i,
  );

  for (const pageNumber of samples) {
    const page = await doc.getPage(pageNumber);
    const text = await page.getTextContent();
    const characters = text.items.reduce(
      (sum, item) => sum + ('str' in item ? item.str.trim().length : 0),
      0,
    );
    if (characters > 20) return true;
  }

  return false;
}

export interface RenderOptions {
  /** CSS-pixel width of the output. Height follows the page aspect ratio. */
  width: number;
  /** 0 | 90 | 180 | 270 — applied on top of the page's intrinsic rotation. */
  rotation?: number;
  signal?: AbortSignal;
}

/** Renders one page to a canvas and returns it as a blob. */
export async function renderPage(
  id: string,
  pageNumber: number,
  options: RenderOptions,
): Promise<Blob> {
  const cached = documentCache.get(id);
  if (!cached) throw new NusaError('E_UNKNOWN', `Dokumen ${id} belum dimuat`);
  const { doc } = cached;

  options.signal?.throwIfAborted();

  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1, rotation: options.rotation });
  const scale = options.width / base.width;
  const viewport = page.getViewport({ scale, rotation: options.rotation });

  // Cap the device pixel ratio: thumbnails at 3x on a phone burn memory for no
  // visible gain, and OOM on large documents is a real failure mode (PRD R6).
  const dpr = Math.min(globalThis.devicePixelRatio ?? 1, 2);

  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);

  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new NusaError('E_UNKNOWN', 'Canvas 2D tidak tersedia');

  context.scale(dpr, dpr);
  // Pages without their own background paint transparent; the warm canvas
  // colour would bleed through and make thumbnails look tinted.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, viewport.width, viewport.height);

  const task = page.render({ canvas, canvasContext: context, viewport });

  options.signal?.addEventListener('abort', () => task.cancel(), { once: true });

  try {
    await task.promise;
  } catch (error) {
    if ((error as { name?: string })?.name === 'RenderingCancelledException') {
      throw new NusaError('E_CANCELED');
    }
    throw error;
  }

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', 0.82),
  );

  // Release the backing store immediately rather than waiting for GC.
  canvas.width = 0;
  canvas.height = 0;

  if (!blob) throw new NusaError('E_OOM', 'Gagal membuat gambar halaman');
  return blob;
}

export interface PdfToImageOptions {
  format: 'image/jpeg' | 'image/png';
  /** 1 = 72dpi baseline. 2 ≈ 144dpi, the default for readable exports. */
  scale: number;
  quality: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

/** Renders the given 1-indexed pages to image blobs, yielding between pages. */
export async function pagesToImages(
  id: string,
  pageNumbers: number[],
  options: PdfToImageOptions,
): Promise<{ pageNumber: number; blob: Blob }[]> {
  const cached = documentCache.get(id);
  if (!cached) throw new NusaError('E_UNKNOWN', `Dokumen ${id} belum dimuat`);
  const { doc } = cached;

  const results: { pageNumber: number; blob: Blob }[] = [];
  const dpr = 1; // Export resolution is driven by `scale`, not the screen.

  for (const [index, pageNumber] of pageNumbers.entries()) {
    options.signal?.throwIfAborted();

    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: options.scale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);

    const context = canvas.getContext('2d', { alpha: options.format === 'image/png' });
    if (!context) throw new NusaError('E_UNKNOWN', 'Canvas 2D tidak tersedia');

    if (options.format === 'image/jpeg') {
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
    }

    try {
      await page.render({ canvas, canvasContext: context, viewport }).promise;
    } catch {
      canvas.width = 0;
      canvas.height = 0;
      throw new NusaError('E_OOM', `Gagal merender halaman ${pageNumber}`);
    }

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, options.format, options.quality),
    );

    canvas.width = 0;
    canvas.height = 0;

    if (!blob) throw new NusaError('E_OOM', `Gagal mengekspor halaman ${pageNumber}`);
    results.push({ pageNumber, blob });

    options.onProgress?.(index + 1, pageNumbers.length);

    // Hand the event loop back so the progress bar actually paints.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return results;
}

/* ==========================================================================
   Text extraction — feeds PDF to Word and PDF to Excel
   ========================================================================== */

interface PositionedItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

async function readItems(id: string, pageNumber: number): Promise<PositionedItem[]> {
  const cached = documentCache.get(id);
  if (!cached) throw new NusaError('E_UNKNOWN', `Dokumen ${id} belum dimuat`);

  const page = await cached.doc.getPage(pageNumber);
  const content = await page.getTextContent();

  const items: PositionedItem[] = [];

  for (const item of content.items) {
    if (!('str' in item) || item.str.trim() === '') continue;
    // transform = [scaleX, skewX, skewY, scaleY, translateX, translateY]
    const [, , , scaleY, x, y] = item.transform as number[];
    items.push({
      text: item.str,
      x,
      y,
      // pdf.js measures each fragment for us, which beats estimating from
      // character count when detecting the gaps that separate words.
      width: typeof item.width === 'number' ? item.width : item.str.length * 5,
      height: Math.abs(scaleY) || 10,
    });
  }

  return items;
}

/** Groups items sharing a baseline into lines, ordered top-to-bottom. */
function toLines(items: PositionedItem[]): PositionedItem[][] {
  if (items.length === 0) return [];

  const tolerance = Math.max(2, median(items.map((item) => item.height)) * 0.5);
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);

  const lines: PositionedItem[][] = [];
  let current: PositionedItem[] = [sorted[0]];

  for (const item of sorted.slice(1)) {
    if (Math.abs(item.y - current[0].y) <= tolerance) current.push(item);
    else {
      lines.push(current.sort((a, b) => a.x - b.x));
      current = [item];
    }
  }

  lines.push(current.sort((a, b) => a.x - b.x));
  return lines;
}

function median(values: number[]): number {
  if (values.length === 0) return 10;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function joinLine(line: PositionedItem[]): string {
  let text = '';
  let previousEnd: number | null = null;

  for (const item of line) {
    // pdf.js emits positioned fragments, not words. A gap wider than roughly a
    // quarter of the glyph height means a real space; without this, adjacent
    // fragments run together into "hargasatuan".
    if (previousEnd !== null && item.x - previousEnd > item.height * 0.25) text += ' ';
    text += item.text;
    previousEnd = item.x + item.width;
  }

  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Reconstructs paragraphs from a page.
 *
 * Lines are merged into a paragraph until the vertical gap grows noticeably
 * beyond the page's normal leading, which is the most reliable signal of a
 * paragraph break available without the original layout.
 */
export async function extractParagraphs(id: string, pageNumber: number): Promise<string[]> {
  const lines = toLines(await readItems(id, pageNumber));
  if (lines.length === 0) return [];

  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    gaps.push(Math.abs(lines[i - 1][0].y - lines[i][0].y));
  }

  const typicalGap = median(gaps.length > 0 ? gaps : [12]);
  const paragraphs: string[] = [];
  let buffer = joinLine(lines[0]);

  for (let i = 1; i < lines.length; i++) {
    const gap = Math.abs(lines[i - 1][0].y - lines[i][0].y);
    const text = joinLine(lines[i]);
    if (!text) continue;

    if (gap > typicalGap * 1.6) {
      if (buffer.trim()) paragraphs.push(buffer.trim());
      buffer = text;
    } else {
      // Rejoin words split by a hyphen at the line break.
      buffer = buffer.endsWith('-') ? buffer.slice(0, -1) + text : `${buffer} ${text}`;
    }
  }

  if (buffer.trim()) paragraphs.push(buffer.trim());
  return paragraphs;
}

/**
 * Reconstructs a page as a grid of cells.
 *
 * Column boundaries are inferred by clustering the left edge of every fragment
 * on the page: aligned text implies a column. This handles ruled and
 * space-aligned tables well; free-flowing prose degrades into one wide column,
 * which is the honest outcome rather than a wrong one.
 */
export async function extractTable(id: string, pageNumber: number): Promise<string[][]> {
  const items = await readItems(id, pageNumber);
  const lines = toLines(items);
  if (lines.length === 0) return [];

  const tolerance = Math.max(6, median(items.map((item) => item.height)) * 0.8);

  const anchors: number[] = [];
  for (const x of items.map((item) => item.x).sort((a, b) => a - b)) {
    if (anchors.length === 0 || x - anchors[anchors.length - 1] > tolerance) anchors.push(x);
  }

  return lines.map((line) => {
    const row: string[] = Array.from({ length: anchors.length }, () => '');

    for (const item of line) {
      let column = 0;
      let closest = Number.POSITIVE_INFINITY;

      for (const [index, anchor] of anchors.entries()) {
        const distance = Math.abs(item.x - anchor);
        if (distance < closest) {
          closest = distance;
          column = index;
        }
      }

      row[column] = row[column] ? `${row[column]} ${item.text.trim()}` : item.text.trim();
    }

    return row.map((cell) => cell.replace(/\s+/g, ' ').trim());
  });
}

export function closeDocument(id: string): void {
  const cached = documentCache.get(id);
  if (!cached) return;
  // Destroying the loading task also tears down the parser worker; calling
  // cleanup() alone would leave that worker alive for the tab's lifetime.
  void cached.task.destroy();
  documentCache.delete(id);
}

export function closeAllDocuments(): void {
  for (const id of [...documentCache.keys()]) closeDocument(id);
}
