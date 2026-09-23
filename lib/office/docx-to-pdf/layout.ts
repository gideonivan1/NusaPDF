/**
 * Typesets a parsed .docx into pages of positioned drawing operations, the
 * way Word does it: greedy line breaking on real glyph widths, Word's line
 * heights, paragraph spacing, tab stops, widow/orphan control, keep-with-next,
 * table rows that break across pages, floating objects placed against the
 * page, margin, or paragraph with text wrapping around them, and
 * headers/footers laid out per page.
 *
 * Every y coordinate is top-down in points, like the page Word shows.
 */

import type { Anchor, Block, Cell, DocxDocument, Inline, Paragraph, Section, Shape, ShapeBox, Table } from './document';
import { Face, fileFor, mapSymbols, symbolMetrics } from './fonts';
import { formatNumber, type BorderLine, type CellMargins, type ParaProps, type RunProps, type TabStop } from './styles';

/* ==========================================================================
   Output
   ========================================================================== */

export type DrawOp =
  | { kind: 'text'; x: number; y: number; text: string; face: Face; size: number; color: string }
  | {
      kind: 'rect';
      x: number;
      y: number;
      w: number;
      h: number;
      fill?: string;
      fillOpacity?: number;
      stroke?: string;
      strokeWidth?: number;
      strokeOpacity?: number;
    }
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number; color: string; width: number; dash?: number[] }
  | { kind: 'image'; x: number; y: number; w: number; h: number; image: string; crop?: { left: number; top: number; right: number; bottom: number } }
  | {
      kind: 'path';
      d: string;
      fill?: string;
      fillOpacity?: number;
      stroke?: string;
      strokeWidth?: number;
      strokeOpacity?: number;
    };

/** Stacking: behind-text objects, then the text layer, then objects in front. */
export interface Layered {
  layer: 0 | 1 | 2;
  order: number;
  op: DrawOp;
}

export interface LaidOutPage {
  width: number;
  height: number;
  ops: Layered[];
}

/* ==========================================================================
   Word's own layout constants — measured against Word, not the spec
   ========================================================================== */

/** "Exactly" line spacing puts the baseline at this fraction of the line. */
const EXACT_BASELINE = 0.8;

/**
 * In justified paragraphs Word squeezes word spaces to fit one more word on
 * a line. Measured against Word 365 with the exact glyph widths: lines that
 * needed spaces squeezed by 15.4% and 24.2% were taken; 25.3%, 25.7%, and
 * 26.8% were refused. So a space may shrink to 75% of its width. Without
 * this the text wraps a word earlier than Word on many lines.
 */
const MIN_SPACE_RATIO = 0.75;

/** Stacking order that puts headers and footers under body drawings. */
const CHROME_ORDER = -1e12;

/* ==========================================================================
   Items and lines
   ========================================================================== */

interface TextItem {
  t: 'text';
  text: string;
  face: Face;
  size: number;
  color: string;
  props: RunProps;
  width: number;
  space: boolean;
  /** No break opportunity before this item (it continues a word). */
  glue: boolean;
  rise: number;
  /** Part of a list label — sized by, but not the basis of, line spacing. */
  label?: boolean;
}

interface TabItem {
  t: 'tab';
  face: Face;
  size: number;
  props: RunProps;
  ptab?: { align: 'left' | 'center' | 'right'; relativeTo: 'margin' | 'indent' };
}

interface BreakItem {
  t: 'break';
  type: 'line' | 'page' | 'column';
  face: Face;
  size: number;
}

interface ImageItem {
  t: 'image';
  width: number;
  height: number;
  image: string;
  crop?: { left: number; top: number; right: number; bottom: number };
  glue: boolean;
}

interface AnchorItem {
  t: 'anchor';
  anchor: Anchor;
}

type Item = TextItem | TabItem | BreakItem | ImageItem | AnchorItem;

interface Placed {
  item: Item;
  x: number;
  width: number;
  /** Tab leader to draw across this span. */
  leader?: { from: number; to: number; char: string };
}

interface Line {
  placed: Placed[];
  /** Where the line's text ends (trailing spaces excluded). */
  end: number;
  start: number;
  limit: number;
  ascent: number;
  descent: number;
  height: number;
  baseline: number;
  pageBreak: boolean;
  endsWithBreak: boolean;
  last: boolean;
  /**
   * Line-spacing space below the text. Word lets it hang past the bottom
   * margin: a line fits a page when its text does.
   */
  hang: number;
}

export interface LayoutContext {
  doc: DocxDocument;
  face: (props: RunProps) => Face;
  pageNumber?: number;
  totalPages?: number;
  pageFormat?: string;
  /** Reports where each body paragraph's first line landed (page index, top). */
  onParagraph?: (paragraph: Paragraph, page: number, top: number, heights: number[]) => void;
}

function fontName(props: RunProps, doc: DocxDocument): string {
  if (props.font) return props.font;
  const theme = props.fontTheme ?? 'minorHAnsi';
  return theme.startsWith('major') ? doc.theme.majorFont : doc.theme.minorFont;
}

export function faceKey(props: RunProps, doc: DocxDocument): string {
  const name = fontName(props, doc);
  const file = fileFor(name, Boolean(props.bold), Boolean(props.italic));
  return symbolMetrics(name) ? file + '|' + name.trim().toLowerCase() : file;
}

/* ==========================================================================
   Paragraph → items
   ========================================================================== */

const SIZE_DEFAULT = 11;

function sizeOf(props: RunProps): number {
  return props.size ?? SIZE_DEFAULT;
}

function itemsOf(paragraph: Paragraph, context: LayoutContext): Item[] {
  const items: Item[] = [];
  const doc = context.doc;

  const pushText = (raw: string, props: RunProps, label = false) => {
    const face = context.face(props);
    let text = mapSymbols(raw, fontName(props, doc));
    if (props.caps || props.smallCaps) text = text.toUpperCase();
    const baseSize = sizeOf(props);
    const scripted = props.vertAlign === 'superscript' || props.vertAlign === 'subscript';
    const size = scripted ? baseSize * 0.65 : props.smallCaps ? baseSize * 0.8 : baseSize;
    const rise = props.vertAlign === 'superscript' ? baseSize * 0.33 : props.vertAlign === 'subscript' ? -baseSize * 0.14 : 0;
    const color = props.color ?? '#000000';
    const spacing = props.spacing ?? 0;

    // Words and spaces become separate items; a word may also break after a
    // hyphen or dash, as Word allows.
    const parts = text.match(/[  　]+|[^  　]+/g) ?? [];
    for (const part of parts) {
      const isSpace = /^[ 　]+$/.test(part);
      const pieces = isSpace ? [part] : part.split(/(?<=[-‐–—](?=\S))/);
      pieces.forEach((piece, index) => {
        const previous = items[items.length - 1];
        const glue =
          !isSpace &&
          index === 0 &&
          previous !== undefined &&
          ((previous.t === 'text' && !previous.space && !/[-‐–—]$/.test(previous.text)) || previous.t === 'image');
        items.push({
          t: 'text',
          text: piece,
          face,
          size,
          color,
          props,
          width: face.width(piece, size) + spacing * [...piece].length,
          space: isSpace,
          glue: glue || (!isSpace && index > 0 ? false : glue),
          rise,
          label,
        });
      });
    }
  };

  if (paragraph.label && !paragraph.label.props.vanish) {
    pushText(paragraph.label.text, paragraph.label.props, true);
    const labelFace = context.face(paragraph.label.props);
    if (paragraph.label.suffix === 'tab') {
      items.push({ t: 'tab', face: labelFace, size: sizeOf(paragraph.label.props), props: paragraph.label.props });
    } else if (paragraph.label.suffix === 'space') {
      pushText(' ', paragraph.label.props, true);
    }
  }

  for (const inline of paragraph.inlines) {
    switch (inline.kind) {
      case 'text':
        pushText(inline.text, inline.props);
        break;
      case 'tab':
        items.push({ t: 'tab', face: context.face(inline.props), size: sizeOf(inline.props), props: inline.props, ptab: inline.ptab });
        break;
      case 'break':
        items.push({ t: 'break', type: inline.type, face: context.face(inline.props), size: sizeOf(inline.props) });
        break;
      case 'field': {
        const value =
          inline.field === 'PAGE'
            ? formatNumber(context.pageNumber ?? 1, context.pageFormat ?? 'decimal')
            : String(context.totalPages ?? context.pageNumber ?? 1);
        pushText(value, inline.props);
        break;
      }
      case 'image': {
        const previous = items[items.length - 1];
        items.push({
          t: 'image',
          width: inline.width,
          height: inline.height,
          image: inline.image,
          crop: inline.crop,
          glue: previous !== undefined && previous.t === 'text' && !previous.space,
        });
        break;
      }
      case 'anchor':
        items.push({ t: 'anchor', anchor: inline.anchor });
        break;
    }
  }

  return items;
}

/* ==========================================================================
   Line breaking
   ========================================================================== */

function tabStops(props: ParaProps): TabStop[] {
  return (props.tabs ?? []).filter((tab) => tab.align !== 'clear' && tab.align !== 'bar');
}

const LEADER: Record<string, string> = { dot: '.', hyphen: '-', underscore: '_', middleDot: '·', heavy: '_' };

/**
 * Where a line may go: a stretch of the column, in column coordinates. Text
 * wrapping around a floating object is set in such stretches.
 */
interface Range {
  from: number;
  to: number;
}

/** A line broken but not yet taken, and where the next one starts. */
interface Attempt {
  line: Line;
  next: number;
  /** A word split by character leaves its rest to be put back in the items. */
  rest?: { at: number; item: TextItem };
}

/**
 * Word does not set an empty line (a bare paragraph mark) in a gap beside a
 * floating object narrower than this. Measured: 8pt gaps were skipped, 12pt
 * gaps took a stack of empty paragraphs.
 */
const EMPTY_LINE_MIN_GAP = 10;

/**
 * Breaks a paragraph into lines one at a time. Most lines use the column's
 * full width; beside a floating object a line is tried in a narrower range,
 * and refused when not even its first word fits there — Word then moves on.
 */
class LineBreaker {
  private readonly props: ParaProps;
  private readonly indLeft: number;
  private readonly firstLine: number;
  private readonly fullLimit: number;
  private readonly stops: TabStop[];
  private readonly defaultTab: number;
  private readonly markFace: Face;
  private readonly markSize: number;
  private readonly squeezes: boolean;
  private readonly items: Item[];
  private readonly width: number;
  private i = 0;
  private emitted = 0;
  /** How far a right- or centre-aligned list number sits left of the indent. */
  private readonly labelShift: number = 0;

  constructor(paragraph: Paragraph, items: Item[], width: number, context: LayoutContext) {
    const props = paragraph.props;
    this.props = props;
    this.items = items;
    this.width = width;
    this.indLeft = props.indLeft ?? 0;
    this.firstLine = props.firstLine ?? 0;
    this.fullLimit = width - (props.indRight ?? 0);
    this.stops = tabStops(props);
    this.defaultTab = context.doc.settings.defaultTabStop || 36;
    this.markFace = context.face(paragraph.mark);
    this.markSize = sizeOf(paragraph.mark);
    this.squeezes = props.align === 'both' || props.align === 'distribute';
    // A right-aligned number ends at the indent (lvlJc="right"), so 1.1 and
    // 1.10 line up on their last digit; a centred one straddles it.
    const align = paragraph.label?.align;
    if (align === 'right' || align === 'center') {
      let labelWidth = 0;
      for (const item of items) {
        if (item.t !== 'text' || !item.label || item.space) break;
        labelWidth += item.width;
      }
      this.labelShift = align === 'right' ? labelWidth : labelWidth / 2;
    }
  }

  /** Every item is on a line (and there is at least one line). */
  done(): boolean {
    return this.emitted > 0 && this.i >= this.items.length;
  }

  /** Whether what is left is only floating objects and the paragraph mark. */
  private emptyRest(): boolean {
    for (let j = this.i; j < this.items.length; j++) if (this.items[j].t !== 'anchor') return false;
    return true;
  }

  /** Takes the line from `attempt`, moving past its items. */
  commit(attempt: Attempt): Line {
    if (attempt.rest) this.items.splice(attempt.rest.at, 0, attempt.rest.item);
    let i = attempt.next;
    // Leading spaces after an automatic wrap are dropped, as Word does.
    while (!attempt.line.endsWithBreak && i < this.items.length && this.items[i].t === 'text' && (this.items[i] as TextItem).space) i++;
    this.i = i;
    this.emitted++;
    attempt.line.last = i >= this.items.length;
    return attempt.line;
  }

  /** Where a tab starting at x goes, and how it aligns the text after it. */
  private nextStop(x: number): TabStop {
    const custom = this.stops.find((stop) => stop.pos > x + 0.01);
    // A hanging indent acts as a tab stop, the way numbered lists line up.
    if (this.firstLine < 0 && x < this.indLeft - 0.01 && (!custom || custom.pos > this.indLeft)) {
      return { pos: this.indLeft, align: 'left', leader: 'none' };
    }
    if (custom) return custom;
    const pos = (Math.floor(x / this.defaultTab + 1e-6) + 1) * this.defaultTab;
    return { pos, align: 'left', leader: 'none' };
  }

  /** Width of the text after index `from` up to the next tab or break. */
  private segmentWidth(from: number): number {
    let total = 0;
    for (let j = from; j < this.items.length; j++) {
      const item = this.items[j];
      if (item.t === 'tab' || item.t === 'break') break;
      if (item.t === 'text' || item.t === 'image') total += item.width;
    }
    return total;
  }

  /**
   * Breaks the next line without taking it. Given a `range`, the line must
   * fit in it: null when not even its first word does.
   */
  attempt(range?: Range): Attempt | null {
    const { items, indLeft, firstLine, squeezes } = this;
    const strict = range !== undefined;
    const indentStart = this.emitted === 0 ? indLeft + firstLine : indLeft;
    const start = range ? Math.max(indentStart, range.from) : indentStart;
    const limit = range ? Math.min(this.fullLimit, range.to) : this.fullLimit;
    // An empty line needs a gap of some width, and its indent inside it.
    if (strict && this.emptyRest() && (limit - range.from < EMPTY_LINE_MIN_GAP || limit < start - 0.01)) return null;

    let x = this.emitted === 0 ? start - this.labelShift : start;
    const placed: Placed[] = [];
    let lastBreak = -1;
    /** Space width after the last tab that justification may squeeze. */
    let squeezable = 0;
    let pageBreak = false;
    let endsWithBreak = false;
    let hasContent = false;
    let rest: Attempt['rest'];

    let j = this.i;
    for (; j < items.length; j++) {
      const item = items[j];

      if (item.t === 'break') {
        placed.push({ item, x, width: 0 });
        endsWithBreak = true;
        pageBreak = item.type === 'page' || item.type === 'column';
        j++;
        break;
      }

      if (item.t === 'anchor') {
        placed.push({ item, x, width: 0 });
        continue;
      }

      if (item.t === 'tab') {
        const width = this.width;
        const stop: TabStop = item.ptab
          ? {
              pos:
                item.ptab.align === 'right'
                  ? item.ptab.relativeTo === 'indent' ? this.fullLimit : width
                  : item.ptab.align === 'center'
                    ? (item.ptab.relativeTo === 'indent' ? (indLeft + this.fullLimit) / 2 : width / 2)
                    : item.ptab.relativeTo === 'indent' ? indLeft : 0,
              align: item.ptab.align,
              leader: 'none',
            }
          : this.nextStop(x);
        let target = stop.pos;
        if (stop.align === 'right') target = Math.max(x, stop.pos - this.segmentWidth(j + 1));
        else if (stop.align === 'center') target = Math.max(x, stop.pos - this.segmentWidth(j + 1) / 2);
        else if (stop.align === 'decimal') target = Math.max(x, stop.pos - this.segmentWidth(j + 1));
        // A tab past the right edge wraps to the next line in Word; clamping
        // keeps it on this line, which is what short documents need.
        if (target > limit && stop.align === 'left' && hasContent) target = Math.max(x, limit);
        const entry: Placed = { item, x, width: Math.max(0, target - x) };
        if (stop.leader !== 'none' && target - x > 1) {
          entry.leader = { from: x, to: target, char: LEADER[stop.leader] ?? '.' };
        }
        placed.push(entry);
        x = target;
        lastBreak = placed.length - 1;
        squeezable = 0;
        hasContent = true;
        continue;
      }

      const itemWidth = item.width;
      const isSpace = item.t === 'text' && item.space;

      if (isSpace) {
        placed.push({ item, x, width: itemWidth });
        x += itemWidth;
        lastBreak = placed.length - 1;
        if (squeezes) squeezable += itemWidth * (1 - MIN_SPACE_RATIO);
        continue;
      }

      // Every space before this word can give, the one right before it too:
      // if the word fits, that space sits between words. Measured: Word took
      // a word needing 22.9% of all ten spaces on the line.
      const give = squeezes ? squeezable : 0;

      if (x + itemWidth > limit + give + 0.01 && hasContent) {
        if (item.t === 'text' && item.glue && lastBreak < 0) {
          // A word longer than the line: Word breaks it where it must.
          if (strict) return null;
          break;
        }
        if (item.t === 'text' && item.glue && lastBreak >= 0) {
          // Carry the whole word, including the parts already placed.
          const keep = placed.slice(0, lastBreak + 1);
          const dropped = placed.length - keep.length;
          placed.length = keep.length;
          j -= dropped;
        }
        break;
      }

      if (x + itemWidth > limit + 0.01 && !hasContent) {
        // Beside a floating object, a first word that does not fit sends the
        // line elsewhere.
        if (strict) return null;
        if (item.t === 'text' && itemWidth > limit - start) {
          // A single word wider than the whole line is split by character.
          let piece = '';
          for (const character of item.text) {
            if (x + item.face.width(piece + character, item.size) > limit && piece) break;
            piece += character;
          }
          const remainder = item.text.slice(piece.length);
          const head: TextItem = { ...item, text: piece, width: item.face.width(piece, item.size) };
          placed.push({ item: head, x, width: head.width });
          x += head.width;
          if (remainder) rest = { at: j + 1, item: { ...item, text: remainder, width: item.face.width(remainder, item.size), glue: false } };
          hasContent = true;
          j++;
          break;
        }
      }

      placed.push({ item, x, width: itemWidth });
      x += itemWidth;
      hasContent = true;
      if (item.t === 'text' && /[-‐–—]$/.test(item.text)) lastBreak = placed.length - 1;
    }

    // Beside an object, a list label does not go on a line of its own: the
    // label and the first word it introduces go together or not at all.
    if (strict && !this.emptyRest()) {
      const real = placed.some(({ item }) => (item.t === 'text' && !item.space && !item.label) || item.t === 'image');
      if (!real && !endsWithBreak) return null;
    }

    const line = this.finish(placed, start, limit, pageBreak, endsWithBreak);
    return { line, next: j, rest };
  }

  private finish(placed: Placed[], start: number, limit: number, pageBreak: boolean, endsWithBreak: boolean): Line {
    const { props, markFace, markSize } = this;
    let end = start;
    let ascent = 0;
    let descent = 0;
    let hasText = false;
    let visible = false;
    let picture = 0;
    /** One line of the text's own font: what multiple spacing multiplies. */
    let base = 0;
    for (const entry of placed) {
      const item = entry.item;
      if (item.t === 'text') {
        if (!item.label) base = Math.max(base, item.face.lineHeight(item.size));
        if (!item.space) end = Math.max(end, entry.x + entry.width);
        // A font's external leading sits above its ascent, so the line's top
        // part is the tallest ascent-plus-leading, not the two maxima added.
        ascent = Math.max(ascent, (item.face.ascent + item.face.leading) * item.size + item.rise);
        descent = Math.max(descent, item.face.descent * item.size);
        hasText = true;
        if (!item.space) visible = true;
      } else if (item.t === 'image') {
        end = Math.max(end, entry.x + entry.width);
        picture = Math.max(picture, item.height);
      } else if (item.t === 'tab') {
        // A tab never sizes its line. Measured: a 36pt tab among 11pt text,
        // at the start, middle, or end, left the line 13.44pt like the rest.
        end = Math.max(end, entry.x + entry.width);
      }
    }
    // The paragraph mark sizes a line with nothing visible on it: a line of
    // 5pt spaces ending in a 12pt mark is a 12pt line in Word, and an empty
    // line is sized by the mark alone. Beside visible text it does not count
    // — measured: an 11pt line ending in a 36pt mark stayed 13.44pt.
    if (!visible) {
      ascent = Math.max(ascent, (markFace.ascent + markFace.leading) * markSize);
      descent = Math.max(descent, markFace.descent * markSize);
      if (!visible) base = Math.max(base, markFace.lineHeight(markSize));
    }
    // A line holding only a picture is as tall as the picture — Word adds no
    // descent under it. Measured on three screenshots: the line is the
    // picture's height plus the line-spacing extra, nothing more.
    if (picture > 0) {
      if (visible) ascent = Math.max(ascent, picture);
      else if (picture >= ascent + descent) {
        ascent = picture;
        descent = 0;
      } else ascent = Math.max(ascent, picture);
    }

    const natural = ascent + descent;
    let height = natural;
    let baseline = ascent;
    const rule = props.lineRule ?? 'auto';
    const value = props.line ?? 240;

    if (rule === 'exact') {
      height = value;
      baseline = value * EXACT_BASELINE;
    } else if (rule === 'atLeast') {
      height = Math.max(natural, value);
      baseline = height - descent;
    } else {
      // Multiple spacing scales one line of the text's own font; anything
      // taller on the line (a picture, a Symbol bullet) adds only its excess.
      // Measured against Word: a 1.5-spaced Arial 12 line is 20.7pt whatever
      // the paragraph mark's font, and 21.54pt with a Symbol bullet — not 1.5
      // times the taller natural height. Empty and picture-only lines use the
      // paragraph mark's font.
      const single = base || markFace.lineHeight(markSize);
      height = natural + (value / 240 - 1) * single;
    }

    return {
      placed,
      end,
      start,
      limit,
      ascent,
      descent,
      height,
      baseline,
      pageBreak,
      endsWithBreak,
      last: false,
      hang: rule === 'auto' ? Math.max(0, height - natural) : 0,
    };
  }
}

/** All of a paragraph's lines at the column's full width. */
function breakLines(paragraph: Paragraph, items: Item[], width: number, context: LayoutContext): Line[] {
  const breaker = new LineBreaker(paragraph, items, width, context);
  const lines: Line[] = [];
  while (!breaker.done()) lines.push(breaker.commit(breaker.attempt()!));
  return lines;
}

/* ==========================================================================
   Pages and flows
   ========================================================================== */

interface AnchorRequest {
  anchor: Anchor;
  /** Top of the paragraph and of its line, and the text column's left edge. */
  paraTop: number;
  lineTop: number;
  columnLeft: number;
  /** Already placed (objects inside table cells), in the same frame as paraTop. */
  fixed?: { x: number; y: number };
}

/** An area text flows around: a floating object with text wrapping. */
interface Exclusion {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  side: Anchor['wrapSide'];
  /** Top-and-bottom wrapping: no text beside it at all. */
  full: boolean;
  /** Tight wrapping follows this outline (page coordinates), kept `gap` away from it. */
  polygon?: { x: number; y: number }[];
  gap?: { left: number; right: number };
}

/**
 * How far across an object reaches between `top` and `bottom`. A tight
 * wrap follows its outline line by line, so a slanted edge gives each line a
 * slightly different width — Word set two empty lines beside a picture and
 * the third, where the outline had crept 0.2pt wider, below it.
 */
function reach(e: Exclusion, top: number, bottom: number): { x0: number; x1: number } | null {
  if (!e.polygon || !e.gap) return { x0: e.x0, x1: e.x1 };
  let low = Infinity;
  let high = -Infinity;
  const points = e.polygon;
  for (let index = 0; index < points.length; index++) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    const from = Math.max(top, Math.min(a.y, b.y));
    const to = Math.min(bottom, Math.max(a.y, b.y));
    if (from > to) continue;
    for (const y of [from, to]) {
      const x = a.y === b.y ? a.x : a.x + ((b.x - a.x) * (y - a.y)) / (b.y - a.y);
      low = Math.min(low, x, a.y === b.y ? b.x : x);
      high = Math.max(high, x, a.y === b.y ? b.x : x);
    }
  }
  if (low === Infinity) return null;
  return { x0: low - e.gap.left, x1: high + e.gap.right };
}

interface PageState {
  index: number;
  section: Section;
  sectionIndex: number;
  /** Page number within the numbering sequence. */
  number: number;
  firstOfSection: boolean;
  ops: Layered[];
  anchors: AnchorRequest[];
  exclusions: Exclusion[];
  bodyTop: number;
  bodyBottom: number;
}

interface FrameResult {
  height: number;
  ops: Layered[];
  anchors: AnchorRequest[];
  /**
   * For splitting a table row across pages: where the content may be cut
   * (line bottoms), what may not be cut through (floating pictures), and for
   * each op the top of the line it belongs to.
   */
  /** `at` is the cut; `fit` what must be above the page's end (line spacing may hang below). */
  marks: { at: number; fit: number }[];
  /** Floating pictures, with the top of the paragraph each is anchored in. */
  spans: { top: number; bottom: number; owner: number }[];
  bands: number[];
  /** Where each line starts, empty ones too. */
  starts: number[];
}

/**
 * The stretches of [left, right] that text may use between `top` and
 * `bottom`, and where the nearest object blocking it ends. Null when no
 * object is in the way.
 */
function freeRanges(exclusions: Exclusion[], top: number, bottom: number, left: number, right: number): { ranges: Range[]; clearAt: number } | null {
  const active = exclusions
    .filter((e) => e.y0 < bottom - 0.01 && e.y1 > top + 0.01)
    .map((e) => ({ e, span: reach(e, top, bottom) }))
    .filter((entry): entry is { e: Exclusion; span: { x0: number; x1: number } } => entry.span !== null && entry.span.x0 < right && entry.span.x1 > left);
  if (active.length === 0) return null;
  const clearAt = Math.min(...active.map(({ e }) => e.y1));
  if (active.some(({ e }) => e.full)) return { ranges: [], clearAt };
  let ranges: Range[] = [{ from: left, to: right }];
  for (const { e, span } of active) {
    let cutFrom = span.x0;
    let cutTo = span.x1;
    if (e.side === 'left') cutTo = right;
    else if (e.side === 'right') cutFrom = left;
    else if (e.side === 'largest') {
      if (span.x0 - left >= right - span.x1) cutTo = right;
      else cutFrom = left;
    }
    ranges = ranges.flatMap((range) => {
      const out: Range[] = [];
      if (cutFrom > range.from) out.push({ from: range.from, to: Math.min(range.to, cutFrom) });
      if (cutTo < range.to) out.push({ from: Math.max(range.from, cutTo), to: range.to });
      return out;
    });
  }
  return { ranges: ranges.filter((range) => range.to - range.from > 0.01), clearAt };
}

/** The area text keeps away from, for an object placed at (x, y). */
function exclusionFor(anchor: Anchor, x: number, y: number): Exclusion {
  const { outset, distance } = anchor;
  if (anchor.polygon) {
    const polygon = anchor.polygon.map((point) => ({ x: x + point.x, y: y + point.y }));
    const xs = polygon.map((point) => point.x);
    const ys = polygon.map((point) => point.y);
    return {
      x0: Math.min(...xs) - distance.left,
      x1: Math.max(...xs) + distance.right,
      y0: Math.min(...ys) - distance.top,
      y1: Math.max(...ys) + distance.bottom,
      side: anchor.wrapSide,
      full: false,
      polygon,
      gap: { left: distance.left, right: distance.right },
    };
  }
  return {
    x0: x - outset.left - distance.left,
    x1: x + anchor.width + outset.right + distance.right,
    y0: y - outset.top - distance.top,
    y1: y + anchor.height + outset.bottom + distance.bottom,
    side: anchor.wrapSide,
    full: anchor.wrap === 'topAndBottom',
  };
}

/** Whether text flows around this object (rather than over or under it). */
function wraps(anchor: Anchor): boolean {
  return anchor.wrap !== 'none';
}

function shiftRequest(request: AnchorRequest, dx: number, dy: number): AnchorRequest {
  return {
    ...request,
    paraTop: request.paraTop + dy,
    lineTop: request.lineTop + dy,
    columnLeft: request.columnLeft + dx,
    fixed: request.fixed && { x: request.fixed.x + dx, y: request.fixed.y + dy },
  };
}

interface CellBox {
  cell: Cell;
  column: number;
  span: number;
  x0: number;
  x1: number;
  frame: FrameResult;
  rowSpan: number;
}

interface RowBox {
  boxes: CellBox[];
  height: number;
  header: boolean;
  /** Border widths the row makes room for above and below its content. */
  above: number;
  below: number;
}

interface RowLayout {
  rows: RowBox[];
  edges: number[];
  margins: CellMargins;
}

/**
 * The deepest cut through a frame within `limit` that splits no line. A
 * floating picture stays with the paragraph it is anchored in, so a cut
 * after that paragraph must leave room for the whole picture above the
 * page's end. Returns where to cut and how tall the part above it is.
 */
function cutFrame(frame: FrameResult, limit: number): { cut: number; height: number } {
  if (frame.height <= limit + 0.01) return { cut: frame.height, height: frame.height };
  let best = { cut: 0, height: 0 };
  for (const { at, fit } of frame.marks) {
    if (fit > limit + 0.01 || at <= best.cut) continue;
    const pictures = frame.spans.filter((span) => span.owner < at - 0.01).map((span) => span.bottom);
    if (Math.max(fit, ...pictures) > limit + 0.01) continue;
    best = { cut: at, height: Math.max(at, ...pictures) };
  }
  return best;
}

/** Which paragraph an object belongs to decides the part it goes with. */
const requestOwner = (request: AnchorRequest) => request.paraTop;

/** What of a frame lies above `cut`: its lines, and the objects anchored in them. */
function frameHead(frame: FrameResult, cut: { cut: number; height: number }): FrameResult {
  const keep = frame.ops.map((_, index) => (frame.bands[index] ?? 0) < cut.cut - 0.01);
  return {
    height: cut.height,
    ops: frame.ops.filter((_, index) => keep[index]),
    bands: frame.bands.filter((_, index) => keep[index]),
    anchors: frame.anchors.filter((request) => requestOwner(request) < cut.cut - 0.01),
    marks: frame.marks.filter((mark) => mark.at <= cut.cut + 0.01),
    spans: frame.spans.filter((span) => span.owner < cut.cut - 0.01),
    starts: frame.starts.filter((start) => start < cut.cut - 0.01),
  };
}

/**
 * What of a frame lies below `cut`, moved up so its first line starts at the
 * top: lines pushed below a picture that stayed behind rise with the rest.
 */
function frameTail(frame: FrameResult, cut: { cut: number }): FrameResult {
  const keep = frame.ops.map((_, index) => (frame.bands[index] ?? 0) >= cut.cut - 0.01);
  const anchors = frame.anchors.filter((request) => requestOwner(request) >= cut.cut - 0.01);
  const tops = [
    ...frame.starts.filter((start) => start >= cut.cut - 0.01),
    ...anchors.map((request) => Math.min(request.paraTop, request.fixed?.y ?? request.paraTop)),
  ];
  const shift = tops.length > 0 ? Math.min(...tops) : cut.cut;
  return {
    height: Math.max(0, frame.height - shift),
    ops: frame.ops.filter((_, index) => keep[index]).map((layered) => ({ ...layered, op: translate(layered.op, 0, -shift) })),
    bands: frame.bands.filter((_, index) => keep[index]).map((band) => band - shift),
    anchors: anchors.map((request) => shiftRequest(request, 0, -shift)),
    marks: frame.marks.filter((mark) => mark.at > cut.cut + 0.01).map((mark) => ({ at: mark.at - shift, fit: mark.fit - shift })),
    spans: frame.spans
      .filter((span) => span.owner >= cut.cut - 0.01)
      .map((span) => ({ top: span.top - shift, bottom: span.bottom - shift, owner: span.owner - shift })),
    starts: frame.starts.filter((start) => start >= cut.cut - 0.01).map((start) => start - shift),
  };
}


function translate(op: DrawOp, dx: number, dy: number): DrawOp {
  switch (op.kind) {
    case 'text':
    case 'rect':
    case 'image':
      return { ...op, x: op.x + dx, y: op.y + dy };
    case 'line':
      return { ...op, x1: op.x1 + dx, x2: op.x2 + dx, y1: op.y1 + dy, y2: op.y2 + dy };
    case 'path':
      return { ...op, d: translatePath(op.d, dx, dy) };
  }
}

function translatePath(d: string, dx: number, dy: number): string {
  // Paths are built from absolute M/L/C/Z commands with x,y pairs.
  return d.replace(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g, (_, x: string, y: string) => `${(+x + dx).toFixed(3)},${(+y + dy).toFixed(3)}`);
}

export class Typesetter {
  readonly pages: PageState[] = [];
  private page!: PageState;
  private y = 0;
  private pageNumberCounter = 0;
  /** Style of the previous paragraph in the flow, for contextual spacing. */
  private previous: { styleId?: string; after: number; contextual: boolean } | null = null;
  private pendingPageBreak = false;

  private readonly context: LayoutContext;

  constructor(context: LayoutContext) {
    this.context = context;
  }

  get doc() {
    return this.context.doc;
  }

  /* ------------------------------------------------------------ pages */

  private newPage(section: Section, sectionIndex: number, firstOfSection: boolean) {
    const restart = firstOfSection && section.pageNumberStart !== undefined;
    this.pageNumberCounter = restart ? section.pageNumberStart! : this.pageNumberCounter + 1;
    const page: PageState = {
      index: this.pages.length,
      section,
      sectionIndex,
      number: this.pageNumberCounter,
      firstOfSection,
      ops: [],
      anchors: [],
      exclusions: [],
      bodyTop: section.margins.top,
      bodyBottom: section.height - section.margins.bottom,
    };
    this.pages.push(page);
    this.page = page;
    this.y = page.bodyTop;
    this.previous = null;
    this.pendingPageBreak = false;
  }

  private atPageTop(): boolean {
    return this.y <= this.page.bodyTop + 0.01;
  }

  run(): void {
    this.doc.sections.forEach((section, sectionIndex) => {
      const continuous = section.type === 'continuous' && this.pages.length > 0;
      if (!continuous) this.newPage(section, sectionIndex, true);
      this.flowBlocks(section.blocks, section.margins.left, section.width - section.margins.left - section.margins.right);
    });
    if (this.pages.length === 0 && this.doc.sections[0]) this.newPage(this.doc.sections[0], 0, true);
  }

  private breakPage() {
    this.newPage(this.page.section, this.page.sectionIndex, false);
  }

  /* ---------------------------------------------------------- blocks */

  private flowBlocks(blocks: Block[], left: number, width: number) {
    for (let index = 0; index < blocks.length; index++) {
      const block = blocks[index];
      if (this.pendingPageBreak) this.breakPage();
      if (block.kind === 'paragraph') this.flowParagraph(block, blocks, index, left, width);
      else this.flowTable(block, left, width);
    }
  }

  /**
   * Space above a paragraph. Word does not add the previous paragraph's space
   * after to this one's space before — it uses the larger of the two (the
   * after is already in y, so only the excess is added here). Measured: a
   * 2pt space-before after an 8pt space-after leaves exactly 8pt.
   */
  private spaceBefore(paragraph: Paragraph): number {
    const props = paragraph.props;
    const before = props.beforeAuto ? 14 : (props.before ?? 0);
    if (this.previous && this.previous.styleId === props.styleId && props.contextual) return 0;
    return Math.max(0, before - (this.previous?.after ?? 0));
  }

  private spaceAfter(paragraph: Paragraph, next: Block | undefined): number {
    const props = paragraph.props;
    const after = props.afterAuto ? 14 : (props.after ?? 0);
    if (
      props.contextual &&
      next?.kind === 'paragraph' &&
      next.props.styleId === props.styleId
    ) {
      return 0;
    }
    return after;
  }

  private flowParagraph(paragraph: Paragraph, siblings: Block[], index: number, left: number, width: number) {
    const props = paragraph.props;
    const next = siblings[index + 1];

    if (props.pageBreakBefore && !this.atPageTop()) this.breakPage();

    const items = itemsOf(paragraph, { ...this.context, pageNumber: this.page.number });
    const lines = breakLines(paragraph, items, width, this.context);

    let before = this.spaceBefore(paragraph);
    // Word drops the space above a paragraph that starts a page.
    if (this.atPageTop()) before = 0;
    const after = this.spaceAfter(paragraph, next);

    /* ---------------------------------------------- keep with next */
    if (props.keepNext && !this.atPageTop()) {
      const total = before + lines.reduce((sum, line) => sum + line.height, 0) + after;
      const nextHeight = this.firstLineHeight(next, width);
      if (this.y + total + nextHeight > this.page.bodyBottom + 0.01 && total + nextHeight < this.page.bodyBottom - this.page.bodyTop) {
        this.breakPage();
        before = 0;
      }
    }

    // Around floating objects lines are set one at a time, each where it fits.
    if (this.page.exclusions.some((e) => e.y1 > this.y) || items.some((item) => item.t === 'anchor' && wraps(item.anchor))) {
      this.flowWrapped(paragraph, left, width, before, after);
      return;
    }

    this.y += before;
    const paraTop = this.y;

    /* -------------------------------------- lines, page by page */
    const widow = props.widowControl !== false;
    let lineIndex = 0;
    let firstLineTop = this.y;

    while (lineIndex < lines.length) {
      // How many of the remaining lines fit on this page?
      let fit = 0;
      let used = 0;
      for (let k = lineIndex; k < lines.length; k++) {
        if (this.y + used + lines[k].height - lines[k].hang > this.page.bodyBottom + 0.01) break;
        used += lines[k].height;
        fit++;
        if (lines[k].pageBreak) break;
      }

      const remaining = lines.length - lineIndex;
      if (fit < remaining && !lines[lineIndex + Math.max(0, fit - 1)]?.pageBreak) {
        if (props.keepLines && lineIndex === 0 && !this.atPageTop()) fit = 0;
        else if (widow) {
          // Orphan: never leave only the first line behind.
          if (lineIndex === 0 && fit === 1 && remaining > 1) fit = 0;
          // Widow: never send only the last line ahead.
          if (remaining - fit === 1 && fit >= 2) fit -= 1;
          else if (remaining - fit === 1 && fit === 1 && lineIndex > 0) fit = 0;
          // Pulling a line back for the widow can leave the first line alone
          // at the foot of the page; then the whole paragraph moves.
          if (lineIndex === 0 && fit === 1 && remaining > 1) fit = 0;
        }
      }

      if (fit === 0) {
        if (this.atPageTop()) fit = 1; // Taller than a page: place it anyway.
        else {
          this.breakPage();
          continue;
        }
      }

      for (let k = 0; k < fit; k++) {
        const line = lines[lineIndex];
        if (lineIndex === 0) {
          firstLineTop = this.y;
          this.context.onParagraph?.(paragraph, this.page.index, this.y, lines.map((l) => l.height));
        }
        this.drawLine(line, paragraph, left, width, this.y, this.page.ops, this.page.anchors, lineIndex === 0 ? this.y : paraTop);
        this.y += line.height;
        lineIndex++;
        if (line.pageBreak) {
          if (lineIndex < lines.length) this.breakPage();
          else this.pendingPageBreak = true;
          break;
        }
      }

      if (lineIndex < lines.length && !this.pendingPageBreak && !lines[lineIndex - 1]?.pageBreak) this.breakPage();
    }

    this.drawParagraphDecoration(paragraph, left, width, firstLineTop, this.y);
    this.y += after;
    this.previous = { styleId: props.styleId, after, contextual: Boolean(props.contextual) };
  }

  /**
   * A paragraph among floating objects that text wraps around. Each line is
   * tried at the full width first; where an object is in the way, it goes in
   * the free stretches beside it — left, then right, on the same line, as
   * Word does — or, when not even its first word fits there, below it.
   */
  private flowWrapped(paragraph: Paragraph, left: number, width: number, before: number, after: number) {
    const props = paragraph.props;
    const items = itemsOf(paragraph, { ...this.context, pageNumber: this.page.number });

    // Word keeps a wrapped object on its page: when one would run past the
    // bottom margin, its paragraph moves to the next page with it. Measured:
    // a 150pt picture 10pt below a paragraph at 628pt (margin at 770pt)
    // took its paragraph over; at 578pt it stayed.
    if (!this.atPageTop()) {
      for (const item of items) {
        if (item.t !== 'anchor' || !wraps(item.anchor)) continue;
        const v = item.anchor.v;
        if (v.from !== 'paragraph' && v.from !== 'line') continue;
        if (this.y + before + (v.offset ?? 0) + item.anchor.height > this.page.bodyBottom + 0.01) {
          this.breakPage();
          before = 0;
          break;
        }
      }
    }

    this.y += before;
    let paraTop = this.y;
    let firstTop = this.y;
    let started = false;
    const breaker = new LineBreaker(paragraph, items, width, this.context);

    while (!breaker.done()) {
      const full = breaker.attempt()!;
      if (this.y + full.line.height - full.line.hang > this.page.bodyBottom + 0.01 && !this.atPageTop()) {
        this.breakPage();
        if (!started) paraTop = this.y;
        continue;
      }

      const free = freeRanges(this.page.exclusions, this.y, this.y + full.line.height, left, left + width);
      const placed: Line[] = [];
      if (!free) placed.push(breaker.commit(full));
      else {
        for (const range of free.ranges) {
          if (breaker.done()) break;
          const attempt = breaker.attempt({ from: range.from - left, to: range.to - left });
          if (attempt) placed.push(breaker.commit(attempt));
        }
      }
      if (placed.length === 0) {
        // Nothing fits beside the object: continue below it.
        this.y = Math.max(this.y + 0.01, free!.clearAt);
        if (!started) paraTop = this.y;
        continue;
      }

      if (!started) {
        started = true;
        firstTop = this.y;
        this.context.onParagraph?.(paragraph, this.page.index, this.y, [full.line.height]);
      }
      for (const line of placed) {
        const count = this.page.anchors.length;
        this.drawLine(line, paragraph, left, width, this.y, this.page.ops, this.page.anchors, paraTop);
        for (const request of this.page.anchors.slice(count)) {
          if (!wraps(request.anchor)) continue;
          const { x, y } = this.anchorPosition(request, this.page.section);
          this.page.exclusions.push(exclusionFor(request.anchor, x, y));
        }
      }
      this.y += Math.max(...placed.map((line) => line.height));

      if (placed.some((line) => line.pageBreak)) {
        if (!breaker.done()) this.breakPage();
        else this.pendingPageBreak = true;
      }
    }

    this.drawParagraphDecoration(paragraph, left, width, firstTop, this.y);
    this.y += after;
    this.previous = { styleId: props.styleId, after, contextual: Boolean(props.contextual) };
  }

  private firstLineHeight(block: Block | undefined, width: number): number {
    if (!block) return 0;
    if (block.kind === 'table') {
      const layout = this.layoutRows(block, 0, width, { ...this.context, pageNumber: this.page.number });
      return this.openingHeight(block, layout);
    }
    const lines = breakLines(block, itemsOf(block, { ...this.context, pageNumber: this.page.number }), width, this.context);
    const first = lines[0]?.height ?? 0;
    const before = block.props.before ?? 0;
    if (block.props.keepNext) {
      return before + lines.reduce((sum, line) => sum + line.height, 0) + (block.props.after ?? 0);
    }
    return before + first;
  }

  /* ------------------------------------------------------------ lines */

  /**
   * Draws one line: alignment, justification, tab leaders, underlines, and
   * highlight. Shared by the page flow and by frames (cells, text boxes).
   */
  drawLine(
    line: Line,
    paragraph: Paragraph,
    left: number,
    width: number,
    top: number,
    ops: Layered[],
    anchors: AnchorRequest[],
    paraTop: number,
  ) {
    const props = paragraph.props;
    const align = props.align ?? 'left';
    // Negative when Word squeezed the spaces to fit the last word.
    const slack = line.limit - line.end;
    let shift = 0;
    let extraPerSpace = 0;

    const lastTab = line.placed.reduce((acc, entry, index) => (entry.item.t === 'tab' ? index : acc), -1);
    const trailing = (() => {
      let index = line.placed.length - 1;
      while (index >= 0) {
        const item = line.placed[index].item;
        if (item.t === 'text' && item.space) index--;
        else if (item.t === 'break' || item.t === 'anchor') index--;
        else break;
      }
      return index;
    })();

    if (align === 'center') shift = Math.max(0, slack) / 2;
    else if (align === 'right') shift = Math.max(0, slack);
    else if (align === 'both' || align === 'distribute') {
      const stretch = align === 'distribute' || !line.last || (line.endsWithBreak && !line.pageBreak);
      const spaceWidth = line.placed
        .filter((entry, index) => index > lastTab && index < trailing && entry.item.t === 'text' && entry.item.space)
        .reduce((sum, entry) => sum + entry.width, 0);
      // Spaces stretch to fill a full line, or squeeze on any line that only
      // fits because Word compressed them.
      if (spaceWidth > 0 && (stretch || slack < 0)) extraPerSpace = slack / spaceWidth;
    }

    const baseline = top + line.baseline;
    let offset = shift;

    for (const [index, entry] of line.placed.entries()) {
      const item = entry.item;
      const x = left + entry.x + offset;

      if (item.t === 'text') {
        if (item.space) {
          const extra = index > lastTab && index < trailing ? extraPerSpace * entry.width : 0;
          offset += extra;
          this.drawUnderline(item, x, entry.width + extra, baseline, ops);
          continue;
        }
        if (item.props.highlight || item.props.shading) {
          ops.push({
            layer: 1,
            order: -1,
            op: {
              kind: 'rect',
              x,
              y: top,
              w: entry.width,
              h: line.height,
              fill: item.props.highlight ?? item.props.shading,
            },
          });
        }
        ops.push({ layer: 1, order: 0, op: { kind: 'text', x, y: baseline - item.rise, text: item.text, face: item.face, size: item.size, color: item.color } });
        this.drawUnderline(item, x, entry.width, baseline, ops);
      } else if (item.t === 'tab') {
        if (entry.leader) {
          const dot = item.face.width(entry.leader.char, item.size);
          const from = left + entry.leader.from + offset;
          const to = left + entry.leader.to + offset;
          // Leader characters sit on a grid, like Word's, so rows of a table
          // of contents line up with each other.
          const count = Math.floor((to - from) / dot - 0.25);
          if (count > 0) {
            const start = to - dot * count;
            ops.push({
              layer: 1,
              order: 0,
              op: { kind: 'text', x: start, y: baseline, text: entry.leader.char.repeat(count), face: item.face, size: item.size, color: item.props.color ?? '#000000' },
            });
          }
        }
      } else if (item.t === 'image') {
        ops.push({ layer: 1, order: 0, op: { kind: 'image', x, y: baseline - item.height, w: item.width, h: item.height, image: item.image, crop: item.crop } });
      } else if (item.t === 'anchor') {
        anchors.push({ anchor: item.anchor, paraTop, lineTop: top, columnLeft: left });
      }
    }
    void width;
  }

  private drawUnderline(item: TextItem, x: number, w: number, baseline: number, ops: Layered[]) {
    if (!item.props.underline || item.props.underline === 'none') {
      if (!item.props.strike) return;
    }
    const thickness = Math.max(0.5, item.face.underlineThickness * item.size);
    if (item.props.underline && item.props.underline !== 'none') {
      const y = baseline + item.face.underlinePosition * item.size;
      ops.push({ layer: 1, order: 0, op: { kind: 'line', x1: x, y1: y, x2: x + w, y2: y, color: item.color, width: thickness } });
    }
    if (item.props.strike && !item.space) {
      const y = baseline - item.size * 0.28;
      ops.push({ layer: 1, order: 0, op: { kind: 'line', x1: x, y1: y, x2: x + w, y2: y, color: item.color, width: thickness } });
    }
  }

  /** Paragraph borders and shading. */
  private drawParagraphDecoration(paragraph: Paragraph, left: number, width: number, top: number, bottom: number) {
    this.decorate(paragraph, left, width, top, bottom, this.page.ops);
  }

  decorate(paragraph: Paragraph, left: number, width: number, top: number, bottom: number, ops: Layered[]) {
    const props = paragraph.props;
    const x0 = left + (props.indLeft ?? 0);
    const x1 = left + width - (props.indRight ?? 0);
    if (props.shading) {
      ops.push({ layer: 1, order: -2, op: { kind: 'rect', x: x0, y: top, w: x1 - x0, h: bottom - top, fill: props.shading } });
    }
    const borders = props.borders;
    if (!borders) return;
    const draw = (border: BorderLine | undefined, ax: number, ay: number, bx: number, by: number) => {
      if (!border) return;
      ops.push({ layer: 1, order: 0, op: { kind: 'line', x1: ax, y1: ay, x2: bx, y2: by, color: border.color, width: border.width } });
    };
    /**
     * Draws a horizontal border outward from `edge` (direction -1 above the
     * text, +1 below). Compound styles are two lines: "thinThick" lists them
     * from the outside in, so for a top border the thick line is on top —
     * measured from Word's own export: 2.9pt thick, 0.7pt gap, 0.7pt thin.
     */
    const horizontal = (border: BorderLine, edge: number, direction: -1 | 1, from: number, to: number) => {
      const compound = /^(thinThick|thickThin)/.test(border.style);
      if (!compound && border.style !== 'double') {
        const y = edge + direction * (border.space + border.width / 2);
        draw(border, from, y, to, y);
        return;
      }
      const thin = Math.min(0.75, border.width);
      const thick = border.style === 'double' ? thin : border.width;
      const gap = 0.75;
      const innerThick = border.style.startsWith('thickThin');
      const inner = innerThick ? thick : thin;
      const outer = innerThick ? thin : thick;
      const innerY = edge + direction * (border.space + inner / 2);
      const outerY = edge + direction * (border.space + inner + gap + outer / 2);
      draw({ ...border, width: inner }, from, innerY, to, innerY);
      draw({ ...border, width: outer }, from, outerY, to, outerY);
    };
    const bottomBorder = borders.bottom;
    if (bottomBorder) horizontal(bottomBorder, bottom, 1, x0 - (borders.left?.space ?? 0), x1 + (borders.right?.space ?? 0));
    if (borders.top) horizontal(borders.top, top, -1, x0, x1);
    if (borders.left) draw(borders.left, x0 - borders.left.space, top, x0 - borders.left.space, bottom);
    if (borders.right) draw(borders.right, x1 + borders.right.space, top, x1 + borders.right.space, bottom);
  }

  /* ---------------------------------------------------------- frames */

  /**
   * Lays blocks out in a box with no page breaks — a table cell, a text box,
   * a header or footer. Coordinates in the result are relative to the box.
   * In a table cell (`cell`), a floating object that text wraps around is
   * placed right away, inside the cell; the text flows around it and the
   * cell grows to hold it.
   */
  frame(blocks: Block[], width: number, extra: Partial<LayoutContext> = {}, cell = false): FrameResult {
    const ops: Layered[] = [];
    const bands: number[] = [];
    const anchors: AnchorRequest[] = [];
    const marks: FrameResult['marks'] = [];
    const starts: number[] = [];
    const spans: FrameResult['spans'] = [];
    const exclusions: Exclusion[] = [];
    const context = { ...this.context, ...extra };
    let y = 0;
    /** The lowest wrapped object: the cell reaches at least this far. */
    let reach = 0;
    let previous: Paragraph | null = null;
    let previousAfter = 0;

    /** Records which line the ops drawn since the last call belong to. */
    const tag = (band: number, line = true) => {
      while (bands.length < ops.length) bands.push(band);
      if (line && starts[starts.length - 1] !== band) starts.push(band);
    };
    const place = (request: AnchorRequest) => {
      const at = this.anchorPosition(request, this.doc.sections[0], { width });
      request.fixed = at;
      exclusions.push(exclusionFor(request.anchor, at.x, at.y));
      spans.push({ top: at.y, bottom: at.y + request.anchor.height, owner: request.paraTop });
      reach = Math.max(reach, at.y + request.anchor.height + request.anchor.distance.bottom);
    };

    blocks.forEach((block, index) => {
      if (block.kind === 'table') {
        const result = this.tableFrame(block, 0, width, context);
        for (const layered of result.ops) ops.push({ ...layered, op: translate(layered.op, 0, y) });
        tag(y);
        for (const request of result.anchors) anchors.push(shiftRequest(request, 0, y));
        y += result.height;
        marks.push({ at: y, fit: y });
        previous = null;
        previousAfter = 0;
        return;
      }

      const next = blocks[index + 1];
      const props = block.props;
      let before = props.beforeAuto ? 14 : (props.before ?? 0);
      if (previous && props.contextual && (previous as Paragraph).props.styleId === props.styleId) before = 0;
      before = Math.max(0, before - previousAfter);
      let after = props.afterAuto ? 14 : (props.after ?? 0);
      if (props.contextual && next?.kind === 'paragraph' && next.props.styleId === props.styleId) after = 0;

      y += before;
      const top = y;
      const items = itemsOf(block, context);
      const wrapped = cell && (exclusions.some((e) => e.y1 > y) || items.some((item) => item.t === 'anchor' && wraps(item.anchor)));

      if (!wrapped) {
        const lines = breakLines(block, items, width, context);
        // Widow/orphan control holds inside a cell too: a row does not break
        // after a paragraph's first line or before its last. Measured: Word
        // moved a row whole rather than leave one line of a cell behind.
        const widow = props.widowControl !== false && lines.length > 1;
        for (const [lineIndex, line] of lines.entries()) {
          this.drawLine(line, block, 0, width, y, ops, anchors, lineIndex === 0 ? y : top);
          tag(y);
          y += line.height;
          const count = lineIndex + 1;
          if (!widow || count === lines.length || (count >= 2 && lines.length - count >= 2)) marks.push({ at: y, fit: y - line.hang });
        }
      } else {
        // As on the page: each line where it fits beside the objects.
        const breaker = new LineBreaker(block, items, width, context);
        let paraTop = y;
        let started = false;
        const bottoms: FrameResult['marks'] = [];
        while (!breaker.done()) {
          const full = breaker.attempt()!;
          const free = freeRanges(exclusions, y, y + full.line.height, 0, width);
          const placed: Line[] = [];
          if (!free) placed.push(breaker.commit(full));
          else {
            for (const range of free.ranges) {
              if (breaker.done()) break;
              const attempt = breaker.attempt(range);
              if (attempt) placed.push(breaker.commit(attempt));
            }
          }
          if (placed.length === 0) {
            y = Math.max(y + 0.01, free!.clearAt);
            if (!started) paraTop = y;
            continue;
          }
          started = true;
          for (const line of placed) {
            const count = anchors.length;
            this.drawLine(line, block, 0, width, y, ops, anchors, paraTop);
            for (const request of anchors.slice(count)) if (wraps(request.anchor)) place(request);
          }
          tag(y);
          const tallest = placed.reduce((a, b) => (b.height > a.height ? b : a));
          y += tallest.height;
          bottoms.push({ at: y, fit: y - tallest.hang });
        }
        const widow = props.widowControl !== false && bottoms.length > 1;
        bottoms.forEach((bottom, index) => {
          const count = index + 1;
          if (!widow || count === bottoms.length || (count >= 2 && bottoms.length - count >= 2)) marks.push(bottom);
        });
      }

      this.decorate(block, 0, width, top, y, ops);
      tag(top, false);
      y += after;
      previous = block;
      previousAfter = after;
    });

    return { height: Math.max(y, reach), ops, anchors, marks, spans, bands, starts };
  }

  /* ---------------------------------------------------------- tables */

  private tableGeometry(table: Table, left: number, width: number) {
    const total = table.grid.reduce((sum, value) => sum + value, 0);
    let x0 = left + (table.props.indent ?? 0);
    if (table.props.align === 'center') x0 = left + (width - total) / 2;
    else if (table.props.align === 'right') x0 = left + width - total;
    const float = table.props.float;
    if (float) {
      // A floating table sits relative to the margin (or text column): by
      // offset, or aligned within it.
      if (float.xAlign === 'center') x0 = left + (width - total) / 2;
      else if (float.xAlign === 'right') x0 = left + width - total;
      else x0 = left + float.x;
    }
    const edges = [x0];
    for (const column of table.grid) edges.push(edges[edges.length - 1] + column);
    return edges;
  }

  /** Resolved border for one edge of one cell. */
  private edge(table: Table, cell: Cell, side: 'top' | 'bottom' | 'left' | 'right', outer: boolean): BorderLine | null {
    const own = cell.borders?.[side];
    if (own !== undefined) return own;
    const borders = table.props.borders ?? {};
    const fallback =
      side === 'top' || side === 'bottom'
        ? outer
          ? borders[side]
          : borders.insideH
        : outer
          ? borders[side]
          : borders.insideV;
    return fallback ?? null;
  }

  private layoutRows(table: Table, left: number, width: number, context: LayoutContext): RowLayout {
    const edges = this.tableGeometry(table, left, width);
    const margins = table.props.cellMargins ?? {};
    const spacing = table.props.cellSpacing ?? 0;

    /**
     * Horizontal borders take up room: Word puts each row's bottom border
     * (and the table's top border) between the rows rather than over them.
     * Measured: a 30pt row with 0.5pt borders is 30.5pt from border to border.
     */
    const rows: RowBox[] = [];
    const openMerges = new Map<number, CellBox>();

    table.rows.forEach((row, rowIndex) => {
      let column = row.gridBefore;
      const boxes: CellBox[] = [];
      for (const cell of row.cells) {
        const span = Math.max(1, cell.span);
        const x0 = edges[Math.min(column, edges.length - 1)];
        const x1 = edges[Math.min(column + span, edges.length - 1)];
        if (cell.vMerge === 'continue' && openMerges.has(column)) {
          openMerges.get(column)!.rowSpan++;
          column += span;
          continue;
        }
        const cellMargins = { ...margins, ...cell.margins };
        const inner = Math.max(1, x1 - x0 - 2 * spacing - (cellMargins.left ?? 5.4) - (cellMargins.right ?? 5.4));
        const box: CellBox = {
          cell,
          column,
          span,
          x0,
          x1,
          frame: this.frame(cell.blocks, inner, context, true),
          rowSpan: 1,
        };
        boxes.push(box);
        if (cell.vMerge === 'restart') openMerges.set(column, box);
        else openMerges.delete(column);
        column += span;
      }

      const contentHeight = Math.max(
        0,
        ...boxes
          .filter((box) => box.cell.vMerge !== 'restart')
          .map((box) => box.frame.height + (box.cell.margins?.top ?? margins.top ?? 0) + (box.cell.margins?.bottom ?? margins.bottom ?? 0)),
      );
      let height = contentHeight;
      if (row.height !== undefined) {
        // A minimum row height leaves the cells' top and bottom margins out.
        // Measured: 18.75pt with 0.75pt margins gave a 20.42pt row.
        const pad = Math.max(0, ...boxes.map((box) => (box.cell.margins?.top ?? margins.top ?? 0) + (box.cell.margins?.bottom ?? margins.bottom ?? 0)));
        height = row.heightRule === 'exact' ? row.height : Math.max(height, row.height + pad);
      }
      const isLastRow = rowIndex === table.rows.length - 1;
      let below = Math.max(0, ...boxes.map((box) => this.edge(table, box.cell, 'bottom', isLastRow)?.width ?? 0));
      let above = rowIndex === 0 ? Math.max(0, ...boxes.map((box) => this.edge(table, box.cell, 'top', true)?.width ?? 0)) : 0;
      if (spacing > 0) {
        // With cell spacing every cell is its own bordered box, set apart
        // from its neighbours. Measured: 0.75pt spacing and 0.25pt borders
        // made each row 1.75pt taller than without spacing.
        above = spacing + Math.max(0, ...boxes.map((box) => this.edge(table, box.cell, 'top', false)?.width ?? 0));
        below = spacing + Math.max(0, ...boxes.map((box) => this.edge(table, box.cell, 'bottom', false)?.width ?? 0));
        // The table's own border sits the spacing away from the outer cells.
        const outer = table.props.borders ?? {};
        if (rowIndex === 0) above += spacing + (outer.top?.width ?? 0);
        if (isLastRow) below += spacing + (outer.bottom?.width ?? 0);
      }
      rows.push({ boxes, height: height + above + below, header: row.header, above, below });
    });

    // A vertically merged cell may need more room than the rows it spans.
    rows.forEach((row, rowIndex) => {
      for (const box of row.boxes) {
        if (box.cell.vMerge !== 'restart' || box.rowSpan <= 1) continue;
        const spanned = rows.slice(rowIndex, rowIndex + box.rowSpan);
        const available = spanned.reduce((sum, r) => sum + r.height, 0);
        const needed = box.frame.height + (margins.top ?? 0) + (margins.bottom ?? 0);
        if (needed > available) spanned[spanned.length - 1].height += needed - available;
      }
    });

    return { rows, edges, margins };
  }

  /**
   * Draws row `rowIndex` of `layout`. A row split across pages is drawn from
   * a one-row layout holding just that part; `source` is then the row's
   * index in the table, which decides its borders.
   */
  private drawRow(
    table: Table,
    layout: RowLayout,
    rowIndex: number,
    top: number,
    ops: Layered[],
    anchors: AnchorRequest[],
    isFirstOnPage: boolean,
    isLast: boolean,
    source?: number,
  ) {
    const { rows, edges, margins } = layout;
    const row = rows[rowIndex];
    const first = (source ?? rowIndex) === 0;
    if (table.props.cellSpacing) {
      this.drawSpacedRow(table, layout, rowIndex, top, ops, anchors, first || isFirstOnPage, isLast);
      return;
    }
    for (const box of row.boxes) {
      const spannedHeight = rows.slice(rowIndex, rowIndex + box.rowSpan).reduce((sum, r) => sum + r.height, 0);
      const cellMargins = { ...margins, ...box.cell.margins };
      if (box.cell.shading) {
        ops.push({ layer: 1, order: -2, op: { kind: 'rect', x: box.x0, y: top, w: box.x1 - box.x0, h: spannedHeight, fill: box.cell.shading } });
      }

      const lastSpanned = rows[Math.min(rows.length - 1, rowIndex + box.rowSpan - 1)];
      const contentTop = top + row.above + (cellMargins.top ?? 0);
      const free = spannedHeight - row.above - lastSpanned.below - (cellMargins.top ?? 0) - (cellMargins.bottom ?? 0) - box.frame.height;
      const dy = box.cell.vAlign === 'center' ? Math.max(0, free / 2) : box.cell.vAlign === 'bottom' ? Math.max(0, free) : 0;
      const dx = box.x0 + (cellMargins.left ?? 5.4);
      for (const layered of box.frame.ops) ops.push({ ...layered, op: translate(layered.op, dx, contentTop + dy) });
      for (const request of box.frame.anchors) anchors.push(shiftRequest(request, dx, contentTop + dy));

      const lastRowOfCell = source === undefined ? rowIndex + box.rowSpan - 1 >= rows.length - 1 || isLast : isLast;
      const sides = {
        top: this.edge(table, box.cell, 'top', first || isFirstOnPage),
        bottom: this.edge(table, box.cell, 'bottom', lastRowOfCell),
        left: this.edge(table, box.cell, 'left', box.column === 0),
        right: this.edge(table, box.cell, 'right', box.column + box.span >= edges.length - 1),
      };
      const line = (border: BorderLine | null, x1: number, y1: number, x2: number, y2: number) => {
        if (!border) return;
        ops.push({ layer: 1, order: 1, op: { kind: 'line', x1, y1, x2, y2, color: border.color, width: border.width } });
      };
      // The row above already drew the shared edge, as its bottom border.
      if (first || isFirstOnPage || box.cell.borders?.top !== undefined) {
        const width = sides.top?.width ?? 0;
        line(sides.top, box.x0, top + (row.above ? width / 2 : -width / 2), box.x1, top + (row.above ? width / 2 : -width / 2));
      }
      const bottomY = top + spannedHeight - (sides.bottom?.width ?? 0) / 2;
      line(sides.bottom, box.x0, bottomY, box.x1, bottomY);
      line(sides.left, box.x0, top, box.x0, top + spannedHeight);
      line(sides.right, box.x1, top, box.x1, top + spannedHeight);
    }
  }

  /**
   * A row of a table with cell spacing: every cell is a separate box with
   * all four borders, set `cellSpacing` in from the row, and the table's own
   * border runs around the outside.
   */
  private drawSpacedRow(
    table: Table,
    layout: RowLayout,
    rowIndex: number,
    top: number,
    ops: Layered[],
    anchors: AnchorRequest[],
    opensPage: boolean,
    isLast: boolean,
  ) {
    const { rows, edges, margins } = layout;
    const row = rows[rowIndex];
    const spacing = table.props.cellSpacing ?? 0;
    const line = (border: BorderLine | null | undefined, x1: number, y1: number, x2: number, y2: number) => {
      if (!border) return;
      ops.push({ layer: 1, order: 1, op: { kind: 'line', x1, y1, x2, y2, color: border.color, width: border.width } });
    };
    const half = (border: BorderLine | null) => (border?.width ?? 0) / 2;

    for (const box of row.boxes) {
      const spannedHeight = rows.slice(rowIndex, rowIndex + box.rowSpan).reduce((sum, r) => sum + r.height, 0);
      const cellMargins = { ...margins, ...box.cell.margins };
      const x0 = box.x0 + spacing;
      const x1 = box.x1 - spacing;
      const sides = {
        top: this.edge(table, box.cell, 'top', false),
        bottom: this.edge(table, box.cell, 'bottom', false),
        left: this.edge(table, box.cell, 'left', false),
        right: this.edge(table, box.cell, 'right', false),
      };
      const lastSpanned = rows[Math.min(rows.length - 1, rowIndex + box.rowSpan - 1)];
      const y0 = top + row.above - (sides.top?.width ?? 0);
      const y1 = top + spannedHeight - lastSpanned.below + (sides.bottom?.width ?? 0);
      if (box.cell.shading) {
        ops.push({ layer: 1, order: -2, op: { kind: 'rect', x: x0, y: y0, w: x1 - x0, h: y1 - y0, fill: box.cell.shading } });
      }

      const contentTop = top + row.above + (cellMargins.top ?? 0);
      const free = spannedHeight - row.above - lastSpanned.below - (cellMargins.top ?? 0) - (cellMargins.bottom ?? 0) - box.frame.height;
      const dy = box.cell.vAlign === 'center' ? Math.max(0, free / 2) : box.cell.vAlign === 'bottom' ? Math.max(0, free) : 0;
      const dx = x0 + (cellMargins.left ?? 5.4);
      for (const layered of box.frame.ops) ops.push({ ...layered, op: translate(layered.op, dx, contentTop + dy) });
      for (const request of box.frame.anchors) anchors.push(shiftRequest(request, dx, contentTop + dy));

      line(sides.top, x0, y0 + half(sides.top), x1, y0 + half(sides.top));
      line(sides.bottom, x0, y1 - half(sides.bottom), x1, y1 - half(sides.bottom));
      line(sides.left, x0 + half(sides.left), y0, x0 + half(sides.left), y1);
      line(sides.right, x1 - half(sides.right), y0, x1 - half(sides.right), y1);
    }

    const borders = table.props.borders ?? {};
    const left = edges[0];
    const right = edges[edges.length - 1];
    const bottom = top + row.height;
    line(borders.left, left, top, left, bottom);
    line(borders.right, right, top, right, bottom);
    if (opensPage) line(borders.top, left, top, right, top);
    if (isLast) line(borders.bottom, left, bottom, right, bottom);
  }

  private tableFrame(table: Table, left: number, width: number, context: LayoutContext): FrameResult {
    const layout = this.layoutRows(table, left, width, context);
    const ops: Layered[] = [];
    const bands: number[] = [];
    const anchors: AnchorRequest[] = [];
    const marks: FrameResult['marks'] = [];
    const starts: number[] = [];
    let y = 0;
    layout.rows.forEach((row, index) => {
      starts.push(y);
      this.drawRow(table, layout, index, y, ops, anchors, index === 0, index === layout.rows.length - 1);
      while (bands.length < ops.length) bands.push(y);
      y += row.height;
      marks.push({ at: y, fit: y });
    });
    return { height: y, ops, anchors, marks, spans: [], bands, starts };
  }

  /**
   * Splits a row at the page's end: each cell keeps the lines that fit in
   * `room`, cut only between lines and never through a picture, and the
   * rest continues on the next page. Null when nothing of it fits.
   */
  private splitRow(row: RowBox, room: number, margins: CellMargins): { head: RowBox; tail: RowBox } | null {
    const pad = (box: CellBox) => {
      const own = { ...margins, ...box.cell.margins };
      return (own.top ?? 0) + (own.bottom ?? 0);
    };
    const cuts = row.boxes.map((box) => {
      const limit = room - row.above - row.below - pad(box);
      return limit > 0 ? cutFrame(box.frame, limit) : { cut: 0, height: 0 };
    });
    // Word splits a row only when every cell with text keeps some of it on
    // this page; otherwise the whole row moves on.
    if (!cuts.every((cut, index) => cut.cut > 0.01 || row.boxes[index].frame.marks.length === 0)) return null;
    if (cuts.every((cut, index) => cut.cut >= row.boxes[index].frame.height - 0.01)) return null;

    // A part of a row starts at its top: vertical centring is for whole rows.
    const head: RowBox = {
      ...row,
      boxes: row.boxes.map((box, index) => ({ ...box, cell: { ...box.cell, vAlign: 'top' }, frame: frameHead(box.frame, cuts[index]) })),
      height: row.above + row.below + Math.max(...row.boxes.map((box, index) => cuts[index].height + pad(box))),
    };
    const tailBoxes = row.boxes.map((box, index) => ({ ...box, cell: { ...box.cell, vAlign: 'top' as const }, frame: frameTail(box.frame, cuts[index]) }));
    const tail: RowBox = {
      ...row,
      above: 0,
      boxes: tailBoxes,
      height: row.below + Math.max(...tailBoxes.map((box) => box.frame.height + pad(box))),
    };
    return { head, tail };
  }

  /**
   * The least of a table that must fit where it starts: its header rows and
   * the smallest part of the first row after them that Word would leave on
   * the page (all of it when the row may not split).
   */
  private openingHeight(table: Table, layout: RowLayout): number {
    let height = 0;
    let index = 0;
    while (index < layout.rows.length && layout.rows[index].header) height += layout.rows[index++].height;
    const row = layout.rows[index];
    if (!row) return height;
    if (table.rows[index]?.cantSplit || row.boxes.some((box) => box.rowSpan > 1)) return height + row.height;
    const content = Math.max(
      ...row.boxes.map((box) => {
        const own = { ...layout.margins, ...box.cell.margins };
        const first = box.frame.marks[0]?.fit ?? box.frame.height;
        return first + (own.top ?? 0) + (own.bottom ?? 0);
      }),
    );
    return height + Math.min(row.height, row.above + row.below + content);
  }

  private flowTable(table: Table, left: number, width: number) {
    const layout = this.layoutRows(table, left, width, { ...this.context, pageNumber: this.page.number });
    // A floating table anchored to the text sits its offset below where the
    // text had reached; the text after it continues underneath.
    const float = table.props.float;
    if (float && float.vertAnchor === 'text' && float.y > 0) this.y += float.y;
    const headers = layout.rows.filter((row) => row.header);

    // A table does not start with its header rows alone at the foot of a
    // page: they go over with the first row that follows them.
    if (!this.atPageTop() && this.y + this.openingHeight(table, layout) > this.page.bodyBottom + 0.01) this.breakPage();

    // Rows inside a vertical merge move as one; they are never split.
    const merged = new Set<number>();
    layout.rows.forEach((row, index) => {
      for (const box of row.boxes) for (let k = 0; k < box.rowSpan; k++) if (box.rowSpan > 1) merged.add(index + k);
    });

    let firstOnPage = true;
    /** On a page this table just broke to: nothing better to wait for. */
    let fresh = false;
    const newPage = (header: boolean) => {
      this.breakPage();
      firstOnPage = true;
      fresh = true;
      // Header rows repeat at the top of each continuation page.
      if (header) return;
      for (const row of headers) {
        this.drawRow(table, layout, layout.rows.indexOf(row), this.y, this.page.ops, this.page.anchors, true, false);
        this.y += row.height;
        firstOnPage = false;
      }
    };

    layout.rows.forEach((row, index) => {
      const isLast = index === layout.rows.length - 1;
      // Word lets a row break across pages unless told not to.
      const canSplit = !table.rows[index]?.cantSplit && !row.header && !merged.has(index);
      let current = row;
      let part = false;

      for (;;) {
        const room = this.page.bodyBottom - this.y;
        if (current.height <= room + 0.01) break;
        if (canSplit) {
          const split = this.splitRow(current, room, layout.margins);
          if (split) {
            this.drawRow(table, { ...layout, rows: [split.head] }, 0, this.y, this.page.ops, this.page.anchors, firstOnPage, false, index);
            this.y += split.head.height;
            newPage(row.header);
            current = split.tail;
            part = true;
            continue;
          }
        }
        // Taller than a page and unsplittable: it goes where it is.
        if (fresh || this.atPageTop()) break;
        newPage(row.header);
      }

      if (part) this.drawRow(table, { ...layout, rows: [current] }, 0, this.y, this.page.ops, this.page.anchors, firstOnPage, isLast, index);
      else this.drawRow(table, layout, index, this.y, this.page.ops, this.page.anchors, firstOnPage, isLast);
      this.y += current.height;
      firstOnPage = false;
      fresh = false;
    });

    this.previous = null;
  }

  /* ------------------------------------------------ floating objects */

  /**
   * Where a floating object goes, from what its position is relative to. In
   * a table cell (`cell`), Word lays the object out inside the cell: page and
   * margin positions count from the cell too.
   */
  anchorPosition(request: AnchorRequest, section: Section, cell?: { width: number }): { x: number; y: number } {
    if (request.fixed) return request.fixed;
    const { anchor } = request;
    const content = cell
      ? { left: 0, right: cell.width, top: 0, bottom: 0 }
      : {
          left: section.margins.left,
          right: section.width - section.margins.right,
          top: section.margins.top,
          bottom: section.height - section.margins.bottom,
        };
    const page = cell ? { width: cell.width, height: 0 } : { width: section.width, height: section.height };

    const h = anchor.h;
    let across = { from: content.left, to: content.right };
    if (h.from === 'page') across = { from: 0, to: page.width };
    else if (h.from === 'leftMargin') across = { from: 0, to: content.left };
    else if (h.from === 'rightMargin') across = { from: content.right, to: page.width };
    else if (h.from === 'character') across = { from: request.columnLeft, to: content.right };
    else if (h.from === 'column' || h.from === 'margin' || h.from === 'insideMargin' || h.from === 'outsideMargin') {
      across = { from: h.from === 'column' ? request.columnLeft : content.left, to: content.right };
    }
    let x = across.from;
    if (h.offset !== undefined) x = across.from + h.offset;
    else if (h.align === 'center') x = (across.from + across.to - anchor.width) / 2;
    else if (h.align === 'right' || h.align === 'outside') x = across.to - anchor.width;

    const v = anchor.v;
    let down = { from: content.top, to: content.bottom };
    if (v.from === 'page') down = { from: 0, to: page.height };
    else if (v.from === 'paragraph') down = { from: request.paraTop, to: request.paraTop };
    else if (v.from === 'line') down = { from: request.lineTop, to: request.lineTop };
    else if (v.from === 'topMargin') down = { from: 0, to: content.top };
    else if (v.from === 'bottomMargin') down = { from: content.bottom, to: page.height };
    let y = down.from;
    if (v.offset !== undefined) y = down.from + v.offset;
    else if (v.align === 'center') y = (down.from + down.to - anchor.height) / 2;
    else if (v.align === 'bottom' || v.align === 'outside') y = down.to - anchor.height;

    return { x, y };
  }

  placeAnchors(page: PageState) {
    for (const request of page.anchors) {
      const { anchor } = request;
      const { x, y } = this.anchorPosition(request, page.section);
      const layer = anchor.behind ? 0 : 2;
      for (const shape of anchor.shapes) this.drawShape(shape, x, y, layer, anchor.z, page.ops, page);
    }
  }

  private drawShape(shape: Shape, originX: number, originY: number, layer: 0 | 1 | 2, order: number, ops: Layered[], page: PageState) {
    const x = originX + shape.x;
    const y = originY + shape.y;

    if (shape.kind === 'picture') {
      ops.push({ layer, order, op: { kind: 'image', x, y, w: shape.w, h: shape.h, image: shape.image, crop: shape.crop } });
      return;
    }

    const d = geometryPath(shape, x, y);
    if (d && (shape.fill || shape.stroke)) {
      ops.push({
        layer,
        order,
        op: {
          kind: 'path',
          d,
          fill: shape.fill?.color,
          fillOpacity: shape.fill?.opacity,
          stroke: shape.stroke?.color,
          strokeWidth: shape.stroke?.width,
          strokeOpacity: shape.stroke?.opacity,
        },
      });
      if (shape.stroke && (shape.stroke.headArrow || shape.stroke.tailArrow)) {
        for (const arrow of arrowHeads(shape, x, y)) {
          ops.push({ layer, order, op: { kind: 'path', d: arrow, fill: shape.stroke.color, fillOpacity: shape.stroke.opacity } });
        }
      }
    }

    if (shape.text) {
      const { insets } = shape.text;
      // Slanted shapes keep their text inside the upright part, the way the
      // preset geometry's text rectangle defines it.
      const slant =
        shape.geometry === 'flowChartInputOutput'
          ? shape.w / 5
          : shape.geometry === 'parallelogram'
            ? Math.min(shape.w, shape.h) * 0.25
            : 0;
      const innerWidth = Math.max(1, shape.w - 2 * slant - insets.left - insets.right);
      const frame = this.frame(shape.text.blocks, innerWidth, { pageNumber: page.number });
      const lastBlock = shape.text.blocks[shape.text.blocks.length - 1];
      const trailing = lastBlock?.kind === 'paragraph' ? (lastBlock.props.after ?? 0) : 0;
      const free = shape.h - insets.top - insets.bottom - (frame.height - trailing);
      const dy = shape.text.anchor === 'center' ? free / 2 : shape.text.anchor === 'bottom' ? free : 0;
      const dx = x + slant + insets.left;
      const top = y + insets.top + dy;
      for (const layered of frame.ops) ops.push({ layer, order: order + 0.5, op: translate(layered.op, dx, top) });
    }
  }

  /* ------------------------------------------------- headers, footers */

  finishPages(): LaidOutPage[] {
    const total = this.pages.length;
    const out: LaidOutPage[] = [];

    for (const page of this.pages) {
      const section = page.section;
      const firstPage = page.firstOfSection && section.titlePage;
      const pick = (set: Section['footers']) => (firstPage ? set.first : set.default) ?? (firstPage ? undefined : set.default);
      const context = { pageNumber: page.number, totalPages: total, pageFormat: section.pageNumberFormat };
      const width = section.width - section.margins.left - section.margins.right;

      const footer = pick(section.footers);
      if (footer) {
        const frame = this.frame(footer, width, context);
        // Word stacks the footer upward from its distance to the page edge.
        const top = section.height - section.margins.footer - frame.height;
        // Headers and footers sit beneath everything in the body, even
        // pictures set behind the text — a full-page cover image hides them.
        for (const layered of frame.ops) page.ops.push({ layer: 0, order: CHROME_ORDER + layered.order, op: translate(layered.op, section.margins.left, top) });
        for (const request of frame.anchors) {
          page.anchors.push(shiftRequest(request, section.margins.left, top));
        }
      }

      const header = pick(section.headers);
      if (header) {
        const frame = this.frame(header, width, context);
        const top = section.margins.header;
        for (const layered of frame.ops) page.ops.push({ layer: 0, order: CHROME_ORDER + layered.order, op: translate(layered.op, section.margins.left, top) });
        for (const request of frame.anchors) {
          page.anchors.push(shiftRequest(request, section.margins.left, top));
        }
      }

      this.placeAnchors(page);
      out.push({ width: section.width, height: section.height, ops: page.ops });
    }

    return out;
  }
}

/* ==========================================================================
   Shape geometry
   ========================================================================== */

const f = (value: number) => value.toFixed(3);

function geometryPath(shape: ShapeBox, x: number, y: number): string | null {
  const { w, h } = shape;
  const x1 = x + w;
  const y1 = y + h;
  const poly = (points: [number, number][]) => `M${points.map(([px, py]) => `${f(px)},${f(py)}`).join(' L')} Z`;

  switch (shape.geometry) {
    case 'line':
    case 'straightConnector1':
    case 'bentConnector1': {
      const [ax, ay, bx, by] = [
        shape.flipH ? x1 : x,
        shape.flipV ? y1 : y,
        shape.flipH ? x : x1,
        shape.flipV ? y : y1,
      ];
      return `M${f(ax)},${f(ay)} L${f(bx)},${f(by)}`;
    }
    case 'ellipse':
    case 'flowChartConnector': {
      const k = 0.5523;
      const cx = x + w / 2;
      const cy = y + h / 2;
      const rx = w / 2;
      const ry = h / 2;
      return (
        `M${f(cx)},${f(y)} C${f(cx + rx * k)},${f(y)} ${f(x1)},${f(cy - ry * k)} ${f(x1)},${f(cy)} ` +
        `C${f(x1)},${f(cy + ry * k)} ${f(cx + rx * k)},${f(y1)} ${f(cx)},${f(y1)} ` +
        `C${f(cx - rx * k)},${f(y1)} ${f(x)},${f(cy + ry * k)} ${f(x)},${f(cy)} ` +
        `C${f(x)},${f(cy - ry * k)} ${f(cx - rx * k)},${f(y)} ${f(cx)},${f(y)} Z`
      );
    }
    case 'roundRect':
    case 'flowChartAlternateProcess':
    case 'flowChartTerminator': {
      const r = shape.geometry === 'flowChartTerminator' ? Math.min(w, h) / 2 : Math.min(w, h) * 0.1667;
      const k = 0.5523 * r;
      return (
        `M${f(x + r)},${f(y)} L${f(x1 - r)},${f(y)} C${f(x1 - r + k)},${f(y)} ${f(x1)},${f(y + r - k)} ${f(x1)},${f(y + r)} ` +
        `L${f(x1)},${f(y1 - r)} C${f(x1)},${f(y1 - r + k)} ${f(x1 - r + k)},${f(y1)} ${f(x1 - r)},${f(y1)} ` +
        `L${f(x + r)},${f(y1)} C${f(x + r - k)},${f(y1)} ${f(x)},${f(y1 - r + k)} ${f(x)},${f(y1 - r)} ` +
        `L${f(x)},${f(y + r)} C${f(x)},${f(y + r - k)} ${f(x + r - k)},${f(y)} ${f(x + r)},${f(y)} Z`
      );
    }
    case 'parallelogram':
    case 'flowChartInputOutput': {
      const o = shape.geometry === 'parallelogram' ? Math.min(w, h) * 0.25 : w / 5;
      return poly([[x + o, y], [x1, y], [x1 - o, y1], [x, y1]]);
    }
    case 'diamond':
    case 'flowChartDecision':
      return poly([[x + w / 2, y], [x1, y + h / 2], [x + w / 2, y1], [x, y + h / 2]]);
    case 'triangle':
      return poly([[x + w / 2, y], [x1, y1], [x, y1]]);
    case 'downArrow': {
      const shaft = w * 0.25;
      const head = h * 0.5;
      return poly([[x + shaft, y], [x1 - shaft, y], [x1 - shaft, y1 - head], [x1, y1 - head], [x + w / 2, y1], [x, y1 - head], [x + shaft, y1 - head]]);
    }
    case 'rightArrow': {
      const shaft = h * 0.25;
      const head = w * 0.5;
      return poly([[x, y + shaft], [x1 - head, y + shaft], [x1 - head, y], [x1, y + h / 2], [x1 - head, y1], [x1 - head, y1 - shaft], [x, y1 - shaft]]);
    }
    default:
      return poly([[x, y], [x1, y], [x1, y1], [x, y1]]);
  }
}

function arrowHeads(shape: ShapeBox, x: number, y: number): string[] {
  if (!shape.stroke) return [];
  const [ax, ay, bx, by] = [
    shape.flipH ? x + shape.w : x,
    shape.flipV ? y + shape.h : y,
    shape.flipH ? x : x + shape.w,
    shape.flipV ? y : y + shape.h,
  ];
  const size = Math.max(6, shape.stroke.width * 6);
  const head = (tipX: number, tipY: number, fromX: number, fromY: number) => {
    const angle = Math.atan2(tipY - fromY, tipX - fromX);
    const left = [tipX - size * Math.cos(angle - 0.45), tipY - size * Math.sin(angle - 0.45)];
    const right = [tipX - size * Math.cos(angle + 0.45), tipY - size * Math.sin(angle + 0.45)];
    return `M${f(tipX)},${f(tipY)} L${f(left[0])},${f(left[1])} L${f(right[0])},${f(right[1])} Z`;
  };
  const out: string[] = [];
  if (shape.stroke.tailArrow) out.push(head(bx, by, ax, ay));
  if (shape.stroke.headArrow) out.push(head(ax, ay, bx, by));
  return out;
}

export type { Inline };
