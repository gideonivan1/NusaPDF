/**
 * Reads the drawable primitives of one PDF page — positioned text runs with
 * their real font style and colour, vector shapes, and image placements.
 *
 * This is the raw material for PDF to Word. `getTextContent()` alone gives
 * strings and positions but not whether a run is bold, what colour it is, or
 * anything about the ruled lines that make a table a table and the pictures
 * that make a report a report. Those only exist in the operator list, so this
 * walks it with the same state machine the canvas renderer uses (save/restore,
 * transform, clip) and records geometry instead of painting.
 *
 * Isomorphic on purpose: it only needs a pdf.js page and the OPS table, so the
 * same code runs in the browser for users and in Node for the verification
 * scripts. Every coordinate returned is in PDF points, top-down (y grows
 * downward, origin at the top-left of the visible page), which is the frame
 * Word thinks in.
 */

import type { PDFPageProxy } from 'pdfjs-dist';

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface FontStyle {
  /** Family as Word knows it: "Arial", "Calibri Light", "Times New Roman". */
  family: string;
  bold: boolean;
  italic: boolean;
}

export interface TextRun {
  text: string;
  x0: number;
  x1: number;
  baseline: number;
  /** Glyph box, from the font's ascent/descent. */
  top: number;
  bottom: number;
  size: number;
  font: FontStyle;
  /** `#rrggbb`. */
  color: string;
}

export interface Shape {
  rect: Rect;
  /** Filled or stroked. A shape that is both is reported twice. */
  paint: 'fill' | 'stroke';
  color: string;
  lineWidth: number;
  /**
   * True when every segment of the path is horizontal or vertical — which is
   * what ruled table borders and cell shading always are, and what curves,
   * arrows, and diagonals never are.
   */
  axisAligned: boolean;
}

export interface ImagePlacement {
  rect: Rect;
  nativeWidth: number;
  nativeHeight: number;
}

export interface PageContent {
  pageNumber: number;
  width: number;
  height: number;
  runs: TextRun[];
  shapes: Shape[];
  images: ImagePlacement[];
}

type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(m: Matrix, n: Matrix): Matrix {
  // Result = n applied first, then m — the PDF `cm` convention (CTM' = n × CTM).
  return [
    n[0] * m[0] + n[1] * m[2],
    n[0] * m[1] + n[1] * m[3],
    n[2] * m[0] + n[3] * m[2],
    n[2] * m[1] + n[3] * m[3],
    n[4] * m[0] + n[5] * m[2] + m[4],
    n[4] * m[1] + n[5] * m[3] + m[5],
  ];
}

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function boxOf(m: Matrix, x0: number, y0: number, x1: number, y1: number): Rect {
  const points = [apply(m, x0, y0), apply(m, x1, y0), apply(m, x1, y1), apply(m, x0, y1)];
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

export function intersect(a: Rect, b: Rect): Rect | null {
  const r = {
    x0: Math.max(a.x0, b.x0),
    y0: Math.max(a.y0, b.y0),
    x1: Math.min(a.x1, b.x1),
    y1: Math.min(a.y1, b.y1),
  };
  return r.x1 > r.x0 && r.y1 > r.y0 ? r : null;
}

/* ------------------------------------------------------------------ fonts */

const STYLE_TOKENS = /^(bold|italic|oblique|bolditalic|boldoblique|regular|roman|book|normal|mt|ps|psmt)$/i;

/**
 * "BCDEEE+Arial-BoldMT" -> Arial, bold. "ABCDEF+Calibri-Light" -> "Calibri
 * Light". "TimesNewRomanPS-BoldItalicMT" -> "Times New Roman", bold italic.
 *
 * Word resolves fonts by family name, so the subset prefix and the PostScript
 * style suffix have to go; weight words it does *not* model as bold/italic
 * (Light, Semibold, Narrow) stay part of the family, because in Word
 * "Calibri Light" and "Arial Narrow" are families of their own.
 */
export function parseFontName(raw: string | undefined): FontStyle {
  const name = (raw ?? '').replace(/^[A-Z]{6}\+/, '');
  if (!name) return { family: 'Arial', bold: false, italic: false };

  const [base, ...styleParts] = name.split(/[-,]/);
  const style = styleParts.join('');

  const bold = /bold|black|heavy/i.test(style) || /bold/i.test(base);
  const italic = /italic|oblique/i.test(style) || /italic/i.test(base);

  // Style words Word expresses as family names are kept.
  const extra = styleParts
    .flatMap((part) => part.replace(/(MT|PSMT|PS)$/, '').split(/(?=[A-Z])/))
    .filter((token) => token && !STYLE_TOKENS.test(token) && !/^(bold|italic|oblique)/i.test(token));

  let family = base
    .replace(/(PSMT|PS|MT)$/, '')
    .replace(/(Bold|Italic|Oblique)+$/i, '')
    // CamelCase -> spaced words, but keep runs like "MS" intact.
    .replace(/([a-z])([A-Z])/g, '$1 $2');

  if (extra.length > 0) family += ` ${extra.join(' ')}`;

  return { family: family.trim() || 'Arial', bold, italic };
}

/* ------------------------------------------------------------------- read */

interface GraphicsState {
  ctm: Matrix;
  clip: Rect | null;
  fill: string;
  stroke: string;
  lineWidth: number;
}

interface TextPaint {
  x: number;
  y: number;
  color: string;
  invisible: boolean;
}

/** Only the OPS entries this walker reacts to. */
export type OpsTable = Record<string, number>;

export async function readPageContent(
  page: PDFPageProxy,
  OPS: OpsTable,
): Promise<PageContent> {
  const viewport = page.getViewport({ scale: 1 });
  // Maps PDF user space onto the top-down visible page, rotation included.
  const view = viewport.transform as Matrix;

  const operatorList = await page.getOperatorList();

  const shapes: Shape[] = [];
  const images: ImagePlacement[] = [];
  const paints: TextPaint[] = [];

  let state: GraphicsState = {
    ctm: view,
    clip: null,
    fill: '#000000',
    stroke: '#000000',
    lineWidth: 1,
  };
  const stack: GraphicsState[] = [];
  let pendingClip = false;

  let textMatrix: Matrix = IDENTITY;
  let lineMatrix: Matrix = IDENTITY;
  let leading = 0;
  let renderMode = 0;

  const clipped = (rect: Rect): Rect | null => (state.clip ? intersect(rect, state.clip) : rect);

  const { fnArray, argsArray } = operatorList;

  for (let index = 0; index < fnArray.length; index++) {
    const fn = fnArray[index];
    const args = argsArray[index] as unknown[] | null;

    switch (fn) {
      case OPS.save:
        stack.push({ ...state });
        break;

      case OPS.restore:
        state = stack.pop() ?? state;
        break;

      case OPS.transform:
        state.ctm = multiply(state.ctm, args as unknown as Matrix);
        break;

      case OPS.paintFormXObjectBegin: {
        stack.push({ ...state });
        const [matrix, bbox] = args as [Matrix | null, number[] | null];
        if (matrix) state.ctm = multiply(state.ctm, matrix);
        if (bbox) {
          const box = boxOf(state.ctm, bbox[0], bbox[1], bbox[2], bbox[3]);
          state.clip = state.clip ? intersect(state.clip, box) : box;
        }
        break;
      }

      case OPS.paintFormXObjectEnd:
        state = stack.pop() ?? state;
        break;

      case OPS.clip:
      case OPS.eoClip:
        pendingClip = true;
        break;

      case OPS.setFillRGBColor:
        state.fill = String((args as string[])[0]);
        break;

      case OPS.setStrokeRGBColor:
        state.stroke = String((args as string[])[0]);
        break;

      case OPS.setLineWidth:
        state.lineWidth = Number((args as number[])[0]);
        break;

      case OPS.constructPath: {
        const [paintOp, data, minMax] = args as [number, unknown[], ArrayLike<number> | null];
        if (!minMax) break;

        const box = boxOf(state.ctm, minMax[0], minMax[1], minMax[2], minMax[3]);

        if (pendingClip) {
          // The path that immediately follows a clip operator *is* the clip.
          state.clip = state.clip ? intersect(state.clip, box) ?? { ...box, x1: box.x0, y1: box.y0 } : box;
          pendingClip = false;
        }

        if (paintOp === OPS.endPath) break;

        const axisAligned = isAxisAligned(data[0], state.ctm);
        const scale = Math.hypot(state.ctm[0], state.ctm[1]) || 1;

        const strokes =
          paintOp === OPS.stroke ||
          paintOp === OPS.closeStroke ||
          paintOp === OPS.fillStroke ||
          paintOp === OPS.eoFillStroke ||
          paintOp === OPS.closeFillStroke ||
          paintOp === OPS.closeEOFillStroke;

        const fills =
          paintOp === OPS.fill ||
          paintOp === OPS.eoFill ||
          paintOp === OPS.fillStroke ||
          paintOp === OPS.eoFillStroke ||
          paintOp === OPS.closeFillStroke ||
          paintOp === OPS.closeEOFillStroke;

        if (fills) {
          const rect = clipped(box);
          if (rect) shapes.push({ rect, paint: 'fill', color: state.fill, lineWidth: 0, axisAligned });
        }
        if (strokes) {
          const half = (state.lineWidth * scale) / 2;
          const rect = clipped({ x0: box.x0 - half, y0: box.y0 - half, x1: box.x1 + half, y1: box.y1 + half });
          if (rect) {
            shapes.push({
              rect,
              paint: 'stroke',
              color: state.stroke,
              lineWidth: Math.max(state.lineWidth * scale, 0.25),
              axisAligned,
            });
          }
        }
        break;
      }

      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject:
      case OPS.paintImageMaskXObject:
      case OPS.paintImageXObjectRepeat: {
        const rect = clipped(boxOf(state.ctm, 0, 0, 1, 1));
        if (!rect) break;

        let nativeWidth = 0;
        let nativeHeight = 0;
        if (fn === OPS.paintImageXObject || fn === OPS.paintImageXObjectRepeat) {
          nativeWidth = Number((args as unknown[])[1]) || 0;
          nativeHeight = Number((args as unknown[])[2]) || 0;
        } else {
          const image = (args as { width?: number; height?: number }[])[0];
          nativeWidth = image?.width ?? 0;
          nativeHeight = image?.height ?? 0;
        }

        images.push({ rect, nativeWidth, nativeHeight });
        break;
      }

      /* ------------------------------------------------ text positioning */
      case OPS.beginText:
        textMatrix = IDENTITY;
        lineMatrix = IDENTITY;
        break;

      case OPS.setTextMatrix:
        textMatrix = lineMatrix = Array.from((args as unknown[])[0] as ArrayLike<number>).slice(0, 6) as Matrix;
        break;

      case OPS.setLeadingMoveText:
      case OPS.moveText: {
        const [tx, ty] = args as number[];
        if (fn === OPS.setLeadingMoveText) leading = -ty;
        textMatrix = lineMatrix = multiply(lineMatrix, [1, 0, 0, 1, tx, ty]);
        break;
      }

      case OPS.nextLine:
        textMatrix = lineMatrix = multiply(lineMatrix, [1, 0, 0, 1, 0, -leading]);
        break;

      case OPS.setTextRenderingMode:
        renderMode = Number((args as number[])[0]);
        break;

      case OPS.showText:
      case OPS.showSpacedText:
      case OPS.nextLineShowText:
      case OPS.nextLineSetSpacingShowText: {
        const [x, y] = apply(multiply(state.ctm, textMatrix), 0, 0);
        paints.push({
          x,
          y,
          color: renderMode === 1 || renderMode === 5 ? state.stroke : state.fill,
          // Mode 3 is invisible text — the OCR layer of a scanned page. It is
          // real text for searching, but drawing it in Word would double up.
          invisible: renderMode === 3 || renderMode === 7,
        });
        break;
      }
    }
  }

  const runs = await readRuns(page, view, paints);

  return {
    pageNumber: page.pageNumber,
    width: viewport.width,
    height: viewport.height,
    runs,
    shapes,
    images,
  };
}

/** True when the path's segments are all horizontal or vertical on the page. */
function isAxisAligned(path: unknown, ctm: Matrix): boolean {
  if (!path || typeof (path as ArrayLike<number>).length !== 'number') return false;
  const data = path as ArrayLike<number>;

  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;

  for (let i = 0; i < data.length; ) {
    const op = data[i++];
    if (op === 0) {
      [x, y] = apply(ctm, data[i], data[i + 1]);
      [startX, startY] = [x, y];
      i += 2;
    } else if (op === 1) {
      const [nx, ny] = apply(ctm, data[i], data[i + 1]);
      if (Math.abs(nx - x) > 0.5 && Math.abs(ny - y) > 0.5) return false;
      [x, y] = [nx, ny];
      i += 2;
    } else if (op === 4) {
      if (Math.abs(startX - x) > 0.5 && Math.abs(startY - y) > 0.5) return false;
      [x, y] = [startX, startY];
    } else {
      // Curves are never table rules.
      return false;
    }
  }

  return true;
}

async function readRuns(page: PDFPageProxy, view: Matrix, paints: TextPaint[]): Promise<TextRun[]> {
  const content = await page.getTextContent();
  const runs: TextRun[] = [];

  for (const item of content.items) {
    if (!('str' in item) || item.str === '') continue;

    const [a, b, c, d, e, f] = item.transform as number[];
    // Rotated text (a vertical label on a chart) cannot be expressed as a Word
    // run in the flow; it stays with the picture it belongs to.
    if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01) continue;

    const matrix = multiply(view, [a, b, c, d, e, f]);
    const size = Math.abs(matrix[3]) || Math.abs(d);
    if (size < 1) continue;

    const [x, baseline] = apply(view, e, f);
    const style = content.styles[item.fontName];
    const ascent = style?.ascent ?? 0.8;
    const descent = Math.abs(style?.descent ?? -0.2);

    let fontName: string | undefined;
    try {
      fontName = (page.commonObjs.get(item.fontName) as { name?: string } | undefined)?.name;
    } catch {
      fontName = undefined;
    }

    const paint = nearestPaint(paints, x, baseline);
    if (paint?.invisible) continue;

    const width = item.width * (Math.abs(view[0]) || 1);

    runs.push({
      text: item.str,
      x0: x,
      x1: x + width,
      baseline,
      top: baseline - ascent * size,
      bottom: baseline + descent * size,
      size,
      font: parseFontName(fontName),
      color: paint?.color ?? '#000000',
    });
  }

  return runs;
}

/**
 * The text content API reports strings and positions; the operator list
 * reports colours. They describe the same show-text operations, so the colour
 * of a run is the one painted at (or just before) its origin on that baseline.
 */
function nearestPaint(paints: TextPaint[], x: number, y: number): TextPaint | undefined {
  let best: TextPaint | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const paint of paints) {
    if (Math.abs(paint.y - y) > 1.5) continue;
    const dx = x - paint.x;
    // Prefer an origin at or left of the run; a run can start mid-operation.
    const distance = dx >= -1 ? dx : 1000 - dx;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = paint;
    }
  }

  return best;
}
