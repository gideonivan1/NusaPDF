/**
 * Fonts for Word and PowerPoint to PDF.
 *
 * Line breaks and page breaks depend on glyph widths to a fraction of a
 * point, so the output can only match Word if the text is measured — and
 * drawn — with fonts whose metrics equal the ones Word used. Browsers cannot
 * hand us Arial's bytes, so NusaPDF ships metric-compatible open fonts:
 *
 *   Arial            → Liberation Sans         (identical advance widths)
 *   Arial Narrow     → Liberation Sans Narrow  (identical)
 *   Times New Roman  → Liberation Serif        (identical)
 *   Courier New      → Liberation Mono         (identical)
 *   Calibri          → Carlito                 (identical)
 *
 * Verified glyph by glyph against the Windows originals. Files load on first
 * use only, and pdf-lib subsets them into the PDF.
 *
 * Some fonts have no open twin. For those NusaPDF carries only the original's
 * advance widths (metrics.ts): text is measured with them and drawn with a
 * look-alike stretched to match, so it breaks and aligns like the original.
 *
 *   Gill Sans MT     → Carlito, at Gill Sans widths
 */

import type { PDFDocument, PDFFont } from 'pdf-lib';
import { GILL_SANS, type WidthTable } from './metrics';

export type FontLoader = (file: string) => Promise<Uint8Array>;

interface Family {
  regular: string;
  bold: string;
  italic: string;
  boldItalic: string;
}

const face = (base: string): Family => ({
  regular: `${base}-Regular.ttf`,
  bold: `${base}-Bold.ttf`,
  italic: `${base}-Italic.ttf`,
  boldItalic: `${base}-BoldItalic.ttf`,
});

const SANS = face('LiberationSans');
const NARROW = face('LiberationSansNarrow');
const SERIF = face('LiberationSerif');
const MONO = face('LiberationMono');
const CARLITO = face('Carlito');

const FAMILIES: Record<string, Family> = {
  arial: SANS,
  helvetica: SANS,
  'arial unicode ms': SANS,
  'liberation sans': SANS,
  'arial narrow': NARROW,
  'liberation sans narrow': NARROW,
  'times new roman': SERIF,
  times: SERIF,
  'liberation serif': SERIF,
  'courier new': MONO,
  courier: MONO,
  consolas: MONO,
  'liberation mono': MONO,
  calibri: CARLITO,
  'calibri light': CARLITO,
  carlito: CARLITO,
  'gill sans mt': CARLITO,
  'gill sans': CARLITO,
};

/** Width tables of fonts drawn by a look-alike, by family. */
const PROXIED: Record<string, Record<'regular' | 'bold' | 'italic' | 'boldItalic', WidthTable>> = {
  'gill sans mt': GILL_SANS,
  'gill sans': GILL_SANS,
};

export function widthTable(name: string | undefined, bold: boolean, italic: boolean): WidthTable | undefined {
  const family = PROXIED[(name ?? '').trim().toLowerCase()];
  if (!family) return undefined;
  return family[bold && italic ? 'boldItalic' : bold ? 'bold' : italic ? 'italic' : 'regular'];
}

/** Symbol-font code points Word uses for bullets, and what they look like. */
const SYMBOL_MAP: Record<number, string> = {
  0xf0b7: '•',
  0xf0a7: '▪',
  0xf076: '❖',
  0xf0d8: '➢',
  0xf0fc: '✓',
  0xf0a8: '□',
  0xf06e: '■',
  0xf0e0: '→',
  0xf0de: '⇒',
  0xf02d: '-',
};

export function familyFor(name: string | undefined): Family {
  const key = (name ?? '').trim().toLowerCase();
  if (FAMILIES[key]) return FAMILIES[key];
  if (/serif|roman|times|georgia|garamond|book|century|cambria|palatino|constantia/.test(key) && !/sans/.test(key)) return SERIF;
  if (/mono|courier|consol/.test(key)) return MONO;
  if (/narrow|condensed/.test(key)) return NARROW;
  if (/calibri|candara|corbel/.test(key)) return CARLITO;
  return SANS;
}

/**
 * Symbol and Wingdings glyphs are drawn from Liberation Sans, but Word sizes
 * the line from the symbol font's own metrics — taller than Arial's — so a
 * bulleted line is taller than a plain one. These are the Windows fonts'
 * OS/2 values (winAscent, winDescent per em).
 */
const SYMBOL_METRICS: Record<string, { ascent: number; descent: number }> = {
  symbol: { ascent: 2059 / 2048, descent: 450 / 2048 },
  wingdings: { ascent: 1841 / 2048, descent: 432 / 2048 },
};

export function symbolMetrics(name: string | undefined) {
  const key = (name ?? '').trim().toLowerCase();
  return SYMBOL_METRICS[key] ?? (key.startsWith('wingdings') ? SYMBOL_METRICS.wingdings : undefined);
}

export function fileFor(name: string | undefined, bold: boolean, italic: boolean): string {
  const family = familyFor(name);
  return bold && italic ? family.boldItalic : bold ? family.bold : italic ? family.italic : family.regular;
}

/** Wingdings 2 lays its glyphs out differently from Wingdings. */
const WINGDINGS2_MAP: Record<number, string> = {
  0xf097: '•',
  0xf098: '•',
  0xf0a1: '■',
  0xf0a2: '■',
  0xf0a3: '■',
  0xf050: '✓',
  0xf0f0: '■',
};

/** Maps private-use symbol code points to real characters. */
export function mapSymbols(text: string, fontName: string | undefined): string {
  const symbolic = /symbol|wingdings|webdings/i.test(fontName ?? '');
  const wingdings2 = /wingdings\s*2/i.test(fontName ?? '');
  let out = '';
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (wingdings2 && code >= 0xf000 && code <= 0xf0ff) out += WINGDINGS2_MAP[code] ?? '▪';
    else if (code >= 0xf000 && code <= 0xf0ff) out += SYMBOL_MAP[code] ?? (symbolic ? '•' : String.fromCharCode(code - 0xf000));
    else out += character;
  }
  return out;
}

interface FontkitGlyph {
  advanceWidth: number;
  id: number;
}

interface FontkitFont {
  unitsPerEm: number;
  ascent: number;
  descent: number;
  lineGap: number;
  underlinePosition: number;
  underlineThickness: number;
  'OS/2'?: { winAscent?: number; winDescent?: number };
  hasGlyphForCodePoint(code: number): boolean;
  glyphForCodePoint(code: number): FontkitGlyph;
  layout(text: string, features?: string[]): { positions: { xAdvance: number }[]; glyphs: FontkitGlyph[] };
}

interface Fontkit {
  create(data: Uint8Array): FontkitFont;
}

export class Face {
  readonly ascent: number;
  readonly descent: number;
  /** External leading Word adds to single spacing. */
  readonly leading: number;
  readonly underlinePosition: number;
  readonly underlineThickness: number;
  private readonly widths = new Map<number, number>();
  /** The original font's advance widths, per em, when a look-alike draws it. */
  private readonly table?: Map<number, number>;
  /** Drawn by a look-alike and stretched to the original's widths. */
  readonly proxied: boolean;
  /** Kerning adjustments per em, by character pair. */
  private readonly kerns = new Map<string, number>();
  private readonly tableKerning: boolean;

  readonly file: string;
  readonly pdf: PDFFont;
  private readonly font: FontkitFont;

  constructor(file: string, pdf: PDFFont, font: FontkitFont, metrics?: { ascent: number; descent: number }, table?: WidthTable) {
    this.file = file;
    this.pdf = pdf;
    this.font = font;
    this.proxied = table !== undefined;
    if (table) {
      this.table = new Map();
      for (const pair of table.widths.split(' ')) {
        const [code, width] = pair.split(':');
        this.table.set(parseInt(code, 36), parseInt(width, 36) / table.unitsPerEm);
      }
      for (const entry of table.kerning ? table.kerning.split(' ') : []) {
        const [left, right, value] = entry.split(':');
        this.kerns.set(String.fromCodePoint(parseInt(left, 36)) + String.fromCodePoint(parseInt(right, 36)), parseInt(value, 36) / table.unitsPerEm);
      }
      metrics = { ascent: table.ascent, descent: table.descent };
    }
    this.tableKerning = table !== undefined;
    const unit = font.unitsPerEm;
    const winAscent = font['OS/2']?.winAscent;
    const winDescent = font['OS/2']?.winDescent;
    // Word measures lines the way GDI does: the Windows ascent and descent,
    // plus whatever of the typographic line gap they do not already cover.
    this.ascent = metrics?.ascent ?? (winAscent ?? font.ascent) / unit;
    this.descent = metrics?.descent ?? (winDescent ?? -font.descent) / unit;
    const typographic = (font.ascent - font.descent) / unit;
    this.leading = metrics ? 0 : Math.max(0, font.lineGap / unit - (this.ascent + this.descent - typographic));
    this.underlinePosition = -font.underlinePosition / unit;
    this.underlineThickness = font.underlineThickness / unit;
  }

  /** Single line height at a size: what Word calls one line. */
  lineHeight(size: number): number {
    return (this.ascent + this.descent + this.leading) * size;
  }

  has(code: number): boolean {
    return this.font.hasGlyphForCodePoint(code);
  }

  /** Kerning between two characters, per em (negative: closer). */
  kern(left: string, right: string): number {
    const pair = left + right;
    let value = this.kerns.get(pair);
    if (value === undefined) {
      value = 0;
      if (!this.tableKerning) {
        try {
          const run = this.font.layout(pair, ['kern']);
          if (run.glyphs.length === 2) value = (run.positions[0].xAdvance - run.glyphs[0].advanceWidth) / this.font.unitsPerEm;
        } catch {
          value = 0;
        }
      }
      this.kerns.set(pair, value);
    }
    return value;
  }

  /**
   * Advance width in points. Without kerning — what Word does, and what the
   * PDF shows — unless `kerning`, as PowerPoint sets text above a size.
   */
  width(text: string, size: number, kerning = false): number {
    if (kerning) {
      const characters = [...text];
      let adjust = 0;
      for (let index = 1; index < characters.length; index++) adjust += this.kern(characters[index - 1], characters[index]);
      return this.width(text, size) + adjust * size;
    }
    if (this.table) {
      let ems = 0;
      for (const character of text) {
        const code = character.codePointAt(0) ?? 0;
        ems += this.table.get(code) ?? this.drawnWidth(character, 1);
      }
      return ems * size;
    }
    return this.drawnWidth(text, size);
  }

  /** Width of the glyphs actually drawn: differs from width() for a look-alike. */
  drawnWidth(text: string, size: number): number {
    let units = 0;
    for (const character of text) {
      const code = character.codePointAt(0) ?? 0;
      let advance = this.widths.get(code);
      if (advance === undefined) {
        advance = this.font.hasGlyphForCodePoint(code) ? this.font.glyphForCodePoint(code).advanceWidth : this.font.glyphForCodePoint(0x3f).advanceWidth;
        this.widths.set(code, advance);
      }
      units += advance;
    }
    return (units / this.font.unitsPerEm) * size;
  }
}

export class FontSet {
  private readonly faces = new Map<string, Promise<Face>>();
  /** One download and one embedding per file, however many faces share it. */
  private readonly files = new Map<string, Promise<{ data: Uint8Array; font: FontkitFont; pdf: PDFFont }>>();

  private readonly pdf: PDFDocument;
  private readonly load: FontLoader;
  private readonly fontkit: Fontkit;

  constructor(pdf: PDFDocument, load: FontLoader, fontkit: Fontkit) {
    this.pdf = pdf;
    this.load = load;
    this.fontkit = fontkit;
  }

  get(name: string | undefined, bold: boolean, italic: boolean): Promise<Face> {
    const file = fileFor(name, bold, italic);
    const metrics = symbolMetrics(name);
    const table = widthTable(name, bold, italic);
    const key = metrics || table ? file + '|' + (name ?? '').trim().toLowerCase() : file;
    let face = this.faces.get(key);
    if (!face) {
      face = (async () => {
        let loaded = this.files.get(file);
        if (!loaded) {
          loaded = (async () => {
            const data = await this.load(file);
            const font = this.fontkit.create(data);
            // Ligatures off: the widths above are per character, and a ligature
            // glyph would make the drawn text narrower than the measured text.
            const pdf = await this.pdf.embedFont(data, {
              // pdf-lib's subsetter drops Carlito's composite glyphs — whole words
              // render as blanks — so it is embedded whole. The others subset fine.
              subset: !file.startsWith('Carlito'),
              features: { liga: false, clig: false, calt: false, dlig: false, kern: false },
            });
            return { data, font, pdf };
          })();
          this.files.set(file, loaded);
        }
        const { font, pdf } = await loaded;
        return new Face(file, pdf, font, metrics, table);
      })();
      this.faces.set(key, face);
    }
    return face;
  }
}
