/**
 * Word to PDF, end to end, in the browser: read the .docx, load the fonts it
 * needs, typeset it the way Word does, and draw it with pdf-lib.
 *
 * Environment-neutral — the caller supplies how font files are fetched and
 * (optionally) how to turn formats pdf-lib cannot embed into PNG. The browser
 * fetches fonts from /fonts and converts through <canvas>; the verification
 * scripts read them from disk.
 */

import { PDFDocument } from 'pdf-lib';
import { readDocx, type Block, type DocxDocument, type Shape } from './document';
import { FontSet, type Face, type FontLoader } from './fonts';
import { faceKey, Typesetter } from './layout';
import { renderPages, type ImageConverter, type ImageResampler } from './render';
import type { RunProps } from './styles';

export type { FontLoader } from './fonts';
export type { ImageConverter, ImageResampler } from './render';

export interface DocxToPdfOptions {
  loadFont: FontLoader;
  convertImage?: ImageConverter;
  /** Scales oversized pictures down (the browser, through <canvas>). */
  resampleImage?: ImageResampler;
  onProgress?: (done: number, total: number, label?: string) => void;
}

/** Every set of run properties that will need a font, so all load up front. */
function collectRunProps(doc: DocxDocument): RunProps[] {
  const out: RunProps[] = [];
  const shapes = (list: Shape[]) => {
    for (const shape of list) if (shape.kind === 'box' && shape.text) blocks(shape.text.blocks);
  };
  const blocks = (list: Block[]) => {
    for (const block of list) {
      if (block.kind === 'table') {
        for (const row of block.rows) for (const cell of row.cells) blocks(cell.blocks);
        continue;
      }
      out.push(block.mark);
      if (block.label) out.push(block.label.props);
      for (const inline of block.inlines) {
        if (inline.kind === 'anchor') shapes(inline.anchor.shapes);
        else if (inline.kind !== 'image') out.push(inline.props);
        else out.push(inline.props);
      }
    }
  };
  for (const section of doc.sections) {
    blocks(section.blocks);
    for (const part of [...Object.values(section.headers), ...Object.values(section.footers)]) blocks(part ?? []);
  }
  return out;
}

export async function convertDocxToPdf(buffer: ArrayBuffer, options: DocxToPdfOptions): Promise<Uint8Array> {
  const progress = options.onProgress;
  progress?.(0, 4, 'Membaca dokumen Word…');
  const doc = readDocx(buffer);

  const pdf = await PDFDocument.create();
  const fontkit = (await import('@pdf-lib/fontkit')).default;
  pdf.registerFontkit(fontkit);
  pdf.setProducer('NusaPDF');
  pdf.setCreator('NusaPDF');

  progress?.(1, 4, 'Memuat huruf…');
  const fonts = new FontSet(pdf, options.loadFont, fontkit as never);
  const needed = new Map<string, RunProps>();
  for (const props of collectRunProps(doc)) {
    const key = faceKey(props, doc);
    if (!needed.has(key)) needed.set(key, props);
  }
  const faces = new Map<string, Face>();
  await Promise.all(
    [...needed.entries()].map(async ([key, props]) => {
      const name = props.font ?? (props.fontTheme?.startsWith('major') ? doc.theme.majorFont : doc.theme.minorFont);
      faces.set(key, await fonts.get(name, Boolean(props.bold), Boolean(props.italic)));
    }),
  );
  const fallback = faces.values().next().value ?? (await fonts.get('Arial', false, false));

  progress?.(2, 4, 'Menata halaman…');
  const typesetter = new Typesetter({
    doc,
    face: (props) => faces.get(faceKey(props, doc)) ?? fallback,
  });
  typesetter.run();
  const pages = typesetter.finishPages();

  progress?.(3, 4, 'Menyusun PDF…');
  await renderPages(pdf, pages, doc.images, options.convertImage, undefined, options.resampleImage);

  const bytes = await pdf.save({ useObjectStreams: true });
  progress?.(4, 4);
  return bytes;
}
