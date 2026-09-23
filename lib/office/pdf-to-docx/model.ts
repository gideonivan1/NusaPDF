/**
 * The layout model PDF to Word reconstructs from a PDF, before any Word
 * specifics are decided.
 *
 * Every geometric value is in PDF points on the page it came from, top-down.
 * Keeping raw geometry here — rather than pre-computed Word spacing — lets the
 * writer own the one genuinely Word-specific question: how to reproduce these
 * positions with paragraph spacing, line heights, and indents.
 */

import type { FontStyle, Rect } from '@/lib/pdf/page-content';

export interface StyledRun {
  /** May contain `\t`, which the writer turns into a real tab. */
  text: string;
  font: FontStyle;
  size: number;
  color: string;
  underline?: boolean;
}

export interface TabStop {
  /** Points from the container's left edge. */
  position: number;
  alignment: 'left' | 'right' | 'center';
  leader?: 'dot';
}

export interface ParagraphBlock {
  kind: 'paragraph';
  page: number;
  runs: StyledRun[];
  align: 'left' | 'center' | 'right' | 'justify';
  /** Points from the container's left edge to the paragraph's text edge. */
  indentLeft: number;
  indentRight: number;
  /** Positive: first-line indent. Negative: hanging indent (lists). */
  firstLine: number;
  tabs: TabStop[];
  /** Baseline-to-baseline distance. */
  lineHeight: number;
  firstBaseline: number;
  /** On `endPage`, which differs from `page` when a paragraph crosses a page. */
  lastBaseline: number;
  endPage: number;
  lineCount: number;
  /** Dominant font size, used for spacing decisions. */
  size: number;
  /** A horizontal rule rendered as this paragraph's bottom border. */
  rule?: { color: string; thickness: number };
}

export interface FigureBlock {
  kind: 'figure';
  page: number;
  rect: Rect;
  /** Pixel scale to rasterise at, relative to 72 dpi. */
  scale: number;
  /** Photographs compress far better as JPEG; line art stays crisp as PNG. */
  format: 'jpeg' | 'png';
  /** A page drawn as a single picture, placed behind everything at 0,0. */
  fullPage?: boolean;
}

export interface Border {
  color: string;
  /** Points. */
  width: number;
}

export interface TableCell {
  row: number;
  column: number;
  rowSpan: number;
  columnSpan: number;
  rect: Rect;
  /** Horizontal cell margin, when narrower than the table's (tight columns). */
  padding?: number;
  fill?: string;
  borders: { top: Border | null; bottom: Border | null; left: Border | null; right: Border | null };
  verticalAlign: 'top' | 'center' | 'bottom';
  blocks: Block[];
}

export interface TableRow {
  height: number;
  /** Top edge, on `page`. Rows of a table continued from the previous page keep their own page. */
  top: number;
  page: number;
  cells: TableCell[];
}

export interface TableBlock {
  kind: 'table';
  page: number;
  rect: Rect;
  /** Column boundaries, left to right, in points on the page. */
  columnEdges: number[];
  rows: TableRow[];
  /** Horizontal padding between cell edge and text. */
  cellPadding: number;
  /** Borderless layout grids (side-by-side columns) rather than ruled tables. */
  layout: boolean;
  endPage: number;
}

export type Block = ParagraphBlock | FigureBlock | TableBlock;

export interface PageModel {
  pageNumber: number;
  width: number;
  height: number;
  blocks: Block[];
}

export interface FooterModel {
  /** Lines of the footer, top to bottom; `pageField` marks the page number run. */
  paragraphs: {
    runs: (StyledRun & { pageField?: boolean })[];
    tabs: TabStop[];
    indentLeft: number;
    align: ParagraphBlock['align'];
    baseline: number;
    lineHeight: number;
  }[];
  rule?: { color: string; thickness: number; y: number; double: boolean };
  /** Pages (1-indexed) that carry the footer. */
  pages: number[];
  /** Topmost point of the footer on the page. */
  top: number;
}

export interface DocumentModel {
  pageWidth: number;
  pageHeight: number;
  margins: { top: number; bottom: number; left: number; right: number };
  pages: PageModel[];
  footer?: FooterModel;
  header?: FooterModel;
  /** Number the first converted page carries, for the PAGE field. */
  firstPageNumber: number;
}
