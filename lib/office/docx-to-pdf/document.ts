/**
 * Reads a .docx into a layout-ready model: blocks of paragraphs and tables
 * whose formatting is already resolved through the style hierarchy, grouped
 * into sections, plus every picture, shape, and text box with its position.
 *
 * What is deliberately *not* done here is decide where anything lands on a
 * page — that belongs to layout.ts, which needs font metrics.
 */

import { strFromU8, unzipSync } from 'fflate';
import {
  mergePara,
  mergeRun,
  mergeTable,
  Numbering,
  parseCellMargins,
  parseParaProps,
  parseRunProps,
  parseSettings,
  parseTableBorders,
  parseTableProps,
  parseTheme,
  shadingColor,
  StyleSheet,
  type CellMargins,
  type ParaProps,
  type RunProps,
  type Settings,
  type TableBorders,
  type TableProps,
  type Theme,
} from './styles';
import { attr, child, children, emu, localName, num, parseXml, path, toggle, val } from './xml';

/* ==========================================================================
   Model
   ========================================================================== */

export interface Crop {
  /** Fractions (0–1) cut from each side. */
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type Inline =
  | { kind: 'text'; text: string; props: RunProps }
  | { kind: 'tab'; props: RunProps; ptab?: { align: 'left' | 'center' | 'right'; relativeTo: 'margin' | 'indent' } }
  | { kind: 'break'; type: 'line' | 'page' | 'column'; props: RunProps }
  | { kind: 'field'; field: 'PAGE' | 'NUMPAGES'; props: RunProps }
  | { kind: 'image'; width: number; height: number; image: string; crop?: Crop; props: RunProps }
  | { kind: 'anchor'; anchor: Anchor };

export interface ListLabel {
  text: string;
  props: RunProps;
  suffix: 'tab' | 'space' | 'nothing';
  align: 'left' | 'center' | 'right';
}

export interface Paragraph {
  kind: 'paragraph';
  props: ParaProps;
  /** Formatting of the paragraph mark — sets the height of an empty line. */
  mark: RunProps;
  inlines: Inline[];
  label?: ListLabel;
}

export interface Cell {
  span: number;
  vMerge?: 'restart' | 'continue';
  borders?: TableBorders;
  shading?: string;
  vAlign: 'top' | 'center' | 'bottom';
  margins?: CellMargins;
  blocks: Block[];
}

export interface Row {
  height?: number;
  heightRule: 'auto' | 'atLeast' | 'exact';
  header: boolean;
  cantSplit: boolean;
  gridBefore: number;
  cells: Cell[];
}

export interface Table {
  kind: 'table';
  props: TableProps;
  /** Column widths, points. */
  grid: number[];
  rows: Row[];
}

export type Block = Paragraph | Table;

export type ShapeFill = { color: string; opacity: number } | null;

export interface ShapeBox {
  kind: 'box';
  x: number;
  y: number;
  w: number;
  h: number;
  geometry: string;
  fill: ShapeFill;
  stroke: { color: string; width: number; opacity: number; headArrow: boolean; tailArrow: boolean } | null;
  rotation: number;
  flipH: boolean;
  flipV: boolean;
  text?: {
    blocks: Block[];
    insets: { left: number; top: number; right: number; bottom: number };
    anchor: 'top' | 'center' | 'bottom';
  };
}

export interface ShapePicture {
  kind: 'picture';
  x: number;
  y: number;
  w: number;
  h: number;
  image: string;
  crop?: Crop;
  rotation: number;
}

export type Shape = ShapeBox | ShapePicture;

export interface AnchorPosition {
  from: string;
  offset?: number;
  align?: string;
}

export interface Anchor {
  behind: boolean;
  z: number;
  h: AnchorPosition;
  v: AnchorPosition;
  width: number;
  height: number;
  wrap: 'none' | 'square' | 'tight' | 'through' | 'topAndBottom';
  /** Which sides of the object text may flow along. */
  wrapSide: 'bothSides' | 'left' | 'right' | 'largest';
  /** Distances text keeps from the object, points. */
  distance: { top: number; bottom: number; left: number; right: number };
  /**
   * How far the area text avoids reaches past the object's box on each side,
   * points: the wrap polygon for tight and through wrapping, the effect
   * extent (shadows, glow) otherwise.
   */
  outset: { top: number; bottom: number; left: number; right: number };
  /** Tight and through wrapping: the outline text follows, points from the object's top left. */
  polygon?: { x: number; y: number }[];
  shapes: Shape[];
}

export interface Section {
  width: number;
  height: number;
  margins: { top: number; bottom: number; left: number; right: number; header: number; footer: number };
  headers: Partial<Record<'default' | 'first' | 'even', Block[]>>;
  footers: Partial<Record<'default' | 'first' | 'even', Block[]>>;
  titlePage: boolean;
  type: 'nextPage' | 'continuous' | 'evenPage' | 'oddPage' | 'nextColumn';
  pageNumberStart?: number;
  pageNumberFormat?: string;
  blocks: Block[];
}

export interface DocxImage {
  data: Uint8Array;
  type: 'png' | 'jpg' | 'other';
  mime: string;
}

export interface DocxDocument {
  sections: Section[];
  images: Map<string, DocxImage>;
  theme: Theme;
  settings: Settings;
  styles: StyleSheet;
}

/* ==========================================================================
   Package
   ========================================================================== */

type Files = Record<string, Uint8Array>;

function text(files: Files, name: string): string | null {
  const entry = files[name];
  return entry ? strFromU8(entry) : null;
}

function readRels(files: Files, part: string): Map<string, string> {
  const slash = part.lastIndexOf('/');
  const dir = part.slice(0, slash + 1);
  const relsPath = `${dir}_rels/${part.slice(slash + 1)}.rels`;
  const xml = text(files, relsPath);
  const map = new Map<string, string>();
  if (!xml) return map;
  for (const node of children(parseXml(xml).documentElement, 'Relationship')) {
    const id = attr(node, 'Id');
    const target = attr(node, 'Target');
    if (!id || !target || attr(node, 'TargetMode') === 'External') continue;
    map.set(id, resolvePath(dir, target));
  }
  return map;
}

function resolvePath(dir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = (dir + target).split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '..') out.pop();
    else if (part !== '.' && part !== '') out.push(part);
  }
  return out.join('/');
}

/* ==========================================================================
   Parser
   ========================================================================== */

interface FieldState {
  instruction: string;
  phase: 'code' | 'result';
  /** A dynamic field (PAGE) replaces its cached result. */
  replaced: boolean;
  /** Which dynamic field, once known. */
  code?: 'PAGE' | 'NUMPAGES';
  emitted?: boolean;
}

interface Context {
  rels: Map<string, string>;
  /** Formatting a table style lends to the paragraphs inside it. */
  tablePara?: ParaProps;
  tableRun?: RunProps;
}

class Parser {
  readonly styles: StyleSheet;
  readonly numbering: Numbering;
  readonly theme: Theme;
  readonly settings: Settings;
  readonly images = new Map<string, DocxImage>();
  private fields: FieldState[] = [];

  private readonly files: Files;

  constructor(files: Files) {
    this.files = files;
    this.styles = new StyleSheet(text(files, 'word/styles.xml'));
    this.numbering = new Numbering(text(files, 'word/numbering.xml'));
    this.theme = parseTheme(text(files, 'word/theme/theme1.xml'));
    this.settings = parseSettings(text(files, 'word/settings.xml'));
  }

  document(): DocxDocument {
    const xml = text(this.files, 'word/document.xml');
    if (!xml) throw new Error('Bukan berkas Word (.docx) yang valid');
    const root = parseXml(xml).documentElement;
    const body = child(root, 'body');
    const context: Context = { rels: readRels(this.files, 'word/document.xml') };

    const sections: Section[] = [];
    let current: Block[] = [];

    const visit = (element: Element) => {
      for (const node of children(element)) {
        const name = localName(node);
        if (name === 'p') {
          const paragraph = this.paragraph(node, context);
          if (paragraph) current.push(paragraph);
          // A paragraph carrying sectPr closes the section it belongs to.
          const sectPr = path(node, 'pPr', 'sectPr');
          if (sectPr) {
            sections.push(this.section(sectPr, current, context));
            current = [];
          }
        } else if (name === 'tbl') {
          current.push(this.table(node, context));
        } else if (name === 'sdt') {
          visit(child(node, 'sdtContent') ?? node);
        } else if (name === 'customXml' || name === 'smartTag') {
          visit(node);
        } else if (name === 'AlternateContent') {
          const choice = child(node, 'Choice');
          if (choice) visit(choice);
        } else if (name === 'sectPr') {
          sections.push(this.section(node, current, context));
          current = [];
        }
      }
    };

    if (body) visit(body);
    if (current.length > 0) {
      if (sections.length > 0) sections[sections.length - 1].blocks.push(...current);
      else sections.push(this.section(undefined, current, context));
    }
    for (const section of sections) section.blocks = joinHiddenMarks(section.blocks);

    return { sections, images: this.images, theme: this.theme, settings: this.settings, styles: this.styles };
  }

  /* -------------------------------------------------------- sections */

  private section(sectPr: Element | undefined, blocks: Block[], context: Context): Section {
    const size = child(sectPr, 'pgSz');
    const margins = child(sectPr, 'pgMar');
    const twip = (element: Element | undefined, name: string, fallback: number) =>
      (num(attr(element, name)) ?? fallback * 20) / 20;

    const width = twip(size, 'w', 595.3);
    const height = twip(size, 'h', 841.9);
    const landscape = attr(size, 'orient') === 'landscape' && width < height;

    const section: Section = {
      width: landscape ? height : width,
      height: landscape ? width : height,
      margins: {
        top: Math.abs(twip(margins, 'top', 72)),
        bottom: Math.abs(twip(margins, 'bottom', 72)),
        left: twip(margins, 'left', 72),
        right: twip(margins, 'right', 72),
        header: twip(margins, 'header', 35.4),
        footer: twip(margins, 'footer', 35.4),
      },
      headers: {},
      footers: {},
      titlePage: toggle(child(sectPr, 'titlePg')) ?? false,
      type: ((val(child(sectPr, 'type')) ?? 'nextPage') as Section['type']),
      blocks,
    };

    const pageNumbers = child(sectPr, 'pgNumType');
    if (pageNumbers) {
      section.pageNumberStart = num(attr(pageNumbers, 'start'));
      section.pageNumberFormat = attr(pageNumbers, 'fmt') ?? undefined;
    }

    for (const [kind, target] of [
      ['headerReference', section.headers],
      ['footerReference', section.footers],
    ] as const) {
      for (const reference of children(sectPr, kind)) {
        const type = (attr(reference, 'type') ?? 'default') as 'default' | 'first' | 'even';
        const id = attr(reference, 'r:id') ?? attr(reference, 'id');
        const part = id ? context.rels.get(id) : undefined;
        if (!part) continue;
        const xml = text(this.files, part);
        if (!xml) continue;
        const partContext: Context = { rels: readRels(this.files, part) };
        const saved = this.fields;
        this.fields = [];
        target[type] = this.blocks(parseXml(xml).documentElement, partContext);
        this.fields = saved;
      }
    }

    return section;
  }

  /** Block content of a container (a header, a cell, a text box). */
  blocks(container: Element, context: Context): Block[] {
    const out: Block[] = [];
    const visit = (element: Element) => {
      for (const node of children(element)) {
        const name = localName(node);
        if (name === 'p') {
          const paragraph = this.paragraph(node, context);
          if (paragraph) out.push(paragraph);
        } else if (name === 'tbl') {
          out.push(this.table(node, context));
        } else if (name === 'sdt') {
          visit(child(node, 'sdtContent') ?? node);
        } else if (name === 'customXml' || name === 'smartTag') {
          visit(node);
        } else if (name === 'AlternateContent') {
          const choice = child(node, 'Choice');
          if (choice) visit(choice);
        }
      }
    };
    visit(container);
    return joinHiddenMarks(out);
  }

  /* ------------------------------------------------------ paragraphs */

  private paragraph(node: Element, context: Context): Paragraph | null {
    const direct = parseParaProps(child(node, 'pPr'));
    const styleId = direct?.styleId ?? this.styles.defaultParagraphStyle;
    const style = this.styles.paragraphStyle(styleId);

    // Numbering can come from the paragraph or from its style.
    const numId = direct?.numId ?? style.para.numId;
    const ilvl = direct?.ilvl ?? style.para.ilvl ?? 0;
    const level = this.numbering.level(numId, ilvl);

    const props = mergePara(
      this.styles.defaultPara,
      context.tablePara,
      style.para,
      level?.para,
      direct,
    );
    props.styleId = styleId;

    const baseRun = mergeRun(this.styles.defaultRun, context.tableRun, style.run);
    const mark = mergeRun(baseRun, parseRunProps(path(node, 'pPr', 'rPr')));

    const inlines: Inline[] = [];
    this.runsOf(node, context, baseRun, inlines);

    let label: ListLabel | undefined;
    if (level && numId) {
      const labelText = this.numbering.next(numId, ilvl);
      if (labelText !== undefined && (labelText !== '' || level.format === 'bullet')) {
        label = {
          text: labelText,
          // The label takes the paragraph mark's formatting, then the level's own.
          props: mergeRun(mark, level.run, { underline: undefined }),
          suffix: level.suffix,
          align: level.align,
        };
      }
    }

    return { kind: 'paragraph', props, mark, inlines, label };
  }

  private runsOf(element: Element, context: Context, base: RunProps, out: Inline[]): void {
    for (const node of children(element)) {
      const name = localName(node);
      switch (name) {
        case 'r':
          this.run(node, context, base, out);
          break;
        case 'hyperlink':
        case 'smartTag':
        case 'customXml':
        case 'ins':
        case 'moveTo':
        case 'dir':
        case 'bdo':
          this.runsOf(node, context, base, out);
          break;
        case 'sdt':
          this.runsOf(child(node, 'sdtContent') ?? node, context, base, out);
          break;
        case 'fldSimple': {
          const instruction = (attr(node, 'instr') ?? '').trim().split(/\s+/)[0]?.toUpperCase();
          if (instruction === 'PAGE' || instruction === 'NUMPAGES') {
            const props = mergeRun(base, parseRunProps(path(node, 'r', 'rPr')));
            out.push({ kind: 'field', field: instruction, props });
          } else {
            this.runsOf(node, context, base, out);
          }
          break;
        }
        case 'AlternateContent': {
          const choice = child(node, 'Choice');
          if (choice) this.runsOf(choice, context, base, out);
          break;
        }
        default:
          break;
      }
    }
  }

  private hiddenByField(): boolean {
    return this.fields.some((field) => field.phase === 'code' || field.replaced);
  }

  private run(node: Element, context: Context, base: RunProps, out: Inline[]): void {
    const direct = parseRunProps(child(node, 'rPr'));
    // Word shows table-of-contents entries without the Hyperlink character
    // style they carry: black, not underlined.
    const inToc = this.fields.some((field) => /^\s*TOC\b/i.test(field.instruction));
    const characterStyle = inToc && direct?.styleId === 'Hyperlink' ? {} : this.styles.characterStyle(direct?.styleId);
    const props = mergeRun(base, characterStyle, direct);

    for (const item of children(node)) {
      const name = localName(item);

      if (name === 'fldChar') {
        const type = attr(item, 'fldCharType');
        if (type === 'begin') this.fields.push({ instruction: '', phase: 'code', replaced: false });
        else if (type === 'separate') {
          const field = this.fields[this.fields.length - 1];
          if (field) {
            field.phase = 'result';
            const code = field.instruction.trim().split(/\s+/)[0]?.toUpperCase();
            if ((code === 'PAGE' || code === 'NUMPAGES') && !this.hiddenByField()) {
              // Emitted at the first cached result character, so the number
              // takes the result's formatting, as Word shows it.
              field.replaced = true;
              field.code = code;
            }
          }
        } else if (type === 'end') {
          const field = this.fields.pop();
          if (field?.replaced && field.code && !field.emitted && !this.hiddenByField()) {
            out.push({ kind: 'field', field: field.code, props });
          }
          if (field && field.phase === 'code') {
            // A field with no cached result still shows its value.
            const code = field.instruction.trim().split(/\s+/)[0]?.toUpperCase();
            if ((code === 'PAGE' || code === 'NUMPAGES') && !this.hiddenByField()) {
              out.push({ kind: 'field', field: code, props });
            }
          }
        }
        continue;
      }

      if (name === 'instrText') {
        const field = this.fields[this.fields.length - 1];
        if (field && field.phase === 'code') field.instruction += item.textContent ?? '';
        continue;
      }

      const open = this.fields[this.fields.length - 1];
      if (open?.replaced && open.code && !open.emitted && open.phase === 'result' && name === 't') {
        open.emitted = true;
        if (this.fields.every((field) => field === open || (field.phase === 'result' && !field.replaced))) {
          out.push({ kind: 'field', field: open.code, props });
        }
        continue;
      }
      if (this.hiddenByField()) continue;
      if (props.vanish && name !== 'drawing') continue;

      switch (name) {
        case 't':
          if (item.textContent) out.push({ kind: 'text', text: item.textContent, props });
          break;
        case 'tab':
          out.push({ kind: 'tab', props });
          break;
        case 'ptab': {
          // A positional tab: aligned to the margin or indent, not to stops.
          const alignment = attr(item, 'alignment');
          out.push({
            kind: 'tab',
            props,
            ptab: {
              align: alignment === 'right' ? 'right' : alignment === 'center' ? 'center' : 'left',
              relativeTo: attr(item, 'relativeTo') === 'indent' ? 'indent' : 'margin',
            },
          });
          break;
        }
        case 'br': {
          const type = attr(item, 'type');
          out.push({ kind: 'break', type: type === 'page' ? 'page' : type === 'column' ? 'column' : 'line', props });
          break;
        }
        case 'cr':
          out.push({ kind: 'break', type: 'line', props });
          break;
        case 'noBreakHyphen':
          out.push({ kind: 'text', text: '-', props });
          break;
        case 'sym': {
          const code = parseInt(attr(item, 'char') ?? '', 16);
          if (Number.isFinite(code)) {
            out.push({
              kind: 'text',
              text: String.fromCodePoint(code < 0xf000 && code < 0x100 ? code + 0xf000 : code),
              props: { ...props, font: attr(item, 'font') ?? props.font, fontTheme: undefined },
            });
          }
          break;
        }
        case 'drawing':
          this.drawing(item, context, props, out);
          break;
        case 'AlternateContent': {
          const choice = child(item, 'Choice');
          const drawing = choice ? child(choice, 'drawing') : undefined;
          if (drawing) this.drawing(drawing, context, props, out);
          break;
        }
        default:
          break;
      }
    }
  }

  /* ---------------------------------------------------------- tables */

  private table(node: Element, context: Context): Table {
    const direct = parseTableProps(child(node, 'tblPr'));
    const style = this.styles.tableStyle(direct?.styleId);
    const props = mergeTable(style.table, direct);
    // Word's built-in fallback when no style sets cell margins.
    props.cellMargins = { left: 5.4, right: 5.4, top: 0, bottom: 0, ...props.cellMargins };

    const grid = children(child(node, 'tblGrid'), 'gridCol').map((col) => (num(attr(col, 'w')) ?? 0) / 20);
    const cellContext: Context = {
      rels: context.rels,
      tablePara: mergePara(context.tablePara, style.para),
      tableRun: mergeRun(context.tableRun, style.run),
    };

    const rows: Row[] = [];
    const rowNodes: Element[] = [];
    const collectRows = (element: Element) => {
      for (const next of children(element)) {
        const name = localName(next);
        if (name === 'tr') rowNodes.push(next);
        else if (name === 'sdt') collectRows(child(next, 'sdtContent') ?? next);
        else if (name === 'customXml') collectRows(next);
      }
    };
    collectRows(node);

    for (const rowNode of rowNodes) {
      const trPr = child(rowNode, 'trPr');
      const heightNode = child(trPr, 'trHeight');
      const row: Row = {
        height: heightNode ? (num(val(heightNode)) ?? 0) / 20 : undefined,
        heightRule: ((attr(heightNode, 'hRule') ?? 'atLeast') as Row['heightRule']),
        header: toggle(child(trPr, 'tblHeader')) ?? false,
        cantSplit: toggle(child(trPr, 'cantSplit')) ?? false,
        gridBefore: num(val(child(trPr, 'gridBefore'))) ?? 0,
        cells: [],
      };

      const cellNodes: Element[] = [];
      const collectCells = (element: Element) => {
        for (const next of children(element)) {
          const name = localName(next);
          if (name === 'tc') cellNodes.push(next);
          else if (name === 'sdt') collectCells(child(next, 'sdtContent') ?? next);
          else if (name === 'customXml') collectCells(next);
        }
      };
      collectCells(rowNode);

      for (const cellNode of cellNodes) {
        const tcPr = child(cellNode, 'tcPr');
        const vMerge = child(tcPr, 'vMerge');
        const vAlign = val(child(tcPr, 'vAlign'));
        row.cells.push({
          span: num(val(child(tcPr, 'gridSpan'))) ?? 1,
          vMerge: vMerge ? (val(vMerge) === 'restart' ? 'restart' : 'continue') : undefined,
          borders: parseTableBorders(child(tcPr, 'tcBorders')),
          shading: shadingColor(child(tcPr, 'shd')),
          vAlign: vAlign === 'center' ? 'center' : vAlign === 'bottom' ? 'bottom' : 'top',
          margins: parseCellMargins(child(tcPr, 'tcMar')),
          blocks: this.blocks(cellNode, cellContext),
        });
      }

      rows.push(row);
    }

    // A grid missing from the file is rebuilt from the first row's cell widths.
    if (grid.length === 0 && rowNodes[0]) {
      for (const cellNode of children(rowNodes[0], 'tc')) {
        grid.push((num(attr(path(cellNode, 'tcPr', 'tcW'), 'w')) ?? 1440) / 20);
      }
    }

    return { kind: 'table', props, grid, rows };
  }

  /* -------------------------------------------------------- drawings */

  private image(rels: Map<string, string>, id: string | null): string | undefined {
    if (!id) return undefined;
    const target = rels.get(id);
    if (!target) return undefined;
    if (!this.images.has(target)) {
      const data = this.files[target];
      if (!data) return undefined;
      const lower = target.toLowerCase();
      const type = lower.endsWith('.png') ? 'png' : /\.jpe?g$/.test(lower) ? 'jpg' : 'other';
      const mime =
        type === 'png' ? 'image/png' : type === 'jpg' ? 'image/jpeg' : lower.endsWith('.gif') ? 'image/gif' : lower.endsWith('.bmp') ? 'image/bmp' : 'application/octet-stream';
      this.images.set(target, { data, type, mime });
    }
    return target;
  }

  private crop(blipFill: Element | undefined): Crop | undefined {
    const rect = child(blipFill, 'srcRect');
    if (!rect) return undefined;
    const read = (name: string) => (num(attr(rect, name)) ?? 0) / 100000;
    const crop = { left: read('l'), top: read('t'), right: read('r'), bottom: read('b') };
    return crop.left || crop.top || crop.right || crop.bottom ? crop : undefined;
  }

  private drawing(node: Element, context: Context, props: RunProps, out: Inline[]): void {
    const inline = child(node, 'inline');
    const anchor = child(node, 'anchor');
    const frame = inline ?? anchor;
    if (!frame) return;
    if (attr(child(frame, 'docPr'), 'hidden') === '1') return;

    const extent = child(frame, 'extent');
    const width = emu(num(attr(extent, 'cx'))) ?? 0;
    const height = emu(num(attr(extent, 'cy'))) ?? 0;
    const graphic = path(frame, 'graphic', 'graphicData');
    const shapes = this.graphicShapes(graphic, context, width, height);

    if (inline) {
      const picture = shapes.length === 1 && shapes[0].kind === 'picture' ? shapes[0] : undefined;
      if (picture) {
        out.push({ kind: 'image', width, height, image: picture.image, crop: picture.crop, props });
      } else if (shapes.length > 0) {
        // An inline shape or group: carried as an anchor at the text position.
        out.push({
          kind: 'anchor',
          anchor: {
            behind: false,
            z: 0,
            h: { from: 'character', offset: 0 },
            v: { from: 'line', offset: 0 },
            width,
            height,
            wrap: 'none',
            wrapSide: 'bothSides',
            distance: { top: 0, bottom: 0, left: 0, right: 0 },
            outset: { top: 0, bottom: 0, left: 0, right: 0 },
            shapes,
          },
        });
      }
      return;
    }

    const position = (name: 'positionH' | 'positionV'): AnchorPosition => {
      const node2 = child(anchor, name);
      const offset = child(node2, 'posOffset');
      const align = child(node2, 'align');
      return {
        from: attr(node2, 'relativeFrom') ?? (name === 'positionH' ? 'column' : 'paragraph'),
        offset: offset ? emu(num(offset.textContent)) : undefined,
        align: align?.textContent ?? undefined,
      };
    };

    const wrapNode = children(anchor).find((next) => localName(next).startsWith('wrap'));
    const wrapName = wrapNode ? localName(wrapNode).slice(4) : 'None';
    const wrap: Anchor['wrap'] = ({ None: 'none', Square: 'square', Tight: 'tight', Through: 'through', TopAndBottom: 'topAndBottom' } as const)[
      wrapName as 'None'
    ] as Anchor['wrap'] | undefined ?? 'none';

    const side = attr(wrapNode, 'wrapText');
    const wrapSide = side === 'left' || side === 'right' || side === 'largest' ? side : 'bothSides';

    // The polygon is in 1/21600ths of the object's box and may reach past it.
    const outset = { top: 0, bottom: 0, left: 0, right: 0 };
    let outline: Anchor['polygon'];
    const polygon = child(wrapNode, 'wrapPolygon');
    if (polygon && (wrap === 'tight' || wrap === 'through') && width > 0 && height > 0) {
      const points = children(polygon).map((point) => ({ x: num(attr(point, 'x')) ?? 0, y: num(attr(point, 'y')) ?? 0 }));
      if (points.length > 2) outline = points.map((point) => ({ x: (point.x / 21600) * width, y: (point.y / 21600) * height }));
      if (points.length > 0) {
        const xs = points.map((point) => point.x);
        const ys = points.map((point) => point.y);
        outset.left = Math.max(0, (-Math.min(...xs) / 21600) * width);
        outset.right = Math.max(0, ((Math.max(...xs) - 21600) / 21600) * width);
        outset.top = Math.max(0, (-Math.min(...ys) / 21600) * height);
        outset.bottom = Math.max(0, ((Math.max(...ys) - 21600) / 21600) * height);
      }
    } else {
      const effect = child(anchor, 'effectExtent');
      if (effect) {
        outset.left = emu(num(attr(effect, 'l'))) ?? 0;
        outset.right = emu(num(attr(effect, 'r'))) ?? 0;
        outset.top = emu(num(attr(effect, 't'))) ?? 0;
        outset.bottom = emu(num(attr(effect, 'b'))) ?? 0;
      }
    }

    const simple = attr(anchor, 'simplePos') === '1';
    const simplePos = child(anchor, 'simplePos');

    out.push({
      kind: 'anchor',
      anchor: {
        behind: attr(anchor, 'behindDoc') === '1',
        z: num(attr(anchor, 'relativeHeight')) ?? 0,
        h: simple ? { from: 'page', offset: emu(num(attr(simplePos, 'x'))) } : position('positionH'),
        v: simple ? { from: 'page', offset: emu(num(attr(simplePos, 'y'))) } : position('positionV'),
        width,
        height,
        wrap,
        wrapSide,
        outset,
        polygon: outline,
        distance: {
          top: emu(num(attr(anchor, 'distT'))) ?? 0,
          bottom: emu(num(attr(anchor, 'distB'))) ?? 0,
          left: emu(num(attr(anchor, 'distL'))) ?? 0,
          right: emu(num(attr(anchor, 'distR'))) ?? 0,
        },
        shapes,
      },
    });
  }

  /** Shapes of a graphic, in the drawing's own frame (0,0)–(width,height). */
  private graphicShapes(graphic: Element | undefined, context: Context, width: number, height: number): Shape[] {
    if (!graphic) return [];
    const out: Shape[] = [];
    for (const node of children(graphic)) {
      const name = localName(node);
      const frame = { x: 0, y: 0, w: width, h: height };
      if (name === 'pic') this.picture(node, context, frame, out);
      else if (name === 'wsp') this.shape(node, context, frame, out);
      else if (name === 'wgp') this.group(node, context, frame, out);
    }
    return out;
  }

  private xfrm(spPr: Element | undefined) {
    const xfrm = child(spPr, 'xfrm');
    const off = child(xfrm, 'off');
    const ext = child(xfrm, 'ext');
    return {
      x: emu(num(attr(off, 'x'))) ?? 0,
      y: emu(num(attr(off, 'y'))) ?? 0,
      w: emu(num(attr(ext, 'cx'))),
      h: emu(num(attr(ext, 'cy'))),
      rotation: (num(attr(xfrm, 'rot')) ?? 0) / 60000,
      flipH: attr(xfrm, 'flipH') === '1',
      flipV: attr(xfrm, 'flipV') === '1',
      chOff: child(xfrm, 'chOff'),
      chExt: child(xfrm, 'chExt'),
    };
  }

  private picture(node: Element, context: Context, frame: { x: number; y: number; w: number; h: number }, out: Shape[]) {
    const blipFill = child(node, 'blipFill');
    const blip = child(blipFill, 'blip');
    const image = this.image(context.rels, attr(blip, 'r:embed') ?? attr(blip, 'embed'));
    if (!image) return;
    const xfrm = this.xfrm(child(node, 'spPr'));
    out.push({ kind: 'picture', ...frame, image, crop: this.crop(blipFill), rotation: xfrm.rotation });
  }

  private group(node: Element, context: Context, frame: { x: number; y: number; w: number; h: number }, out: Shape[]) {
    const xfrm = this.xfrm(child(node, 'grpSpPr'));
    const chOffX = emu(num(attr(xfrm.chOff, 'x'))) ?? 0;
    const chOffY = emu(num(attr(xfrm.chOff, 'y'))) ?? 0;
    const chW = emu(num(attr(xfrm.chExt, 'cx'))) || xfrm.w || frame.w;
    const chH = emu(num(attr(xfrm.chExt, 'cy'))) || xfrm.h || frame.h;
    const sx = frame.w / (chW || 1);
    const sy = frame.h / (chH || 1);

    // Children are positioned in the group's child space; map them into ours.
    const map = (x: number, y: number, w: number, h: number) => ({
      x: frame.x + (x - chOffX) * sx,
      y: frame.y + (y - chOffY) * sy,
      w: w * sx,
      h: h * sy,
    });

    for (const next of children(node)) {
      const name = localName(next);
      if (name === 'grpSpPr' || name === 'cNvGrpSpPr' || name === 'cNvPr') continue;
      const spPr = child(next, name === 'grpSp' ? 'grpSpPr' : 'spPr');
      const box = this.xfrm(spPr);
      const childFrame = map(box.x, box.y, box.w ?? 0, box.h ?? 0);
      if (name === 'pic') this.picture(next, context, childFrame, out);
      else if (name === 'wsp') this.shape(next, context, childFrame, out);
      else if (name === 'grpSp') this.group(next, context, childFrame, out);
      else if (name === 'AlternateContent') {
        const choice = child(next, 'Choice');
        if (choice) this.group(choice, context, frame, out);
      }
    }
  }

  private color(node: Element | undefined): { color: string; opacity: number } | null | undefined {
    if (!node) return undefined;
    const name = localName(node);
    if (name === 'noFill') return null;
    let colorNode: Element | undefined;
    if (name === 'solidFill') colorNode = children(node)[0];
    else if (name === 'gradFill') colorNode = children(child(child(node, 'gsLst'), 'gs'))[0];
    else colorNode = node;
    if (!colorNode) return undefined;

    const kind = localName(colorNode);
    let hex: string | undefined;
    if (kind === 'srgbClr') hex = `#${(attr(colorNode, 'val') ?? '000000').toUpperCase()}`;
    else if (kind === 'schemeClr') hex = this.theme.colors[attr(colorNode, 'val') ?? ''] ?? '#000000';
    else if (kind === 'sysClr') hex = `#${(attr(colorNode, 'lastClr') ?? '000000').toUpperCase()}`;
    else if (kind === 'prstClr') hex = attr(colorNode, 'val') === 'white' ? '#FFFFFF' : '#000000';
    if (!hex) return undefined;

    let opacity = 1;
    let [r, g, b] = [1, 3, 5].map((i) => parseInt(hex!.slice(i, i + 2), 16) / 255);
    for (const mod of children(colorNode)) {
      const amount = (num(attr(mod, 'val')) ?? 100000) / 100000;
      switch (localName(mod)) {
        case 'lumMod':
        case 'lumOff': {
          const [h, s, l] = rgbToHsl(r, g, b);
          const nextL = localName(mod) === 'lumMod' ? l * amount : Math.min(1, l + amount);
          [r, g, b] = hslToRgb(h, s, nextL);
          break;
        }
        case 'shade':
          [r, g, b] = [r * amount, g * amount, b * amount];
          break;
        case 'tint':
          [r, g, b] = [r + (1 - r) * (1 - amount), g + (1 - g) * (1 - amount), b + (1 - b) * (1 - amount)];
          break;
        case 'alpha':
          opacity = amount;
          break;
      }
    }
    const toHex = (value: number) => Math.round(Math.max(0, Math.min(1, value)) * 255).toString(16).padStart(2, '0');
    return { color: `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase(), opacity };
  }

  private shape(node: Element, context: Context, frame: { x: number; y: number; w: number; h: number }, out: Shape[]) {
    const spPr = child(node, 'spPr');
    const xfrm = this.xfrm(spPr);
    const geometry = attr(child(spPr, 'prstGeom'), 'prst') ?? (child(spPr, 'custGeom') ? 'rect' : 'rect');
    const style = child(node, 'style');

    let fill: ShapeFill | undefined = undefined;
    for (const next of children(spPr)) {
      const name = localName(next);
      if (name === 'noFill' || name === 'solidFill' || name === 'gradFill') {
        fill = this.color(next) ?? null;
      }
    }
    if (fill === undefined) {
      const fillRef = child(style, 'fillRef');
      fill = fillRef && (num(attr(fillRef, 'idx')) ?? 0) > 0 ? (this.color(children(fillRef)[0]) ?? null) : null;
    }

    const ln = child(spPr, 'ln');
    let stroke: ShapeBox['stroke'] = null;
    const lineFill = children(ln).find((next) => ['noFill', 'solidFill', 'gradFill'].includes(localName(next)));
    const lnRef = child(style, 'lnRef');
    const refIndex = num(attr(lnRef, 'idx')) ?? 0;
    const lineColor = lineFill ? this.color(lineFill) : refIndex > 0 ? this.color(children(lnRef)[0]) : null;
    if (lineColor) {
      const width = emu(num(attr(ln, 'w'))) ?? this.theme.lineWidths[refIndex - 1] ?? 0.75;
      stroke = {
        color: lineColor.color,
        opacity: lineColor.opacity,
        width,
        headArrow: (attr(child(ln, 'headEnd'), 'type') ?? 'none') !== 'none',
        tailArrow: (attr(child(ln, 'tailEnd'), 'type') ?? 'none') !== 'none',
      };
    }

    const box: ShapeBox = {
      kind: 'box',
      ...frame,
      geometry,
      fill,
      stroke,
      rotation: xfrm.rotation,
      flipH: xfrm.flipH,
      flipV: xfrm.flipV,
    };

    const textBox = path(node, 'txbx', 'txbxContent');
    if (textBox) {
      const bodyPr = child(node, 'bodyPr');
      const inset = (name: string, fallback: number) => emu(num(attr(bodyPr, name))) ?? fallback;
      const anchorValue = attr(bodyPr, 'anchor');
      box.text = {
        blocks: this.blocks(textBox, { rels: context.rels }),
        insets: { left: inset('lIns', 7.2), top: inset('tIns', 3.6), right: inset('rIns', 7.2), bottom: inset('bIns', 3.6) },
        anchor: anchorValue === 'ctr' ? 'center' : anchorValue === 'b' ? 'bottom' : 'top',
      };
    }

    out.push(box);
  }
}

/**
 * A paragraph whose mark is hidden is not a paragraph in Word's layout: its
 * content runs on into the next paragraph, which supplies the formatting.
 */
function joinHiddenMarks(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    const next = blocks[index + 1];
    if (block.kind === 'paragraph' && block.mark.vanish && next?.kind === 'paragraph') {
      // A hidden mark (a style separator) runs the two paragraphs together.
      // The joined paragraph is laid out with the first one's formatting —
      // measured: a Heading 1 joined to a Normal paragraph kept 1.5 spacing
      // and its keep-with-next.
      blocks[index + 1] = { ...block, inlines: [...block.inlines, ...next.inlines], mark: next.mark };
      continue;
    }
    out.push(block);
  }
  return out;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === r ? ((g - b) / d + (g < b ? 6 : 0)) / 6 : max === g ? ((b - r) / d + 2) / 6 : ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
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

export function readDocx(buffer: ArrayBuffer): DocxDocument {
  let files: Files;
  try {
    files = unzipSync(new Uint8Array(buffer));
  } catch {
    throw new Error('Berkas ini bukan arsip .docx yang valid');
  }
  return new Parser(files).document();
}
