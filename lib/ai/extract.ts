import 'server-only';

/**
 * Server-side PDF text extraction and chunking for the RAG index.
 *
 * Runs on the pdfjs *legacy* build, which is the one that works under Node —
 * the default build assumes DOM globals. Extraction happens here rather than in
 * the browser so the indexed text is derived from the file the server actually
 * stored, not from something a client reported.
 */

export interface PageText {
  pageNumber: number;
  text: string;
}

export interface Chunk {
  pageNumber: number;
  chunkIndex: number;
  content: string;
}

/** ~1200 chars ≈ 300 tokens: enough for a full argument, small enough to rank. */
const CHUNK_TARGET = 1200;
const CHUNK_OVERLAP = 200;
const MIN_CHUNK = 80;

let pdfjsPromise: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> | null = null;

function loadPdfjs() {
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

export async function extractPageTexts(data: Uint8Array): Promise<PageText[]> {
  const pdfjs = await loadPdfjs();

  const task = pdfjs.getDocument({
    data,
    // No rendering happens here, so skip the font machinery entirely.
    disableFontFace: true,
    useSystemFonts: false,
  });

  const doc = await task.promise;
  const pages: PageText[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();

      // pdfjs emits positioned fragments, not sentences. `hasEOL` is the only
      // signal for a real line break; without honouring it, words from adjacent
      // lines run together and wreck both chunking and retrieval quality.
      let text = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        text += item.str;
        if (item.hasEOL) text += '\n';
        else if (!item.str.endsWith(' ')) text += ' ';
      }

      pages.push({ pageNumber, text: normalise(text) });
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }

  return pages;
}

function normalise(text: string): string {
  return text
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Splits page text into overlapping chunks, never merging across pages.
 *
 * Keeping the page boundary intact is what makes `[hal. N]` citations exact: a
 * chunk that spanned pages 6 and 7 could only ever be attributed to one of them.
 */
export function chunkPages(pages: PageText[]): Chunk[] {
  const chunks: Chunk[] = [];
  let chunkIndex = 0;

  for (const page of pages) {
    if (page.text.length < MIN_CHUNK) continue;

    for (const piece of splitText(page.text)) {
      chunks.push({ pageNumber: page.pageNumber, chunkIndex: chunkIndex++, content: piece });
    }
  }

  return chunks;
}

function splitText(text: string): string[] {
  if (text.length <= CHUNK_TARGET) return [text];

  const pieces: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + CHUNK_TARGET, text.length);

    if (end < text.length) {
      // Prefer to break at a sentence end, then a line break, then a space —
      // anywhere but mid-word.
      const window = text.slice(start, end);
      const candidates = [
        window.lastIndexOf('. '),
        window.lastIndexOf('.\n'),
        window.lastIndexOf('\n'),
        window.lastIndexOf(' '),
      ].filter((index) => index > CHUNK_TARGET * 0.5);

      if (candidates.length > 0) end = start + Math.max(...candidates) + 1;
    }

    const piece = text.slice(start, end).trim();
    if (piece.length >= MIN_CHUNK) pieces.push(piece);

    if (end >= text.length) break;
    start = Math.max(start + 1, end - CHUNK_OVERLAP);
  }

  return pieces;
}

/** Cheap heuristic used only for logging and budget guards. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
