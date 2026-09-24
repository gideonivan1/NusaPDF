/**
 * A small EMF (Windows enhanced metafile) interpreter.
 *
 * Office stores tables and charts pasted from Excel or Word as EMF — a
 * recording of GDI calls — and browsers cannot display it. This replays the
 * common records (pens, brushes, lines, polygons, rectangle fills, fonts,
 * and text) as the Word engine's drawing operations, so the picture stays
 * vector and its text stays text. EMF+ records riding along in comments are
 * skipped: dual files carry the same drawing as plain GDI records too.
 * Clipping is kept as a rectangle, which is what tables use; bitmaps inside
 * the metafile are not replayed.
 */

import type { Face } from './docx-to-pdf/fonts';
import type { DrawOp } from './docx-to-pdf/layout';

export type EmfFaceFor = (font: string, bold: boolean, italic: boolean) => Face;

interface Pen {
  color: string;
  width: number;
  none: boolean;
}

interface Brush {
  color: string;
  none: boolean;
}

interface Font {
  name: string;
  /** Logical units; negative: the em height. */
  height: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  escapement: number;
}

interface State {
  windowOrg: [number, number];
  windowExt: [number, number];
  viewportOrg: [number, number];
  viewportExt: [number, number];
  mapMode: number;
  pen: Pen;
  brush: Brush;
  font: Font;
  textColor: string;
  textAlign: number;
  position: [number, number];
  /** Page-space clip rectangle, or none. */
  clip: { x0: number; y0: number; x1: number; y1: number } | null;
}

const BLACK_PEN: Pen = { color: '#000000', width: 0, none: false };
const WHITE_BRUSH: Brush = { color: '#ffffff', none: false };
const DEFAULT_FONT: Font = { name: 'Arial', height: -12, bold: false, italic: false, underline: false, escapement: 0 };

const STOCK: Record<number, Pen | Brush | Font> = {
  0: WHITE_BRUSH,
  1: { color: '#c0c0c0', none: false },
  2: { color: '#808080', none: false },
  3: { color: '#404040', none: false },
  4: { color: '#000000', none: false },
  5: { color: '#000000', none: true },
  6: { color: '#ffffff', width: 0, none: false },
  7: BLACK_PEN,
  8: { color: '#000000', width: 0, none: true },
  10: DEFAULT_FONT,
  11: DEFAULT_FONT,
  12: DEFAULT_FONT,
  13: DEFAULT_FONT,
  14: DEFAULT_FONT,
  16: DEFAULT_FONT,
  17: DEFAULT_FONT,
};

function colorref(view: DataView, offset: number): string {
  const hex = (value: number) => value.toString(16).padStart(2, '0');
  return `#${hex(view.getUint8(offset))}${hex(view.getUint8(offset + 1))}${hex(view.getUint8(offset + 2))}`;
}

function isEmf(data: Uint8Array): boolean {
  return data.length > 88 && data[0] === 1 && data[1] === 0 && data[40] === 0x20 && data[41] === 0x45 && data[42] === 0x4d && data[43] === 0x46;
}

export class Emf {
  private readonly view: DataView;
  private readonly data: Uint8Array;
  /** The picture's frame in logical (device) units: what maps onto the box. */
  private readonly frame: { x: number; y: number; w: number; h: number };

  static parse(data: Uint8Array): Emf | null {
    return isEmf(data) ? new Emf(data) : null;
  }

  private constructor(data: Uint8Array) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const v = this.view;
    // rclFrame is in 0.01 mm; the reference device tells pixels per mm.
    const frame = [v.getInt32(24, true), v.getInt32(28, true), v.getInt32(32, true), v.getInt32(36, true)];
    const pixels = [v.getInt32(72, true), v.getInt32(76, true)];
    const millimetres = [v.getInt32(80, true), v.getInt32(84, true)];
    const px = pixels[0] / Math.max(1, millimetres[0]) / 100;
    const py = pixels[1] / Math.max(1, millimetres[1]) / 100;
    this.frame = { x: frame[0] * px, y: frame[1] * py, w: (frame[2] - frame[0]) * px, h: (frame[3] - frame[1]) * py };
  }

  private *records(): Generator<{ type: number; offset: number; size: number }> {
    let offset = 0;
    while (offset + 8 <= this.data.length) {
      const type = this.view.getUint32(offset, true);
      const size = this.view.getUint32(offset + 4, true);
      if (size < 8 || offset + size > this.data.length) return;
      yield { type, offset, size };
      if (type === 14) return;
      offset += size;
    }
  }

  private readFont(offset: number): Font {
    const v = this.view;
    const logfont = offset + 12;
    let name = '';
    for (let index = 0; index < 32; index++) {
      const code = v.getUint16(logfont + 28 + index * 2, true);
      if (!code) break;
      name += String.fromCharCode(code);
    }
    return {
      name: name || 'Arial',
      height: v.getInt32(logfont, true),
      escapement: v.getInt32(logfont + 8, true),
      bold: v.getInt32(logfont + 16, true) >= 600,
      italic: v.getUint8(logfont + 20) !== 0,
      underline: v.getUint8(logfont + 21) !== 0,
    };
  }

  /** Every font the text in the metafile uses, so they can load first. */
  fonts(): [string, boolean, boolean][] {
    const out = new Map<string, [string, boolean, boolean]>();
    for (const record of this.records()) {
      if (record.type !== 82) continue;
      const font = this.readFont(record.offset);
      out.set(`${font.name}|${font.bold}|${font.italic}`, [font.name, font.bold, font.italic]);
    }
    return [...out.values()];
  }

  /** Replays the metafile into a box on the page. */
  draw(box: { x: number; y: number; w: number; h: number }, faceFor: EmfFaceFor): DrawOp[] {
    const v = this.view;
    const ops: DrawOp[] = [];
    const objects = new Map<number, Pen | Brush | Font>();
    const kinds = new Map<number, 'pen' | 'brush' | 'font'>();
    let state: State = {
      windowOrg: [0, 0],
      windowExt: [1, 1],
      viewportOrg: [0, 0],
      viewportExt: [1, 1],
      mapMode: 1,
      pen: BLACK_PEN,
      brush: WHITE_BRUSH,
      font: DEFAULT_FONT,
      textColor: '#000000',
      textAlign: 0,
      position: [0, 0],
      clip: null,
    };
    const saved: State[] = [];
    const sx = box.w / Math.max(1e-6, this.frame.w);
    const sy = box.h / Math.max(1e-6, this.frame.h);

    /** Logical → device → page. */
    const toDevice = (x: number, y: number): [number, number] => {
      if (state.mapMode === 1) return [x - state.windowOrg[0] + state.viewportOrg[0], y - state.windowOrg[1] + state.viewportOrg[1]];
      const kx = state.viewportExt[0] / (state.windowExt[0] || 1);
      const ky = state.viewportExt[1] / (state.windowExt[1] || 1);
      return [(x - state.windowOrg[0]) * kx + state.viewportOrg[0], (y - state.windowOrg[1]) * ky + state.viewportOrg[1]];
    };
    const point = (x: number, y: number) => {
      const [dx, dy] = toDevice(x, y);
      return { x: box.x + (dx - this.frame.x) * sx, y: box.y + (dy - this.frame.y) * sy };
    };
    const scaleX = () => (state.mapMode === 1 ? 1 : Math.abs(state.viewportExt[0] / (state.windowExt[0] || 1))) * sx;
    const scaleY = () => (state.mapMode === 1 ? 1 : Math.abs(state.viewportExt[1] / (state.windowExt[1] || 1))) * sy;
    const penWidth = () => Math.max(0.25, state.pen.width * scaleX());
    const f = (value: number) => value.toFixed(3);
    const intersect = (a: NonNullable<State['clip']>) => {
      const b = state.clip;
      state.clip = b ? { x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) } : a;
    };

    const shape = (points: { x: number; y: number }[][], closed: boolean) => {
      const d = points
        .filter((list) => list.length > 0)
        .map((list) => list.map((p, index) => `${index === 0 ? 'M' : 'L'}${f(p.x)},${f(p.y)}`).join(' ') + (closed ? ' Z' : ''))
        .join(' ');
      if (!d) return;
      if (closed && !state.brush.none) ops.push({ kind: 'path', d, fill: state.brush.color });
      if (!state.pen.none) ops.push({ kind: 'path', d, stroke: state.pen.color, strokeWidth: penWidth() });
    };
    const points16 = (offset: number, count: number) => {
      const out: { x: number; y: number }[] = [];
      for (let index = 0; index < count; index++) out.push(point(v.getInt16(offset + index * 4, true), v.getInt16(offset + index * 4 + 2, true)));
      return out;
    };
    const points32 = (offset: number, count: number) => {
      const out: { x: number; y: number }[] = [];
      for (let index = 0; index < count; index++) out.push(point(v.getInt32(offset + index * 8, true), v.getInt32(offset + index * 8 + 4, true)));
      return out;
    };

    for (const { type, offset } of this.records()) {
      const i32 = (at: number) => v.getInt32(offset + at, true);
      const u32 = (at: number) => v.getUint32(offset + at, true);
      switch (type) {
        case 9:
          state.windowExt = [i32(8), i32(12)];
          break;
        case 10:
          state.windowOrg = [i32(8), i32(12)];
          break;
        case 11:
          state.viewportExt = [i32(8), i32(12)];
          break;
        case 12:
          state.viewportOrg = [i32(8), i32(12)];
          break;
        case 17:
          state.mapMode = u32(8);
          break;
        case 22:
          state.textAlign = u32(8);
          break;
        case 24:
          state.textColor = colorref(v, offset + 8);
          break;
        case 33:
          saved.push({ ...state });
          break;
        case 34: {
          const which = i32(8);
          const index = which < 0 ? saved.length + which : which;
          if (index >= 0 && index < saved.length) {
            state = saved[index];
            saved.length = index;
          }
          break;
        }
        case 38: {
          const handle = u32(8);
          const style = u32(12);
          objects.set(handle, { none: (style & 0xf) === 5, width: i32(16), color: colorref(v, offset + 24) });
          kinds.set(handle, 'pen');
          break;
        }
        case 95: {
          // EXTCREATEPEN: the LOGPEN follows the bitmap offsets.
          const handle = u32(8);
          const style = u32(28);
          objects.set(handle, { none: (style & 0xf) === 5, width: u32(32), color: colorref(v, offset + 40) });
          kinds.set(handle, 'pen');
          break;
        }
        case 39: {
          const handle = u32(8);
          objects.set(handle, { none: u32(12) === 1, color: colorref(v, offset + 16) });
          kinds.set(handle, 'brush');
          break;
        }
        case 82: {
          const handle = u32(8);
          objects.set(handle, this.readFont(offset));
          kinds.set(handle, 'font');
          break;
        }
        case 37: {
          const handle = u32(8);
          if (handle & 0x80000000) {
            const stock = handle & 0x7fffffff;
            const object = STOCK[stock];
            if (!object) break;
            if (stock <= 5) state.brush = object as Brush;
            else if (stock <= 8) state.pen = object as Pen;
            else state.font = object as Font;
            break;
          }
          const object = objects.get(handle);
          const kind = kinds.get(handle);
          if (!object) break;
          if (kind === 'pen') state.pen = object as Pen;
          else if (kind === 'brush') state.brush = object as Brush;
          else if (kind === 'font') state.font = object as Font;
          break;
        }
        case 40:
          objects.delete(u32(8));
          break;
        case 30: {
          // INTERSECTCLIPRECT, in logical units.
          const a = point(i32(8), i32(12));
          const b = point(i32(16), i32(20));
          intersect({ x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) });
          break;
        }
        case 75: {
          // EXTSELECTCLIPRGN: its bounding rectangle, in device units.
          const size = u32(8);
          const mode = u32(12);
          if (size === 0) {
            if (mode === 5) state.clip = null;
            break;
          }
          const device = (x: number, y: number) => ({ x: box.x + (x - this.frame.x) * sx, y: box.y + (y - this.frame.y) * sy });
          const a = device(i32(32), i32(36));
          const b = device(i32(40), i32(44));
          const rect = { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
          if (mode === 1) intersect(rect);
          else state.clip = rect;
          break;
        }
        case 27:
          state.position = [i32(8), i32(12)];
          break;
        case 54: {
          const to: [number, number] = [i32(8), i32(12)];
          if (!state.pen.none) {
            const a = point(...state.position);
            const b = point(...to);
            ops.push({ kind: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y, color: state.pen.color, width: penWidth() });
          }
          state.position = to;
          break;
        }
        case 43: {
          const a = point(i32(8), i32(12));
          const b = point(i32(16), i32(20));
          shape([[a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }]], true);
          break;
        }
        case 3:
        case 86:
          shape([type === 3 ? points32(offset + 28, u32(24)) : points16(offset + 28, u32(24))], true);
          break;
        case 4:
        case 87:
          shape([type === 4 ? points32(offset + 28, u32(24)) : points16(offset + 28, u32(24))], false);
          break;
        case 91:
        case 90: {
          // POLYPOLYGON16 / POLYPOLYLINE16: counts, then all the points.
          const polys = u32(24);
          let at = offset + 32 + polys * 4;
          const lists: { x: number; y: number }[][] = [];
          for (let index = 0; index < polys; index++) {
            const count = v.getUint32(offset + 32 + index * 4, true);
            lists.push(points16(at, count));
            at += count * 4;
          }
          shape(lists, type === 91);
          break;
        }
        case 76: {
          // BITBLT without a bitmap and a pattern copy: a rectangle filled
          // with the current brush. Word and Excel paint cell fills this way.
          const cbBmi = u32(88);
          const rop = u32(40);
          if (cbBmi === 0 && (rop === 0x00f00021 || rop === 0x00fb0a09) && !state.brush.none) {
            const a = point(i32(24), i32(28));
            const b = point(i32(24) + i32(32), i32(28) + i32(36));
            let x0 = Math.min(a.x, b.x);
            let y0 = Math.min(a.y, b.y);
            let x1 = Math.max(a.x, b.x);
            let y1 = Math.max(a.y, b.y);
            if (state.clip) {
              x0 = Math.max(x0, state.clip.x0);
              y0 = Math.max(y0, state.clip.y0);
              x1 = Math.min(x1, state.clip.x1);
              y1 = Math.min(y1, state.clip.y1);
            }
            if (x1 > x0 && y1 > y0) ops.push({ kind: 'rect', x: x0, y: y0, w: x1 - x0, h: y1 - y0, fill: state.brush.color });
          }
          break;
        }
        case 84: {
          // EXTTEXTOUTW
          const emrtext = offset + 36;
          const refX = v.getInt32(emrtext, true);
          const refY = v.getInt32(emrtext + 4, true);
          const count = v.getUint32(emrtext + 8, true);
          const offString = v.getUint32(emrtext + 12, true);
          const offDx = v.getUint32(emrtext + 36, true);
          let text = '';
          for (let index = 0; index < count; index++) text += String.fromCharCode(v.getUint16(offset + offString + index * 2, true));
          if (!text.trim()) break;
          let advance = 0;
          if (offDx) for (let index = 0; index < count; index++) advance += v.getInt32(offset + offDx + index * 4, true);
          const font = state.font;
          const face = faceFor(font.name, font.bold, font.italic);
          const em = Math.abs(font.height) * scaleY();
          // A positive height is the cell height (ascent + descent).
          const size = font.height < 0 ? em : em / Math.max(0.5, face.ascent + face.descent);
          if (size <= 0.1) break;
          const width = offDx ? advance * scaleX() : face.width(text, size);
          const at = point(refX, refY);
          let x = at.x;
          let y = at.y;
          const align = state.textAlign;
          if ((align & 6) === 6) x -= width / 2;
          else if (align & 2) x -= width;
          if ((align & 24) === 24) {
            // baseline
          } else if (align & 8) y -= face.descent * size;
          else y += face.ascent * size;
          ops.push({ kind: 'text', x, y, text, face, size, color: state.textColor, width: offDx ? width : undefined });
          if (font.underline) ops.push({ kind: 'line', x1: x, y1: y + size * 0.1, x2: x + width, y2: y + size * 0.1, color: state.textColor, width: Math.max(0.4, size * 0.05) });
          break;
        }
      }
    }
    return ops;
  }
}
