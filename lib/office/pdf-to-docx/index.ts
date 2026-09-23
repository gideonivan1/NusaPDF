/**
 * PDF to Word, end to end: read each page's primitives, reconstruct layout,
 * rasterise the figures, and assemble the .docx.
 *
 * Environment-neutral. The caller supplies the pdf.js document, the `docx`
 * module, and a canvas backend — the browser passes `<canvas>`, the
 * verification script passes @napi-rs/canvas — so the conversion users get is
 * byte-for-byte the conversion the tests check.
 */

import type * as Docx from 'docx';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { readPageContent, type OpsTable, type PageContent } from '@/lib/pdf/page-content';
import { analyzeDocument } from './layout';
import type { Block, DocumentModel, FigureBlock } from './model';
import { buildDocx, type RasterImage } from './write-docx';

export type { DocumentModel } from './model';

/** The slice of a 2D canvas this module needs, satisfied by DOM and Node canvases. */
export interface CanvasLike {
  width: number;
  height: number;
  getContext(type: '2d'): unknown;
}

export interface CanvasBackend {
  create(width: number, height: number): CanvasLike;
  encode(canvas: CanvasLike, format: 'jpeg' | 'png', quality: number): Promise<Uint8Array>;
}

export interface PdfToDocxOptions {
  pdfjsOps: OpsTable;
  docx: typeof Docx;
  canvas: CanvasBackend;
  onProgress?: (done: number, total: number, label?: string) => void;
  signal?: AbortSignal;
}

/** Longest edge of a page render. Keeps a 3× A4 render (~1800 × 2500) within reach of phones. */
const MAX_RENDER_EDGE = 3000;

export async function convertPdfToDocx(
  pdf: PDFDocumentProxy,
  pageNumbers: number[],
  options: PdfToDocxOptions,
): Promise<{ document: Docx.Document; model: DocumentModel }> {
  const total = pageNumbers.length * 2 + 1;
  let step = 0;
  const tick = (label: string) => options.onProgress?.(++step, total, label);

  const contents: PageContent[] = [];
  for (const pageNumber of pageNumbers) {
    options.signal?.throwIfAborted();
    const page = await pdf.getPage(pageNumber);
    contents.push(await readPageContent(page, options.pdfjsOps));
    tick(`Membaca tata letak halaman ${pageNumber}…`);
    await yieldToEventLoop();
  }

  const model = analyzeDocument(contents);

  const images = new Map<FigureBlock, RasterImage>();
  for (const pageModel of model.pages) {
    options.signal?.throwIfAborted();
    const figures = collectFigures(pageModel.blocks);
    if (figures.length > 0) {
      const page = await pdf.getPage(pageModel.pageNumber);
      const rendered = await rasterise(page, figures, options.canvas);
      rendered.forEach((image, index) => images.set(figures[index], image));
    }
    tick(`Menyalin gambar halaman ${pageModel.pageNumber}…`);
    await yieldToEventLoop();
  }

  const document = buildDocx(model, images, options.docx);
  tick('Menyusun dokumen Word…');
  return { document, model };
}

function collectFigures(blocks: Block[]): FigureBlock[] {
  const out: FigureBlock[] = [];
  for (const block of blocks) {
    if (block.kind === 'figure') out.push(block);
    else if (block.kind === 'table') {
      for (const row of block.rows) for (const cell of row.cells) out.push(...collectFigures(cell.blocks));
    }
  }
  return out;
}

/**
 * Renders the page once at the sharpest scale any of its figures needs, then
 * cuts each figure out of that render.
 *
 * Cropping a render rather than extracting the embedded image streams is
 * deliberate: it reproduces exactly what the reader saw — masks, colour
 * spaces, clipping, overlapping pictures, and drawn shapes with their labels
 * all come out right, where raw streams would need each of those rebuilt.
 */
async function rasterise(
  page: PDFPageProxy,
  figures: FigureBlock[],
  backend: CanvasBackend,
): Promise<RasterImage[]> {
  const base = page.getViewport({ scale: 1 });
  const wanted = Math.max(...figures.map((figure) => figure.scale));
  const scale = Math.min(wanted, MAX_RENDER_EDGE / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale });

  const canvas = backend.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const context = canvas.getContext('2d') as CanvasRenderingContext2D;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);

  await page.render({
    canvas: canvas as unknown as HTMLCanvasElement,
    canvasContext: context,
    viewport,
  }).promise;

  const out: RasterImage[] = [];
  for (const figure of figures) {
    const sx = Math.max(0, Math.floor(figure.rect.x0 * scale));
    const sy = Math.max(0, Math.floor(figure.rect.y0 * scale));
    const sw = Math.max(1, Math.min(canvas.width - sx, Math.ceil((figure.rect.x1 - figure.rect.x0) * scale)));
    const sh = Math.max(1, Math.min(canvas.height - sy, Math.ceil((figure.rect.y1 - figure.rect.y0) * scale)));

    const crop = backend.create(sw, sh);
    const cropContext = crop.getContext('2d') as CanvasRenderingContext2D;
    cropContext.drawImage(canvas as unknown as CanvasImageSource, sx, sy, sw, sh, 0, 0, sw, sh);

    const data = await backend.encode(crop, figure.format, 0.9);
    out.push({ data, type: figure.format === 'png' ? 'png' : 'jpg' });

    crop.width = 0;
    crop.height = 0;
  }

  canvas.width = 0;
  canvas.height = 0;
  return out;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
