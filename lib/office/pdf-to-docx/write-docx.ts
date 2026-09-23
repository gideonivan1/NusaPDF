/**
 * Turns the layout model into a Word document that lands every element where
 * the PDF had it.
 *
 * Word has no absolute positioning for flowing content, so position is
 * reproduced the way a careful typist would: exact line spacing measured from
 * the PDF, and paragraph spacing computed from the gap to the element above.
 * The constants below were measured against Word itself rather than taken
 * from the specification — see `WORD_BASELINE` in particular.
 *
 * `docx` is passed in rather than imported so the browser can keep loading it
 * lazily, only when this tool is opened.
 */

import type * as Docx from 'docx';
import type {
  Block,
  Border,
  DocumentModel,
  FigureBlock,
  FooterModel,
  ParagraphBlock,
  StyledRun,
  TableBlock,
  TableCell,
} from './model';

type DocxModule = typeof Docx;

export interface RasterImage {
  data: Uint8Array;
  type: 'jpg' | 'png';
}

/**
 * With "exactly" line spacing, Word puts the baseline at 80% of the line
 * height from the top of the line box — for every font and size. Measured by
 * rendering test documents through Word and reading the baselines back.
 */
const WORD_BASELINE = 0.8;

/** Word's paragraph mark under an inline picture adds a sliver of descent. */
const PICTURE_DESCENT = 0.3;

const twips = (points: number) => Math.round(points * 20);
const pixels = (points: number) => Math.max(1, Math.round((points * 96) / 72));
const hex = (color: string) => color.replace('#', '').toUpperCase();

interface Flow {
  /** Where Word's previous element ended, in page points. */
  cursor: number;
  /** Page the cursor is on. */
  page: number;
}

type Child = Docx.Paragraph | Docx.Table;

export function buildDocx(
  model: DocumentModel,
  images: Map<FigureBlock, RasterImage>,
  docx: DocxModule,
): Docx.Document {
  const {
    AlignmentType,
    BorderStyle,
    Document,
    Footer,
    Header,
    HeightRule,
    HorizontalPositionRelativeFrom,
    ImageRun,
    LineRuleType,
    PageNumber,
    Paragraph,
    ShadingType,
    Tab,
    Table,
    TableCell: DocxTableCell,
    TableLayoutType,
    TableRow,
    TabStopType,
    TextRun,
    TextWrappingType,
    VerticalAlign,
    VerticalPositionRelativeFrom,
    WidthType,
  } = docx;

  const contentLeft = model.margins.left;

  // instanceof rather than constructor.name: the browser bundle minifies names.
  const lastIsTable = (children: Child[]) => children[children.length - 1] instanceof Table;

  /* ------------------------------------------------------------ runs */

  const textRun = (run: StyledRun & { pageField?: boolean }) => {
    const base = {
      font: run.font.family,
      size: Math.max(2, Math.round(run.size * 2)),
      bold: run.font.bold || undefined,
      italics: run.font.italic || undefined,
      color: run.color && run.color !== '#000000' ? hex(run.color) : undefined,
      underline: run.underline ? {} : undefined,
    };

    if (run.pageField) return [new TextRun({ ...base, children: [PageNumber.CURRENT] })];

    // A tab has to be its own element; a literal \t in text is not one.
    const parts = run.text.split('\t');
    const children: (string | Docx.Tab)[] = [];
    parts.forEach((part, index) => {
      if (index > 0) children.push(new Tab());
      if (part) children.push(part);
    });
    return [new TextRun({ ...base, children })];
  };

  const alignment = (align: ParagraphBlock['align']) =>
    align === 'center'
      ? AlignmentType.CENTER
      : align === 'right'
        ? AlignmentType.RIGHT
        : align === 'justify'
          ? AlignmentType.JUSTIFIED
          : AlignmentType.LEFT;

  const tabStops = (paragraph: { tabs: ParagraphBlock['tabs'] }) =>
    paragraph.tabs.map((tab) => ({
      type:
        tab.alignment === 'right'
          ? TabStopType.RIGHT
          : tab.alignment === 'center'
            ? TabStopType.CENTER
            : TabStopType.LEFT,
      position: twips(tab.position),
      leader: tab.leader === 'dot' ? ('dot' as const) : undefined,
    }));

  /** An empty paragraph of an exact height — how Word is told "leave this gap". */
  const spacer = (gap: number, pageBreak = false) =>
    new Paragraph({
      children: [],
      pageBreakBefore: pageBreak || undefined,
      spacing: { before: 0, after: 0, line: twips(Math.max(0.5, gap)), lineRule: LineRuleType.EXACT },
      run: { size: 2 },
      widowControl: false,
    });

  /* ------------------------------------------------------ paragraphs */

  const paragraphOf = (block: ParagraphBlock, before: number, pageBreak: boolean): Docx.Paragraph => {
    if (block.rule) {
      return new Paragraph({
        children: [],
        pageBreakBefore: pageBreak || undefined,
        spacing: { before: twips(before), after: 0, line: twips(1), lineRule: LineRuleType.EXACT },
        indent: { left: twips(block.indentLeft), right: twips(block.indentRight) },
        border: {
          bottom: {
            style: BorderStyle.SINGLE,
            size: Math.max(2, Math.min(96, Math.round(block.rule.thickness * 8))),
            color: hex(block.rule.color),
            space: 0,
          },
        },
        run: { size: 2 },
        widowControl: false,
      });
    }

    const firstLine = block.firstLine;
    return new Paragraph({
      children: block.runs.flatMap(textRun),
      alignment: alignment(block.align),
      pageBreakBefore: pageBreak || undefined,
      indent: {
        left: twips(block.indentLeft),
        right: Math.abs(block.indentRight) > 0.25 ? twips(block.indentRight) : undefined,
        firstLine: firstLine > 0.5 ? twips(firstLine) : undefined,
        hanging: firstLine < -0.5 ? twips(-firstLine) : undefined,
      },
      spacing: {
        before: twips(Math.max(0, before)),
        after: 0,
        line: twips(block.lineHeight),
        lineRule: LineRuleType.EXACT,
      },
      tabStops: block.tabs.length > 0 ? tabStops(block) : undefined,
      // Widow control would move lines between pages that the PDF kept
      // together, shifting everything after them.
      widowControl: false,
    });
  };

  /* --------------------------------------------------------- figures */

  const figureOf = (
    block: FigureBlock,
    container: { left: number; right: number },
    before: number,
    pageBreak: boolean,
  ): Docx.Paragraph | null => {
    const image = images.get(block);
    if (!image) return null;

    const w = block.rect.x1 - block.rect.x0;
    const h = block.rect.y1 - block.rect.y0;

    if (block.fullPage) {
      return new Paragraph({
        children: [
          new ImageRun({
            type: image.type,
            data: image.data,
            transformation: { width: pixels(w), height: pixels(h) },
            floating: {
              horizontalPosition: { relative: HorizontalPositionRelativeFrom.PAGE, offset: 0 },
              verticalPosition: { relative: VerticalPositionRelativeFrom.PAGE, offset: 0 },
              behindDocument: true,
              allowOverlap: true,
              wrap: { type: TextWrappingType.NONE },
            },
          }),
        ],
        pageBreakBefore: pageBreak || undefined,
        spacing: { before: 0, after: 0, line: twips(1), lineRule: LineRuleType.EXACT },
        run: { size: 2 },
        widowControl: false,
      });
    }

    const middle = (block.rect.x0 + block.rect.x1) / 2;
    const centered = Math.abs(middle - (container.left + container.right) / 2) <= 3;

    return new Paragraph({
      children: [
        new ImageRun({
          type: image.type,
          data: image.data,
          transformation: { width: pixels(w), height: pixels(h) },
        }),
      ],
      alignment: centered ? AlignmentType.CENTER : AlignmentType.LEFT,
      indent: centered ? undefined : { left: twips(block.rect.x0 - container.left) },
      pageBreakBefore: pageBreak || undefined,
      spacing: { before: twips(Math.max(0, before)), after: 0 },
      // A 1pt paragraph mark keeps the line exactly as tall as the picture.
      run: { size: 2 },
      widowControl: false,
    });
  };

  /* ---------------------------------------------------------- tables */

  const border = (value: Border | null) =>
    value
      ? {
          style: BorderStyle.SINGLE,
          size: Math.max(2, Math.min(96, Math.round(value.width * 8))),
          color: hex(value.color),
        }
      : { style: BorderStyle.NONE, size: 0, color: 'auto' };

  const tableOf = (block: TableBlock, container: { left: number; right: number }): Docx.Table => {
    const edges = block.columnEdges;
    const widths = edges.slice(1).map((edge, index) => edge - edges[index]);

    const rows = block.rows.map((row) => {
      const topBorder = Math.max(0, ...row.cells.map((cell) => cell.borders.top?.width ?? 0));
      const bottomBorder = Math.max(0, ...row.cells.map((cell) => cell.borders.bottom?.width ?? 0));

      const cells = row.cells.map((cell) => {
        const padding = cell.padding ?? block.cellPadding;
        const inner = { left: cell.rect.x0 + padding, right: cell.rect.x1 - padding };
        const start = cell.rect.y0 + (cell.borders.top?.width ?? 0) / 2;
        const children = renderCell(cell, inner, start);

        return new DocxTableCell({
          children,
          columnSpan: cell.columnSpan > 1 ? cell.columnSpan : undefined,
          rowSpan: cell.rowSpan > 1 ? cell.rowSpan : undefined,
          width: { size: twips(cell.rect.x1 - cell.rect.x0), type: WidthType.DXA },
          margins:
            cell.padding !== undefined
              ? { left: twips(cell.padding), right: twips(cell.padding), marginUnitType: WidthType.DXA }
              : undefined,
          shading: cell.fill ? { fill: hex(cell.fill), type: ShadingType.CLEAR, color: 'auto' } : undefined,
          borders: {
            top: border(cell.borders.top),
            bottom: border(cell.borders.bottom),
            left: border(cell.borders.left),
            right: border(cell.borders.right),
          },
          verticalAlign:
            cell.verticalAlign === 'center'
              ? VerticalAlign.CENTER
              : cell.verticalAlign === 'bottom'
                ? VerticalAlign.BOTTOM
                : VerticalAlign.TOP,
        });
      });

      return new TableRow({
        children: cells,
        // Word adds the borders to the declared height; the PDF measures
        // between border centres.
        height: {
          value: twips(Math.max(1, row.height - (topBorder + bottomBorder) / 2)),
          rule: HeightRule.ATLEAST,
        },
      });
    });

    const none = { style: BorderStyle.NONE, size: 0, color: 'auto' };

    return new Table({
      rows,
      columnWidths: widths.map(twips),
      width: { size: twips(edges[edges.length - 1] - edges[0]), type: WidthType.DXA },
      layout: TableLayoutType.FIXED,
      indent: { size: twips(edges[0] - container.left), type: WidthType.DXA },
      margins: {
        left: twips(block.cellPadding),
        right: twips(block.cellPadding),
        top: 0,
        bottom: 0,
      },
      borders: { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none },
    });
  };

  /* ---------------------------------------------------- flow layout */

  /**
   * Emits blocks into a container (the page body or a table cell), turning
   * the gap above each block into Word spacing.
   */
  function renderFlow(
    blocks: Block[],
    container: { left: number; right: number },
    flow: Flow,
    options: { pageStarts?: Set<Block>; topMargin?: number } = {},
  ): Child[] {
    const out: Child[] = [];

    blocks.forEach((block) => {
      const startsPage = options.pageStarts?.has(block) ?? false;
      if (startsPage) {
        flow.cursor = options.topMargin ?? 0;
        flow.page = block.page;
      }

      const top = topOf(block);
      let gap = top - flow.cursor;
      let pageBreak = startsPage;

      // Word drops "space before" on the first paragraph after a page break,
      // and a table cannot carry one at all — so either case gets a spacer
      // paragraph of exactly the needed height.
      const needsSpacer = block.kind === 'table' ? gap > 0.3 || startsPage || lastIsTable(out) : startsPage && gap > 0.5;
      if (needsSpacer) {
        out.push(spacer(Math.max(0.5, gap), pageBreak));
        flow.cursor += Math.max(0.5, gap);
        gap = 0;
        pageBreak = false;
      }

      if (block.kind === 'paragraph') {
        out.push(paragraphOf(block, gap, pageBreak));
        flow.cursor = block.rule
          ? top + 1 + block.rule.thickness
          : block.lastBaseline + (1 - WORD_BASELINE) * block.lineHeight;
        flow.page = block.endPage;
      } else if (block.kind === 'figure') {
        const paragraph = figureOf(block, container, gap, pageBreak);
        if (paragraph) out.push(paragraph);
        flow.cursor = block.fullPage ? (options.topMargin ?? 0) + 1 : block.rect.y1 + PICTURE_DESCENT;
      } else {
        out.push(tableOf(block, container));
        const last = block.rows[block.rows.length - 1];
        const bottomBorder = Math.max(0, ...last.cells.map((cell) => cell.borders.bottom?.width ?? 0));
        flow.cursor = last.top + last.height + bottomBorder / 2;
        flow.page = block.endPage;
      }
    });

    return out;
  }

  function renderCell(cell: TableCell, inner: { left: number; right: number }, start: number): Child[] {
    const flow: Flow = { cursor: start, page: 0 };
    const blocks = cell.blocks;

    // Vertically centred content is placed by Word; only the spacing between
    // its own paragraphs is ours to set.
    if (cell.verticalAlign !== 'top' && blocks.length > 0) flow.cursor = topOf(blocks[0]);

    const children = renderFlow(blocks, inner, flow);

    // Word requires a cell to end with a paragraph.
    if (children.length === 0 || lastIsTable(children)) children.push(spacer(1));
    return children;
  }

  /* -------------------------------------------------------- document */

  // The top margin must sit at or above the first element of every page:
  // Word cannot use negative spacing, so anything that starts higher would be
  // pushed down and drag the whole page with it.
  const topMargin = Math.max(
    0,
    Math.min(
      model.margins.top,
      ...model.pages.filter((page) => page.blocks.length > 0 && !isFullPage(page.blocks[0])).map((page) => topOf(page.blocks[0])),
    ),
  );

  for (const page of model.pages) fitLayoutRows(page.blocks);

  const pageStarts = new Set<Block>();
  const body: Block[] = [];
  for (const page of model.pages) {
    page.blocks.forEach((block, index) => {
      if (index === 0 && body.length > 0) pageStarts.add(block);
      body.push(block);
    });
  }

  // Pages that begin with continued content (a paragraph or table carried over)
  // have no block of their own at the top — the flow breaks there naturally.
  const flow: Flow = { cursor: topMargin, page: model.pages[0]?.pageNumber ?? 1 };
  const children = renderFlow(
    body,
    { left: contentLeft, right: model.pageWidth - model.margins.right },
    flow,
    { pageStarts, topMargin },
  );
  if (children.length === 0) children.push(spacer(1));

  const firstPage = model.pages[0];
  const coverIsPicture = firstPage?.blocks.length === 1 && firstPage.blocks[0].kind === 'figure' && firstPage.blocks[0].fullPage;

  const chrome = (part: FooterModel | undefined, kind: 'footer' | 'header') => {
    if (!part) return undefined;
    const paragraphs = part.paragraphs.map((paragraph, index) => {
      const ruleAbove = kind === 'footer' && index === 0 && part.rule;
      return new Paragraph({
        children: paragraph.runs.flatMap(textRun),
        indent: { left: twips(paragraph.indentLeft - contentLeft) },
        tabStops: paragraph.tabs.length
          ? tabStops({ tabs: paragraph.tabs.map((tab) => ({ ...tab, position: tab.position - contentLeft })) })
          : undefined,
        spacing: { before: 0, after: 0, line: twips(paragraph.lineHeight), lineRule: LineRuleType.EXACT },
        border: ruleAbove
          ? {
              top: {
                style: part.rule!.double ? BorderStyle.THICK_THIN_SMALL_GAP : BorderStyle.SINGLE,
                size: Math.max(4, Math.min(96, Math.round(part.rule!.thickness * 8))),
                color: hex(part.rule!.color),
                space: Math.max(
                  0,
                  Math.round(paragraph.baseline - WORD_BASELINE * paragraph.lineHeight - (part.rule!.y + part.rule!.thickness)),
                ),
              },
            }
          : undefined,
        widowControl: false,
      });
    });
    return kind === 'footer' ? new Footer({ children: paragraphs }) : new Header({ children: paragraphs });
  };

  const footer = chrome(model.footer, 'footer');
  const header = chrome(model.header, 'header');
  const lastFooterLine = model.footer?.paragraphs[model.footer.paragraphs.length - 1];
  const footerDistance = lastFooterLine
    ? Math.max(0, model.pageHeight - (lastFooterLine.baseline + (1 - WORD_BASELINE) * lastFooterLine.lineHeight))
    : 36;
  const firstHeaderLine = model.header?.paragraphs[0];
  const headerDistance = firstHeaderLine
    ? Math.max(0, firstHeaderLine.baseline - WORD_BASELINE * firstHeaderLine.lineHeight)
    : 36;

  const titlePage = Boolean(coverIsPicture || (model.footer && firstPage && !model.footer.pages.includes(firstPage.pageNumber)));

  return new Document({
    creator: 'NusaPDF',
    sections: [
      {
        properties: {
          titlePage,
          page: {
            size: { width: twips(model.pageWidth), height: twips(model.pageHeight) },
            margin: {
              top: twips(topMargin),
              bottom: twips(model.margins.bottom),
              left: twips(model.margins.left),
              right: twips(model.margins.right),
              footer: twips(footerDistance),
              header: twips(headerDistance),
            },
            pageNumbers: { start: model.firstPageNumber },
          },
        },
        footers: footer ? { default: footer, first: titlePage ? new Footer({ children: [spacer(1)] }) : undefined } : undefined,
        headers: header ? { default: header, first: titlePage ? new Header({ children: [spacer(1)] }) : undefined } : undefined,
        children,
      },
    ],
  });
}

/**
 * A borderless layout table's row is measured from its content's glyphs, but
 * Word places a first line by its line box, which starts higher. Growing the
 * row upward to that line box keeps the content where it was instead of
 * pushing it down by the difference.
 */
function fitLayoutRows(blocks: Block[]): void {
  for (const block of blocks) {
    if (block.kind !== 'table') continue;
    for (const row of block.rows) {
      for (const cell of row.cells) fitLayoutRows(cell.blocks);
      if (!block.layout) continue;
      const tops = row.cells.filter((cell) => cell.blocks.length > 0).map((cell) => topOf(cell.blocks[0]));
      const needed = Math.min(row.top, ...tops);
      if (needed < row.top) {
        row.height += row.top - needed;
        row.top = needed;
        for (const cell of row.cells) cell.rect = { ...cell.rect, y0: needed };
      }
    }
    if (block.layout) block.rect = { ...block.rect, y0: block.rows[0].top };
  }
}

function isFullPage(block: Block): boolean {
  return block.kind === 'figure' && Boolean(block.fullPage);
}

/** Where a block begins on its page, in the terms Word positions it by. */
function topOf(block: Block): number {
  if (block.kind === 'paragraph') {
    return block.rule ? block.firstBaseline - 1 : block.firstBaseline - WORD_BASELINE * block.lineHeight;
  }
  if (block.kind === 'table') {
    const first = block.rows[0];
    const topBorder = Math.max(0, ...first.cells.map((cell) => cell.borders.top?.width ?? 0));
    return first.top - topBorder / 2;
  }
  return block.rect.y0;
}

