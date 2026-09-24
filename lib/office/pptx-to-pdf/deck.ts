/**
 * Reads a .pptx into slides of positioned, fully resolved elements.
 *
 * A slide on its own says little: most of what it looks like is inherited.
 * A placeholder takes its position, text styles, and body settings from the
 * matching placeholder on its layout, which takes them from the master; the
 * master's text styles and the theme's colours and fonts sit underneath all
 * of that. This module walks those chains so layout.ts only ever sees
 * absolute boxes, concrete colours, and resolved text formatting.
 */

import { strFromU8, unzipSync } from 'fflate';
import { attr, child, children, localName, num, parseXml, path } from '../docx-to-pdf/xml';

/* ==========================================================================
   Model
   ========================================================================== */

export interface Paint {
  /** #rrggbb */
  color: string;
  /** 0–1 */
  alpha: number;
}

export interface Crop {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type Fill = { kind: 'solid'; paint: Paint } | { kind: 'image'; image: string; crop?: Crop; alpha: number } | null;

export interface ArrowEnd {
  type: string;
  w: string;
  len: string;
}

export interface Stroke {
  paint: Paint;
  width: number;
  /** Dash and gap lengths as multiples of the line width. */
  dash?: number[];
  head?: ArrowEnd;
  tail?: ArrowEnd;
  cap: 'flat' | 'round' | 'square';
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Degrees clockwise. */
  rot: number;
  flipH: boolean;
  flipV: boolean;
}

export type PathCommand =
  | { op: 'M' | 'L'; x: number; y: number }
  | { op: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { op: 'A'; wR: number; hR: number; stAng: number; swAng: number }
  | { op: 'Z' };

export interface CustomPath {
  w: number;
  h: number;
  fill: boolean;
  stroke: boolean;
  commands: PathCommand[];
}

export type Geometry = { preset: string; adjust: Record<string, number> } | { custom: CustomPath[] };

export interface Run {
  text: string;
  size: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  paint: Paint;
  font: string;
  /** Percent of the font size the text is raised (negative: lowered). */
  baseline: number;
  /** Kerning applies from this font size up; 0: never. */
  kern: number;
  /** A line break rather than text. */
  br?: boolean;
  tab?: boolean;
}

export type Bullet =
  | { kind: 'none' }
  | { kind: 'char'; char: string; font?: string; paint?: Paint; sizePct?: number; sizePts?: number }
  | { kind: 'number'; scheme: string; startAt: number; font?: string; paint?: Paint; sizePct?: number; sizePts?: number };

export type Spacing = { pct: number } | { pts: number };

export interface TextParagraph {
  level: number;
  align: 'l' | 'ctr' | 'r' | 'just' | 'dist';
  marL: number;
  indent: number;
  lineSpacing: Spacing;
  spaceBefore: Spacing;
  spaceAfter: Spacing;
  bullet: Bullet;
  defaultTab: number;
  runs: Run[];
  /** Formatting of the paragraph end: sizes an empty paragraph. */
  end: Run;
}

export interface TextBody {
  insets: { l: number; t: number; r: number; b: number };
  anchor: 't' | 'ctr' | 'b';
  anchorCenter: boolean;
  wrap: boolean;
  fontScale: number;
  lineReduction: number;
  vertical: string;
  paragraphs: TextParagraph[];
}

export interface ShapeElement {
  kind: 'shape';
  box: Box;
  geometry: Geometry;
  fill: Fill;
  stroke: Stroke | null;
  text?: TextBody;
}

export interface PictureElement {
  kind: 'picture';
  box: Box;
  image: string;
  crop?: Crop;
  alpha: number;
  geometry: Geometry;
  stroke: Stroke | null;
}

export interface TableCell {
  text: TextBody;
  fill: Fill;
  borders: { l: Stroke | null; r: Stroke | null; t: Stroke | null; b: Stroke | null };
  gridSpan: number;
  rowSpan: number;
  /** Covered by a merge from the left or above. */
  merged: boolean;
}

export interface TableElement {
  kind: 'table';
  x: number;
  y: number;
  columns: number[];
  rows: { height: number; cells: TableCell[] }[];
}

export type SlideElement = ShapeElement | PictureElement | TableElement;

export interface Slide {
  number: number;
  background: Fill;
  elements: SlideElement[];
}

export interface DeckImage {
  data: Uint8Array;
  type: 'png' | 'jpg' | 'other';
  mime: string;
}

export interface Deck {
  width: number;
  height: number;
  slides: Slide[];
  images: Map<string, DeckImage>;
}

/* ==========================================================================
   Package
   ========================================================================== */

type Files = Record<string, Uint8Array>;

function text(files: Files, name: string): string | null {
  const entry = files[name];
  return entry ? strFromU8(entry) : null;
}

function resolvePath(dir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const out: string[] = [];
  for (const part of (dir + target).split('/')) {
    if (part === '..') out.pop();
    else if (part !== '.' && part !== '') out.push(part);
  }
  return out.join('/');
}

interface Rel {
  target: string;
  type: string;
  external: boolean;
}

function readRels(files: Files, part: string): Map<string, Rel> {
  const slash = part.lastIndexOf('/');
  const dir = part.slice(0, slash + 1);
  const xml = text(files, `${dir}_rels/${part.slice(slash + 1)}.rels`);
  const map = new Map<string, Rel>();
  if (!xml) return map;
  for (const node of children(parseXml(xml).documentElement, 'Relationship')) {
    const id = attr(node, 'Id');
    const target = attr(node, 'Target');
    if (!id || !target) continue;
    const external = attr(node, 'TargetMode') === 'External';
    map.set(id, { target: external ? target : resolvePath(dir, target), type: attr(node, 'Type') ?? '', external });
  }
  return map;
}

const relOfType = (rels: Map<string, Rel>, suffix: string) => [...rels.values()].find((rel) => rel.type.endsWith(suffix));

/* ==========================================================================
   Colour
   ========================================================================== */

const PRESET_COLORS: Record<string, string> = {
  black: '000000',
  white: 'FFFFFF',
  red: 'FF0000',
  green: '008000',
  blue: '0000FF',
  yellow: 'FFFF00',
  gray: '808080',
  grey: '808080',
  darkGray: 'A9A9A9',
  lightGray: 'D3D3D3',
  orange: 'FFA500',
};

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '').padEnd(6, '0');
  return [0, 2, 4].map((index) => parseInt(value.slice(index, index + 2), 16) / 255) as [number, number, number];
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  const channel = (value: number) =>
    Math.round(Math.min(1, Math.max(0, value)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

function rgbToHsl([r, g, b]: [number, number, number]): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) / 6 : max === g ? ((b - r) / d + 2) / 6 : ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb([h, s, l]: [number, number, number]): [number, number, number] {
  if (s === 0) return [l, l, l];
  const hue = (p: number, q: number, t: number) => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (u < 1 / 6) return p + (q - p) * 6 * u;
    if (u < 1 / 2) return q;
    if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue(p, q, h + 1 / 3), hue(p, q, h), hue(p, q, h - 1 / 3)];
}

/* ==========================================================================
   Theme
   ========================================================================== */

interface Theme {
  colors: Record<string, string>;
  majorFont: string;
  minorFont: string;
  fills: Element[];
  lines: Element[];
  backgrounds: Element[];
}

function parseTheme(xml: string | null): Theme {
  const theme: Theme = { colors: {}, majorFont: 'Calibri', minorFont: 'Calibri', fills: [], lines: [], backgrounds: [] };
  if (!xml) return theme;
  const root = parseXml(xml).documentElement;
  const elements = path(root, 'themeElements');
  for (const node of children(path(elements, 'clrScheme'))) {
    const color = children(node)[0];
    if (!color) continue;
    const value = localName(color) === 'sysClr' ? attr(color, 'lastClr') : attr(color, 'val');
    if (value) theme.colors[localName(node)] = value;
  }
  theme.majorFont = attr(path(elements, 'fontScheme', 'majorFont', 'latin'), 'typeface') || theme.majorFont;
  theme.minorFont = attr(path(elements, 'fontScheme', 'minorFont', 'latin'), 'typeface') || theme.minorFont;
  const format = path(elements, 'fmtScheme');
  theme.fills = children(path(format, 'fillStyleLst'));
  theme.lines = children(path(format, 'lnStyleLst'));
  theme.backgrounds = children(path(format, 'bgFillStyleLst'));
  return theme;
}

/* ==========================================================================
   Text styles
   ========================================================================== */

interface RunStyle {
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: Element;
  font?: string;
  baseline?: number;
  caps?: boolean;
  kern?: number;
}

interface ParaStyle {
  marL?: number;
  indent?: number;
  align?: TextParagraph['align'];
  lineSpacing?: Spacing;
  spaceBefore?: Spacing;
  spaceAfter?: Spacing;
  bulletType?: { kind: 'none' } | { kind: 'char'; char: string } | { kind: 'number'; scheme: string; startAt: number };
  bulletFont?: string;
  bulletColor?: Element;
  bulletSizePct?: number;
  bulletSizePts?: number;
  defaultTab?: number;
}

interface LevelStyle {
  para: ParaStyle;
  run: RunStyle;
}

/** Nine levels of paragraph formatting (a list style, or a master text style). */
type ListStyle = (LevelStyle | undefined)[];

function spacing(node: Element | undefined): Spacing | undefined {
  if (!node) return undefined;
  const pct = num(attr(child(node, 'spcPct'), 'val'));
  if (pct !== undefined) return { pct: pct / 100000 };
  const pts = num(attr(child(node, 'spcPts'), 'val'));
  if (pts !== undefined) return { pts: pts / 100 };
  return undefined;
}

function parseRunStyle(node: Element | undefined): RunStyle {
  const style: RunStyle = {};
  if (!node) return style;
  const size = num(attr(node, 'sz'));
  if (size !== undefined) style.size = size / 100;
  const b = attr(node, 'b');
  if (b !== null) style.bold = b === '1' || b === 'true';
  const i = attr(node, 'i');
  if (i !== null) style.italic = i === '1' || i === 'true';
  const u = attr(node, 'u');
  if (u !== null) style.underline = u !== 'none';
  const strike = attr(node, 'strike');
  if (strike !== null) style.strike = strike !== 'noStrike';
  const baseline = num(attr(node, 'baseline'));
  if (baseline !== undefined) style.baseline = baseline / 1000;
  const cap = attr(node, 'cap');
  if (cap !== null) style.caps = cap === 'all';
  const kern = num(attr(node, 'kern'));
  if (kern !== undefined) style.kern = kern / 100;
  const fill = child(node, 'solidFill');
  if (fill) style.color = fill;
  else if (child(node, 'noFill')) style.color = node.ownerDocument.createElement('noFill');
  const latin = attr(child(node, 'latin'), 'typeface');
  if (latin) style.font = latin;
  return style;
}

function parseLevel(node: Element | undefined): LevelStyle | undefined {
  if (!node) return undefined;
  const para: ParaStyle = {};
  const marL = num(attr(node, 'marL'));
  if (marL !== undefined) para.marL = marL / 12700;
  const indent = num(attr(node, 'indent'));
  if (indent !== undefined) para.indent = indent / 12700;
  const algn = attr(node, 'algn');
  if (algn) para.align = (['l', 'ctr', 'r', 'just', 'dist'].includes(algn) ? algn : 'l') as TextParagraph['align'];
  const tab = num(attr(node, 'defTabSz'));
  if (tab !== undefined) para.defaultTab = tab / 12700;
  para.lineSpacing = spacing(child(node, 'lnSpc'));
  para.spaceBefore = spacing(child(node, 'spcBef'));
  para.spaceAfter = spacing(child(node, 'spcAft'));
  if (child(node, 'buNone')) para.bulletType = { kind: 'none' };
  const buChar = child(node, 'buChar');
  if (buChar) para.bulletType = { kind: 'char', char: attr(buChar, 'char') ?? '•' };
  const autoNum = child(node, 'buAutoNum');
  if (autoNum) para.bulletType = { kind: 'number', scheme: attr(autoNum, 'type') ?? 'arabicPeriod', startAt: num(attr(autoNum, 'startAt')) ?? 1 };
  const buFont = attr(child(node, 'buFont'), 'typeface');
  if (buFont) para.bulletFont = buFont;
  const buClr = child(node, 'buClr');
  if (buClr) para.bulletColor = buClr;
  const buSzPct = num(attr(child(node, 'buSzPct'), 'val'));
  if (buSzPct !== undefined) para.bulletSizePct = buSzPct / 100000;
  const buSzPts = num(attr(child(node, 'buSzPts'), 'val'));
  if (buSzPts !== undefined) para.bulletSizePts = buSzPts / 100;
  for (const key of Object.keys(para) as (keyof ParaStyle)[]) if (para[key] === undefined) delete para[key];
  return { para, run: parseRunStyle(child(node, 'defRPr')) };
}

function parseListStyle(node: Element | undefined): ListStyle {
  const out: ListStyle = [];
  if (!node) return out;
  for (let level = 1; level <= 9; level++) out[level - 1] = parseLevel(child(node, `lvl${level}pPr`));
  return out;
}

function mergeLevel(target: LevelStyle, source: LevelStyle | undefined) {
  if (!source) return;
  Object.assign(target.para, source.para);
  Object.assign(target.run, source.run);
}

/* ==========================================================================
   Parts: master, layout, slide
   ========================================================================== */

interface Placeholder {
  type: string;
  idx?: string;
  node: Element;
}

interface Part {
  name: string;
  root: Element;
  tree: Element | undefined;
  rels: Map<string, Rel>;
  placeholders: Placeholder[];
}

function placeholderOf(node: Element): { type: string; idx?: string } | undefined {
  const nv = children(node).find((next) => localName(next).startsWith('nv'));
  const ph = path(nv, 'nvPr', 'ph');
  if (!ph) return undefined;
  return { type: attr(ph, 'type') ?? 'body', idx: attr(ph, 'idx') ?? undefined };
}

function readPart(files: Files, name: string): Part | undefined {
  const xml = text(files, name);
  if (!xml) return undefined;
  const root = parseXml(xml).documentElement;
  const tree = path(root, 'cSld', 'spTree');
  const placeholders: Placeholder[] = [];
  for (const node of children(tree)) {
    const ph = placeholderOf(node);
    if (ph) placeholders.push({ ...ph, node });
  }
  return { name, root, tree, rels: readRels(files, name), placeholders };
}

/** The families a placeholder type belongs to, for matching across parts. */
function family(type: string): string {
  if (type === 'title' || type === 'ctrTitle') return 'title';
  if (type === 'body' || type === 'subTitle' || type === 'obj' || type === 'tbl' || type === 'chart' || type === 'pic' || type === 'media' || type === 'clipArt' || type === 'dgm')
    return 'body';
  return type;
}

function findPlaceholder(part: Part | undefined, ph: { type: string; idx?: string }, byIndex: boolean): Placeholder | undefined {
  if (!part) return undefined;
  if (byIndex && ph.idx !== undefined) {
    const same = part.placeholders.find((candidate) => candidate.idx === ph.idx);
    if (same) return same;
  }
  return (
    part.placeholders.find((candidate) => candidate.type === ph.type) ??
    part.placeholders.find((candidate) => family(candidate.type) === family(ph.type))
  );
}

/* ==========================================================================
   Reader
   ========================================================================== */

interface Context {
  part: Part;
  /** Chain of parts this element's placeholders inherit through. */
  layout?: Part;
  master: Part;
  clrMap: Record<string, string>;
  /** The colour a style reference hands to phClr. */
  phColor?: Element;
  /** What a grpFill resolves to. */
  groupFill?: Fill;
  /** The slide's background, for shapes that are filled with it (useBgFill). */
  background?: Fill;
  slideNumber: number;
  /** Offset and scale of the enclosing groups, applied to child coordinates. */
  transform: { x: number; y: number; sx: number; sy: number };
}

class Reader {
  readonly images = new Map<string, DeckImage>();
  private readonly files: Files;
  private readonly theme: Theme;
  private readonly defaultText: ListStyle;
  private readonly tableStyles = new Map<string, Element>();
  private readonly masterStyles = new Map<string, { title: ListStyle; body: ListStyle; other: ListStyle }>();

  constructor(files: Files, presentation: Element, presentationRels: Map<string, Rel>) {
    this.files = files;
    const themeRel = relOfType(presentationRels, '/theme');
    this.theme = parseTheme(themeRel ? text(files, themeRel.target) : null);
    this.defaultText = parseListStyle(child(presentation, 'defaultTextStyle'));
    const styles = text(files, 'ppt/tableStyles.xml');
    if (styles) {
      for (const style of children(parseXml(styles).documentElement, 'tblStyle')) {
        const id = attr(style, 'styleId');
        if (id) this.tableStyles.set(id, style);
      }
    }
  }

  /* ------------------------------------------------------------ colour */

  private schemeColor(name: string, context: Context): string {
    if (name === 'phClr' && context.phColor) return this.paint(context.phColor, { ...context, phColor: undefined })?.color.slice(1) ?? '000000';
    const mapped = context.clrMap[name] ?? name;
    return this.theme.colors[mapped] ?? this.theme.colors[name] ?? '000000';
  }

  /** A colour element (solidFill, buClr, a gradient stop…) → concrete paint. */
  paint(container: Element | undefined, context: Context): Paint | undefined {
    if (!container) return undefined;
    const node = ['srgbClr', 'schemeClr', 'sysClr', 'prstClr', 'scrgbClr', 'hslClr'].includes(localName(container))
      ? container
      : children(container).find((next) => ['srgbClr', 'schemeClr', 'sysClr', 'prstClr', 'scrgbClr', 'hslClr'].includes(localName(next)));
    if (!node) return undefined;
    let hex = '000000';
    switch (localName(node)) {
      case 'srgbClr':
        hex = attr(node, 'val') ?? hex;
        break;
      case 'schemeClr':
        hex = this.schemeColor(attr(node, 'val') ?? 'tx1', context);
        break;
      case 'sysClr':
        hex = attr(node, 'lastClr') ?? (attr(node, 'val') === 'window' ? 'FFFFFF' : '000000');
        break;
      case 'prstClr':
        hex = PRESET_COLORS[attr(node, 'val') ?? ''] ?? '000000';
        break;
      case 'scrgbClr': {
        const linear = (name: string) => Math.pow((num(attr(node, name)) ?? 0) / 100000, 1 / 2.2);
        hex = rgbToHex([linear('r'), linear('g'), linear('b')]).slice(1);
        break;
      }
      case 'hslClr':
        hex = rgbToHex(hslToRgb([(num(attr(node, 'hue')) ?? 0) / 21600000, (num(attr(node, 'sat')) ?? 0) / 100000, (num(attr(node, 'lum')) ?? 0) / 100000])).slice(1);
        break;
    }
    let rgb = hexToRgb(hex);
    let alpha = 1;
    for (const modifier of children(node)) {
      const value = (num(attr(modifier, 'val')) ?? 0) / 100000;
      switch (localName(modifier)) {
        case 'alpha':
          alpha = value;
          break;
        case 'lumMod': {
          const [h, s, l] = rgbToHsl(rgb);
          rgb = hslToRgb([h, s, Math.min(1, l * value)]);
          break;
        }
        case 'lumOff': {
          const [h, s, l] = rgbToHsl(rgb);
          rgb = hslToRgb([h, s, Math.min(1, Math.max(0, l + value))]);
          break;
        }
        case 'satMod': {
          const [h, s, l] = rgbToHsl(rgb);
          rgb = hslToRgb([h, Math.min(1, s * value), l]);
          break;
        }
        case 'tint':
          rgb = rgb.map((channel) => channel + (1 - channel) * (1 - value)) as [number, number, number];
          break;
        case 'shade':
          rgb = rgb.map((channel) => channel * value) as [number, number, number];
          break;
      }
    }
    return { color: rgbToHex(rgb), alpha };
  }

  /* -------------------------------------------------------------- fill */

  private image(rel: Rel | undefined): string | undefined {
    if (!rel || rel.external) return undefined;
    if (!this.images.has(rel.target)) {
      const data = this.files[rel.target];
      if (!data) return undefined;
      const extension = rel.target.split('.').pop()?.toLowerCase() ?? '';
      const type = extension === 'png' ? 'png' : extension === 'jpg' || extension === 'jpeg' ? 'jpg' : 'other';
      const mime = type === 'png' ? 'image/png' : type === 'jpg' ? 'image/jpeg' : `image/${extension === 'tif' ? 'tiff' : extension}`;
      this.images.set(rel.target, { data, type, mime });
    }
    return rel.target;
  }

  private crop(blipFill: Element | undefined): Crop | undefined {
    const rect = child(blipFill, 'srcRect');
    if (!rect) return undefined;
    const read = (name: string) => (num(attr(rect, name)) ?? 0) / 100000;
    const crop = { left: read('l'), top: read('t'), right: read('r'), bottom: read('b') };
    return crop.left || crop.top || crop.right || crop.bottom ? crop : undefined;
  }

  /** Fill in a property element (spPr, tcPr, bgPr…): undefined when not stated. */
  fill(container: Element | undefined, context: Context): Fill | undefined {
    if (!container) return undefined;
    for (const node of children(container)) {
      switch (localName(node)) {
        case 'noFill':
          return null;
        case 'solidFill': {
          const paint = this.paint(node, context);
          return paint ? { kind: 'solid', paint } : null;
        }
        case 'gradFill': {
          // Drawn as one colour: the average of its stops.
          const stops = children(path(node, 'gsLst'), 'gs')
            .map((stop) => this.paint(stop, context))
            .filter((paint): paint is Paint => paint !== undefined);
          if (stops.length === 0) return null;
          const rgb = stops.map((stop) => hexToRgb(stop.color));
          const mean = [0, 1, 2].map((index) => rgb.reduce((sum, value) => sum + value[index], 0) / rgb.length) as [number, number, number];
          return { kind: 'solid', paint: { color: rgbToHex(mean), alpha: stops.reduce((sum, stop) => sum + stop.alpha, 0) / stops.length } };
        }
        case 'blipFill': {
          const blip = child(node, 'blip');
          const image = this.image(context.part.rels.get(attr(blip, 'embed') ?? ''));
          if (!image) return null;
          const alpha = (num(attr(child(blip, 'alphaModFix'), 'amt')) ?? 100000) / 100000;
          return { kind: 'image', image, crop: this.crop(node), alpha };
        }
        case 'grpFill':
          return context.groupFill ?? null;
        case 'pattFill': {
          const paint = this.paint(child(node, 'fgClr'), context);
          return paint ? { kind: 'solid', paint } : null;
        }
      }
    }
    return undefined;
  }

  /** A theme fill or line style by index, coloured by the reference. */
  private styleFill(ref: Element | undefined, context: Context): Fill | undefined {
    if (!ref) return undefined;
    const index = num(attr(ref, 'idx')) ?? 0;
    if (index === 0) return null;
    const list = index >= 1000 ? this.theme.backgrounds : this.theme.fills;
    const style = list[(index >= 1000 ? index - 1000 : index) - 1];
    if (!style) return undefined;
    const holder = style.ownerDocument.createElement('holder');
    holder.appendChild(style.cloneNode(true));
    return this.fill(holder, { ...context, phColor: ref });
  }

  /** A line: undefined when not stated, null when explicitly none. */
  line(node: Element | undefined, context: Context, base?: Stroke | null): Stroke | null | undefined {
    if (!node) return undefined;
    if (child(node, 'noFill')) return null;
    const fill = child(node, 'solidFill') ?? child(node, 'gradFill');
    const paint = fill ? this.paint(localName(fill) === 'gradFill' ? children(path(fill, 'gsLst'), 'gs')[0] : fill, context) : base?.paint;
    if (!paint) return base === null ? null : undefined;
    const width = num(attr(node, 'w'));
    const dashName = attr(child(node, 'prstDash'), 'val');
    const dashes: Record<string, number[]> = {
      dash: [4, 3],
      sysDash: [3, 1],
      dot: [1, 1],
      sysDot: [1, 1],
      lgDash: [8, 3],
      dashDot: [4, 3, 1, 3],
      lgDashDot: [8, 3, 1, 3],
      sysDashDot: [3, 1, 1, 1],
    };
    const end = (name: string): ArrowEnd | undefined => {
      const element = child(node, name);
      const type = attr(element, 'type');
      if (!element || !type || type === 'none') return undefined;
      return { type, w: attr(element, 'w') ?? 'med', len: attr(element, 'len') ?? 'med' };
    };
    const capName = attr(node, 'cap');
    return {
      paint,
      width: width !== undefined ? width / 12700 : base?.width ?? 0.75,
      dash: dashName ? dashes[dashName] : base?.dash,
      head: end('headEnd') ?? (child(node, 'headEnd') ? undefined : base?.head),
      tail: end('tailEnd') ?? (child(node, 'tailEnd') ? undefined : base?.tail),
      cap: capName === 'rnd' ? 'round' : capName === 'sq' ? 'square' : (base?.cap ?? 'flat'),
    };
  }

  private styleLine(ref: Element | undefined, context: Context): Stroke | null | undefined {
    if (!ref) return undefined;
    const index = num(attr(ref, 'idx')) ?? 0;
    if (index === 0) return null;
    const style = this.theme.lines[index - 1];
    return style ? this.line(style, { ...context, phColor: ref }) : undefined;
  }

  /* ---------------------------------------------------------- geometry */

  private box(xfrm: Element | undefined, context: Context): Box | undefined {
    if (!xfrm) return undefined;
    const off = child(xfrm, 'off');
    const ext = child(xfrm, 'ext');
    if (!off || !ext) return undefined;
    const { x, y, sx, sy } = context.transform;
    return {
      x: x + ((num(attr(off, 'x')) ?? 0) / 12700) * sx,
      y: y + ((num(attr(off, 'y')) ?? 0) / 12700) * sy,
      w: ((num(attr(ext, 'cx')) ?? 0) / 12700) * sx,
      h: ((num(attr(ext, 'cy')) ?? 0) / 12700) * sy,
      rot: (num(attr(xfrm, 'rot')) ?? 0) / 60000,
      flipH: attr(xfrm, 'flipH') === '1',
      flipV: attr(xfrm, 'flipV') === '1',
    };
  }

  private geometry(spPr: Element | undefined): Geometry | undefined {
    const preset = child(spPr, 'prstGeom');
    if (preset) {
      const adjust: Record<string, number> = {};
      for (const guide of children(path(preset, 'avLst'), 'gd')) {
        const formula = attr(guide, 'fmla') ?? '';
        const match = /^val\s+(-?\d+)/.exec(formula);
        const name = attr(guide, 'name');
        if (match && name) adjust[name] = Number(match[1]);
      }
      return { preset: attr(preset, 'prst') ?? 'rect', adjust };
    }
    const custom = child(spPr, 'custGeom');
    if (custom) {
      const paths: CustomPath[] = [];
      for (const node of children(path(custom, 'pathLst'), 'path')) {
        const point = (element: Element | undefined) => ({ x: num(attr(element, 'x')) ?? 0, y: num(attr(element, 'y')) ?? 0 });
        const commands: PathCommand[] = [];
        for (const step of children(node)) {
          const points = children(step, 'pt').map(point);
          switch (localName(step)) {
            case 'moveTo':
              commands.push({ op: 'M', ...points[0] });
              break;
            case 'lnTo':
              commands.push({ op: 'L', ...points[0] });
              break;
            case 'cubicBezTo':
              if (points.length === 3) commands.push({ op: 'C', x1: points[0].x, y1: points[0].y, x2: points[1].x, y2: points[1].y, x: points[2].x, y: points[2].y });
              break;
            case 'quadBezTo':
              // Kept as a cubic with both handles on the quadratic's control point.
              if (points.length === 2) commands.push({ op: 'C', x1: points[0].x, y1: points[0].y, x2: points[0].x, y2: points[0].y, x: points[1].x, y: points[1].y });
              break;
            case 'arcTo':
              commands.push({
                op: 'A',
                wR: num(attr(step, 'wR')) ?? 0,
                hR: num(attr(step, 'hR')) ?? 0,
                stAng: (num(attr(step, 'stAng')) ?? 0) / 60000,
                swAng: (num(attr(step, 'swAng')) ?? 0) / 60000,
              });
              break;
            case 'close':
              commands.push({ op: 'Z' });
              break;
          }
        }
        paths.push({
          w: num(attr(node, 'w')) ?? 0,
          h: num(attr(node, 'h')) ?? 0,
          fill: attr(node, 'fill') !== 'none',
          stroke: attr(node, 'stroke') !== '0' && attr(node, 'stroke') !== 'false',
          commands,
        });
      }
      return { custom: paths };
    }
    return undefined;
  }

  /* -------------------------------------------------------------- text */

  private masterText(master: Part) {
    let styles = this.masterStyles.get(master.name);
    if (!styles) {
      const txStyles = child(master.root, 'txStyles');
      styles = {
        title: parseListStyle(child(txStyles, 'titleStyle')),
        body: parseListStyle(child(txStyles, 'bodyStyle')),
        other: parseListStyle(child(txStyles, 'otherStyle')),
      };
      this.masterStyles.set(master.name, styles);
    }
    return styles;
  }

  private font(name: string | undefined): string {
    if (!name) return this.theme.minorFont;
    if (name.startsWith('+mj')) return this.theme.majorFont;
    if (name.startsWith('+mn')) return this.theme.minorFont;
    return name;
  }

  /**
   * Resolves a text body. `lists` is the inheritance chain of list styles
   * from the deepest (master text styles) to the shape's own; `bodies` the
   * chain of bodyPr elements; `base` formatting a table style or a shape
   * style reference lends underneath the paragraph's own.
   */
  textBody(
    txBody: Element | undefined,
    lists: ListStyle[],
    bodies: (Element | undefined)[],
    context: Context,
    base: RunStyle = {},
  ): TextBody | undefined {
    if (!txBody) return undefined;
    const bodyPr: Record<string, string> = {};
    let autofit: Element | undefined;
    for (const body of [...bodies, child(txBody, 'bodyPr')]) {
      if (!body) continue;
      for (const attribute of Array.from(body.attributes ?? [])) bodyPr[attribute.name.replace(/^.*:/, '')] = attribute.value;
      const fit = child(body, 'normAutofit') ?? child(body, 'spAutoFit') ?? child(body, 'noAutofit');
      if (fit) autofit = fit;
    }
    const inset = (name: string, fallback: number) => (bodyPr[name] !== undefined ? Number(bodyPr[name]) / 12700 : fallback);
    const own = parseListStyle(child(txBody, 'lstStyle'));

    const numbering = new Map<number, number>();
    const paragraphs: TextParagraph[] = [];
    for (const p of children(txBody, 'p')) {
      const pPr = child(p, 'pPr');
      const level = Math.min(8, num(attr(pPr, 'lvl')) ?? 0);
      const merged: LevelStyle = { para: {}, run: {} };
      for (const list of lists) mergeLevel(merged, list[level]);
      Object.assign(merged.run, base);
      mergeLevel(merged, own[level]);
      mergeLevel(merged, parseLevel(pPr));
      const para = merged.para;

      const resolveRun = (style: RunStyle, value: string): Run => {
        const paint = style.color && localName(style.color) !== 'noFill' ? this.paint(style.color, context) : undefined;
        return {
          text: style.caps ? value.toUpperCase() : value,
          size: style.size ?? 18,
          bold: style.bold ?? false,
          italic: style.italic ?? false,
          underline: style.underline ?? false,
          strike: style.strike ?? false,
          paint: style.color && localName(style.color) === 'noFill' ? { color: '#000000', alpha: 0 } : (paint ?? { color: '#000000', alpha: 1 }),
          font: this.font(style.font),
          baseline: style.baseline ?? 0,
          kern: style.kern ?? 0,
        };
      };

      const runs: Run[] = [];
      for (const node of children(p)) {
        const name = localName(node);
        if (name === 'r' || name === 'fld') {
          const rPr = child(node, 'rPr');
          const style = { ...merged.run, ...parseRunStyle(rPr) };
          // Hyperlinks are underlined, and take the theme's link colour
          // unless the run sets its own.
          if (child(rPr, 'hlinkClick')) {
            style.underline = true;
            if (!child(rPr, 'solidFill')) {
              const holder = node.ownerDocument.createElement('holder');
              const scheme = node.ownerDocument.createElement('a:schemeClr');
              scheme.setAttribute('val', 'hlink');
              holder.appendChild(scheme);
              style.color = holder;
            }
          }
          let value = child(node, 't')?.textContent ?? '';
          if (name === 'fld' && attr(node, 'type') === 'slidenum') value = String(context.slideNumber);
          const pieces = value.split('\t');
          pieces.forEach((piece, index) => {
            if (index > 0) runs.push({ ...resolveRun(style, ''), tab: true });
            if (piece) runs.push(resolveRun(style, piece));
          });
        } else if (name === 'br') {
          runs.push({ ...resolveRun({ ...merged.run, ...parseRunStyle(child(node, 'rPr')) }, ''), br: true });
        }
      }
      const end = resolveRun({ ...merged.run, ...parseRunStyle(child(p, 'endParaRPr')) }, '');

      let bullet: Bullet = { kind: 'none' };
      const type = para.bulletType;
      const hasText = runs.some((run) => run.text.trim().length > 0);
      if (type && type.kind !== 'none' && hasText) {
        const extra = {
          font: para.bulletFont,
          paint: para.bulletColor ? this.paint(para.bulletColor, context) : undefined,
          sizePct: para.bulletSizePct,
          sizePts: para.bulletSizePts,
        };
        if (type.kind === 'char') bullet = { kind: 'char', char: type.char, ...extra };
        else {
          const count = (numbering.get(level) ?? type.startAt - 1) + 1;
          numbering.set(level, count);
          bullet = { kind: 'number', scheme: type.scheme, startAt: count, ...extra };
        }
      }
      // A deeper list restarts its numbering; so does anything unnumbered.
      for (const key of [...numbering.keys()]) if (key > level || (key === level && bullet.kind !== 'number')) numbering.delete(key);

      paragraphs.push({
        level,
        align: para.align ?? 'l',
        marL: para.marL ?? 0,
        indent: para.indent ?? 0,
        lineSpacing: para.lineSpacing ?? { pct: 1 },
        spaceBefore: para.spaceBefore ?? { pts: 0 },
        spaceAfter: para.spaceAfter ?? { pts: 0 },
        bullet,
        defaultTab: para.defaultTab ?? 72,
        runs,
        end,
      });
    }

    const anchor = bodyPr.anchor;
    return {
      insets: { l: inset('lIns', 7.2), t: inset('tIns', 3.6), r: inset('rIns', 7.2), b: inset('bIns', 3.6) },
      anchor: anchor === 'ctr' ? 'ctr' : anchor === 'b' ? 'b' : 't',
      anchorCenter: bodyPr.anchorCtr === '1',
      wrap: bodyPr.wrap !== 'none',
      fontScale: autofit && localName(autofit) === 'normAutofit' ? (num(attr(autofit, 'fontScale')) ?? 100000) / 100000 : 1,
      lineReduction: autofit && localName(autofit) === 'normAutofit' ? (num(attr(autofit, 'lnSpcReduction')) ?? 0) / 100000 : 0,
      vertical: bodyPr.vert ?? 'horz',
      paragraphs,
    };
  }

  /* ------------------------------------------------------------ shapes */

  /** Elements of a shape tree, in drawing order. `skipPlaceholders` for masters and layouts. */
  tree(tree: Element | undefined, context: Context, skipPlaceholders: boolean, out: SlideElement[]) {
    for (let node of children(tree)) {
      if (localName(node) === 'AlternateContent') {
        const choice = child(node, 'Choice') ?? child(node, 'Fallback');
        const inner = children(choice)[0];
        if (!inner) continue;
        node = inner;
      }
      const nv = children(node).find((next) => localName(next).startsWith('nv'));
      if (attr(child(nv, 'cNvPr'), 'hidden') === '1') continue;
      const ph = placeholderOf(node);
      if (ph && skipPlaceholders) continue;
      try {
        switch (localName(node)) {
          case 'sp':
          case 'cxnSp':
            this.shape(node, context, ph, out);
            break;
          case 'pic':
            this.picture(node, context, ph, out);
            break;
          case 'grpSp':
            this.group(node, context, out);
            break;
          case 'graphicFrame':
            this.frame(node, context, out);
            break;
        }
      } catch {
        // One unreadable shape must not lose the whole slide.
      }
    }
  }

  private inherited(ph: { type: string; idx?: string } | undefined, context: Context) {
    if (!ph) return { layout: undefined, master: undefined };
    const layout = findPlaceholder(context.layout, ph, true);
    const master = findPlaceholder(context.master, layout ? { type: layout.type, idx: layout.idx } : ph, false);
    return { layout: layout?.node, master: master?.node };
  }

  private shape(node: Element, context: Context, ph: { type: string; idx?: string } | undefined, out: SlideElement[]) {
    const spPr = child(node, 'spPr');
    const style = child(node, 'style');
    const { layout, master } = this.inherited(ph, context);
    const chainPr = [spPr, child(layout, 'spPr'), child(master, 'spPr')];

    const box = chainPr.map((pr) => this.box(child(pr, 'xfrm'), pr === spPr ? context : { ...context, transform: { x: 0, y: 0, sx: 1, sy: 1 } })).find(Boolean);
    if (!box) return;
    const geometry = chainPr.map((pr) => this.geometry(pr)).find(Boolean) ?? { preset: 'rect', adjust: {} };

    let fill: Fill | undefined;
    for (const pr of chainPr) {
      fill = this.fill(pr, context);
      if (fill !== undefined) break;
    }
    // A shape can take the slide's background as its fill: design layouts
    // cover part of a slide with it.
    if (attr(node, 'useBgFill') === '1') fill = context.background ?? null;
    if (fill === undefined) fill = this.styleFill(child(style ?? child(layout, 'style') ?? child(master, 'style'), 'fillRef'), context);

    const lineStyle = this.styleLine(child(style, 'lnRef'), context);
    let stroke: Stroke | null | undefined;
    for (const pr of chainPr) {
      stroke = this.line(child(pr, 'ln'), context, lineStyle);
      if (stroke !== undefined) break;
    }
    if (stroke === undefined) stroke = lineStyle ?? null;

    let text: TextBody | undefined;
    const txBody = child(node, 'txBody');
    if (txBody) {
      const styles = this.masterText(context.master);
      const lists: ListStyle[] = [];
      const base: RunStyle = {};
      if (ph) {
        const kind = family(ph.type);
        lists.push(kind === 'title' ? styles.title : kind === 'body' ? styles.body : styles.other);
        lists.push(parseListStyle(path(master, 'txBody', 'lstStyle')), parseListStyle(path(layout, 'txBody', 'lstStyle')));
      } else {
        lists.push(this.defaultText);
        const fontRef = child(style, 'fontRef');
        if (fontRef) {
          const idx = attr(fontRef, 'idx');
          base.font = idx === 'major' ? '+mj-lt' : '+mn-lt';
          if (children(fontRef).length > 0) base.color = fontRef;
        }
      }
      text = this.textBody(txBody, lists, [path(master, 'txBody', 'bodyPr'), path(layout, 'txBody', 'bodyPr')], context, base);
    }

    out.push({ kind: 'shape', box, geometry, fill: fill ?? null, stroke, text });
  }

  private picture(node: Element, context: Context, ph: { type: string; idx?: string } | undefined, out: SlideElement[]) {
    const spPr = child(node, 'spPr');
    const { layout, master } = this.inherited(ph, context);
    const box =
      this.box(child(spPr, 'xfrm'), context) ??
      [child(layout, 'spPr'), child(master, 'spPr')].map((pr) => this.box(child(pr, 'xfrm'), { ...context, transform: { x: 0, y: 0, sx: 1, sy: 1 } })).find(Boolean);
    if (!box) return;
    const blipFill = child(node, 'blipFill');
    const blip = child(blipFill, 'blip');
    const image = this.image(context.part.rels.get(attr(blip, 'embed') ?? ''));
    if (!image) return;
    const style = child(node, 'style');
    const stroke = this.line(child(spPr, 'ln'), context, this.styleLine(child(style, 'lnRef'), context)) ?? null;
    out.push({
      kind: 'picture',
      box,
      image,
      crop: this.crop(blipFill),
      alpha: (num(attr(child(blip, 'alphaModFix'), 'amt')) ?? 100000) / 100000,
      geometry: this.geometry(spPr) ?? { preset: 'rect', adjust: {} },
      stroke,
    });
  }

  private group(node: Element, context: Context, out: SlideElement[]) {
    const grpSpPr = child(node, 'grpSpPr');
    const xfrm = child(grpSpPr, 'xfrm');
    const box = this.box(xfrm, context);
    const chOff = child(xfrm, 'chOff');
    const chExt = child(xfrm, 'chExt');
    let transform = context.transform;
    if (box && chOff && chExt) {
      const cw = (num(attr(chExt, 'cx')) ?? 0) / 12700;
      const ch = (num(attr(chExt, 'cy')) ?? 0) / 12700;
      const sx = cw > 0 ? box.w / cw : 1;
      const sy = ch > 0 ? box.h / ch : 1;
      transform = { x: box.x - ((num(attr(chOff, 'x')) ?? 0) / 12700) * sx, y: box.y - ((num(attr(chOff, 'y')) ?? 0) / 12700) * sy, sx, sy };
    }
    const groupFill = this.fill(grpSpPr, context);
    this.tree(node, { ...context, transform, groupFill: groupFill ?? context.groupFill }, false, out);
  }

  /* ------------------------------------------------------------ tables */

  private frame(node: Element, context: Context, out: SlideElement[]) {
    const data = path(node, 'graphic', 'graphicData');
    const table = child(data, 'tbl');
    if (!table) return;
    const box = this.box(child(node, 'xfrm'), context);
    if (!box) return;
    const tblPr = child(table, 'tblPr');
    const styleId = child(tblPr, 'tableStyleId')?.textContent ?? '';
    const style = this.tableStyles.get(styleId);
    const flags = {
      firstRow: attr(tblPr, 'firstRow') === '1',
      lastRow: attr(tblPr, 'lastRow') === '1',
      firstCol: attr(tblPr, 'firstCol') === '1',
      lastCol: attr(tblPr, 'lastCol') === '1',
      bandRow: attr(tblPr, 'bandRow') === '1',
      bandCol: attr(tblPr, 'bandCol') === '1',
    };
    const columns = children(child(table, 'tblGrid'), 'gridCol').map((column) => ((num(attr(column, 'w')) ?? 0) / 12700) * context.transform.sx);
    const rowNodes = children(table, 'tr');

    /** Table-style parts that apply to a cell, from the broadest to the most specific. */
    const parts = (row: number, column: number): Element[] => {
      if (!style) return [];
      const names = ['wholeTbl'];
      const bodyRow = flags.firstRow ? row - 1 : row;
      if (flags.bandCol) names.push((flags.firstCol ? column - 1 : column) % 2 === 0 ? 'band1V' : 'band2V');
      if (flags.bandRow && bodyRow >= 0) names.push(bodyRow % 2 === 0 ? 'band1H' : 'band2H');
      if (flags.firstCol && column === 0) names.push('firstCol');
      if (flags.lastCol && column === columns.length - 1) names.push('lastCol');
      if (flags.lastRow && row === rowNodes.length - 1) names.push('lastRow');
      if (flags.firstRow && row === 0) names.push('firstRow');
      return names.map((name) => child(style, name)).filter((part): part is Element => part !== undefined);
    };

    const rows: TableElement['rows'] = rowNodes.map((rowNode, rowIndex) => {
      const cells = children(rowNode, 'tc').map((cellNode, columnIndex): TableCell => {
        const tcPr = child(cellNode, 'tcPr');
        const styleParts = parts(rowIndex, columnIndex);
        const own = this.fill(tcPr, context);
        let fill: Fill | undefined;
        const borders: TableCell['borders'] = { l: null, r: null, t: null, b: null };
        const base: RunStyle = {};
        for (const part of styleParts) {
          const tcStyle = child(part, 'tcStyle');
          const partFill = this.fill(child(tcStyle, 'fill'), context) ?? this.styleFill(child(tcStyle, 'fillRef'), context);
          if (partFill !== undefined) fill = partFill;
          const tcBdr = child(tcStyle, 'tcBdr');
          const edge = (name: string) => {
            const holder = child(tcBdr, name);
            return holder ? (this.line(child(holder, 'ln'), context) ?? (child(holder, 'lnRef') ? this.styleLine(child(holder, 'lnRef'), context) : undefined)) : undefined;
          };
          const lastRow = rowIndex === rowNodes.length - 1;
          const lastCol = columnIndex === columns.length - 1;
          const l = edge(columnIndex === 0 ? 'left' : 'insideV');
          const r = edge(lastCol ? 'right' : 'insideV');
          const t = edge(rowIndex === 0 ? 'top' : 'insideH');
          const b = edge(lastRow ? 'bottom' : 'insideH');
          if (l !== undefined) borders.l = l;
          if (r !== undefined) borders.r = r;
          if (t !== undefined) borders.t = t;
          if (b !== undefined) borders.b = b;
          const tcTxStyle = child(part, 'tcTxStyle');
          if (tcTxStyle) {
            if (attr(tcTxStyle, 'b') === 'on') base.bold = true;
            if (attr(tcTxStyle, 'b') === 'off') base.bold = false;
            if (attr(tcTxStyle, 'i') === 'on') base.italic = true;
            const color = children(tcTxStyle).find((next) => localName(next).endsWith('Clr'));
            if (color) base.color = tcTxStyle;
            const fontRef = child(tcTxStyle, 'fontRef');
            if (fontRef) base.font = attr(fontRef, 'idx') === 'major' ? '+mj-lt' : '+mn-lt';
          }
        }
        if (own !== undefined) fill = own;
        const ownLine = (name: string) => this.line(child(tcPr, name), context);
        for (const [key, name] of [['l', 'lnL'], ['r', 'lnR'], ['t', 'lnT'], ['b', 'lnB']] as const) {
          const line = ownLine(name);
          if (line !== undefined) borders[key] = line;
        }
        const margin = (name: string, fallback: number) => {
          const value = num(attr(tcPr, name));
          return value !== undefined ? value / 12700 : fallback;
        };
        const anchor = attr(tcPr, 'anchor');
        const bodyPr = cellNode.ownerDocument.createElement('bodyPr');
        bodyPr.setAttribute('lIns', String(margin('marL', 7.2) * 12700));
        bodyPr.setAttribute('rIns', String(margin('marR', 7.2) * 12700));
        bodyPr.setAttribute('tIns', String(margin('marT', 3.6) * 12700));
        bodyPr.setAttribute('bIns', String(margin('marB', 3.6) * 12700));
        if (anchor) bodyPr.setAttribute('anchor', anchor);
        const textBody =
          this.textBody(child(cellNode, 'txBody'), [this.defaultText], [bodyPr], context, base) ??
          this.textBody(cellNode.ownerDocument.createElement('txBody'), [this.defaultText], [bodyPr], context, base)!;
        return {
          text: textBody,
          fill: fill ?? null,
          borders,
          gridSpan: num(attr(cellNode, 'gridSpan')) ?? 1,
          rowSpan: num(attr(cellNode, 'rowSpan')) ?? 1,
          merged: attr(cellNode, 'hMerge') === '1' || attr(cellNode, 'vMerge') === '1',
        };
      });
      return { height: ((num(attr(rowNode, 'h')) ?? 0) / 12700) * context.transform.sy, cells };
    });

    out.push({ kind: 'table', x: box.x, y: box.y, columns, rows });
  }

  /* ---------------------------------------------------------- background */

  background(parts: Part[], context: Context): Fill {
    for (const part of parts) {
      const bg = path(part.root, 'cSld', 'bg');
      if (!bg) continue;
      const partContext = { ...context, part };
      const bgPr = child(bg, 'bgPr');
      if (bgPr) {
        const fill = this.fill(bgPr, partContext);
        if (fill !== undefined) return fill;
      }
      const bgRef = child(bg, 'bgRef');
      if (bgRef) {
        const fill = this.styleFill(bgRef, partContext);
        if (fill !== undefined) return fill;
      }
    }
    return { kind: 'solid', paint: { color: '#FFFFFF', alpha: 1 } };
  }
}

function clrMapOf(node: Element | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  for (const attribute of Array.from(node?.attributes ?? [])) map[attribute.name] = attribute.value;
  return map;
}

export function readPptx(buffer: ArrayBuffer): Deck {
  let files: Files;
  try {
    files = unzipSync(new Uint8Array(buffer));
  } catch {
    throw new Error('Berkas bukan presentasi .pptx yang valid');
  }
  const presentationXml = text(files, 'ppt/presentation.xml');
  if (!presentationXml) throw new Error('Berkas bukan presentasi .pptx yang valid');
  const presentation = parseXml(presentationXml).documentElement;
  const presentationRels = readRels(files, 'ppt/presentation.xml');
  const size = child(presentation, 'sldSz');
  const width = (num(attr(size, 'cx')) ?? 9144000) / 12700;
  const height = (num(attr(size, 'cy')) ?? 6858000) / 12700;

  const reader = new Reader(files, presentation, presentationRels);
  const parts = new Map<string, Part | undefined>();
  const part = (name: string) => {
    if (!parts.has(name)) parts.set(name, readPart(files, name));
    return parts.get(name);
  };

  const slides: Slide[] = [];
  const ids = children(child(presentation, 'sldIdLst'), 'sldId');
  ids.forEach((id, index) => {
    // r:id, not the slide's numeric id attribute of the same local name.
    const rel = presentationRels.get(id.getAttribute('r:id') ?? '');
    if (!rel) return;
    if (attr(id, 'show') === '0') return;
    const slide = part(rel.target);
    if (!slide) return;
    if (attr(slide.root, 'show') === '0') return;
    const layoutRel = relOfType(slide.rels, '/slideLayout');
    const layout = layoutRel ? part(layoutRel.target) : undefined;
    const masterRel = layout ? relOfType(layout.rels, '/slideMaster') : undefined;
    const master = masterRel ? part(masterRel.target) : undefined;
    if (!master) return;

    const baseMap = clrMapOf(child(master.root, 'clrMap'));
    const override = (owner: Part | undefined) => child(path(owner?.root, 'clrMapOvr'), 'overrideClrMapping');
    const clrMap = { ...baseMap, ...clrMapOf(override(layout)), ...clrMapOf(override(slide)) };
    const number = index + 1;
    const base: Context = { part: slide, layout, master, clrMap, slideNumber: number, transform: { x: 0, y: 0, sx: 1, sy: 1 } };
    const background = reader.background([slide, layout, master].filter((entry): entry is Part => !!entry), base);
    base.background = background;

    const elements: SlideElement[] = [];
    const showMaster = (owner: Part | undefined) => attr(owner?.root, 'showMasterSp') !== '0';
    if (showMaster(slide) && showMaster(layout)) reader.tree(master.tree, { ...base, part: master, layout: undefined }, true, elements);
    if (layout && showMaster(slide)) reader.tree(layout.tree, { ...base, part: layout, layout: undefined }, true, elements);
    reader.tree(slide.tree, base, false, elements);

    slides.push({ number, background, elements });
  });

  return { width, height, slides, images: reader.images };
}
