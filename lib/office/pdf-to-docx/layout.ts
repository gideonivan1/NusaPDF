/**
 * Reconstructs document structure from positioned PDF primitives.
 *
 * A PDF has no paragraphs, tables, or lists — only glyphs, lines, and images
 * at coordinates. Word needs the structure back, and needs it in a form that
 * lands every element where it was: that is the whole difference between a
 * converted document that looks like the original and one that is merely the
 * same words.
 *
 * The pipeline, per page:
 *
 *   1. Repeating header/footer content is recognised across pages and lifted
 *      out, so it becomes a real Word footer instead of text stranded at the
 *      bottom of every page.
 *   2. Ruled tables are rebuilt from their border lines — grid, merged cells,
 *      per-edge borders, and cell shading.
 *   3. Images and vector drawings are grouped into figures.
 *   4. What remains is split into regions (an XY cut) so that side-by-side
 *      content — two screenshots with captions, a three-column signature
 *      block — stays side by side.
 *   5. Lines inside each region are grouped into paragraphs with their
 *      alignment, indents, list markers, tab stops, and line spacing measured
 *      from the page.
 *
 * Pure: no DOM, no pdf.js, no Word. That keeps it testable in Node against
 * the same geometry the browser sees.
 */

import { intersect, type PageContent, type Rect, type Shape, type TextRun } from '@/lib/pdf/page-content';
import type {
  Block,
  Border,
  DocumentModel,
  FigureBlock,
  FooterModel,
  PageModel,
  ParagraphBlock,
  StyledRun,
  TabStop,
  TableBlock,
  TableCell,
} from './model';

/* ==========================================================================
   Geometry helpers
   ========================================================================== */

const width = (r: Rect) => r.x1 - r.x0;
const height = (r: Rect) => r.y1 - r.y0;
const area = (r: Rect) => Math.max(0, width(r)) * Math.max(0, height(r));

function union(a: Rect, b: Rect): Rect {
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

function expand(r: Rect, by: number): Rect {
  return { x0: r.x0 - by, y0: r.y0 - by, x1: r.x1 + by, y1: r.y1 + by };
}

function touches(a: Rect, b: Rect, tolerance = 0): boolean {
  return (
    a.x0 - tolerance <= b.x1 &&
    b.x0 - tolerance <= a.x1 &&
    a.y0 - tolerance <= b.y1 &&
    b.y0 - tolerance <= a.y1
  );
}

function contains(outer: Rect, x: number, y: number, tolerance = 0): boolean {
  return (
    x >= outer.x0 - tolerance &&
    x <= outer.x1 + tolerance &&
    y >= outer.y0 - tolerance &&
    y <= outer.y1 + tolerance
  );
}

function median(values: number[], fallback = 0): number {
  if (values.length === 0) return fallback;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function percentile(values: number[], p: number, fallback = 0): number {
  if (values.length === 0) return fallback;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))];
}

/** Most frequent value after rounding to `step`. */
function mode(values: number[], step: number, fallback = 0): number {
  if (values.length === 0) return fallback;
  const counts = new Map<number, number>();
  for (const value of values) {
    const key = Math.round(value / step) * step;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = fallback;
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount || (count === bestCount && key < best)) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

/** Clusters sorted-able numbers that sit within `tolerance` of each other. */
function clusterValues(values: number[], tolerance: number): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const clusters: number[][] = [];
  for (const value of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && value - last[last.length - 1] <= tolerance) last.push(value);
    else clusters.push([value]);
  }
  return clusters.map((cluster) => median(cluster));
}

class UnionFind {
  private parent: number[];
  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]];
      i = this.parent[i];
    }
    return i;
  }
  join(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
  groups(): number[][] {
    const map = new Map<number, number[]>();
    this.parent.forEach((_, i) => {
      const root = this.find(i);
      map.set(root, [...(map.get(root) ?? []), i]);
    });
    return [...map.values()];
  }
}

function isWhitish(color: string): boolean {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!match) return false;
  return [match[1], match[2], match[3]].every((hex) => parseInt(hex, 16) >= 245);
}

const isBlank = (text: string) => text.trim() === '';

/* ==========================================================================
   Lines and segments
   ========================================================================== */

interface Line {
  runs: TextRun[];
  baseline: number;
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  size: number;
}

/** A stretch of one line with no large horizontal gap inside it. */
interface Segment extends Line {}

function measure(runs: TextRun[]): Line {
  const visible = runs.filter((run) => !isBlank(run.text));
  const geometry = visible.length > 0 ? visible : runs;
  const sizes = new Map<number, number>();
  for (const run of geometry) {
    const key = Math.round(run.size * 2) / 2;
    sizes.set(key, (sizes.get(key) ?? 0) + run.text.length);
  }
  const size = [...sizes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 11;

  return {
    runs,
    baseline: median(geometry.map((run) => run.baseline)),
    x0: Math.min(...geometry.map((run) => run.x0)),
    x1: Math.max(...geometry.map((run) => run.x1)),
    top: Math.min(...geometry.map((run) => run.top)),
    bottom: Math.max(...geometry.map((run) => run.bottom)),
    size,
  };
}

function buildLines(runs: TextRun[]): Line[] {
  const sorted = [...runs].sort((a, b) => a.baseline - b.baseline || a.x0 - b.x0);
  const groups: TextRun[][] = [];

  for (const run of sorted) {
    const group = groups[groups.length - 1];
    const reference = group?.[0];
    if (reference && Math.abs(run.baseline - reference.baseline) <= Math.max(1.2, 0.2 * Math.min(run.size, reference.size))) {
      group.push(run);
    } else {
      groups.push([run]);
    }
  }

  return groups
    .map((group) => group.sort((a, b) => a.x0 - b.x0))
    .filter((group) => group.some((run) => !isBlank(run.text)))
    .map(measure);
}

/**
 * Splits a line where the horizontal gap is far wider than any word space —
 * a tab in the original, or a separate column.
 */
function splitSegments(line: Line): Segment[] {
  const threshold = Math.max(1.8 * line.size, 14);
  const segments: TextRun[][] = [];
  let current: TextRun[] = [];
  let lastEnd: number | null = null;

  for (const run of line.runs) {
    if (isBlank(run.text)) {
      current.push(run);
      continue;
    }
    if (lastEnd !== null && run.x0 - lastEnd > threshold) {
      segments.push(current);
      current = [];
    }
    current.push(run);
    lastEnd = run.x1;
  }
  if (current.length > 0) segments.push(current);

  return segments
    .map((runs) => {
      // Whitespace at either end belongs to the gap, not the segment.
      let start = 0;
      let end = runs.length;
      while (start < end && isBlank(runs[start].text)) start++;
      while (end > start && isBlank(runs[end - 1].text)) end--;
      return runs.slice(start, end);
    })
    .filter((runs) => runs.length > 0)
    .map(measure);
}

/* ==========================================================================
   Runs -> styled Word runs
   ========================================================================== */

function toStyled(run: TextRun, text: string, underline: boolean): StyledRun {
  return {
    text,
    font: run.font,
    size: Math.round(run.size * 2) / 2,
    color: run.color,
    underline: underline || undefined,
  };
}

function sameStyle(a: StyledRun, b: StyledRun): boolean {
  return (
    a.font.family === b.font.family &&
    a.font.bold === b.font.bold &&
    a.font.italic === b.font.italic &&
    a.size === b.size &&
    a.color === b.color &&
    Boolean(a.underline) === Boolean(b.underline)
  );
}

function pushRun(target: StyledRun[], run: StyledRun): void {
  if (run.text === '') return;
  const last = target[target.length - 1];
  // Whitespace carries no visible style, so it joins its neighbour rather
  // than fragmenting the paragraph into a run per space.
  if (last && (sameStyle(last, run) || (isBlank(run.text) && !run.underline))) {
    last.text += run.text;
  } else {
    target.push({ ...run });
  }
}

/**
 * Symbol-font bullets are extracted as their Unicode equivalents. Writing them
 * back in the Symbol font would map them to a different glyph, so they take
 * the font of the text that follows instead.
 */
const SYMBOL_FAMILIES = /^(symbol|wingdings|webdings|zapf ?dingbats)/i;

/** Unicode bullets as extracted, and the Symbol-font code points Word uses for them. */
const SYMBOL_BULLETS = new Map([
  ['•', '\uF0B7'],
  ['·', '\uF0B7'],
]);

function runsOfSegment(
  segment: Segment,
  underlined: Set<TextRun>,
  fallbackFont?: StyledRun['font'],
): StyledRun[] {
  const out: StyledRun[] = [];
  let lastEnd: number | null = null;

  segment.runs.forEach((run, index) => {
    let font = run.font;
    let text = run.text;
    if (/^symbol/i.test(font.family) && SYMBOL_BULLETS.has(text.trim())) {
      // Word writes its own bullets as Symbol-font code points in the private
      // use area; using the same one gives the same glyph at the same size.
      text = text.replace(text.trim(), SYMBOL_BULLETS.get(text.trim())!);
    } else if (SYMBOL_FAMILIES.test(font.family)) {
      const next = segment.runs.slice(index + 1).find((candidate) => !SYMBOL_FAMILIES.test(candidate.font.family));
      font = next?.font ?? fallbackFont ?? { family: 'Arial', bold: false, italic: false };
    }

    const styled = toStyled({ ...run, font }, text, underlined.has(run));

    if (lastEnd !== null && !isBlank(run.text)) {
      const previous = out[out.length - 1];
      const gap = run.x0 - lastEnd;
      // pdf.js emits positioned fragments; a visible gap with no space
      // character between them is still a word break.
      if (gap > run.size * 0.15 && previous && !/\s$/.test(previous.text) && !/^\s/.test(run.text)) {
        pushRun(out, { ...styled, text: ' ' });
      }
    }

    pushRun(out, styled);
    if (!isBlank(run.text)) lastEnd = run.x1;
  });

  return out;
}

/* ==========================================================================
   Header / footer
   ========================================================================== */

interface Chrome {
  /** Per page: y above which (header) / below which (footer) is chrome. */
  bodyTop: Map<number, number>;
  bodyBottom: Map<number, number>;
  footer?: FooterModel;
  header?: FooterModel;
  firstPageNumber: number;
}

function chromeKey(zone: string, y: number, text: string): string {
  return `${zone}|${Math.round(y / 2)}|${text.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim()}`;
}

function detectChrome(pages: PageContent[]): Chrome {
  const chrome: Chrome = { bodyTop: new Map(), bodyBottom: new Map(), firstPageNumber: pages[0]?.pageNumber ?? 1 };
  if (pages.length < 2) return chrome;

  type Item = { key: string; zone: 'top' | 'bottom'; rect: Rect; line?: Line; shape?: Shape };
  const perPage = new Map<number, Item[]>();
  const counts = new Map<string, Set<number>>();

  for (const page of pages) {
    const items: Item[] = [];
    const topZone = page.height * 0.12;
    const bottomZone = page.height * 0.88;

    for (const line of buildLines(page.runs)) {
      const zone = line.bottom < topZone ? 'top' : line.top > bottomZone ? 'bottom' : null;
      if (!zone) continue;
      const text = line.runs.map((run) => run.text).join('');
      items.push({ key: chromeKey(zone, line.baseline, text), zone, rect: { x0: line.x0, x1: line.x1, y0: line.top, y1: line.bottom }, line });
    }

    for (const shape of page.shapes) {
      const zone = shape.rect.y1 < topZone ? 'top' : shape.rect.y0 > bottomZone ? 'bottom' : null;
      if (!zone || isWhitish(shape.color)) continue;
      const r = shape.rect;
      items.push({
        key: `${zone}|shape|${Math.round(r.x0)}|${Math.round(r.y0)}|${Math.round(r.x1)}|${Math.round(r.y1)}|${shape.color}`,
        zone,
        rect: r,
        shape,
      });
    }

    perPage.set(page.pageNumber, items);
    for (const item of items) {
      const set = counts.get(item.key) ?? new Set<number>();
      set.add(page.pageNumber);
      counts.set(item.key, set);
    }
  }

  const needed = Math.max(2, Math.ceil(pages.length * 0.4));
  const repeating = (item: Item) => (counts.get(item.key)?.size ?? 0) >= needed;

  let representative: { page: PageContent; items: Item[] } | null = null;
  const footerPages: number[] = [];
  const headerPages: number[] = [];

  for (const page of pages) {
    const items = (perPage.get(page.pageNumber) ?? []).filter(repeating);
    const bottom = items.filter((item) => item.zone === 'bottom');
    const top = items.filter((item) => item.zone === 'top');

    if (bottom.length > 0) {
      chrome.bodyBottom.set(page.pageNumber, Math.min(...bottom.map((item) => item.rect.y0)) - 0.5);
      footerPages.push(page.pageNumber);
    }
    if (top.length > 0) {
      chrome.bodyTop.set(page.pageNumber, Math.max(...top.map((item) => item.rect.y1)) + 0.5);
      headerPages.push(page.pageNumber);
    }

    if (!representative || items.length > representative.items.length) {
      representative = { page, items };
    }
  }

  if (!representative) return chrome;

  const build = (zone: 'top' | 'bottom', pagesWith: number[]): FooterModel | undefined => {
    const items = representative!.items.filter((item) => item.zone === zone);
    if (items.length === 0 || pagesWith.length === 0) return undefined;

    const page = representative!.page;
    const lines = items.filter((item) => item.line).map((item) => item.line!);
    const shapes = items.filter((item) => item.shape).map((item) => item.shape!);

    const paragraphs: FooterModel['paragraphs'] = lines
      .sort((a, b) => a.baseline - b.baseline)
      .map((line) => {
        const segments = splitSegments(line);
        const runs: (StyledRun & { pageField?: boolean })[] = [];
        const tabs: TabStop[] = [];
        const left = segments[0]?.x0 ?? line.x0;

        segments.forEach((segment, index) => {
          if (index > 0) {
            runs.push({ ...toStyled(segment.runs[0], '\t', false) });
            const rightAligned = segment.x1 >= page.width * 0.8;
            tabs.push({
              position: rightAligned ? segment.x1 : segment.x0,
              alignment: rightAligned ? 'right' : 'left',
            });
          }
          for (const run of segment.runs) {
            const isNumber = /^\s*\d+\s*$/.test(run.text) && Number(run.text) > 0;
            if (isNumber && Number(run.text.trim()) >= page.pageNumber - pages[0].pageNumber) {
              chrome.firstPageNumber = Number(run.text.trim()) - pages.findIndex((p) => p.pageNumber === page.pageNumber);
              runs.push({ ...toStyled(run, run.text.trim(), false), pageField: true });
            } else {
              runs.push(toStyled(run, run.text, false));
            }
          }
        });

        return {
          runs,
          tabs,
          indentLeft: left,
          align: 'left' as const,
          baseline: line.baseline,
          lineHeight: line.size * 1.2,
        };
      });

    const rules = shapes
      .filter((shape) => height(shape.rect) <= 4 && width(shape.rect) > page.width * 0.3)
      .sort((a, b) => a.rect.y0 - b.rect.y0);

    let rule: FooterModel['rule'];
    if (rules.length > 0) {
      const thickest = [...rules].sort((a, b) => height(b.rect) - height(a.rect))[0];
      rule = {
        color: thickest.color,
        thickness: rules.reduce((sum, shape) => sum + height(shape.rect), 0),
        y: rules[0].rect.y0,
        double: rules.length >= 2,
      };
    }

    return {
      paragraphs,
      rule,
      pages: pagesWith,
      top: Math.min(...items.map((item) => item.rect.y0)),
    };
  };

  chrome.footer = build('bottom', footerPages);
  chrome.header = build('top', headerPages);
  return chrome;
}

/* ==========================================================================
   Tables from ruled lines
   ========================================================================== */

interface RuleSegment {
  orientation: 'h' | 'v';
  /** y for horizontal, x for vertical. */
  position: number;
  start: number;
  end: number;
  thickness: number;
  color: string;
  shape: Shape;
}

function toRuleSegments(shape: Shape): RuleSegment[] {
  if (!shape.axisAligned) return [];
  const r = shape.rect;
  const w = width(r);
  const h = height(r);
  const base = { color: shape.color, shape };

  if (shape.paint === 'fill') {
    if (h <= 3 && w >= Math.max(3, h * 2)) {
      return [{ ...base, orientation: 'h', position: (r.y0 + r.y1) / 2, start: r.x0, end: r.x1, thickness: h }];
    }
    if (w <= 3 && h >= Math.max(3, w * 2)) {
      return [{ ...base, orientation: 'v', position: (r.x0 + r.x1) / 2, start: r.y0, end: r.y1, thickness: w }];
    }
    return [];
  }

  const lw = shape.lineWidth;
  if (h <= lw + 1.5 && w > h) {
    return [{ ...base, orientation: 'h', position: (r.y0 + r.y1) / 2, start: r.x0, end: r.x1, thickness: lw }];
  }
  if (w <= lw + 1.5 && h > w) {
    return [{ ...base, orientation: 'v', position: (r.x0 + r.x1) / 2, start: r.y0, end: r.y1, thickness: lw }];
  }

  // A stroked rectangle: its four edges.
  const inset = lw / 2;
  return [
    { ...base, orientation: 'h', position: r.y0 + inset, start: r.x0, end: r.x1, thickness: lw },
    { ...base, orientation: 'h', position: r.y1 - inset, start: r.x0, end: r.x1, thickness: lw },
    { ...base, orientation: 'v', position: r.x0 + inset, start: r.y0, end: r.y1, thickness: lw },
    { ...base, orientation: 'v', position: r.x1 - inset, start: r.y0, end: r.y1, thickness: lw },
  ];
}

function segmentRect(segment: RuleSegment): Rect {
  const half = segment.thickness / 2;
  return segment.orientation === 'h'
    ? { x0: segment.start, x1: segment.end, y0: segment.position - half, y1: segment.position + half }
    : { x0: segment.position - half, x1: segment.position + half, y0: segment.start, y1: segment.end };
}

/** Which border segment, if any, covers most of the given edge. */
function findBorder(
  segments: RuleSegment[],
  orientation: 'h' | 'v',
  position: number,
  start: number,
  end: number,
): Border | null {
  const span = end - start;
  if (span <= 0) return null;

  let covered = 0;
  let best: RuleSegment | null = null;
  for (const segment of segments) {
    if (segment.orientation !== orientation) continue;
    if (Math.abs(segment.position - position) > 2.2) continue;
    const overlap = Math.min(end, segment.end) - Math.max(start, segment.start);
    if (overlap <= 0) continue;
    covered += overlap;
    if (!best || segment.thickness > best.thickness) best = segment;
  }

  return best && covered >= span * 0.6 ? { color: best.color, width: best.thickness } : null;
}

interface TableCandidate {
  rect: Rect;
  xs: number[];
  ys: number[];
  segments: RuleSegment[];
  fills: Shape[];
  shapes: Set<Shape>;
}

function findTables(shapes: Shape[]): { tables: TableCandidate[]; used: Set<Shape> } {
  const segments = shapes.flatMap(toRuleSegments);
  const used = new Set<Shape>();
  if (segments.length < 4) return { tables: [], used };

  const rects = segments.map(segmentRect);
  const uf = new UnionFind(segments.length);
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      if (touches(rects[i], rects[j], 1.5)) uf.join(i, j);
    }
  }

  const fills = shapes.filter(
    (shape) => shape.paint === 'fill' && shape.axisAligned && !isWhitish(shape.color) && toRuleSegments(shape).length === 0,
  );

  const tables: TableCandidate[] = [];

  for (const group of uf.groups()) {
    const members = group.map((index) => segments[index]);
    const horizontals = members.filter((segment) => segment.orientation === 'h');
    const verticals = members.filter((segment) => segment.orientation === 'v');
    if (horizontals.length < 2 || verticals.length < 2) continue;

    const rect = group.map((index) => rects[index]).reduce(union);
    if (width(rect) < 20 || height(rect) < 8) continue;

    const xs = clusterValues(
      [...verticals.map((s) => s.position), ...horizontals.flatMap((s) => [s.start, s.end])],
      2.5,
    );
    const ys = clusterValues(
      [...horizontals.map((s) => s.position), ...verticals.flatMap((s) => [s.start, s.end])],
      2.5,
    );

    // Drop grid lines so close together they are the same border drawn twice.
    const dedupe = (values: number[]) =>
      values.filter((value, index) => index === 0 || value - values[index - 1] > 3);

    const gridXs = dedupe(xs);
    const gridYs = dedupe(ys);
    if (gridXs.length < 2 || gridYs.length < 2) continue;

    const tableFills = fills.filter((fill) => {
      const overlap = intersect(fill.rect, rect);
      return overlap && area(overlap) >= area(fill.rect) * 0.8;
    });

    const shapeSet = new Set(members.map((segment) => segment.shape));
    for (const fill of tableFills) shapeSet.add(fill);

    tables.push({ rect, xs: gridXs, ys: gridYs, segments: members, fills: tableFills, shapes: shapeSet });
  }

  // A single empty box is a frame or a shape, not a table; its fate is decided
  // with the other drawings.
  const real = tables.filter((table) => table.xs.length > 2 || table.ys.length > 2);
  for (const table of real) for (const shape of table.shapes) used.add(shape);
  return { tables: real, used };
}

/* ==========================================================================
   Context shared across the document
   ========================================================================== */

interface Context {
  margins: DocumentModel['margins'];
  pageWidth: number;
  /** Typical baseline-to-baseline distance, keyed by font size ×2. */
  pitch: Map<number, number>;
  /**
   * Left edges many lines on the current page start at. A line starting on one
   * of these is aligned to it, however centred it happens to look.
   */
  edges: number[];
}

function pitchFor(context: Context, size: number): number {
  return context.pitch.get(Math.round(size * 2)) ?? size * 1.15;
}

/* ==========================================================================
   Paragraph building
   ========================================================================== */

const MARKER =
  /^(?:[•●○◦▪■□➢➤►✓✔\-–*]|\(?[0-9]{1,3}[.)]|[0-9]{1,3}(?:\.[0-9]{1,3}){1,4}\.?|\(?[a-zA-Z][.)]|\(?[ivxlcIVXLC]{1,5}[.)])$/;

interface Container {
  left: number;
  right: number;
}

interface WorkingParagraph {
  lines: Line[];
  segments: Segment[][];
  markerEnd: number | null;
  textX: number | null;
  tabbed: boolean;
}

/** The text after a list marker starts here, if the line opens with one. */
function markerOf(line: Line): { markerEnd: number; textX: number } | null {
  const visible = line.runs.filter((run) => !isBlank(run.text));
  if (visible.length < 2) {
    // A single fragment can still hold "1. Text" when the PDF wrote it as one.
    const run = visible[0];
    const match = run && /^(\S{1,5})(\s+)\S/.exec(run.text);
    if (run && match && MARKER.test(match[1]) && match[2].length >= 1) {
      const charWidth = (run.x1 - run.x0) / Math.max(1, run.text.length);
      const offset = (match[1].length + match[2].length) * charWidth;
      if (match[2].length >= 2) return { markerEnd: run.x0 + match[1].length * charWidth, textX: run.x0 + offset };
    }
    return null;
  }

  const first = visible[0];
  const text = first.text.trim();
  if (!MARKER.test(text)) return null;

  const next = visible[1];
  // A marker is separated by more than a word space: a tab or a hanging indent.
  if (next.x0 - first.x1 < first.size * 0.45) return null;
  return { markerEnd: first.x1, textX: next.x0 };
}

function lastWordFits(previous: Line, next: Line, container: Container): boolean {
  // Would the first word of `next` have fitted at the end of `previous`? If so
  // the author broke the line deliberately — a new paragraph.
  const first = next.runs.find((run) => !isBlank(run.text));
  if (!first) return true;
  const word = first.text.trimStart().split(/\s+/)[0] ?? '';
  const charWidth = (first.x1 - first.x0) / Math.max(1, first.text.length);
  // The average glyph width understates capitals and wide letters, so the
  // estimate is padded: wrongly splitting a wrapped line into two paragraphs
  // costs far more than keeping a genuine short line with its paragraph.
  const wordWidth = word.length * charWidth * 1.2;
  const space = first.size * 0.28;
  return previous.x1 + space + wordWidth + 2 < container.right;
}

function isCentered(line: Line, container: Container, context: Context): boolean {
  const middle = (line.x0 + line.x1) / 2;
  const center = (container.left + container.right) / 2;
  // In a narrow table column the whole slack may be a few points, so what
  // counts as "clearly indented from the left" scales with the column.
  const width = container.right - container.left;
  const inset = Math.min(12, width * 0.04);
  const tolerance = Math.min(3, Math.max(1, width * 0.04));
  if (Math.abs(middle - center) > tolerance || line.x0 <= container.left + inset) return false;
  if (markerOf(line)) return false;
  // A line that starts where many others start is left-aligned text whose
  // length merely happens to put its middle near the centre.
  return !context.edges.some((edge) => Math.abs(edge - line.x0) < 1);
}

function buildParagraphs(
  lines: Line[],
  container: Container,
  context: Context,
  page: number,
  underlined: Set<TextRun>,
): ParagraphBlock[] {
  const working: WorkingParagraph[] = [];

  for (const line of lines) {
    const segments = splitSegments(line);
    const marker = markerOf(line);
    const tabbed = segments.length > 1;
    const current = working[working.length - 1];

    const continues = (() => {
      if (!current || current.tabbed || tabbed || marker) return false;
      const previous = current.lines[current.lines.length - 1];
      if (Math.abs(previous.size - line.size) > 0.75) return false;

      const gap = line.baseline - previous.baseline;
      const expected =
        current.lines.length >= 2
          ? current.lines[current.lines.length - 1].baseline - current.lines[current.lines.length - 2].baseline
          : pitchFor(context, line.size);
      if (gap < line.size * 0.6 || gap > expected * 1.18 + 0.5) return false;

      if (isCentered(previous, container, context) || isCentered(line, container, context)) return false;

      // Continuation lines share one left edge (the text edge after a marker).
      const bodyX = current.lines.length >= 2 ? current.lines[1].x0 : current.textX;
      if (bodyX !== null && Math.abs(line.x0 - bodyX) > 2.5) return false;
      if (current.lines.length === 1 && current.textX === null && line.x0 > previous.x0 + 40) return false;

      return !lastWordFits(previous, line, container);
    })();

    if (continues) {
      current.lines.push(line);
      current.segments.push(segments);
    } else {
      working.push({
        lines: [line],
        segments: [segments],
        markerEnd: marker?.markerEnd ?? null,
        textX: marker?.textX ?? null,
        tabbed,
      });
    }
  }

  const paragraphs = working.map((paragraph) => finishParagraph(paragraph, container, context, page, underlined));

  // A one-line paragraph has no spacing of its own to measure, so it starts
  // with the document's usual line height. Where its neighbours sit closer
  // than that (a tight signature block), Word would push them apart — it
  // cannot use negative spacing — so the line height gives way instead.
  paragraphs.forEach((paragraph, index) => {
    if (paragraph.lineCount !== 1) return;
    const next = paragraphs[index + 1];
    const previous = paragraphs[index - 1];
    const gaps = [
      next ? next.firstBaseline - paragraph.lastBaseline : Number.POSITIVE_INFINITY,
      previous ? paragraph.firstBaseline - previous.lastBaseline : Number.POSITIVE_INFINITY,
    ].filter((gap) => gap > paragraph.size * 0.8);
    const tightest = Math.min(...gaps);
    if (tightest < paragraph.lineHeight) paragraph.lineHeight = tightest;
  });

  return paragraphs;
}

/** Whitespace at a paragraph's edges is invisible in the PDF but wraps in Word. */
function trimEdges(runs: StyledRun[]): void {
  while (runs.length > 0 && isBlank(runs[0].text)) runs.shift();
  while (runs.length > 0 && isBlank(runs[runs.length - 1].text)) runs.pop();
  if (runs.length === 0) return;
  runs[0] = { ...runs[0], text: runs[0].text.replace(/^[  ]+/, '') };
  const last = runs.length - 1;
  runs[last] = { ...runs[last], text: runs[last].text.replace(/[  ]+$/, '') };
}

const TOC_LEADER = /^(.*?\S)[ \t]*\.{4,}[ \t.]*(\S+)[ \t]*$/;

function finishParagraph(
  paragraph: WorkingParagraph,
  container: Container,
  context: Context,
  page: number,
  underlined: Set<TextRun>,
): ParagraphBlock {
  const { lines } = paragraph;
  const first = lines[0];
  const last = lines[lines.length - 1];
  const size = median(lines.map((line) => line.size), first.size);

  const baselines = lines.map((line) => line.baseline);
  const diffs = baselines.slice(1).map((value, index) => value - baselines[index]);
  const lineHeight = diffs.length > 0 ? median(diffs) : pitchFor(context, size);

  const runs: StyledRun[] = [];
  const tabs: TabStop[] = [];
  let indentLeft = first.x0 - container.left;
  let firstLine = 0;
  let indentRight = 0;
  let align: ParagraphBlock['align'] = 'left';

  if (paragraph.tabbed) {
    const segments = paragraph.segments[0];
    const fallbackFont = segments.flatMap((segment) => segment.runs).find((run) => !SYMBOL_FAMILIES.test(run.font.family))?.font;
    segments.forEach((segment, index) => {
      if (index > 0) {
        pushRun(runs, { ...toStyled(segment.runs[0], '\t', false) });
        const rightAligned = segment.x1 >= container.right - 3;
        tabs.push({
          position: (rightAligned ? segment.x1 : segment.x0) - container.left,
          alignment: rightAligned ? 'right' : 'left',
        });
      }
      for (const run of runsOfSegment(segment, underlined, fallbackFont)) pushRun(runs, run);
    });
    indentLeft = segments[0].x0 - container.left;
  } else {
    const fallbackFont = lines.flatMap((line) => line.runs).find((run) => !SYMBOL_FAMILIES.test(run.font.family))?.font;

    lines.forEach((line, index) => {
      const lineRuns = runsOfSegment(measure(line.runs), underlined, fallbackFont);

      if (index === 0 && paragraph.textX !== null) {
        // Marker, then a tab to the hanging indent — exactly how Word lists
        // are built, so the text column lines up as it did.
        const markerRuns: StyledRun[] = [];
        const rest: StyledRun[] = [];
        let seenMarker = false;
        const markerChars = line.runs
          .filter((run) => !isBlank(run.text))[0]
          ?.text.trim().length ?? 0;
        let consumed = 0;
        for (const run of lineRuns) {
          if (!seenMarker) {
            const trimmed = run.text.trimStart();
            const take = Math.min(trimmed.length, markerChars - consumed);
            if (take > 0) {
              markerRuns.push({ ...run, text: trimmed.slice(0, take) });
              consumed += take;
              const remainder = trimmed.slice(take).trimStart();
              if (consumed >= markerChars) {
                seenMarker = true;
                if (remainder) rest.push({ ...run, text: remainder });
              }
              continue;
            }
            seenMarker = true;
          }
          rest.push(run);
        }
        for (const run of markerRuns) pushRun(runs, run);
        pushRun(runs, { ...(rest[0] ?? markerRuns[0]), text: '\t' });
        rest[0] = rest[0] ? { ...rest[0], text: rest[0].text.trimStart() } : rest[0];
        for (const run of rest) if (run) pushRun(runs, run);
      } else {
        if (index > 0) {
          const previous = runs[runs.length - 1];
          // A word hyphenated across the line keeps its hyphen and loses the
          // space; everything else joins with one.
          if (previous && !/[-‐‑]$/.test(previous.text) && !/\s$/.test(previous.text)) {
            pushRun(runs, { ...lineRuns[0], text: ' ' });
          }
          if (lineRuns[0]) lineRuns[0] = { ...lineRuns[0], text: lineRuns[0].text.trimStart() };
        }
        for (const run of lineRuns) pushRun(runs, run);
      }
    });

    if (paragraph.textX !== null) {
      indentLeft = paragraph.textX - container.left;
      firstLine = -(paragraph.textX - first.x0);
    } else {
      const bodyX = lines.length >= 2 ? lines[1].x0 : first.x0;
      indentLeft = bodyX - container.left;
      firstLine = first.x0 - bodyX;
    }

    /* ------------------------------------------------------- alignment */
    const inner = lines.slice(0, -1);
    const containerWidth = container.right - container.left;

    if (lines.every((line) => isCentered(line, container, context))) {
      align = 'center';
      indentLeft = 0;
      firstLine = 0;
      // Word centres on the middle of the indents. Shifting that middle onto
      // the line's own centre puts it back to the point, even when the region
      // this text sits in is not exactly the column it was centred in.
      const axis = median(lines.map((line) => (line.x0 + line.x1) / 2));
      const offset = axis - (container.left + container.right) / 2;
      if (offset > 0.2) indentLeft = offset * 2;
      else if (offset < -0.2) indentRight = -offset * 2;
    } else if (
      lines.length === 1 &&
      first.x1 >= container.right - 3 &&
      first.x0 > container.left + containerWidth * 0.35
    ) {
      align = 'right';
      indentLeft = 0;
      firstLine = 0;
    } else if (inner.length > 0) {
      const rights = inner.map((line) => line.x1);
      const maxRight = Math.max(...rights);
      const spread = maxRight - Math.min(...rights);
      if (spread <= 2.5 && inner.length >= 1) {
        align = 'justify';
        indentRight = Math.max(0, container.right - maxRight - 1.5);
      }
    }
  }

  /* ------------------------------------------------- table of contents */
  const plain = runs.map((run) => run.text).join('');
  const leader = TOC_LEADER.exec(plain);
  if (leader && !paragraph.tabbed && lines.length === 1) {
    const titleEnd = leader[1].length;
    const numberStart = plain.lastIndexOf(leader[2]);
    const rebuilt: StyledRun[] = [];
    let offset = 0;
    for (const run of runs) {
      const start = offset;
      const end = offset + run.text.length;
      offset = end;
      const titlePart = run.text.slice(0, Math.max(0, Math.min(end, titleEnd) - start));
      if (titlePart) pushRun(rebuilt, { ...run, text: titlePart });
    }
    const numberRun = runs[runs.length - 1];
    pushRun(rebuilt, { ...numberRun, text: '\t' });
    pushRun(rebuilt, { ...numberRun, text: plain.slice(numberStart).trim() });
    runs.splice(0, runs.length, ...rebuilt);
    tabs.push({ position: first.x1 - container.left, alignment: 'right', leader: 'dot' });
    align = 'left';
    indentRight = 0;
  }

  trimEdges(runs);

  // A single line that nearly fills its width can wrap in Word over a fraction
  // of a point of metric difference, pushing the rest of the page down a line.
  // It has no following line to pull words from, so letting it run a little
  // past the edge changes nothing visible and removes that risk.
  if (lines.length === 1 && (align === 'left' || align === 'justify') && tabs.length === 0) {
    const slack = container.right - first.x1;
    if (slack < 24) indentRight = Math.min(indentRight, slack - 12);
  }

  return {
    kind: 'paragraph',
    page,
    runs,
    align,
    indentLeft,
    indentRight,
    firstLine,
    tabs,
    lineHeight,
    firstBaseline: first.baseline,
    lastBaseline: last.baseline,
    endPage: page,
    lineCount: lines.length,
    size,
  };
}

/* ==========================================================================
   Region segmentation (XY cut)
   ========================================================================== */

type Atom =
  | { kind: 'text'; line: Segment; rect: Rect }
  | { kind: 'block'; block: Block; rect: Rect };

type RegionNode =
  | { kind: 'leaf'; atoms: Atom[] }
  | { kind: 'stack'; children: RegionNode[] }
  | { kind: 'columns'; edges: number[]; children: RegionNode[]; rect: Rect };

const ROW_GAP = 5;
const GUTTER = 8;
const MIN_COLUMN = 36;

function splitY(atoms: Atom[]): Atom[][] {
  const sorted = [...atoms].sort((a, b) => a.rect.y0 - b.rect.y0);
  const chunks: Atom[][] = [];
  let bottom = Number.NEGATIVE_INFINITY;
  for (const atom of sorted) {
    if (chunks.length === 0 || atom.rect.y0 > bottom + ROW_GAP) {
      chunks.push([atom]);
      bottom = atom.rect.y1;
    } else {
      chunks[chunks.length - 1].push(atom);
      bottom = Math.max(bottom, atom.rect.y1);
    }
  }
  return chunks;
}

function splitX(atoms: Atom[]): { groups: Atom[][]; gutters: number[] } {
  const sorted = [...atoms].sort((a, b) => a.rect.x0 - b.rect.x0);
  const groups: Atom[][] = [];
  const gutters: number[] = [];
  let right = Number.NEGATIVE_INFINITY;
  for (const atom of sorted) {
    if (groups.length > 0 && atom.rect.x0 - right >= GUTTER) {
      gutters.push((right + atom.rect.x0) / 2);
      groups.push([atom]);
    } else if (groups.length === 0) {
      groups.push([atom]);
    } else {
      groups[groups.length - 1].push(atom);
    }
    right = Math.max(right, atom.rect.x1);
  }

  const valid =
    groups.length > 1 &&
    groups.every((group) => {
      const r = group.map((atom) => atom.rect).reduce(union);
      return width(r) >= MIN_COLUMN;
    });

  return valid ? { groups, gutters } : { groups: [atoms], gutters: [] };
}

function cut(atoms: Atom[], depth = 0): RegionNode {
  if (atoms.length <= 1 || depth > 8) return { kind: 'leaf', atoms };

  const chunks = splitY(atoms);
  const columnar = (group: Atom[]) => splitX(group).groups.length > 1;

  // Consecutive chunks that share the same column structure belong together:
  // a signature block is several rows of three columns, not several tables.
  // Consecutive chunks with no columns at all belong together too — they are
  // ordinary flowing text, and splitting them would cut paragraphs apart at
  // every line.
  const merged: { atoms: Atom[]; columnar: boolean }[] = [];
  for (const chunk of chunks) {
    const previous = merged[merged.length - 1];
    const isColumnar = columnar(chunk);

    // A chunk that sits inside one column (the signature image under "Dibuat
    // oleh") still belongs to the block, as long as it follows closely.
    const gap = previous
      ? Math.min(...chunk.map((atom) => atom.rect.y0)) - Math.max(...previous.atoms.map((atom) => atom.rect.y1))
      : Number.POSITIVE_INFINITY;
    if (
      previous &&
      previous.columnar &&
      (isColumnar || gap < 24) &&
      columnar([...previous.atoms, ...chunk])
    ) {
      previous.atoms.push(...chunk);
      continue;
    }
    if (previous && !previous.columnar && !isColumnar) {
      previous.atoms.push(...chunk);
      continue;
    }
    merged.push({ atoms: [...chunk], columnar: isColumnar });
  }

  if (merged.length > 1) {
    return { kind: 'stack', children: merged.map((chunk) => cut(chunk.atoms, depth + 1)) };
  }

  const { groups, gutters } = splitX(atoms);
  if (groups.length > 1) {
    const rect = atoms.map((atom) => atom.rect).reduce(union);
    return {
      kind: 'columns',
      edges: gutters,
      rect,
      children: groups.map((group) => cut(group, depth + 1)),
    };
  }

  return { kind: 'leaf', atoms };
}

function renderRegion(
  node: RegionNode,
  container: Container,
  context: Context,
  page: number,
  underlined: Set<TextRun>,
): Block[] {
  if (node.kind === 'stack') {
    return node.children.flatMap((child) => renderRegion(child, container, context, page, underlined));
  }

  if (node.kind === 'columns') {
    const edges = [container.left, ...node.edges, container.right];
    const cells: TableCell[] = node.children.map((child, index) => {
      const cellContainer = { left: edges[index], right: edges[index + 1] };
      return {
        row: 0,
        column: index,
        rowSpan: 1,
        columnSpan: 1,
        rect: { x0: edges[index], x1: edges[index + 1], y0: node.rect.y0, y1: node.rect.y1 },
        borders: { top: null, bottom: null, left: null, right: null },
        verticalAlign: 'top',
        blocks: renderRegion(child, cellContainer, context, page, underlined),
      };
    });

    const table: TableBlock = {
      kind: 'table',
      page,
      rect: { x0: container.left, x1: container.right, y0: node.rect.y0, y1: node.rect.y1 },
      columnEdges: edges,
      rows: [{ height: height(node.rect), top: node.rect.y0, page, cells }],
      cellPadding: 0,
      layout: true,
      endPage: page,
    };
    return [table];
  }

  // Leaf: text lines become paragraphs; blocks stay where they are in order.
  const blocks: { y: number; block: Block }[] = [];
  const textAtoms = node.atoms.filter((atom): atom is Extract<Atom, { kind: 'text' }> => atom.kind === 'text');
  const lineGroups = regroupLines(textAtoms.map((atom) => atom.line));

  // Paragraph building needs to see runs of consecutive text; a block in
  // between (a figure between two paragraphs) interrupts the run.
  const others = node.atoms.filter((atom): atom is Extract<Atom, { kind: 'block' }> => atom.kind === 'block');
  const sortedOthers = [...others].sort((a, b) => a.rect.y0 - b.rect.y0);

  let pending: Line[] = [];
  const flush = () => {
    if (pending.length === 0) return;
    for (const paragraph of buildParagraphs(pending, container, context, page, underlined)) {
      blocks.push({ y: paragraph.firstBaseline, block: paragraph });
    }
    pending = [];
  };

  let otherIndex = 0;
  for (const line of lineGroups) {
    while (otherIndex < sortedOthers.length && sortedOthers[otherIndex].rect.y0 < line.top) {
      flush();
      blocks.push({ y: sortedOthers[otherIndex].rect.y0, block: sortedOthers[otherIndex].block });
      otherIndex++;
    }
    pending.push(line);
  }
  flush();
  while (otherIndex < sortedOthers.length) {
    blocks.push({ y: sortedOthers[otherIndex].rect.y0, block: sortedOthers[otherIndex].block });
    otherIndex++;
  }

  return blocks.map((entry) => entry.block);
}

/** Segments that share a baseline form one line again (with their gaps intact). */
function regroupLines(segments: Segment[]): Line[] {
  const all = segments.flatMap((segment) => segment.runs);
  return buildLines(all);
}

/* ==========================================================================
   Page analysis
   ========================================================================== */

function underlineRuns(runs: TextRun[], segments: RuleSegment[]): { runs: Set<TextRun>; consumed: Set<Shape> } {
  const underlined = new Set<TextRun>();
  const consumed = new Set<Shape>();

  for (const segment of segments) {
    if (segment.orientation !== 'h' || segment.thickness > 2) continue;
    const hits = runs.filter(
      (run) =>
        !isBlank(run.text) &&
        segment.position >= run.baseline - 0.5 &&
        segment.position <= run.baseline + run.size * 0.3 &&
        run.x0 >= segment.start - 2 &&
        run.x1 <= segment.end + 2,
    );
    const covered = hits.reduce((sum, run) => sum + (run.x1 - run.x0), 0);
    if (hits.length > 0 && covered >= (segment.end - segment.start) * 0.6) {
      for (const run of hits) underlined.add(run);
      consumed.add(segment.shape);
    }
  }

  return { runs: underlined, consumed };
}

function analyzePage(content: PageContent, chrome: Chrome, context: Context): PageModel {
  const page = content.pageNumber;
  const bodyTop = chrome.bodyTop.get(page) ?? Number.NEGATIVE_INFINITY;
  const bodyBottom = chrome.bodyBottom.get(page) ?? Number.POSITIVE_INFINITY;
  const pageRect: Rect = { x0: 0, y0: 0, x1: content.width, y1: content.height };

  const inBody = (rect: Rect) => (rect.y0 + rect.y1) / 2 > bodyTop && (rect.y0 + rect.y1) / 2 < bodyBottom;

  let runs = content.runs.filter((run) => inBody({ x0: run.x0, x1: run.x1, y0: run.top, y1: run.bottom }));
  const images = content.images
    .map((image) => ({ ...image, rect: intersect(image.rect, pageRect) }))
    .filter((image): image is typeof image & { rect: Rect } => Boolean(image.rect) && area(image.rect!) >= 16)
    .filter((image) => inBody(image.rect));
  const shapes = content.shapes.filter(
    (shape) => inBody(shape.rect) && area(shape.rect) < content.width * content.height * 0.9,
  );

  /* ------------------------------------------- whole page as a picture */
  // A cover is typically one large picture with text laid over it. Rebuilding
  // that as text on top of an image cannot line up reliably, so the page is
  // carried over exactly as it looks.
  const imageArea = images.reduce((sum, image) => sum + area(image.rect), 0);
  const textOverImage = runs.some(
    (run) => !isBlank(run.text) && images.some((image) => contains(image.rect, (run.x0 + run.x1) / 2, run.baseline)),
  );
  if (imageArea >= content.width * content.height * 0.45 && textOverImage) {
    const figure: FigureBlock = {
      kind: 'figure',
      page,
      rect: pageRect,
      scale: 2.5,
      format: 'jpeg',
      fullPage: true,
    };
    return { pageNumber: page, width: content.width, height: content.height, blocks: [figure] };
  }

  context.edges = commonEdges(buildLines(runs));

  /* ----------------------------------------------------------- tables */
  const { tables, used } = findTables(shapes);

  const allSegments = shapes.filter((shape) => !used.has(shape)).flatMap(toRuleSegments);
  const underline = underlineRuns(runs, allSegments);

  const atoms: Atom[] = [];
  const claimed = new Set<TextRun>();

  const tableBlocks = tables.map((candidate) => buildTable(candidate, runs, images, claimed, context, page, underline.runs));

  /* ---------------------------------------------------------- figures */
  const drawings = shapes.filter(
    (shape) => !used.has(shape) && !underline.consumed.has(shape) && !(shape.paint === 'fill' && isWhitish(shape.color)),
  );

  type Item = { rect: Rect; image: boolean; shape?: Shape };
  const items: Item[] = [
    ...images
      .filter((image) => !tableBlocks.some((table) => claimsImage(table, image.rect)))
      .map((image) => ({ rect: image.rect, image: true })),
    ...drawings.map((shape) => ({ rect: shape.rect, image: false, shape })),
  ];

  const uf = new UnionFind(items.length);
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (touches(items[i].rect, items[j].rect, items[i].image && items[j].image ? 0 : 4)) uf.join(i, j);
    }
  }

  for (const group of uf.groups()) {
    const members = group.map((index) => items[index]);
    const rect = members.map((member) => member.rect).reduce(union);
    const hasImage = members.some((member) => member.image);

    // A lone horizontal line is a rule, not a picture.
    if (!hasImage && members.length <= 2 && height(rect) <= 3.5 && width(rect) >= 20) {
      const rule = members[0].shape!;
      const paragraph: ParagraphBlock = {
        kind: 'paragraph',
        page,
        runs: [],
        align: 'left',
        indentLeft: rect.x0 - context.margins.left,
        indentRight: Math.max(0, context.pageWidth - context.margins.right - rect.x1),
        firstLine: 0,
        tabs: [],
        lineHeight: 1,
        firstBaseline: rect.y0,
        lastBaseline: rect.y0,
        endPage: page,
        lineCount: 1,
        size: 1,
        rule: { color: rule.color, thickness: Math.max(0.5, height(rect)) },
      };
      atoms.push({ kind: 'block', block: paragraph, rect });
      continue;
    }

    // Tiny specks (stray clip remnants, invisible markers) are not content.
    if (!hasImage && (width(rect) < 3 || height(rect) < 3)) continue;

    // Rendered at the pictures' own resolution (2–3× of 72 dpi), so
    // screenshots stay legible without inflating the file.
    const scale = hasImage
      ? Math.min(3, Math.max(2, ...images.filter((image) => touches(image.rect, rect)).map((image) => image.nativeWidth / Math.max(1, width(image.rect)))))
      : 3;

    for (const run of runs) {
      if (claimed.has(run)) continue;
      if (contains(rect, (run.x0 + run.x1) / 2, (run.top + run.bottom) / 2, 0.5)) claimed.add(run);
    }

    const figure: FigureBlock = {
      kind: 'figure',
      page,
      rect: hasImage ? rect : expand(rect, 1),
      scale,
      format: hasImage ? 'jpeg' : 'png',
    };
    atoms.push({ kind: 'block', block: figure, rect: figure.rect });
  }

  for (const table of tableBlocks) atoms.push({ kind: 'block', block: table, rect: table.rect });

  /* ------------------------------------------------------------- text */
  runs = runs.filter((run) => !claimed.has(run));
  for (const line of buildLines(runs)) {
    for (const segment of splitSegments(line)) {
      atoms.push({
        kind: 'text',
        line: segment,
        rect: { x0: segment.x0, x1: segment.x1, y0: segment.top, y1: segment.bottom },
      });
    }
  }

  const container = {
    left: context.margins.left,
    right: content.width - context.margins.right,
  };

  const tree = cut(atoms);
  const blocks = renderRegion(tree, container, context, page, underline.runs);

  return { pageNumber: page, width: content.width, height: content.height, blocks };
}

function commonEdges(lines: Line[]): number[] {
  const counts = new Map<number, number>();
  for (const line of lines) {
    const key = Math.round(line.x0 * 2) / 2;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count >= 3).map(([edge]) => edge);
}

function claimsImage(table: TableBlock, rect: Rect): boolean {
  return contains(table.rect, (rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2);
}

function buildTable(
  candidate: TableCandidate,
  runs: TextRun[],
  images: { rect: Rect; nativeWidth: number }[],
  claimed: Set<TextRun>,
  context: Context,
  page: number,
  underlined: Set<TextRun>,
): TableBlock {
  const { xs, ys, segments } = candidate;
  const rows = ys.length - 1;
  const columns = xs.length - 1;

  const index = (r: number, c: number) => r * columns + c;
  const uf = new UnionFind(rows * columns);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      if (c + 1 < columns && !findBorder(segments, 'v', xs[c + 1], ys[r], ys[r + 1])) {
        uf.join(index(r, c), index(r, c + 1));
      }
      if (r + 1 < rows && !findBorder(segments, 'h', ys[r + 1], xs[c], xs[c + 1])) {
        uf.join(index(r, c), index(r + 1, c));
      }
    }
  }

  const cells: TableCell[] = [];
  const seen = new Set<number>();

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const root = uf.find(index(r, c));
      if (seen.has(root)) continue;
      seen.add(root);

      // The merged region's grid extent.
      let r1 = r;
      let c1 = c;
      for (let rr = r; rr < rows; rr++) {
        for (let cc = c; cc < columns; cc++) {
          if (uf.find(index(rr, cc)) === root) {
            r1 = Math.max(r1, rr);
            c1 = Math.max(c1, cc);
          }
        }
      }

      const rect: Rect = { x0: xs[c], x1: xs[c1 + 1], y0: ys[r], y1: ys[r1 + 1] };

      let fill: string | undefined;
      let bestOverlap = 0;
      for (const shape of candidate.fills) {
        const overlap = intersect(shape.rect, rect);
        const size = overlap ? area(overlap) : 0;
        if (size >= area(rect) * 0.45 && size > bestOverlap) {
          bestOverlap = size;
          fill = shape.color;
        }
      }

      cells.push({
        row: r,
        column: c,
        rowSpan: r1 - r + 1,
        columnSpan: c1 - c + 1,
        rect,
        fill,
        borders: {
          top: findBorder(segments, 'h', rect.y0, rect.x0, rect.x1),
          bottom: findBorder(segments, 'h', rect.y1, rect.x0, rect.x1),
          left: findBorder(segments, 'v', rect.x0, rect.y0, rect.y1),
          right: findBorder(segments, 'v', rect.x1, rect.y0, rect.y1),
        },
        verticalAlign: 'top',
        blocks: [],
      });
    }
  }

  /* ------------------------------------------------ cell content */
  const cellRuns = new Map<TableCell, TextRun[]>();
  for (const run of runs) {
    if (claimed.has(run) || isBlank(run.text)) continue;
    const cx = (run.x0 + run.x1) / 2;
    const cy = (run.top + run.bottom) / 2;
    const cell = cells.find((candidateCell) => contains(candidateCell.rect, cx, cy));
    if (!cell) continue;
    claimed.add(run);
    cellRuns.set(cell, [...(cellRuns.get(cell) ?? []), run]);
  }
  // Spaces travel with the words they separate.
  for (const run of runs) {
    if (claimed.has(run) || !isBlank(run.text)) continue;
    const cx = (run.x0 + run.x1) / 2;
    const cell = cells.find((candidateCell) => contains(candidateCell.rect, cx, run.baseline - run.size * 0.3));
    if (cell && cellRuns.has(cell)) {
      claimed.add(run);
      cellRuns.get(cell)!.push(run);
    }
  }

  // Padding is what Word calls the cell margin: the distance from the border
  // to where left-aligned text starts. It is shared by the whole table.
  const leftGaps: number[] = [];
  for (const [cell, list] of cellRuns) {
    const x = Math.min(...list.filter((run) => !isBlank(run.text)).map((run) => run.x0));
    const gap = x - cell.rect.x0;
    if (gap >= 0 && gap < 20) leftGaps.push(gap);
  }
  const cellPadding = Math.max(0, Math.min(10, percentile(leftGaps, 0.1, 5.4)));

  // Tables are usually set tighter than body text; a one-line cell has no
  // spacing of its own to measure, so it takes the table's.
  const cellLines = new Map<TableCell, Line[]>();
  for (const cell of cells) cellLines.set(cell, buildLines(cellRuns.get(cell) ?? []));
  const local = pitchFromLineGroups([...cellLines.values()]);
  const tableContext: Context = { ...context, pitch: new Map([...context.pitch, ...local]) };
  if (local.size === 0) {
    // No multi-line cell to learn from: single spacing for the table's text.
    for (const lines of cellLines.values()) {
      for (const line of lines) tableContext.pitch.set(Math.round(line.size * 2), line.size * 1.15);
    }
  }

  for (const cell of cells) {
    const lines = cellLines.get(cell) ?? [];

    // A narrow column ("Jan", "Feb" in a timeline) may have been set with
    // tighter margins than the rest; keeping the table's margin there would
    // wrap "Apr" into "Ap / r".
    const widest = Math.max(0, ...lines.map((line) => line.x1 - line.x0));
    const room = (cell.rect.x1 - cell.rect.x0 - widest) / 2 - 0.6;
    if (lines.length > 0 && room < cellPadding) cell.padding = Math.max(0, room);
    const padding = cell.padding ?? cellPadding;
    const container = { left: cell.rect.x0 + padding, right: cell.rect.x1 - padding };

    const figures: Block[] = images
      .filter((image) => contains(cell.rect, (image.rect.x0 + image.rect.x1) / 2, (image.rect.y0 + image.rect.y1) / 2))
      .map((image) => ({
        kind: 'figure' as const,
        page,
        rect: image.rect,
        scale: Math.min(3, Math.max(2, image.nativeWidth / Math.max(1, width(image.rect)))),
        format: 'jpeg' as const,
      }));

    const paragraphs = lines.length > 0 ? buildParagraphs(lines, container, tableContext, page, underlined) : [];
    cell.blocks = [...paragraphs, ...figures].sort((a, b) => blockTop(a) - blockTop(b));

    if (lines.length > 0) {
      const top = Math.min(...lines.map((line) => line.top));
      const bottom = Math.max(...lines.map((line) => line.bottom));
      const above = top - cell.rect.y0;
      const below = cell.rect.y1 - bottom;
      if (above > 3 && below > 3 && Math.abs(above - below) < Math.max(2.5, (above + below) * 0.15)) {
        cell.verticalAlign = 'center';
      } else if (above > 3 && below <= 3 && above > below * 3) {
        cell.verticalAlign = 'bottom';
      }
    }
  }

  return {
    kind: 'table',
    page,
    rect: candidate.rect,
    columnEdges: xs,
    rows: Array.from({ length: rows }, (_, r) => ({
      height: ys[r + 1] - ys[r],
      top: ys[r],
      page,
      cells: cells.filter((cell) => cell.row === r),
    })),
    cellPadding,
    layout: false,
    endPage: page,
  };
}

export function blockTop(block: Block): number {
  if (block.kind === 'paragraph') return block.firstBaseline - block.size;
  return block.rect.y0;
}

/* ==========================================================================
   Document
   ========================================================================== */

function computePitch(pages: PageContent[]): Map<number, number> {
  return pitchFromLineGroups(pages.map((page) => buildLines(page.runs)));
}

/** Typical baseline distance per font size, from groups of consecutive lines. */
function pitchFromLineGroups(groups: Line[][]): Map<number, number> {
  const samples = new Map<number, number[]>();
  for (const lines of groups) {
    for (let i = 1; i < lines.length; i++) {
      const a = lines[i - 1];
      const b = lines[i];
      if (Math.abs(a.size - b.size) > 0.3 || Math.abs(a.x0 - b.x0) > 30) continue;
      const diff = b.baseline - a.baseline;
      if (diff < a.size || diff > a.size * 2.2) continue;
      const key = Math.round(a.size * 2);
      samples.set(key, [...(samples.get(key) ?? []), diff]);
    }
  }
  const pitch = new Map<number, number>();
  for (const [key, values] of samples) pitch.set(key, mode(values, 0.1));
  return pitch;
}

function computeMargins(pages: PageContent[], chrome: Chrome): DocumentModel['margins'] {
  const first = pages[0];
  const W = first.width;
  const H = first.height;

  const lefts: number[] = [];
  const rights: number[] = [];
  const tops: number[] = [];
  const bottoms: number[] = [];

  for (const page of pages) {
    const top = chrome.bodyTop.get(page.pageNumber) ?? Number.NEGATIVE_INFINITY;
    const bottom = chrome.bodyBottom.get(page.pageNumber) ?? Number.POSITIVE_INFINITY;
    const lines = buildLines(page.runs).filter((line) => line.top > top && line.bottom < bottom);
    for (const line of lines) {
      if (line.x1 - line.x0 > W * 0.3) lefts.push(line.x0);
      if (line.x1 - line.x0 > W * 0.5) rights.push(line.x1);
    }
    const body = [
      ...lines.map((line) => ({ y0: line.top, y1: line.bottom })),
      ...page.images.map((image) => image.rect).filter((rect) => rect.y0 > top && rect.y1 < bottom),
    ];
    if (body.length > 0) {
      tops.push(Math.min(...body.map((rect) => rect.y0)));
      bottoms.push(Math.max(...body.map((rect) => rect.y1)));
    }
  }

  // Word decides line breaks against the text column width to a fraction of a
  // point — measured: 451.2pt reproduces the original's breaks, 451.64pt pulls
  // an extra word onto a line and reflows the whole paragraph. So the edges
  // are taken from where justified lines actually end (the most common right
  // edge, not an outlier), then snapped to the units Word margins are set in.
  const left = snapMargin(Math.max(18, Math.min(mode(lefts, 0.1, 72), percentile(lefts, 0.02, 72))));
  const right = snapMargin(Math.max(18, W - mode(rights, 0.1, W - 72)));

  // Top and bottom are chosen so the tallest page still fits: the converted
  // document inserts a page break before each original page, so a margin
  // that is too generous would push the last lines onto a page of their own.
  const top = Math.max(14, Math.min(72, percentile(tops, 0.05, 72) - 2));
  let bottom = Math.max(14, Math.min(72, H - Math.max(...bottoms, H - 72) - 4));
  if (chrome.footer) bottom = Math.max(14, Math.min(bottom, H - chrome.footer.top - 2));

  return { top, bottom, left, right };
}

/**
 * Margins in Word are set in centimetres or inches, so a measured margin that
 * sits within half a point of 0.1 cm or 0.05 in is almost certainly that
 * value, and using it exactly keeps the text width — and line breaks — exact.
 */
function snapMargin(value: number): number {
  const grids = [72 / 2.54 / 10, 3.6]; // 0.1 cm, 0.05 in
  const candidates = [
    Math.round(value / grids[0]) * grids[0],
    Math.round(value / grids[1]) * grids[1],
  ];
  let best = value;
  let distance = 0.5;
  for (const candidate of candidates) {
    const d = Math.abs(candidate - value);
    if (d <= distance) {
      best = candidate;
      distance = d;
    }
  }
  return Math.round(best * 1000) / 1000;
}

export function analyzeDocument(pages: PageContent[]): DocumentModel {
  if (pages.length === 0) throw new Error('Tidak ada halaman untuk dianalisis');

  const chrome = detectChrome(pages);
  const margins = computeMargins(pages, chrome);
  const context: Context = { margins, pageWidth: pages[0].width, pitch: computePitch(pages), edges: [] };

  // Content split by a page break stays split, deliberately. Rejoining it
  // hands pagination back to Word, whose widow control and page capacity do not
  // match the application that made the PDF — the break moves by a line, and
  // every page after it shifts. Keeping the PDF's own breaks is what keeps
  // page N of the Word file identical to page N of the PDF.
  const models = pages.map((page) => analyzePage(page, chrome, context));

  return {
    pageWidth: pages[0].width,
    pageHeight: pages[0].height,
    margins,
    pages: models,
    footer: chrome.footer,
    header: chrome.header,
    firstPageNumber: Math.max(1, chrome.firstPageNumber),
  };
}
