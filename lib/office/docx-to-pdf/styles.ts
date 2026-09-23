/**
 * Formatting properties and how Word resolves them.
 *
 * A run's final look is the merge, in order, of: document defaults → table
 * style → paragraph style chain → character style chain → direct formatting.
 * Paragraphs follow the same order with numbering-level properties slotted in
 * between the paragraph style and direct formatting. Getting this order right
 * is most of what makes the output look like Word: the body text of the test
 * report is Arial 12 at 1.5 spacing purely through the "List Paragraph" style
 * and the table text is single-spaced purely through "Table Grid".
 */

import { attr, child, children, num, parseXml, path, toggle, twips, val } from './xml';

/* ==========================================================================
   Property shapes
   ========================================================================== */

export interface RunProps {
  font?: string;
  /** Theme font slot, resolved against the theme when the font is needed. */
  fontTheme?: string;
  bold?: boolean;
  italic?: boolean;
  /** Points. */
  size?: number;
  color?: string;
  underline?: string;
  strike?: boolean;
  caps?: boolean;
  smallCaps?: boolean;
  vertAlign?: 'superscript' | 'subscript' | 'baseline';
  highlight?: string;
  shading?: string;
  /** Extra space after each character, points. */
  spacing?: number;
  vanish?: boolean;
  styleId?: string;
}

export interface TabStop {
  /** Points from the text column's left edge. */
  pos: number;
  align: 'left' | 'center' | 'right' | 'decimal' | 'bar' | 'clear';
  leader: 'none' | 'dot' | 'hyphen' | 'underscore' | 'middleDot' | 'heavy';
}

export interface BorderLine {
  style: string;
  /** Points. */
  width: number;
  /** Distance from text, points. */
  space: number;
  color: string;
}

export interface ParaProps {
  styleId?: string;
  align?: 'left' | 'center' | 'right' | 'both' | 'distribute';
  indLeft?: number;
  indRight?: number;
  /** Positive first-line indent, negative hanging. */
  firstLine?: number;
  before?: number;
  after?: number;
  beforeAuto?: boolean;
  afterAuto?: boolean;
  /** Line spacing value: 240ths of a line for auto, points otherwise. */
  line?: number;
  lineRule?: 'auto' | 'exact' | 'atLeast';
  contextual?: boolean;
  keepNext?: boolean;
  keepLines?: boolean;
  pageBreakBefore?: boolean;
  widowControl?: boolean;
  tabs?: TabStop[];
  numId?: string;
  ilvl?: number;
  borders?: Partial<Record<'top' | 'bottom' | 'left' | 'right' | 'between', BorderLine>>;
  shading?: string;
  outlineLvl?: number;
}

export interface TableBorders {
  top?: BorderLine | null;
  bottom?: BorderLine | null;
  left?: BorderLine | null;
  right?: BorderLine | null;
  insideH?: BorderLine | null;
  insideV?: BorderLine | null;
}

export interface CellMargins {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
}

export interface TableProps {
  styleId?: string;
  borders?: TableBorders;
  cellMargins?: CellMargins;
  indent?: number;
  align?: 'left' | 'center' | 'right';
  shading?: string;
  /** Space around every cell (tblCellSpacing), points: each cell gets its own border box. */
  cellSpacing?: number;
  /** A floating table's offset from where it is anchored in the text, points. */
  float?: { x: number; y: number; xAlign?: string; horzAnchor: string; vertAnchor: string };
}

/* ==========================================================================
   Merging
   ========================================================================== */

export function mergeRun(...layers: (RunProps | undefined)[]): RunProps {
  const out: RunProps = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [key, value] of Object.entries(layer)) {
      if (value !== undefined) (out as Record<string, unknown>)[key] = value;
    }
    // An explicit font overrides an inherited theme slot and vice versa.
    if (layer.font !== undefined) out.fontTheme = layer.fontTheme;
    if (layer.fontTheme !== undefined && layer.font === undefined) out.font = undefined;
  }
  return out;
}

export function mergePara(...layers: (ParaProps | undefined)[]): ParaProps {
  const out: ParaProps = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [key, value] of Object.entries(layer)) {
      if (value === undefined) continue;
      if (key === 'tabs') {
        out.tabs = mergeTabs(out.tabs, value as TabStop[]);
      } else if (key === 'borders') {
        out.borders = { ...out.borders, ...(value as ParaProps['borders']) };
      } else {
        (out as Record<string, unknown>)[key] = value;
      }
    }
  }
  return out;
}

/** Tab stops accumulate down the style chain; `clear` removes an inherited one. */
function mergeTabs(base: TabStop[] | undefined, next: TabStop[]): TabStop[] {
  const result = [...(base ?? [])];
  for (const tab of next) {
    const index = result.findIndex((existing) => Math.abs(existing.pos - tab.pos) < 0.5);
    if (index >= 0) result.splice(index, 1);
    if (tab.align !== 'clear') result.push(tab);
  }
  return result.sort((a, b) => a.pos - b.pos);
}

export function mergeTable(...layers: (TableProps | undefined)[]): TableProps {
  const out: TableProps = {};
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.styleId !== undefined) out.styleId = layer.styleId;
    if (layer.borders) out.borders = { ...out.borders, ...layer.borders };
    if (layer.cellMargins) out.cellMargins = { ...out.cellMargins, ...layer.cellMargins };
    if (layer.indent !== undefined) out.indent = layer.indent;
    if (layer.align !== undefined) out.align = layer.align;
    if (layer.shading !== undefined) out.shading = layer.shading;
    if (layer.float !== undefined) out.float = layer.float;
    if (layer.cellSpacing !== undefined) out.cellSpacing = layer.cellSpacing;
  }
  return out;
}

/* ==========================================================================
   Parsing
   ========================================================================== */

const HIGHLIGHT: Record<string, string> = {
  yellow: '#FFFF00',
  green: '#00FF00',
  cyan: '#00FFFF',
  magenta: '#FF00FF',
  blue: '#0000FF',
  red: '#FF0000',
  darkBlue: '#000080',
  darkCyan: '#008080',
  darkGreen: '#008000',
  darkMagenta: '#800080',
  darkRed: '#800000',
  darkYellow: '#808000',
  darkGray: '#808080',
  lightGray: '#C0C0C0',
  black: '#000000',
  white: '#FFFFFF',
};

function color(value: string | null): string | undefined {
  if (!value || value === 'auto') return undefined;
  return /^[0-9a-f]{6}$/i.test(value) ? `#${value.toUpperCase()}` : undefined;
}

export function parseRunProps(rPr: Element | undefined): RunProps | undefined {
  if (!rPr) return undefined;
  const props: RunProps = {};

  const fonts = child(rPr, 'rFonts');
  if (fonts) {
    const font = attr(fonts, 'ascii') ?? attr(fonts, 'hAnsi');
    const theme = attr(fonts, 'asciiTheme') ?? attr(fonts, 'hAnsiTheme');
    if (font) props.font = font;
    else if (theme) props.fontTheme = theme;
  }

  props.bold = toggle(child(rPr, 'b'));
  props.italic = toggle(child(rPr, 'i'));
  const size = num(val(child(rPr, 'sz')));
  if (size !== undefined) props.size = size / 2;

  const colorElement = child(rPr, 'color');
  if (colorElement) props.color = color(val(colorElement)) ?? (val(colorElement) === 'auto' ? '#000000' : undefined);

  const underline = child(rPr, 'u');
  if (underline) props.underline = val(underline) ?? 'single';
  props.strike = toggle(child(rPr, 'strike')) ?? toggle(child(rPr, 'dstrike'));
  props.caps = toggle(child(rPr, 'caps'));
  props.smallCaps = toggle(child(rPr, 'smallCaps'));
  props.vanish = toggle(child(rPr, 'vanish'));

  const vertAlign = val(child(rPr, 'vertAlign'));
  if (vertAlign === 'superscript' || vertAlign === 'subscript' || vertAlign === 'baseline') props.vertAlign = vertAlign;

  const highlight = val(child(rPr, 'highlight'));
  if (highlight && highlight !== 'none') props.highlight = HIGHLIGHT[highlight];

  const shd = child(rPr, 'shd');
  if (shd) props.shading = color(attr(shd, 'fill'));

  const spacing = num(val(child(rPr, 'spacing')));
  if (spacing !== undefined) props.spacing = spacing / 20;

  const style = val(child(rPr, 'rStyle'));
  if (style) props.styleId = style;

  return props;
}

function parseBorder(element: Element | undefined): BorderLine | null | undefined {
  if (!element) return undefined;
  const style = val(element) ?? 'single';
  if (style === 'nil' || style === 'none') return null;
  return {
    style,
    width: Math.max(0.25, (num(attr(element, 'sz')) ?? 4) / 8),
    space: num(attr(element, 'space')) ?? 0,
    color: color(attr(element, 'color')) ?? '#000000',
  };
}

function parseTabs(tabs: Element | undefined): TabStop[] | undefined {
  if (!tabs) return undefined;
  return children(tabs, 'tab').map((tab) => {
    const align = (val(tab) ?? 'left') as string;
    return {
      pos: (num(attr(tab, 'pos')) ?? 0) / 20,
      align: (align === 'start' ? 'left' : align === 'end' ? 'right' : align === 'num' ? 'left' : align) as TabStop['align'],
      leader: ((attr(tab, 'leader') as TabStop['leader'] | null) ?? 'none'),
    };
  });
}

export function parseParaProps(pPr: Element | undefined): ParaProps | undefined {
  if (!pPr) return undefined;
  const props: ParaProps = {};

  const style = val(child(pPr, 'pStyle'));
  if (style) props.styleId = style;

  const jc = val(child(pPr, 'jc'));
  if (jc) {
    props.align =
      jc === 'start' || jc === 'left'
        ? 'left'
        : jc === 'end' || jc === 'right'
          ? 'right'
          : jc === 'center'
            ? 'center'
            : jc === 'distribute'
              ? 'distribute'
              : 'both';
  }

  const ind = child(pPr, 'ind');
  if (ind) {
    const left = num(attr(ind, 'left') ?? attr(ind, 'start'));
    const right = num(attr(ind, 'right') ?? attr(ind, 'end'));
    const firstLine = num(attr(ind, 'firstLine'));
    const hanging = num(attr(ind, 'hanging'));
    if (left !== undefined) props.indLeft = left / 20;
    if (right !== undefined) props.indRight = right / 20;
    if (hanging !== undefined) props.firstLine = -hanging / 20;
    else if (firstLine !== undefined) props.firstLine = firstLine / 20;
  }

  const spacing = child(pPr, 'spacing');
  if (spacing) {
    const before = num(attr(spacing, 'before'));
    const after = num(attr(spacing, 'after'));
    const line = num(attr(spacing, 'line'));
    if (before !== undefined) props.before = before / 20;
    if (after !== undefined) props.after = after / 20;
    if (attr(spacing, 'beforeAutospacing') !== null) props.beforeAuto = attr(spacing, 'beforeAutospacing') !== '0';
    if (attr(spacing, 'afterAutospacing') !== null) props.afterAuto = attr(spacing, 'afterAutospacing') !== '0';
    if (line !== undefined) {
      const rule = (attr(spacing, 'lineRule') ?? 'auto') as ParaProps['lineRule'];
      props.lineRule = rule;
      props.line = rule === 'auto' ? line : line / 20;
    }
  }

  props.contextual = toggle(child(pPr, 'contextualSpacing'));
  props.keepNext = toggle(child(pPr, 'keepNext'));
  props.keepLines = toggle(child(pPr, 'keepLines'));
  props.pageBreakBefore = toggle(child(pPr, 'pageBreakBefore'));
  props.widowControl = toggle(child(pPr, 'widowControl'));
  props.tabs = parseTabs(child(pPr, 'tabs'));

  const numPr = child(pPr, 'numPr');
  if (numPr) {
    const numId = val(child(numPr, 'numId'));
    const ilvl = num(val(child(numPr, 'ilvl')));
    if (numId !== null) props.numId = numId;
    if (ilvl !== undefined) props.ilvl = ilvl;
  }

  const pBdr = child(pPr, 'pBdr');
  if (pBdr) {
    const borders: ParaProps['borders'] = {};
    for (const side of ['top', 'bottom', 'left', 'right', 'between'] as const) {
      const border = parseBorder(child(pBdr, side));
      if (border) borders[side] = border;
    }
    props.borders = borders;
  }

  const shd = child(pPr, 'shd');
  if (shd) props.shading = color(attr(shd, 'fill'));

  const outline = num(val(child(pPr, 'outlineLvl')));
  if (outline !== undefined) props.outlineLvl = outline;

  return props;
}

export function parseTableBorders(element: Element | undefined): TableBorders | undefined {
  if (!element) return undefined;
  const out: TableBorders = {};
  for (const [side, alias] of [
    ['top', 'top'],
    ['bottom', 'bottom'],
    ['left', 'start'],
    ['right', 'end'],
    ['insideH', 'insideH'],
    ['insideV', 'insideV'],
  ] as const) {
    const border = parseBorder(child(element, side) ?? child(element, alias));
    if (border !== undefined) out[side] = border;
  }
  return out;
}

export function parseCellMargins(element: Element | undefined): CellMargins | undefined {
  if (!element) return undefined;
  const read = (name: string, alias: string) => {
    const node = child(element, name) ?? child(element, alias);
    if (!node) return undefined;
    const type = attr(node, 'type');
    const value = num(attr(node, 'w'));
    if (value === undefined || (type && type !== 'dxa')) return undefined;
    return value / 20;
  };
  return {
    top: read('top', 'top'),
    bottom: read('bottom', 'bottom'),
    left: read('left', 'start'),
    right: read('right', 'end'),
  };
}

export function parseTableProps(tblPr: Element | undefined): TableProps | undefined {
  if (!tblPr) return undefined;
  const props: TableProps = {};
  const style = val(child(tblPr, 'tblStyle'));
  if (style) props.styleId = style;
  props.borders = parseTableBorders(child(tblPr, 'tblBorders'));
  props.cellMargins = parseCellMargins(child(tblPr, 'tblCellMar'));
  const ind = child(tblPr, 'tblInd');
  if (ind && (attr(ind, 'type') ?? 'dxa') === 'dxa') props.indent = twips(num(attr(ind, 'w')));
  const jc = val(child(tblPr, 'jc'));
  if (jc) props.align = jc === 'center' ? 'center' : jc === 'right' || jc === 'end' ? 'right' : 'left';
  const shd = child(tblPr, 'shd');
  if (shd) props.shading = color(attr(shd, 'fill'));
  const spacing = child(tblPr, 'tblCellSpacing');
  if (spacing && (attr(spacing, 'type') ?? 'dxa') === 'dxa') props.cellSpacing = twips(num(attr(spacing, 'w')));
  const floating = child(tblPr, 'tblpPr');
  if (floating) {
    props.float = {
      x: (num(attr(floating, 'tblpX')) ?? 0) / 20,
      y: (num(attr(floating, 'tblpY')) ?? 0) / 20,
      xAlign: attr(floating, 'tblpXSpec') ?? undefined,
      horzAnchor: attr(floating, 'horzAnchor') ?? 'text',
      vertAnchor: attr(floating, 'vertAnchor') ?? 'margin',
    };
  }
  return props;
}

export function shadingColor(element: Element | undefined): string | undefined {
  if (!element) return undefined;
  return color(attr(element, 'fill'));
}

/* ==========================================================================
   Theme
   ========================================================================== */

export interface Theme {
  majorFont: string;
  minorFont: string;
  colors: Record<string, string>;
  /** Line widths of the theme's line styles, points (index 1-based). */
  lineWidths: number[];
}

export function parseTheme(xml: string | null): Theme {
  const theme: Theme = { majorFont: 'Calibri Light', minorFont: 'Calibri', colors: {}, lineWidths: [0.75, 1, 1.5] };
  if (!xml) return theme;
  const document = parseXml(xml);
  const root = document.documentElement;

  const find = (node: Element, name: string): Element | undefined => {
    for (const next of Array.from(node.children)) {
      if (next.localName === name || next.nodeName.endsWith(`:${name}`)) return next;
      const deeper = find(next, name);
      if (deeper) return deeper;
    }
    return undefined;
  };

  const major = find(root, 'majorFont');
  const minor = find(root, 'minorFont');
  const latin = (node?: Element) => (node ? attr(child(node, 'latin'), 'typeface') : null);
  theme.majorFont = latin(major) || theme.majorFont;
  theme.minorFont = latin(minor) || theme.minorFont;

  const scheme = find(root, 'clrScheme');
  for (const entry of children(scheme)) {
    const name = entry.localName.replace(/^.*:/, '');
    const value = child(entry, 'srgbClr') ?? child(entry, 'sysClr');
    const hex = attr(value, 'val') === 'windowText' ? attr(value, 'lastClr') : attr(value, 'lastClr') ?? attr(value, 'val');
    if (hex && /^[0-9a-f]{6}$/i.test(hex)) theme.colors[name] = `#${hex.toUpperCase()}`;
  }
  // Word's aliases for the theme slots.
  theme.colors.tx1 = theme.colors.dk1 ?? '#000000';
  theme.colors.bg1 = theme.colors.lt1 ?? '#FFFFFF';
  theme.colors.tx2 = theme.colors.dk2 ?? '#44546A';
  theme.colors.bg2 = theme.colors.lt2 ?? '#E7E6E6';
  theme.colors.text1 = theme.colors.tx1;
  theme.colors.background1 = theme.colors.bg1;

  const lines = find(root, 'lnStyleLst');
  if (lines) theme.lineWidths = children(lines, 'ln').map((line) => (num(attr(line, 'w')) ?? 9525) / 12700);

  return theme;
}

/* ==========================================================================
   Styles
   ========================================================================== */

interface RawStyle {
  id: string;
  type: string;
  basedOn?: string;
  para?: ParaProps;
  run?: RunProps;
  table?: TableProps;
}

export class StyleSheet {
  readonly defaultRun: RunProps;
  readonly defaultPara: ParaProps;
  readonly defaultParagraphStyle?: string;
  readonly defaultTableStyle?: string;
  private readonly styles = new Map<string, RawStyle>();
  private readonly paraCache = new Map<string, { para: ParaProps; run: RunProps }>();

  constructor(xml: string | null) {
    this.defaultRun = { font: undefined, fontTheme: 'minorHAnsi', size: 10 };
    this.defaultPara = {};
    if (!xml) return;

    const root = parseXml(xml).documentElement;
    const defaults = child(root, 'docDefaults');
    this.defaultRun = mergeRun(this.defaultRun, parseRunProps(path(defaults, 'rPrDefault', 'rPr')));
    this.defaultPara = parseParaProps(path(defaults, 'pPrDefault', 'pPr')) ?? {};

    for (const node of children(root, 'style')) {
      const id = attr(node, 'styleId');
      if (!id) continue;
      const type = attr(node, 'type') ?? 'paragraph';
      const style: RawStyle = {
        id,
        type,
        basedOn: val(child(node, 'basedOn')) ?? undefined,
        para: parseParaProps(child(node, 'pPr')),
        run: parseRunProps(child(node, 'rPr')),
        table: parseTableProps(child(node, 'tblPr')),
      };
      this.styles.set(id, style);
      if (attr(node, 'default') === '1' || attr(node, 'default') === 'true') {
        if (type === 'paragraph') this.defaultParagraphStyle = id;
        if (type === 'table') this.defaultTableStyle = id;
      }
    }
  }

  private chain(id: string | undefined): RawStyle[] {
    const out: RawStyle[] = [];
    const seen = new Set<string>();
    let current = id ? this.styles.get(id) : undefined;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      out.unshift(current);
      current = current.basedOn ? this.styles.get(current.basedOn) : undefined;
    }
    return out;
  }

  /** Paragraph style chain, merged: its paragraph props and the run props it gives its text. */
  paragraphStyle(id: string | undefined): { para: ParaProps; run: RunProps } {
    const key = id ?? this.defaultParagraphStyle ?? '';
    const cached = this.paraCache.get(key);
    if (cached) return cached;
    const chain = this.chain(key);
    const result = {
      para: mergePara(...chain.map((style) => style.para)),
      run: mergeRun(...chain.map((style) => style.run)),
    };
    this.paraCache.set(key, result);
    return result;
  }

  characterStyle(id: string | undefined): RunProps {
    if (!id) return {};
    return mergeRun(...this.chain(id).map((style) => style.run));
  }

  tableStyle(id: string | undefined): { table: TableProps; para: ParaProps; run: RunProps } {
    const chain = this.chain(id ?? this.defaultTableStyle);
    return {
      table: mergeTable(...chain.map((style) => style.table)),
      para: mergePara(...chain.map((style) => style.para)),
      run: mergeRun(...chain.map((style) => style.run)),
    };
  }

  /** The numbering a paragraph style carries (e.g. "3.1.1 Style" → numId 4). */
  styleNumbering(id: string | undefined): { numId?: string; ilvl?: number } {
    const para = this.paragraphStyle(id).para;
    return { numId: para.numId, ilvl: para.ilvl };
  }
}

/* ==========================================================================
   Numbering
   ========================================================================== */

export interface NumberingLevel {
  start: number;
  format: string;
  text: string;
  align: 'left' | 'center' | 'right';
  suffix: 'tab' | 'space' | 'nothing';
  para?: ParaProps;
  run?: RunProps;
  isLegal: boolean;
}

interface NumInstance {
  abstractId: string;
  overrides: Map<number, { start?: number; level?: NumberingLevel }>;
}

export class Numbering {
  private readonly abstracts = new Map<string, Map<number, NumberingLevel>>();
  private readonly instances = new Map<string, NumInstance>();
  /** Counters per abstract list, per level — lists sharing a definition continue. */
  private readonly counters = new Map<string, number[]>();
  private readonly startedInstances = new Set<string>();

  constructor(xml: string | null) {
    if (!xml) return;
    const root = parseXml(xml).documentElement;

    const parseLevel = (node: Element): NumberingLevel => ({
      start: num(val(child(node, 'start'))) ?? 1,
      format: val(child(node, 'numFmt')) ?? 'decimal',
      text: val(child(node, 'lvlText')) ?? '',
      align: ((val(child(node, 'lvlJc')) ?? 'left') as string).replace('start', 'left').replace('end', 'right') as NumberingLevel['align'],
      suffix: (val(child(node, 'suff')) ?? 'tab') as NumberingLevel['suffix'],
      para: parseParaProps(child(node, 'pPr')),
      run: parseRunProps(child(node, 'rPr')),
      isLegal: toggle(child(node, 'isLgl')) ?? false,
    });

    for (const node of children(root, 'abstractNum')) {
      const id = attr(node, 'abstractNumId');
      if (id === null) continue;
      const levels = new Map<number, NumberingLevel>();
      for (const level of children(node, 'lvl')) levels.set(num(attr(level, 'ilvl')) ?? 0, parseLevel(level));
      this.abstracts.set(id, levels);
    }

    for (const node of children(root, 'num')) {
      const id = attr(node, 'numId');
      const abstractId = val(child(node, 'abstractNumId'));
      if (id === null || abstractId === null) continue;
      const overrides = new Map<number, { start?: number; level?: NumberingLevel }>();
      for (const override of children(node, 'lvlOverride')) {
        const ilvl = num(attr(override, 'ilvl')) ?? 0;
        const level = child(override, 'lvl');
        overrides.set(ilvl, {
          start: num(val(child(override, 'startOverride'))),
          level: level ? parseLevel(level) : undefined,
        });
      }
      this.instances.set(id, { abstractId, overrides });
    }
  }

  level(numId: string | undefined, ilvl: number): NumberingLevel | undefined {
    if (!numId || numId === '0') return undefined;
    const instance = this.instances.get(numId);
    if (!instance) return undefined;
    return instance.overrides.get(ilvl)?.level ?? this.abstracts.get(instance.abstractId)?.get(ilvl);
  }

  /** Advances the list counter and returns the label text for this paragraph. */
  next(numId: string, ilvl: number): string | undefined {
    const instance = this.instances.get(numId);
    const level = this.level(numId, ilvl);
    if (!instance || !level) return undefined;

    const levels = this.abstracts.get(instance.abstractId) ?? new Map<number, NumberingLevel>();
    const key = instance.abstractId;
    const counters = this.counters.get(key) ?? [];

    // A list instance with a start override restarts its levels the first
    // time it is used; otherwise instances of one definition keep counting.
    if (!this.startedInstances.has(numId)) {
      this.startedInstances.add(numId);
      for (const [overrideLevel, override] of instance.overrides) {
        if (override.start !== undefined) counters[overrideLevel] = override.start - 1;
      }
    }

    const startOf = (index: number) => (index === ilvl ? level.start : (levels.get(index)?.start ?? 1));
    counters[ilvl] = (counters[ilvl] ?? startOf(ilvl) - 1) + 1;
    // A higher level resets everything below it.
    for (let deeper = ilvl + 1; deeper < 9; deeper++) counters[deeper] = undefined as unknown as number;
    this.counters.set(key, counters);

    return level.text.replace(/%(\d)/g, (_, digit: string) => {
      const index = Number(digit) - 1;
      const value = counters[index] ?? startOf(index);
      const format = level.isLegal && index !== ilvl ? 'decimal' : (index === ilvl ? level.format : levels.get(index)?.format ?? 'decimal');
      return formatNumber(value, format);
    });
  }
}

export function formatNumber(value: number, format: string): string {
  switch (format) {
    case 'lowerLetter':
      return letters(value).toLowerCase();
    case 'upperLetter':
      return letters(value);
    case 'lowerRoman':
      return roman(value).toLowerCase();
    case 'upperRoman':
      return roman(value);
    case 'decimalZero':
      return value < 10 ? `0${value}` : String(value);
    case 'bullet':
    case 'none':
      return '';
    default:
      return String(value);
  }
}

function letters(value: number): string {
  // Word repeats the letter: a, b, … z, aa, bb, …
  const index = (value - 1) % 26;
  const repeat = Math.floor((value - 1) / 26) + 1;
  return String.fromCharCode(65 + index).repeat(repeat);
}

function roman(value: number): string {
  const table: [number, string][] = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
    [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ];
  let out = '';
  let rest = value;
  for (const [amount, symbol] of table) {
    while (rest >= amount) {
      out += symbol;
      rest -= amount;
    }
  }
  return out;
}

/* ==========================================================================
   Settings
   ========================================================================== */

export interface Settings {
  defaultTabStop: number;
}

export function parseSettings(xml: string | null): Settings {
  const settings: Settings = { defaultTabStop: 36 };
  if (!xml) return settings;
  const root = parseXml(xml).documentElement;
  const tab = num(val(child(root, 'defaultTabStop')));
  if (tab) settings.defaultTabStop = tab / 20;
  return settings;
}
