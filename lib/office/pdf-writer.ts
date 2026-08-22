import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

/**
 * A small text-layout engine over pdf-lib, shared by the three
 * "something → PDF" conversions.
 *
 * pdf-lib draws text at coordinates; it has no concept of flow, wrapping, or
 * pagination. Everything below exists to turn a linear list of blocks into
 * paginated output.
 */

export type Block =
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'table'; rows: string[][]; headerRow: boolean }
  /** `dataUrl` must be a PNG or JPEG data URI — the only formats pdf-lib embeds. */
  | { type: 'image'; dataUrl: string; alt?: string }
  | { type: 'spacer'; height: number }
  | { type: 'pagebreak' };

export interface PageSetup {
  width: number;
  height: number;
  margin: number;
}

export const A4_PORTRAIT: PageSetup = { width: 595.28, height: 841.89, margin: 56 };
export const A4_LANDSCAPE: PageSetup = { width: 841.89, height: 595.28, margin: 56 };

export interface RenderOptions {
  page?: PageSetup;
  baseSize?: number;
  title?: string;
  /** Draws "N / total" at the foot of every page. */
  pageNumbers?: boolean;
  onProgress?: (done: number, total: number) => void;
}

/**
 * The standard PDF fonts are WinAnsi-encoded, and pdf-lib throws on any
 * character outside that set rather than substituting. Since the input is an
 * arbitrary user document, unmapped characters must be handled explicitly —
 * otherwise a single typographic quote fails the whole conversion.
 */
const REPLACEMENTS: Record<string, string> = {
  '‘': "'", '’': "'", '‚': ',', '‛': "'",
  '“': '"', '”': '"', '„': '"',
  '–': '-', '—': '-', '―': '-', '−': '-',
  '…': '...', '•': '-', '·': '-', '●': '-', '◦': '-',
  ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', '​': '',
  '™': '(TM)', '≥': '>=', '≤': '<=', '≠': '!=',
  '\t': '    ',
};

export function sanitise(text: string): string {
  let result = '';

  for (const character of text) {
    const replacement = REPLACEMENTS[character];
    if (replacement !== undefined) {
      result += replacement;
      continue;
    }

    const code = character.codePointAt(0) ?? 0;
    // Printable ASCII and Latin-1 both encode cleanly in WinAnsi.
    if (code === 10 || (code >= 32 && code <= 126) || (code >= 160 && code <= 255)) {
      result += character;
    } else {
      result += '?';
    }
  }

  return result;
}

interface Context {
  doc: PDFDocument;
  regular: PDFFont;
  bold: PDFFont;
  setup: PageSetup;
  page: PDFPage;
  cursor: number;
  pages: PDFPage[];
}

const INK = rgb(0.078, 0.078, 0.075); // Ink Black #141413
const MUTED = rgb(0.41, 0.41, 0.41); // Granite #555555
const RULE = rgb(0.82, 0.805, 0.78); // Dust Taupe #D1CDC7
const HEADER_FILL = rgb(0.953, 0.941, 0.933); // Canvas Cream #F3F0EE

export async function renderBlocksToPdf(
  blocks: Block[],
  options: RenderOptions = {},
): Promise<Uint8Array> {
  const setup = options.page ?? A4_PORTRAIT;
  const base = options.baseSize ?? 11;

  const doc = await PDFDocument.create();
  const context: Context = {
    doc,
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    setup,
    page: doc.addPage([setup.width, setup.height]),
    cursor: setup.height - setup.margin,
    pages: [],
  };
  context.pages.push(context.page);

  if (options.title) {
    drawWrapped(context, sanitise(options.title), context.bold, base + 9, base + 13, INK);
    context.cursor -= base;
  }

  for (const [index, block] of blocks.entries()) {
    await renderBlock(context, block, base);
    options.onProgress?.(index + 1, blocks.length);
  }

  if (options.pageNumbers) drawPageNumbers(context, base);

  doc.setProducer('NusaPDF');
  doc.setCreator('NusaPDF');
  if (options.title) doc.setTitle(options.title);

  return doc.save({ useObjectStreams: true });
}

/** Decodes a `data:` URI into bytes and its media type. */
function decodeDataUrl(dataUrl: string): { bytes: Uint8Array; mime: string } | null {
  const match = dataUrl.match(/^data:([^;,]+)(;base64)?,(.*)$/s);
  if (!match) return null;

  const [, mime, isBase64, payload] = match;

  try {
    if (!isBase64) {
      return { bytes: new TextEncoder().encode(decodeURIComponent(payload)), mime };
    }
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { bytes, mime };
  } catch {
    return null;
  }
}

/**
 * Draws an embedded image, scaled to the text column.
 *
 * Word documents carry images as PNG or JPEG in the common case, but also EMF
 * and WMF (pasted charts and shapes), which pdf-lib cannot embed. Those are
 * skipped with a visible placeholder rather than silently dropped — a reader
 * who sees nothing assumes the converter lost their content, whereas a marked
 * gap tells them exactly what happened.
 */
async function renderImage(
  context: Context,
  block: Extract<Block, { type: 'image' }>,
  base: number,
): Promise<void> {
  const decoded = decodeDataUrl(block.dataUrl);
  const usable = context.setup.width - context.setup.margin * 2;

  const placeholder = (reason: string) => {
    drawWrapped(context, sanitise(`[${reason}]`), context.regular, base - 1, base * 1.4, MUTED);
    context.cursor -= base * 0.4;
  };

  if (!decoded) return placeholder('gambar tidak dapat dibaca');

  const isPng = decoded.mime.includes('png');
  const isJpeg = /jpe?g/.test(decoded.mime);

  if (!isPng && !isJpeg) {
    return placeholder(`gambar ${decoded.mime.replace('image/', '')} tidak didukung`);
  }

  let embedded;
  try {
    embedded = isPng
      ? await context.doc.embedPng(decoded.bytes)
      : await context.doc.embedJpg(decoded.bytes);
  } catch {
    return placeholder('gambar tidak dapat disisipkan');
  }

  // Never upscale past native resolution, and never exceed half a page in
  // height or a single figure would push everything else off the page.
  const maxHeight = (context.setup.height - context.setup.margin * 2) * 0.55;
  const scale = Math.min(usable / embedded.width, maxHeight / embedded.height, 1);
  const width = embedded.width * scale;
  const height = embedded.height * scale;

  ensureSpace(context, height + base);

  context.page.drawImage(embedded, {
    x: context.setup.margin + (usable - width) / 2,
    y: context.cursor - height,
    width,
    height,
  });

  context.cursor -= height + base * 0.6;
}

// Async only because image embedding is; every other block is synchronous.
async function renderBlock(context: Context, block: Block, base: number): Promise<void> {
  switch (block.type) {
    case 'image':
      await renderImage(context, block, base);
      return;

    case 'pagebreak':
      newPage(context);
      return;

    case 'spacer':
      context.cursor -= block.height;
      return;

    case 'heading': {
      const size = block.level === 1 ? base + 7 : block.level === 2 ? base + 4 : base + 2;
      context.cursor -= base * 0.8;
      // Never leave a heading stranded at the foot of a page.
      ensureSpace(context, size * 3);
      drawWrapped(context, sanitise(block.text), context.bold, size, size * 1.25, INK);
      context.cursor -= base * 0.3;
      return;
    }

    case 'paragraph': {
      const text = sanitise(block.text).trim();
      if (!text) {
        context.cursor -= base * 0.5;
        return;
      }
      drawWrapped(context, text, context.regular, base, base * 1.45, INK);
      context.cursor -= base * 0.5;
      return;
    }

    case 'list': {
      for (const [index, item] of block.items.entries()) {
        const marker = block.ordered ? `${index + 1}.` : '-';
        drawWrapped(
          context,
          `${marker} ${sanitise(item)}`,
          context.regular,
          base,
          base * 1.4,
          INK,
          base * 1.4,
        );
      }
      context.cursor -= base * 0.5;
      return;
    }

    case 'table':
      renderTable(context, block, base);
      return;
  }
}

/* -------------------------------------------------------------- text flow -- */

function drawWrapped(
  context: Context,
  text: string,
  font: PDFFont,
  size: number,
  lineHeight: number,
  colour: ReturnType<typeof rgb>,
  hangingIndent = 0,
): void {
  const usable = context.setup.width - context.setup.margin * 2;

  for (const paragraph of text.split('\n')) {
    const lines = wrapText(paragraph, font, size, usable - hangingIndent);

    for (const [index, line] of lines.entries()) {
      ensureSpace(context, lineHeight);
      context.page.drawText(line, {
        x: context.setup.margin + (index > 0 ? hangingIndent : 0),
        y: context.cursor - size,
        size,
        font,
        color: colour,
      });
      context.cursor -= lineHeight;
    }
  }
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  if (!text) return [''];

  const lines: string[] = [];
  let current = '';

  for (const word of text.split(/\s+/)) {
    const candidate = current ? `${current} ${word}` : word;

    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }

    if (current) lines.push(current);

    // A single word longer than the line (a URL, a long identifier) has to be
    // broken mid-word or it would overflow the page silently.
    if (font.widthOfTextAtSize(word, size) > maxWidth) {
      let chunk = '';
      for (const character of word) {
        if (font.widthOfTextAtSize(chunk + character, size) > maxWidth) {
          lines.push(chunk);
          chunk = character;
        } else {
          chunk += character;
        }
      }
      current = chunk;
    } else {
      current = word;
    }
  }

  if (current) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

function ensureSpace(context: Context, needed: number): void {
  if (context.cursor - needed < context.setup.margin) newPage(context);
}

function newPage(context: Context): void {
  context.page = context.doc.addPage([context.setup.width, context.setup.height]);
  context.pages.push(context.page);
  context.cursor = context.setup.height - context.setup.margin;
}

/* ------------------------------------------------------------------ tables -- */

/**
 * Draws a table with a real grid.
 *
 * The first version drew a single rule under the header and nothing else, so a
 * Word table arrived as loosely aligned columns of text — readers saw it as
 * "the table disappeared", because a table without its frame does not read as a
 * table at all. Every cell now gets ruled edges, and the header repeats when a
 * table spans pages so the columns stay identifiable.
 */
function renderTable(context: Context, block: Extract<Block, { type: 'table' }>, base: number) {
  const rows = block.rows.filter((row) => row.length > 0);
  if (rows.length === 0) return;

  const columnCount = Math.max(...rows.map((row) => row.length));
  const usable = context.setup.width - context.setup.margin * 2;

  // Shrink type rather than clipping when a sheet has many columns — a
  // spreadsheet that renders unreadably small is still more useful than one
  // with its right-hand columns missing.
  const size = columnCount > 12 ? base - 3 : columnCount > 8 ? base - 2 : base - 1;
  const widths = columnWidths(context, rows, columnCount, usable, size);
  const lineHeight = size * 1.3;
  const padding = 5;

  /** Left edge of every column plus the closing right edge. */
  const edges = [context.setup.margin];
  for (const width of widths) edges.push(edges[edges.length - 1] + width);

  const header = block.headerRow ? rows[0] : null;
  const body = block.headerRow ? rows.slice(1) : rows;

  const measure = (row: string[], font: PDFFont) =>
    Array.from({ length: columnCount }, (_, column) =>
      wrapText(sanitise(row[column] ?? ''), font, size, widths[column] - padding * 2),
    );

  const heightOf = (cellLines: string[][]) =>
    Math.max(...cellLines.map((lines) => lines.length)) * lineHeight + padding * 2 - lineHeight + size;

  /** Draws one row's text plus its own cell borders, and advances the cursor. */
  const drawRow = (row: string[], isHeader: boolean) => {
    const font = isHeader ? context.bold : context.regular;
    const cellLines = measure(row, font);
    const rowHeight = heightOf(cellLines);

    const top = context.cursor;
    const bottom = top - rowHeight;

    if (isHeader) {
      // A tinted band is what makes the header read as a header even in
      // greyscale printing.
      context.page.drawRectangle({
        x: edges[0],
        y: bottom,
        width: usable,
        height: rowHeight,
        color: HEADER_FILL,
      });
    }

    cellLines.forEach((lines, column) => {
      let y = top - padding - size;
      for (const line of lines) {
        context.page.drawText(line, {
          x: edges[column] + padding,
          y,
          size,
          font,
          color: isHeader ? INK : MUTED,
        });
        y -= lineHeight;
      }
    });

    // Cell edges: verticals for every boundary, plus the row's own baseline.
    for (const x of edges) {
      context.page.drawLine({
        start: { x, y: top },
        end: { x, y: bottom },
        thickness: 0.6,
        color: RULE,
      });
    }

    context.page.drawLine({
      start: { x: edges[0], y: bottom },
      end: { x: edges[edges.length - 1], y: bottom },
      thickness: isHeader ? 0.9 : 0.6,
      color: RULE,
    });

    context.cursor = bottom;
  };

  /** Top edge of the table on the current page. */
  const capTop = () => {
    context.page.drawLine({
      start: { x: edges[0], y: context.cursor },
      end: { x: edges[edges.length - 1], y: context.cursor },
      thickness: 0.9,
      color: RULE,
    });
  };

  const headerHeight = header ? heightOf(measure(header, context.bold)) : 0;

  ensureSpace(context, headerHeight + lineHeight * 2);
  capTop();
  if (header) drawRow(header, true);

  for (const row of body) {
    const needed = heightOf(measure(row, context.regular));

    // A row that will not fit starts a new page — and the header goes with it,
    // otherwise the continuation is a grid of unlabelled numbers.
    if (context.cursor - needed < context.setup.margin) {
      newPage(context);
      capTop();
      if (header) drawRow(header, true);
    }

    drawRow(row, false);
  }

  context.cursor -= base * 0.6;
}

/**
 * Widths proportional to the widest content in each column, clamped so one
 * verbose column cannot squeeze the others to nothing.
 */
function columnWidths(
  context: Context,
  rows: string[][],
  columnCount: number,
  usable: number,
  size: number,
): number[] {
  const natural = Array.from({ length: columnCount }, (_, column) => {
    let widest = 0;
    // Sampling caps the cost on very tall sheets; the first rows are
    // representative in practice.
    for (const row of rows.slice(0, 200)) {
      const width = context.regular.widthOfTextAtSize(sanitise(row[column] ?? ''), size);
      if (width > widest) widest = width;
    }
    return Math.max(28, Math.min(widest + 10, usable * 0.4));
  });

  const total = natural.reduce((sum, width) => sum + width, 0);
  const scale = usable / total;
  return natural.map((width) => width * scale);
}

function drawPageNumbers(context: Context, base: number): void {
  const total = context.pages.length;

  context.pages.forEach((page, index) => {
    const label = `${index + 1} / ${total}`;
    const size = base - 3;
    const width = context.regular.widthOfTextAtSize(label, size);
    page.drawText(label, {
      x: (context.setup.width - width) / 2,
      y: context.setup.margin / 2,
      size,
      font: context.regular,
      color: MUTED,
    });
  });
}
