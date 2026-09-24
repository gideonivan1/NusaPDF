/**
 * PowerPoint to PDF, end to end, in the browser: read the .pptx, load the
 * fonts its text uses, lay every slide out, and draw it with pdf-lib — one
 * page per slide, at the deck's own size.
 *
 * Environment-neutral like the Word converter: the caller supplies how font
 * files are fetched and how formats pdf-lib cannot embed become PNG.
 */

import { PDFDocument } from 'pdf-lib';
import { FontSet, type Face, type FontLoader } from '../docx-to-pdf/fonts';
import { renderPages, type ImageConverter, type ImageResampler } from '../docx-to-pdf/render';
import { readPptx, type Deck, type TextBody } from './deck';
import { layoutDeck, metafilesOf } from './layout';

export interface PptxToPdfOptions {
  loadFont: FontLoader;
  convertImage?: ImageConverter;
  /** Scales oversized pictures down (the browser, through <canvas>). */
  resampleImage?: ImageResampler;
  onProgress?: (done: number, total: number, label?: string) => void;
}

const key = (font: string, bold: boolean, italic: boolean) => `${font.trim().toLowerCase()}|${bold ? 1 : 0}|${italic ? 1 : 0}`;

/** Every font, weight, and style the deck's text asks for. */
function fontsOf(deck: Deck): [string, boolean, boolean][] {
  const seen = new Map<string, [string, boolean, boolean]>();
  const add = (font: string, bold: boolean, italic: boolean) => seen.set(key(font, bold, italic), [font, bold, italic]);
  const body = (text: TextBody | undefined) => {
    for (const paragraph of text?.paragraphs ?? []) {
      for (const run of [...paragraph.runs, paragraph.end]) add(run.font, run.bold, run.italic);
      const first = paragraph.runs.find((run) => run.text) ?? paragraph.end;
      if (paragraph.bullet.kind === 'char') add(paragraph.bullet.font ?? first.font, false, false);
      if (paragraph.bullet.kind === 'number') add(first.font, first.bold, false);
    }
  };
  const metafiles = metafilesOf(deck);
  for (const slide of deck.slides) {
    for (const element of slide.elements) {
      if (element.kind === 'picture') for (const [font, bold, italic] of metafiles(element.image)?.fonts() ?? []) add(font, bold, italic);
      if (element.kind === 'shape') body(element.text);
      else if (element.kind === 'table') for (const row of element.rows) for (const cell of row.cells) body(cell.text);
    }
  }
  return [...seen.values()];
}

export async function convertPptxToPdf(buffer: ArrayBuffer, options: PptxToPdfOptions): Promise<Uint8Array> {
  const { onProgress } = options;
  onProgress?.(0, 3, 'Membaca presentasi…');
  const deck = readPptx(buffer);
  if (deck.slides.length === 0) throw new Error('Presentasi tidak berisi slide');

  const pdf = await PDFDocument.create();
  const fontkit = (await import('@pdf-lib/fontkit')).default;
  pdf.registerFontkit(fontkit);
  const fonts = new FontSet(pdf, options.loadFont, fontkit as never);

  onProgress?.(1, 3, 'Memuat huruf…');
  const faces = new Map<string, Face>();
  for (const [font, bold, italic] of fontsOf(deck)) faces.set(key(font, bold, italic), await fonts.get(font, bold, italic));
  const fallback = faces.values().next().value ?? (await fonts.get('Arial', false, false));

  onProgress?.(2, 3, 'Menata slide…');
  const pages = layoutDeck(deck, (font, bold, italic) => faces.get(key(font, bold, italic)) ?? fallback);

  await renderPages(
    pdf,
    pages,
    deck.images,
    options.convertImage,
    (index) => onProgress?.(2 + (index + 1) / pages.length, 3, `Menggambar slide ${index + 1}…`),
    options.resampleImage,
  );
  onProgress?.(3, 3);
  return pdf.save({ useObjectStreams: true });
}
