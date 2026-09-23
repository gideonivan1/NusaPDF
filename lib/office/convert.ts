'use client';

import { NusaError } from '@/lib/errors';
import { extractParagraphs, extractTable, getLoadedDocument, pagesToImages } from '@/lib/pdf/render';
import { convertPdfToDocx, type CanvasBackend } from './pdf-to-docx';
import {
  A4_LANDSCAPE,
  A4_PORTRAIT,
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
 * PDF to Word is the exception that keeps layout as well: it rebuilds the
 * page from the PDF's drawing operations (lib/office/pdf-to-docx), so fonts,
 * spacing, tables, pictures, and pagination come across. The other directions
 * deliver **content fidelity, not layout fidelity**: text, structure, and
 * tabular data survive; original pagination, fonts, and decorative styling do
 * not. The UI states each tool's limit plainly rather than implying a
 * pixel-perfect clone (PRD risk R1).
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

export async function wordToPdf(file: File, onProgress?: Progress): Promise<Blob> {
  const mammoth = await import('mammoth');

  onProgress?.(0, 3, 'Membaca dokumen Word…');

  let html: string;
  try {
    const result = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
    html = result.value;
  } catch (error) {
    throw new NusaError(
      'E_CORRUPT',
      error instanceof Error ? error.message : 'Dokumen Word tidak dapat dibaca',
    );
  }

  onProgress?.(1, 3, 'Menata ulang isi…');
  const blocks = htmlToBlocks(html);

  if (blocks.length === 0) throw new NusaError('E_CORRUPT', 'Dokumen tidak memuat teks');

  onProgress?.(2, 3, 'Menyusun PDF…');
  const bytes = await renderBlocksToPdf(blocks, {
    page: A4_PORTRAIT,
    baseSize: 11,
    pageNumbers: true,
  });

  onProgress?.(3, 3);
  return new Blob([bytes as BlobPart], { type: 'application/pdf' });
}

/** Maps the subset of HTML that mammoth emits onto layout blocks. */
function htmlToBlocks(html: string): Block[] {
  const document = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const blocks: Block[] = [];

  /**
   * Word puts most images inside a paragraph, so an element has to be checked
   * for images *and* text. Handling only one of the two is what made pictures
   * disappear from converted documents: `<p>` was read with `textContent`,
   * which silently discards any `<img>` it contains.
   */
  const pushImage = (image: Element) => {
    const src = image.getAttribute('src');
    // mammoth inlines images as base64 data URIs; anything else would be a
    // remote reference we deliberately will not fetch.
    if (!src?.startsWith('data:')) return;
    blocks.push({
      type: 'image',
      dataUrl: src,
      alt: image.getAttribute('alt') ?? undefined,
    });
  };

  const emitImagesWithin = (container: Element) => {
    for (const image of Array.from(container.querySelectorAll('img'))) pushImage(image);
  };

  const walk = (node: Element) => {
    for (const child of Array.from(node.children)) {
      const tag = child.tagName.toLowerCase();

      switch (tag) {
        case 'h1':
        case 'h2':
        case 'h3':
        case 'h4':
        case 'h5':
        case 'h6': {
          const level = Math.min(3, Number(tag[1])) as 1 | 2 | 3;
          const text = child.textContent?.trim();
          if (text) blocks.push({ type: 'heading', level, text });
          break;
        }

        case 'img': {
          pushImage(child);
          break;
        }

        case 'p': {
          emitImagesWithin(child);
          const text = child.textContent?.trim();
          if (text) blocks.push({ type: 'paragraph', text });
          break;
        }

        case 'ul':
        case 'ol': {
          const items = Array.from(child.querySelectorAll(':scope > li'))
            .map((li) => li.textContent?.trim() ?? '')
            .filter(Boolean);
          if (items.length > 0) blocks.push({ type: 'list', ordered: tag === 'ol', items });
          break;
        }

        case 'table': {
          const rows = Array.from(child.querySelectorAll('tr')).map((tr) =>
            Array.from(tr.querySelectorAll('th, td')).map(
              (cell) => cell.textContent?.trim() ?? '',
            ),
          );
          const hasHeader = child.querySelector('th') !== null;
          if (rows.length > 0) blocks.push({ type: 'table', rows, headerRow: hasHeader });
          break;
        }

        default:
          // Wrappers such as <div> carry no meaning here; descend into them.
          walk(child);
      }
    }
  };

  walk(document.body);
  return blocks;
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
