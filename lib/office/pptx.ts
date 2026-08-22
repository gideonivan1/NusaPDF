import { findAll, listEntries, openArchive, parseXml, readText } from './ooxml';

export interface SlideShape {
  /** Paragraph lines belonging to one text frame, in document order. */
  lines: string[];
  /** Vertical position in EMU, used only to order shapes on the slide. */
  top: number;
}

export interface Slide {
  index: number;
  shapes: SlideShape[];
}

export interface Deck {
  slides: Slide[];
  /** Slide dimensions in points, so the PDF page can match the aspect ratio. */
  widthPt: number;
  heightPt: number;
}

/** OOXML measures in English Metric Units: 914400 per inch, 72 points per inch. */
const EMU_PER_POINT = 12700;
const DEFAULT_WIDTH_PT = 960; // 13.33in — the 16:9 default
const DEFAULT_HEIGHT_PT = 540;

/**
 * Extracts slide text from a .pptx.
 *
 * This reads the text layer only — shape geometry, themes, gradients, and
 * embedded media are not reconstructed. Faithful pptx rendering needs a real
 * layout engine; what this gives is the content, laid out readably.
 */
export function readDeck(buffer: ArrayBuffer): Deck {
  const archive = openArchive(buffer);

  const presentationXml = readText(archive, 'ppt/presentation.xml');
  if (!presentationXml) throw new Error('Bukan berkas PowerPoint (.pptx) yang valid');

  const { widthPt, heightPt } = readSlideSize(presentationXml);

  const slidePaths = listEntries(archive, 'ppt/slides/slide', '.xml');
  if (slidePaths.length === 0) throw new Error('Tidak ada slide yang dapat dibaca');

  const slides: Slide[] = [];

  for (const [index, path] of slidePaths.entries()) {
    const xml = readText(archive, path);
    if (!xml) continue;
    slides.push({ index: index + 1, shapes: readSlideShapes(xml) });
  }

  return { slides, widthPt, heightPt };
}

function readSlideSize(xml: string): { widthPt: number; heightPt: number } {
  try {
    const size = findAll(parseXml(xml).documentElement, 'sldSz')[0];
    const cx = Number(size?.getAttribute('cx'));
    const cy = Number(size?.getAttribute('cy'));

    if (Number.isFinite(cx) && Number.isFinite(cy) && cx > 0 && cy > 0) {
      return { widthPt: cx / EMU_PER_POINT, heightPt: cy / EMU_PER_POINT };
    }
  } catch {
    // Fall through to the 16:9 default.
  }

  return { widthPt: DEFAULT_WIDTH_PT, heightPt: DEFAULT_HEIGHT_PT };
}

function readSlideShapes(xml: string): SlideShape[] {
  const slide = parseXml(xml);
  const shapes: SlideShape[] = [];

  for (const shape of findAll(slide.documentElement, 'sp')) {
    const paragraphs = findAll(shape, 'p');
    const lines: string[] = [];

    for (const paragraph of paragraphs) {
      // A paragraph's text is split across <a:r> runs whenever formatting
      // changes mid-sentence, so the runs must be joined before use.
      const text = findAll(paragraph, 't')
        .map((node) => node.textContent ?? '')
        .join('')
        .trim();

      if (text) lines.push(text);
    }

    if (lines.length === 0) continue;

    shapes.push({ lines, top: readOffsetY(shape) });
  }

  // Author order in the XML follows z-order, not reading order; sorting by
  // vertical position puts the title above the body where it belongs.
  return shapes.sort((a, b) => a.top - b.top);
}

function readOffsetY(shape: Element): number {
  const offset = findAll(shape, 'off')[0];
  const y = Number(offset?.getAttribute('y'));
  return Number.isFinite(y) ? y : Number.MAX_SAFE_INTEGER;
}
