'use client';

import { NusaError } from '@/lib/errors';
import { extractParagraphs, extractTable, getLoadedDocument, pagesToImages } from '@/lib/pdf/render';
import { convertPdfToDocx, type CanvasBackend } from './pdf-to-docx';
import {
  A4_LANDSCAPE,
  renderBlocksToPdf,
  sanitise,
  type Block,
  type PageSetup,
} from './pdf-writer';
import { readDeck } from './pptx';
import { readWorkbook, writeWorkbook, type Sheet } from './xlsx';

/**
 * Office conversions, all running in the browser.
 *
 * The alternative — LibreOffice in a container, or a paid conversion API —
 * gives higher layout fidelity but breaks the product's central promise that
 * files are not uploaded, and needs infrastructure that does not exist here.
 *
 * PDF to Word and Word to PDF keep the layout as well as the content. PDF to
 * Word rebuilds pages from the PDF's drawing operations (lib/office/pdf-to-docx);
 * Word to PDF typesets the document the way Word does, with metric-identical
 * open fonts (lib/office/docx-to-pdf). The remaining directions deliver
 * **content fidelity, not layout fidelity**: text, structure, and tabular data
 * survive; original pagination, fonts, and decorative styling do not. The UI
 * states each tool's limit plainly rather than implying a pixel-perfect clone
 * (PRD risk R1).
 *
 * Each heavy library is imported dynamically so it only downloads when the
 * matching tool is actually opened.
 */

export type Progress = (done: number, total: number, label?: string) => void;

/* ==========================================================================
   PDF -> Word
   ========================================================================== */

/**
 * Canvas backend for the figure rasteriser: plain <canvas>, encoded in-page.
 * Nothing here touches the network.
 */
const browserCanvas: CanvasBackend = {
  create(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  },
  encode(canvas, format, quality) {
    return new Promise((resolve, reject) => {
      (canvas as HTMLCanvasElement).toBlob(
        (blob) => {
          if (!blob) {
            reject(new NusaError('E_OOM', 'Gagal menyalin gambar halaman'));
            return;
          }
          void blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject);
        },
        format === 'png' ? 'image/png' : 'image/jpeg',
        quality,
      );
    });
  },
};

/**
 * Rebuilds the PDF as an editable Word document that keeps its layout: real
 * paragraphs with their fonts, spacing, indents and alignment; real tables
 * with merged cells, borders and shading; pictures where they were; and the
 * repeating footer as a Word footer. See lib/office/pdf-to-docx for how.
 */
export async function pdfToWord(
  docId: string,
  pageNumbers: number[],
  onProgress?: Progress,
  signal?: AbortSignal,
): Promise<Blob> {
  const [docx, { doc, OPS }] = await Promise.all([import('docx'), getLoadedDocument(docId)]);

  const { document } = await convertPdfToDocx(doc, pageNumbers, {
    pdfjsOps: OPS,
    docx,
    canvas: browserCanvas,
    onProgress,
    signal,
  });

  onProgress?.(1, 1, 'Menyusun dokumen Word…');
  return docx.Packer.toBlob(document);
}

/* ==========================================================================
   PDF -> PowerPoint
   ========================================================================== */

/**
 * `gambar` keeps the page exactly as it looks but the text is not editable;
 * `teks` gives editable text boxes but discards the original layout. There is
 * no option that delivers both without a real layout engine, so the choice is
 * handed to the person who knows which one they need.
 */
export type SlideMode = 'gambar' | 'teks';

export async function pdfToPowerpoint(
  docId: string,
  pageNumbers: number[],
  mode: SlideMode = 'gambar',
  onProgress?: Progress,
): Promise<Blob> {
  const PptxGenJS = (await import('pptxgenjs')).default;

  if (mode === 'teks') return pdfToPowerpointText(PptxGenJS, docId, pageNumbers, onProgress);

  const images = await pagesToImages(docId, pageNumbers, {
    format: 'image/jpeg',
    scale: 2,
    quality: 0.85,
    onProgress: (done, total) => onProgress?.(done, total, `Merender halaman ${done}/${total}…`),
  });

  const pptx = new PptxGenJS();
  pptx.author = 'NusaPDF';
  pptx.layout = 'LAYOUT_16x9';

  const SLIDE_WIDTH = 10;
  const SLIDE_HEIGHT = 5.625;

  for (const image of images) {
    const dataUrl = await blobToDataUrl(image.blob);
    const { width, height } = await imageSize(dataUrl);

    // Fit inside the slide without distorting the page's aspect ratio.
    const scale = Math.min(SLIDE_WIDTH / width, SLIDE_HEIGHT / height);
    const drawWidth = width * scale;
    const drawHeight = height * scale;

    const slide = pptx.addSlide();
    slide.background = { color: 'FFFFFF' };
    slide.addImage({
      data: dataUrl,
      x: (SLIDE_WIDTH - drawWidth) / 2,
      y: (SLIDE_HEIGHT - drawHeight) / 2,
      w: drawWidth,
      h: drawHeight,
    });
  }

  onProgress?.(images.length, images.length, 'Menyusun presentasi…');

  const output = await pptx.write({ outputType: 'blob' });
  return output as Blob;
}

/**
 * Text mode: each page becomes a slide whose first paragraph is the title and
 * the rest are bullets. Nothing about the original layout survives — this is
 * for decks people intend to rewrite, not to mirror.
 */
async function pdfToPowerpointText(
  PptxGenJS: typeof import('pptxgenjs').default,
  docId: string,
  pageNumbers: number[],
  onProgress?: Progress,
): Promise<Blob> {
  const pptx = new PptxGenJS();
  pptx.author = 'NusaPDF';
  pptx.layout = 'LAYOUT_16x9';

  for (const [index, pageNumber] of pageNumbers.entries()) {
    onProgress?.(index, pageNumbers.length, `Mengambil teks halaman ${pageNumber}…`);

    const paragraphs = await extractParagraphs(docId, pageNumber);
    const slide = pptx.addSlide();
    slide.background = { color: 'FFFFFF' };

    if (paragraphs.length === 0) {
      slide.addText(`Halaman ${pageNumber} tidak memuat teks`, {
        x: 0.6, y: 0.5, w: 8.8, h: 0.8, fontSize: 16, color: '696969', italic: true,
      });
      continue;
    }

    const [title, ...rest] = paragraphs;

    slide.addText(title.slice(0, 180), {
      x: 0.6, y: 0.4, w: 8.8, h: 0.9,
      fontSize: 22, bold: true, color: '141413', valign: 'top',
    });

    if (rest.length > 0) {
      slide.addText(
        // A page of prose can far exceed one slide; capping keeps the text
        // inside the frame instead of silently overflowing off-slide.
        rest.slice(0, 8).map((text) => ({ text: text.slice(0, 300), options: { bullet: true } })),
        { x: 0.6, y: 1.5, w: 8.8, h: 3.6, fontSize: 13, color: '555555', valign: 'top' },
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  onProgress?.(pageNumbers.length, pageNumbers.length, 'Menyusun presentasi…');
  return (await pptx.write({ outputType: 'blob' })) as Blob;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new NusaError('E_UNKNOWN', 'Gagal membaca gambar halaman'));
    reader.readAsDataURL(blob);
  });
}

function imageSize(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new NusaError('E_UNKNOWN', 'Gambar halaman tidak valid'));
    image.src = dataUrl;
  });
}

/* ==========================================================================
   PDF -> Excel
   ========================================================================== */

export async function pdfToExcel(
  docId: string,
  pageNumbers: number[],
  onProgress?: Progress,
): Promise<Blob> {
  const sheets: Sheet[] = [];

  for (const [index, pageNumber] of pageNumbers.entries()) {
    onProgress?.(index, pageNumbers.length, `Menganalisis tata letak halaman ${pageNumber}…`);

    const rows = await extractTable(docId, pageNumber);
    const meaningful = rows.filter((row) => row.some((cell) => cell !== ''));

    sheets.push({
      name: `Halaman ${pageNumber}`,
      rows: meaningful.length > 0 ? meaningful : [['(halaman tanpa teks)']],
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  onProgress?.(pageNumbers.length, pageNumbers.length, 'Menyusun lembar kerja…');
  return writeWorkbook(sheets);
}

/* ==========================================================================
   Word -> PDF
   ========================================================================== */

/** Fonts are static files under /fonts, fetched only when a document needs them. */
async function fetchFont(file: string): Promise<Uint8Array> {
  const response = await fetch(`/fonts/${file}`);
  if (!response.ok) throw new NusaError('E_NETWORK', `Huruf ${file} gagal dimuat`);
  return new Uint8Array(await response.arrayBuffer());
}

/** GIF, BMP, and the like go through a canvas to become PNG, which PDF can hold. */
async function imageToPng(image: { data: Uint8Array; mime: string }): Promise<{ data: Uint8Array; type: 'png' } | null> {
  if (!/^image\/(gif|bmp|webp|tiff?)$/.test(image.mime)) return null;
  try {
    const bitmap = await createImageBitmap(new Blob([image.data as BlobPart], { type: image.mime }));
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    canvas.width = 0;
    canvas.height = 0;
    return blob ? { data: new Uint8Array(await blob.arrayBuffer()), type: 'png' } : null;
  } catch {
    return null;
  }
}

/**
 * Typesets the document the way Word does and draws it to PDF: its fonts
 * (through metric-identical open substitutes), spacing, numbering, tables,
 * pictures, shapes, and footers. See lib/office/docx-to-pdf for how.
 */
export async function wordToPdf(file: File, onProgress?: Progress): Promise<Blob> {
  const { convertDocxToPdf } = await import('./docx-to-pdf');

  let bytes: Uint8Array;
  try {
    bytes = await convertDocxToPdf(await file.arrayBuffer(), {
      loadFont: fetchFont,
      convertImage: imageToPng,
      onProgress,
    });
  } catch (error) {
    if (error instanceof NusaError) throw error;
    throw new NusaError('E_CORRUPT', error instanceof Error ? error.message : 'Dokumen Word tidak dapat dibaca');
  }

  return new Blob([bytes as BlobPart], { type: 'application/pdf' });
}

/* ==========================================================================
   PowerPoint -> PDF
   ========================================================================== */

export async function powerpointToPdf(file: File, onProgress?: Progress): Promise<Blob> {
  onProgress?.(0, 2, 'Membaca presentasi…');

  const deck = readDeck(await file.arrayBuffer());
  const blocks: Block[] = [];

  deck.slides.forEach((slide, index) => {
    if (index > 0) blocks.push({ type: 'pagebreak' });

    blocks.push({ type: 'heading', level: 3, text: `Slide ${slide.index}` });

    if (slide.shapes.length === 0) {
      blocks.push({ type: 'paragraph', text: '(slide tanpa teks)' });
      return;
    }

    // The topmost shape is the title in virtually every deck layout.
    const [title, ...rest] = slide.shapes;
    blocks.push({ type: 'heading', level: 1, text: title.lines.join(' ') });

    for (const shape of rest) {
      if (shape.lines.length > 1) {
        blocks.push({ type: 'list', ordered: false, items: shape.lines });
      } else {
        blocks.push({ type: 'paragraph', text: shape.lines[0] });
      }
    }
  });

  onProgress?.(1, 2, 'Menyusun PDF…');

  // Match the deck's own aspect ratio so slides are not letterboxed.
  const page: PageSetup = {
    width: deck.widthPt,
    height: deck.heightPt,
    margin: Math.round(deck.widthPt * 0.06),
  };

  const bytes = await renderBlocksToPdf(blocks, { page, baseSize: 14, pageNumbers: true });

  onProgress?.(2, 2);
  return new Blob([bytes as BlobPart], { type: 'application/pdf' });
}

/* ==========================================================================
   Excel -> PDF
   ========================================================================== */

export async function excelToPdf(file: File, onProgress?: Progress): Promise<Blob> {
  onProgress?.(0, 2, 'Membaca lembar kerja…');

  const sheets = readWorkbook(await file.arrayBuffer());
  const blocks: Block[] = [];

  sheets.forEach((sheet, index) => {
    const rows = sheet.rows.filter((row) => row.some((cell) => cell !== ''));
    if (rows.length === 0) return;

    if (index > 0) blocks.push({ type: 'pagebreak' });
    blocks.push({ type: 'heading', level: 2, text: sanitise(sheet.name) });
    // The first row is treated as a header: that is the overwhelmingly common
    // shape for spreadsheets people convert.
    blocks.push({ type: 'table', rows, headerRow: true });
  });

  if (blocks.length === 0) throw new NusaError('E_CORRUPT', 'Lembar kerja kosong');

  onProgress?.(1, 2, 'Menyusun PDF…');

  const bytes = await renderBlocksToPdf(blocks, {
    // Spreadsheets are wider than they are tall.
    page: A4_LANDSCAPE,
    baseSize: 10,
    pageNumbers: true,
  });

  onProgress?.(2, 2);
  return new Blob([bytes as BlobPart], { type: 'application/pdf' });
}
