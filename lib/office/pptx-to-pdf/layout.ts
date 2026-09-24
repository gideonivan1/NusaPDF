/**
 * Lays resolved slides out as drawing operations: shape outlines from their
 * preset geometry, pictures, tables, and text set the way PowerPoint sets
 * it — word wrap inside the shape's insets, bullets hanging in the indent,
 * line spacing as a percentage of the line, and the body anchored top,
 * middle, or bottom.
 *
 * The output is the Word engine's page format, so docx-to-pdf/render.ts
 * draws it — fonts, pictures, and the look-alike stretching included.
 */

import type { Face } from '../docx-to-pdf/fonts';
import { mapSymbols } from '../docx-to-pdf/fonts';
import type { DrawOp, LaidOutPage, Layered } from '../docx-to-pdf/layout';
import { Emf } from '../emf';
import type { Box, Bullet, Deck, Fill, Geometry, Paint, Run, ShapeElement, Slide, Stroke, TableElement, TextBody, TextParagraph } from './deck';

export type FaceFor = (font: string, bold: boolean, italic: boolean) => Face;

/* ==========================================================================
   PowerPoint's text constants — measured against its own PDF export
   ========================================================================== */

/**
 * A line at 100% spacing is 1.2 times its font size, whatever the font, and
 * splits into ascent and descent in the font's own proportion. Measured on
 * PowerPoint's PDF export: Gill Sans and Arial at 20pt both step 24pt, with
 * the baseline 19.2pt and 19.44pt below the line's top.
 */
const LINE_FACTOR = 1.2;

/**
 * Where the baseline sits in a line spaced above 100%, or spaced exactly:
 * three quarters of the way down. Measured at 120%, 150%, 200%, and exact
 * 16pt and 30pt. At 100% and below it sits where the font puts it, less
 * whatever the reduction took off the line.
 */
const LOOSE_BASELINE = 0.75;

/**
 * How far a word may run past the line before it wraps. Measured: a line
 * 0.044pt too long stayed whole, one 0.064pt too long wrapped.
 */
const WRAP_TOLERANCE = 0.05;

/* ==========================================================================
   Geometry
   ========================================================================== */

type Point = { x: number; y: number };
type Segment = { op: 'M' | 'L'; p: Point } | { op: 'C'; c1: Point; c2: Point; p: Point } | { op: 'Z' };

/** Quarter-ellipse arcs as Béziers: kappa. */
const K = 0.5522847498;

function ellipse(cx: number, cy: number, rx: number, ry: number): Segment[] {
  return [
    { op: 'M', p: { x: cx + rx, y: cy } },
    { op: 'C', c1: { x: cx + rx, y: cy + ry * K }, c2: { x: cx + rx * K, y: cy + ry }, p: { x: cx, y: cy + ry } },
    { op: 'C', c1: { x: cx - rx * K, y: cy + ry }, c2: { x: cx - rx, y: cy + ry * K }, p: { x: cx - rx, y: cy } },
    { op: 'C', c1: { x: cx - rx, y: cy - ry * K }, c2: { x: cx - rx * K, y: cy - ry }, p: { x: cx, y: cy - ry } },
    { op: 'C', c1: { x: cx + rx * K, y: cy - ry }, c2: { x: cx + rx, y: cy - ry * K }, p: { x: cx + rx, y: cy } },
    { op: 'Z' },
  ];
}

function polygon(points: [number, number][], closed = true): Segment[] {
  const out: Segment[] = points.map(([x, y], index) => ({ op: index === 0 ? 'M' : 'L', p: { x, y } }) as Segment);
  if (closed) out.push({ op: 'Z' });
  return out;
}

function roundRect(w: number, h: number, r: number): Segment[] {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  const k = radius * (1 - K);
  return [
    { op: 'M', p: { x: radius, y: 0 } },
    { op: 'L', p: { x: w - radius, y: 0 } },
    { op: 'C', c1: { x: w - k, y: 0 }, c2: { x: w, y: k }, p: { x: w, y: radius } },
    { op: 'L', p: { x: w, y: h - radius } },
    { op: 'C', c1: { x: w, y: h - k }, c2: { x: w - k, y: h }, p: { x: w - radius, y: h } },
    { op: 'L', p: { x: radius, y: h } },
    { op: 'C', c1: { x: k, y: h }, c2: { x: 0, y: h - k }, p: { x: 0, y: h - radius } },
    { op: 'L', p: { x: 0, y: radius } },
    { op: 'C', c1: { x: 0, y: k }, c2: { x: k, y: 0 }, p: { x: radius, y: 0 } },
    { op: 'Z' },
  ];
}

/** An arc of an ellipse as Béziers, from the current point (DrawingML arcTo). */
function arc(from: Point, wR: number, hR: number, stAng: number, swAng: number): Segment[] {
  const toRad = Math.PI / 180;
  // DrawingML angles are visual; turn them into the ellipse's parameter.
  const param = (angle: number) => Math.atan2(Math.sin(angle * toRad) * wR, Math.cos(angle * toRad) * hR);
  const start = param(stAng);
  const end = start + swAng * toRad;
  const cx = from.x - wR * Math.cos(start);
  const cy = from.y - hR * Math.sin(start);
  const pieces = Math.max(1, Math.ceil(Math.abs(end - start) / (Math.PI / 2)));
  const step = (end - start) / pieces;
  const out: Segment[] = [];
  for (let index = 0; index < pieces; index++) {
    const a = start + step * index;
    const b = a + step;
    const t = (4 / 3) * Math.tan(step / 4);
    const p1 = { x: cx + wR * Math.cos(a), y: cy + hR * Math.sin(a) };
    const p2 = { x: cx + wR * Math.cos(b), y: cy + hR * Math.sin(b) };
    out.push({
      op: 'C',
      c1: { x: p1.x - t * wR * Math.sin(a), y: p1.y + t * hR * Math.cos(a) },
      c2: { x: p2.x + t * wR * Math.sin(b), y: p2.y - t * hR * Math.cos(b) },
      p: p2,
    });
  }
  return out;
}

/** A shape's outline in its own box (0,0)–(w,h), and whether it is a line. */
function outline(geometry: Geometry, w: number, h: number): { segments: Segment[]; open: boolean }[] {
  if ('custom' in geometry) {
    return geometry.custom.map((custom) => {
      const sx = custom.w > 0 ? w / custom.w : 1;
      const sy = custom.h > 0 ? h / custom.h : 1;
      const segments: Segment[] = [];
      let current: Point = { x: 0, y: 0 };
      let closed = false;
      for (const command of custom.commands) {
        if (command.op === 'M' || command.op === 'L') {
          current = { x: command.x * sx, y: command.y * sy };
          segments.push({ op: command.op, p: current });
        } else if (command.op === 'C') {
          current = { x: command.x * sx, y: command.y * sy };
          segments.push({ op: 'C', c1: { x: command.x1 * sx, y: command.y1 * sy }, c2: { x: command.x2 * sx, y: command.y2 * sy }, p: current });
        } else if (command.op === 'A') {
          const pieces = arc(current, command.wR * sx, command.hR * sy, command.stAng, command.swAng);
          segments.push(...pieces);
          const last = pieces[pieces.length - 1];
          if (last && last.op !== 'Z') current = last.p;
        } else {
          segments.push({ op: 'Z' });
          closed = true;
        }
      }
      return { segments, open: !closed && !custom.fill };
    });
  }

  const a = (name: string, fallback: number) => (geometry.adjust[name] ?? fallback) / 100000;
  const m = Math.min(w, h);
  const closed = (segments: Segment[]) => [{ segments, open: false }];
  switch (geometry.preset) {
    case 'line':
    case 'straightConnector1':
      return [{ segments: polygon([[0, 0], [w, h]], false), open: true }];
    case 'bentConnector2':
      return [{ segments: polygon([[0, 0], [w, 0], [w, h]], false), open: true }];
    case 'bentConnector3': {
      const x = w * a('adj1', 50000);
      return [{ segments: polygon([[0, 0], [x, 0], [x, h], [w, h]], false), open: true }];
    }
    case 'bentConnector4': {
      const x = w * a('adj1', 50000);
      const y = h * a('adj2', 50000);
      return [{ segments: polygon([[0, 0], [x, 0], [x, y], [w, y], [w, h]], false), open: true }];
    }
    case 'curvedConnector3': {
      const x = w * a('adj1', 50000);
      return [
        {
          segments: [
            { op: 'M', p: { x: 0, y: 0 } },
            { op: 'C', c1: { x: x / 2, y: 0 }, c2: { x, y: h / 4 }, p: { x, y: h / 2 } },
            { op: 'C', c1: { x, y: (h * 3) / 4 }, c2: { x: (w + x) / 2, y: h }, p: { x: w, y: h } },
          ],
          open: true,
        },
      ];
    }
    case 'ellipse':
    case 'flowChartConnector':
      return closed(ellipse(w / 2, h / 2, w / 2, h / 2));
    case 'roundRect':
      return closed(roundRect(w, h, m * a('adj', 16667)));
    case 'flowChartAlternateProcess':
      return closed(roundRect(w, h, m * 0.1667));
    case 'flowChartTerminator':
      return closed(roundRect(w, h, h / 2));
    case 'diamond':
    case 'flowChartDecision':
      return closed(polygon([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]));
    case 'triangle': {
      const x = w * a('adj', 50000);
      return closed(polygon([[x, 0], [w, h], [0, h]]));
    }
    case 'rtTriangle':
      return closed(polygon([[0, 0], [w, h], [0, h]]));
    case 'parallelogram':
    case 'flowChartInputOutput': {
      const x = geometry.preset === 'flowChartInputOutput' ? w / 5 : m * a('adj', 25000);
      return closed(polygon([[x, 0], [w, 0], [w - x, h], [0, h]]));
    }
    case 'trapezoid': {
      const x = m * a('adj', 25000);
      return closed(polygon([[x, 0], [w - x, 0], [w, h], [0, h]]));
    }
    case 'hexagon': {
      const x = m * a('adj', 25000);
      return closed(polygon([[x, 0], [w - x, 0], [w, h / 2], [w - x, h], [x, h], [0, h / 2]]));
    }
    case 'octagon': {
      const x = m * a('adj', 29289);
      return closed(polygon([[x, 0], [w - x, 0], [w, x], [w, h - x], [w - x, h], [x, h], [0, h - x], [0, x]]));
    }
    case 'pentagon':
      return closed(polygon([[w / 2, 0], [w, h * 0.38], [w * 0.81, h], [w * 0.19, h], [0, h * 0.38]]));
    case 'homePlate': {
      const x = w - m * a('adj', 50000);
      return closed(polygon([[0, 0], [x, 0], [w, h / 2], [x, h], [0, h]]));
    }
    case 'chevron': {
      const x = m * a('adj', 50000);
      return closed(polygon([[0, 0], [w - x, 0], [w, h / 2], [w - x, h], [0, h], [x, h / 2]]));
    }
    case 'rightArrow': {
      const shaft = h * a('adj1', 50000);
      const head = m * a('adj2', 50000);
      const top = (h - shaft) / 2;
      return closed(polygon([[0, top], [w - head, top], [w - head, 0], [w, h / 2], [w - head, h], [w - head, h - top], [0, h - top]]));
    }
    case 'leftArrow': {
      const shaft = h * a('adj1', 50000);
      const head = m * a('adj2', 50000);
      const top = (h - shaft) / 2;
      return closed(polygon([[w, top], [head, top], [head, 0], [0, h / 2], [head, h], [head, h - top], [w, h - top]]));
    }
    case 'downArrow': {
      const shaft = w * a('adj1', 50000);
      const head = m * a('adj2', 50000);
      const left = (w - shaft) / 2;
      return closed(polygon([[left, 0], [w - left, 0], [w - left, h - head], [w, h - head], [w / 2, h], [0, h - head], [left, h - head]]));
    }
    case 'upArrow': {
      const shaft = w * a('adj1', 50000);
      const head = m * a('adj2', 50000);
      const left = (w - shaft) / 2;
      return closed(polygon([[left, h], [w - left, h], [w - left, head], [w, head], [w / 2, 0], [0, head], [left, head]]));
    }
    case 'plus': {
      const x = m * a('adj', 25000);
      return closed(polygon([[x, 0], [w - x, 0], [w - x, x], [w, x], [w, h - x], [w - x, h - x], [w - x, h], [x, h], [x, h - x], [0, h - x], [0, x], [x, x]]));
    }
    case 'snip1Rect': {
      const x = m * a('adj', 16667);
      return closed(polygon([[0, 0], [w - x, 0], [w, x], [w, h], [0, h]]));
    }
    case 'round2SameRect': {
      const r = m * a('adj1', 16667);
      const k = r * (1 - K);
      return closed([
        { op: 'M', p: { x: r, y: 0 } },
        { op: 'L', p: { x: w - r, y: 0 } },
        { op: 'C', c1: { x: w - k, y: 0 }, c2: { x: w, y: k }, p: { x: w, y: r } },
        { op: 'L', p: { x: w, y: h } },
        { op: 'L', p: { x: 0, y: h } },
        { op: 'L', p: { x: 0, y: r } },
        { op: 'C', c1: { x: 0, y: k }, c2: { x: k, y: 0 }, p: { x: r, y: 0 } },
        { op: 'Z' },
      ]);
    }
    default:
      return closed(polygon([[0, 0], [w, 0], [w, h], [0, h]]));
  }
}

/**
 * Where text goes inside a preset shape (its text rectangle), as insets from
 * the shape's box — the presets' own definitions. A rounded rectangle keeps
 * its text clear of the corners, a diamond to its middle.
 */
function textRect(geometry: Geometry, w: number, h: number): { l: number; t: number; r: number; b: number } {
  const none = { l: 0, t: 0, r: 0, b: 0 };
  if ('custom' in geometry) return none;
  const a = (name: string, fallback: number) => (geometry.adjust[name] ?? fallback) / 100000;
  const m = Math.min(w, h);
  switch (geometry.preset) {
    case 'roundRect': {
      const inset = m * a('adj', 16667) * 0.29289;
      return { l: inset, t: inset, r: inset, b: inset };
    }
    case 'flowChartAlternateProcess': {
      const inset = m * 0.16667 * 0.29289;
      return { l: inset, t: inset, r: inset, b: inset };
    }
    case 'ellipse':
    case 'flowChartConnector':
      return { l: w * 0.14645, t: h * 0.14645, r: w * 0.14645, b: h * 0.14645 };
    case 'diamond':
    case 'flowChartDecision':
      return { l: w / 4, t: h / 4, r: w / 4, b: h / 4 };
    case 'flowChartTerminator':
      return { l: (w * 1018) / 21600, t: (h * 3163) / 21600, r: (w * 1018) / 21600, b: (h * 3163) / 21600 };
    case 'triangle':
      return { l: w / 4, t: h / 2, r: w / 4, b: 0 };
    case 'parallelogram':
    case 'flowChartInputOutput': {
      const x = geometry.preset === 'flowChartInputOutput' ? w / 5 : m * a('adj', 25000);
      return { l: x / 2, t: 0, r: x / 2, b: 0 };
    }
    case 'hexagon': {
      const x = m * a('adj', 25000);
      return { l: x / 2, t: 0, r: x / 2, b: 0 };
    }
    case 'homePlate':
      return { l: 0, t: 0, r: (m * a('adj', 50000)) / 2, b: 0 };
    case 'chevron': {
      const x = m * a('adj', 50000);
      return { l: x, t: 0, r: x, b: 0 };
    }
    default:
      return none;
  }
}

/** Places a point of a shape's own box on the slide: flip, rotate, move. */
function place(box: Box): (point: Point) => Point {
  const cx = box.w / 2;
  const cy = box.h / 2;
  const angle = (box.rot * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return ({ x, y }) => {
    const fx = box.flipH ? box.w - x : x;
    const fy = box.flipV ? box.h - y : y;
    const dx = fx - cx;
    const dy = fy - cy;
    return { x: box.x + cx + dx * cos - dy * sin, y: box.y + cy + dx * sin + dy * cos };
  };
}

const f = (value: number) => value.toFixed(3);

/** A font's ascent and descent in a line at 100% spacing. */
function split(face: Face, size: number): [number, number] {
  const total = face.ascent + face.descent;
  const line = size * LINE_FACTOR;
  return [(line * face.ascent) / total, (line * face.descent) / total];
}

/**
 * A font size under autofit's shrink: PowerPoint shows whole points —
 * 18pt at 92.5% is drawn at 17pt, 28pt at 90% at 25pt.
 */
function scaled(size: number, scale: number): number {
  return scale === 1 ? size : Math.max(1, Math.round(size * scale));
}

function toSvg(segments: Segment[], map: (point: Point) => Point): string {
  return segments
    .map((segment) => {
      if (segment.op === 'Z') return 'Z';
      const p = map(segment.p);
      if (segment.op === 'C') {
        const c1 = map(segment.c1);
        const c2 = map(segment.c2);
        return `C${f(c1.x)},${f(c1.y)} ${f(c2.x)},${f(c2.y)} ${f(p.x)},${f(p.y)}`;
      }
      return `${segment.op}${f(p.x)},${f(p.y)}`;
    })
    .join(' ');
}

/* ==========================================================================
   Page builder
   ========================================================================== */

class Canvas {
  readonly ops: Layered[] = [];

  push(op: DrawOp) {
    this.ops.push({ layer: 1, order: 0, op });
  }

  fillPath(d: string, fill: Fill) {
    if (!fill || fill.kind !== 'solid' || fill.paint.alpha <= 0) return;
    this.push({ kind: 'path', d, fill: fill.paint.color, fillOpacity: fill.paint.alpha < 1 ? fill.paint.alpha : undefined });
  }

  strokePath(d: string, stroke: Stroke) {
    if (stroke.paint.alpha <= 0 || stroke.width <= 0) return;
    this.push({
      kind: 'path',
      d,
      stroke: stroke.paint.color,
      strokeWidth: stroke.width,
      strokeOpacity: stroke.paint.alpha < 1 ? stroke.paint.alpha : undefined,
      dash: stroke.dash?.map((length) => length * Math.max(1, stroke.width)),
      cap: stroke.cap === 'round' ? 1 : stroke.cap === 'square' ? 2 : 0,
    });
  }

  image(image: string, x: number, y: number, w: number, h: number, crop?: { left: number; top: number; right: number; bottom: number }, alpha = 1) {
    this.push({ kind: 'image', x, y, w, h, image, crop, opacity: alpha < 1 ? alpha : undefined });
  }
}

/** Arrowheads at the ends of an open outline. */
function arrowHeads(canvas: Canvas, points: Point[], stroke: Stroke) {
  const draw = (tip: Point, from: Point, end: NonNullable<Stroke['head']>) => {
    const scale = (value: string) => (value === 'sm' ? 2 : value === 'lg' ? 5 : 3);
    const width = Math.max(stroke.width, 0.75);
    const length = scale(end.len) * width;
    const half = (scale(end.w) * width) / 2;
    const dx = tip.x - from.x;
    const dy = tip.y - from.y;
    const d = Math.hypot(dx, dy);
    if (d < 0.001) return;
    const ux = dx / d;
    const uy = dy / d;
    const base = { x: tip.x - ux * length, y: tip.y - uy * length };
    const left = { x: base.x - uy * half, y: base.y + ux * half };
    const right = { x: base.x + uy * half, y: base.y - ux * half };
    if (end.type === 'arrow') {
      canvas.strokePath(`M${f(left.x)},${f(left.y)} L${f(tip.x)},${f(tip.y)} L${f(right.x)},${f(right.y)}`, stroke);
      return;
    }
    if (end.type === 'oval') {
      const r = half;
      const c = { x: tip.x - ux * r, y: tip.y - uy * r };
      canvas.fillPath(toSvg(ellipse(c.x, c.y, r, r), (p) => p), { kind: 'solid', paint: stroke.paint });
      return;
    }
    if (end.type === 'diamond') {
      const mid = { x: tip.x - ux * length, y: tip.y - uy * length };
      const center = { x: tip.x - (ux * length) / 2, y: tip.y - (uy * length) / 2 };
      const l2 = { x: center.x - uy * half, y: center.y + ux * half };
      const r2 = { x: center.x + uy * half, y: center.y - ux * half };
      canvas.fillPath(`M${f(tip.x)},${f(tip.y)} L${f(l2.x)},${f(l2.y)} L${f(mid.x)},${f(mid.y)} L${f(r2.x)},${f(r2.y)} Z`, { kind: 'solid', paint: stroke.paint });
      return;
    }
    // triangle, stealth
    canvas.fillPath(`M${f(tip.x)},${f(tip.y)} L${f(left.x)},${f(left.y)} L${f(right.x)},${f(right.y)} Z`, { kind: 'solid', paint: stroke.paint });
  };
  if (points.length < 2) return;
  if (stroke.head) draw(points[0], points[1], stroke.head);
  if (stroke.tail) draw(points[points.length - 1], points[points.length - 2], stroke.tail);
}

/* ==========================================================================
   Text
   ========================================================================== */

interface Word {
  text: string;
  run: Run;
  face: Face;
  size: number;
  /** Kerned, at the size the text is drawn: what PowerPoint wraps lines by. */
  width: number;
  space: boolean;
  /** Continues the word before it (a word split across runs): no break between. */
  glue?: boolean;
  /** A no-break space: stretches like a space, measures like a letter. */
  noBreak?: boolean;
  kerning?: boolean;
  tab?: boolean;
  br?: boolean;
}

interface LineOut {
  words: { word: Word; x: number }[];
  width: number;
  ascent: number;
  descent: number;
  /** Largest font size on the line: what percentage spacing scales. */
  size: number;
  last: boolean;
}

const ROMAN: [number, string][] = [
  [1000, 'm'],
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i'],
];

function numberLabel(scheme: string, value: number): string {
  const roman = (n: number) => {
    let out = '';
    for (const [amount, letters] of ROMAN) {
      while (n >= amount) {
        out += letters;
        n -= amount;
      }
    }
    return out;
  };
  const alpha = (n: number) => {
    let out = '';
    while (n > 0) {
      out = String.fromCharCode(97 + ((n - 1) % 26)) + out;
      n = Math.floor((n - 1) / 26);
    }
    return out;
  };
  let body = String(value);
  if (scheme.startsWith('alphaLc')) body = alpha(value);
  else if (scheme.startsWith('alphaUc')) body = alpha(value).toUpperCase();
  else if (scheme.startsWith('romanLc')) body = roman(value);
  else if (scheme.startsWith('romanUc')) body = roman(value).toUpperCase();
  if (scheme.endsWith('ParenBoth')) return `(${body})`;
  if (scheme.endsWith('ParenR')) return `${body})`;
  if (scheme.endsWith('Period')) return `${body}.`;
  if (scheme.endsWith('Plain')) return body;
  return `${body}.`;
}

export class SlideTypesetter {
  private readonly faceFor: FaceFor;
  private readonly metafiles: (image: string) => Emf | null;

  constructor(faceFor: FaceFor, metafiles: (image: string) => Emf | null = () => null) {
    this.faceFor = faceFor;
    this.metafiles = metafiles;
  }

  private face(run: Run) {
    return this.faceFor(run.font, run.bold, run.italic);
  }

  /** A line's height and how far below its top the baseline sits. */
  private lineBox(spacing: TextParagraph['lineSpacing'], line: LineOut, reduction: number): { height: number; baseline: number } {
    if ('pts' in spacing) return { height: spacing.pts, baseline: spacing.pts * LOOSE_BASELINE };
    const natural = line.ascent + line.descent;
    const pct = Math.max(0.1, spacing.pct - reduction);
    const height = natural * pct;
    return { height, baseline: pct <= 1 ? line.ascent - (1 - pct) * natural : height * LOOSE_BASELINE };
  }

  private words(paragraph: TextParagraph, scale: number): Word[] {
    const out: Word[] = [];
    for (const run of paragraph.runs) {
      const face = this.face(run);
      const size = scaled(run.size, scale);
      if (run.br) {
        out.push({ text: '', run, face, size, width: 0, space: false, br: true });
        continue;
      }
      if (run.tab) {
        out.push({ text: '', run, face, size, width: 0, space: false, tab: true });
        continue;
      }
      // A no-break hyphen is drawn as a hyphen: the fonts here lack U+2011.
      const text = mapSymbols(run.text, run.font).replace(/\u2011/g, '-');
      // PowerPoint kerns text from the run's threshold size up (kern="1200").
      const kerning = run.kern > 0 && size >= run.kern;
      // Words split into spaces and words, and a word again after a hyphen,
      // where PowerPoint may also break the line.
      // A no-break space stretches like a space in a justified line, but it
      // belongs to the word before it: the line may not break there, and it
      // does not hang past the line's end. Measured: PowerPoint moved
      // "sektor." plus a trailing no-break space to the next line, where
      // "sektor." alone fitted.
      const parts = (text.match(/[ \u00a0]+|[^ \u00a0]+/g) ?? []).flatMap((part) => (/^[ \u00a0]/.test(part) ? [part] : part.split(/(?<=[-‐–—](?=[^ \u00a0]))/)));
      parts.forEach((part, index) => {
        const space = /^[ \u00a0]/.test(part);
        let width = face.width(part, size, kerning);
        // Kerning reaches across spaces too (Gill Sans pairs " A", "T ").
        if (space && kerning) {
          const before = parts[index - 1];
          const after = parts[index + 1];
          if (before) width += face.kern(before[before.length - 1], ' ') * size;
          if (after) width += face.kern(' ', after[0]) * size;
        }
        const previous = out[out.length - 1];
        const afterHyphen = index > 0 && /[-‐–—]$/.test(parts[index - 1]);
        const noBreak = space && !part.includes(' ');
        const afterNoBreak = previous !== undefined && previous.noBreak === true;
        const glue =
          (noBreak && previous !== undefined && !previous.space) ||
          (!space && (afterNoBreak || (!afterHyphen && previous !== undefined && !previous.space && !previous.br && !previous.tab && previous.text !== '')));
        out.push({ text: part, run, face, size, width, space, noBreak, glue, kerning });
      });
    }
    return out;
  }

  /** Lines of one paragraph, broken to `width` (Infinity: no wrapping). */
  private breakLines(paragraph: TextParagraph, words: Word[], width: number, firstStart: number, restStart: number): LineOut[] {
    const lines: LineOut[] = [];
    let current: LineOut | null = null;
    let x = 0;
    /** Where the word being built on the current line starts. */
    let wordStart = 0;
    const open = (first: boolean) => {
      current = { words: [], width: 0, ascent: 0, descent: 0, size: 0, last: false };
      lines.push(current);
      x = first ? firstStart : restStart;
      wordStart = 0;
    };
    open(true);
    const measure = (line: LineOut, word: Word) => {
      const [ascent, descent] = split(word.face, word.size);
      line.ascent = Math.max(line.ascent, ascent);
      line.descent = Math.max(line.descent, descent);
      line.size = Math.max(line.size, word.size);
    };

    for (let index = 0; index < words.length; index++) {
      const word = words[index];
      const line = current!;
      if (word.br) {
        measure(line, word);
        open(false);
        continue;
      }
      if (word.tab) {
        const next = (Math.floor(x / paragraph.defaultTab + 1e-6) + 1) * paragraph.defaultTab;
        line.words.push({ word: { ...word, width: next - x }, x });
        x = next;
        continue;
      }
      if ((!word.space || word.noBreak) && x + word.width > width + WRAP_TOLERANCE && line.words.some((entry) => !entry.word.space)) {
        // Wrap: trailing spaces stay on the line they end, and a word split
        // across runs goes over whole.
        const carried = word.glue && wordStart > 0 && line.words.slice(0, wordStart).some((entry) => !entry.word.space) ? line.words.splice(wordStart) : [];
        open(false);
        for (const entry of carried) {
          current!.words.push({ word: entry.word, x });
          measure(current!, entry.word);
          x += entry.word.width;
        }
      }
      const target = current!;
      if (word.space && target.words.length === 0 && lines.length > 1) continue;
      if (!word.space && x + word.width > width + WRAP_TOLERANCE && target.words.length === 0 && Number.isFinite(width)) {
        // A word wider than the whole line breaks by character.
        let piece = '';
        for (const character of word.text) {
          if (x + word.face.width(piece + character, word.size) > width && piece) break;
          piece += character;
        }
        const rest = word.text.slice(piece.length);
        const head = { ...word, text: piece, width: word.face.width(piece, word.size, word.kerning) };
        target.words.push({ word: head, x });
        measure(target, head);
        x += head.width;
        if (rest) {
          const width = word.face.width(rest, word.size, word.kerning);
          words.splice(index + 1, 0, { ...word, text: rest, width });
        }
        continue;
      }
      if (!word.space && !word.glue) wordStart = target.words.length;
      target.words.push({ word, x });
      measure(target, word);
      x += word.width;
    }

    for (const line of lines) {
      let end = 0;
      for (const { word, x: at } of line.words) if (!word.space) end = Math.max(end, at + word.width);
      line.width = end;
    }
    if (lines.length > 0) lines[lines.length - 1].last = true;
    return lines;
  }

  /**
   * Sets a text body into a box. Returns the height it takes (for tables,
   * which grow to fit their text); draws only when `canvas` is given.
   */
  text(body: TextBody, box: { x: number; y: number; w: number; h: number }, canvas?: Canvas): number {
    const scale = body.fontScale;
    const width = body.wrap ? box.w - body.insets.l - body.insets.r : Infinity;

    interface Set {
      paragraph: TextParagraph;
      lines: LineOut[];
      before: number;
      after: number;
      bullet?: { text: string; face: Face; size: number; paint: Paint; x: number };
    }
    const sets: Set[] = [];

    body.paragraphs.forEach((paragraph, index) => {
      const words = this.words(paragraph, scale);
      const firstRun = paragraph.runs.find((run) => !run.br && !run.tab && run.text) ?? paragraph.end;
      const firstSize = scaled(firstRun.size, scale);
      let bulletSet: Set['bullet'];
      let firstStart = paragraph.marL + paragraph.indent;
      if (paragraph.bullet.kind !== 'none') {
        const bullet = paragraph.bullet as Exclude<Bullet, { kind: 'none' }>;
        const font = bullet.font ?? firstRun.font;
        const size = bullet.sizePts !== undefined ? bullet.sizePts * scale : firstSize * (bullet.sizePct ?? 1);
        const text = bullet.kind === 'char' ? mapSymbols(bullet.char, font) : numberLabel(bullet.scheme, bullet.startAt);
        const face = this.faceFor(bullet.kind === 'char' ? font : firstRun.font, bullet.kind === 'number' ? firstRun.bold : false, false);
        const x = paragraph.marL + paragraph.indent;
        bulletSet = { text, face, size, paint: bullet.paint ?? firstRun.paint, x };
        // The text starts at the left margin, unless the bullet reaches past
        // it; then at the next tab stop after the bullet.
        const bulletEnd = x + face.width(text, size);
        firstStart = bulletEnd <= paragraph.marL + 0.01 ? paragraph.marL : Math.ceil(bulletEnd / paragraph.defaultTab) * paragraph.defaultTab;
      }
      const lines = this.breakLines(paragraph, words, width, firstStart, paragraph.marL);
      // An empty paragraph (or line) is as tall as its end mark.
      const endFace = this.face(paragraph.end);
      for (const line of lines) {
        if (line.ascent === 0 && line.descent === 0) {
          const size = scaled(paragraph.end.size, scale);
          [line.ascent, line.descent] = split(endFace, size);
          line.size = size;
        }
      }
      const size = lines[0]?.size ?? firstSize;
      const amount = (spacing: TextParagraph['spaceBefore']) => ('pts' in spacing ? spacing.pts : spacing.pct * size * LINE_FACTOR);
      sets.push({
        paragraph,
        lines,
        before: index === 0 ? 0 : amount(paragraph.spaceBefore),
        after: amount(paragraph.spaceAfter),
        bullet: bulletSet,
      });
    });

    // Heights: space before each paragraph (not the first), its lines, and
    // the space after between paragraphs (not after the last).
    let total = 0;
    sets.forEach((set, index) => {
      total += set.before;
      for (const line of set.lines) total += this.lineBox(set.paragraph.lineSpacing, line, body.lineReduction).height;
      if (index < sets.length - 1) total += set.after;
    });
    const contentHeight = total + body.insets.t + body.insets.b;
    if (!canvas) return contentHeight;

    const available = box.h - body.insets.t - body.insets.b;
    let y = box.y + body.insets.t;
    if (body.anchor === 'ctr') y += (available - total) / 2;
    else if (body.anchor === 'b') y += available - total;
    const left = box.x + body.insets.l;
    const right = box.x + box.w - body.insets.r;

    sets.forEach((set, index) => {
      y += set.before;
      set.lines.forEach((line, lineIndex) => {
        const { height, baseline } = this.lineBox(set.paragraph.lineSpacing, line, body.lineReduction);
        const drawBaseline = y + baseline;
        let shift = 0;
        let extra = 0;
        const lineRight = Number.isFinite(width) ? right : left + line.width;
        const room = lineRight - left - line.width;
        if (set.paragraph.align === 'ctr') shift = Number.isFinite(width) ? room / 2 : (box.w - body.insets.l - body.insets.r - line.width) / 2;
        else if (set.paragraph.align === 'r') shift = Number.isFinite(width) ? room : box.w - body.insets.l - body.insets.r - line.width;
        else if ((set.paragraph.align === 'just' && !line.last) || set.paragraph.align === 'dist') {
          const spaces = line.words.filter(({ word }, at) => word.space && at > 0 && at < line.words.length - 1).length;
          if (spaces > 0) extra = room / spaces;
        }

        if (lineIndex === 0 && set.bullet) {
          const bullet = set.bullet;
          canvas.push({ kind: 'text', x: left + bullet.x + shift, y: drawBaseline, text: bullet.text, face: bullet.face, size: bullet.size, color: bullet.paint.color });
        }

        let offset = 0;
        for (const [at, { word, x }] of line.words.entries()) {
          if (word.space) {
            if (at > 0 && at < line.words.length - 1) offset += extra;
            continue;
          }
          if (!word.text) continue;
          const wx = left + x + shift + offset;
          const rise = (word.run.baseline / 100) * word.size;
          if (word.run.paint.alpha > 0) {
            canvas.push({
              kind: 'text',
              x: wx,
              y: drawBaseline - rise,
              text: word.text,
              face: word.face,
              size: word.size,
              color: word.run.paint.color,
              opacity: word.run.paint.alpha < 1 ? word.run.paint.alpha : undefined,
              width: word.kerning ? word.width : undefined,
            });
          }
          if (word.run.underline || word.run.strike) {
            // Underline runs on through the spaces that follow, like PowerPoint.
            let endX = wx + word.width;
            for (let next = at + 1; next < line.words.length; next++) {
              const following = line.words[next];
              if (following.word.run !== word.run || !following.word.space || next === line.words.length - 1) break;
              endX += following.word.width + extra;
            }
            const thickness = Math.max(0.5, word.face.underlineThickness * word.size);
            if (word.run.underline) {
              const uy = drawBaseline + word.face.underlinePosition * word.size;
              canvas.push({ kind: 'line', x1: wx, y1: uy, x2: endX, y2: uy, color: word.run.paint.color, width: thickness });
            }
            if (word.run.strike) {
              const sy = drawBaseline - word.size * 0.3;
              canvas.push({ kind: 'line', x1: wx, y1: sy, x2: endX, y2: sy, color: word.run.paint.color, width: thickness });
            }
          }
        }
        y += height;
      });
      if (index < sets.length - 1) y += set.after;
    });
    return contentHeight;
  }

  /* ----------------------------------------------------------- elements */

  private shape(element: ShapeElement, canvas: Canvas) {
    const { box } = element;
    const map = place(box);
    for (const { segments, open } of outline(element.geometry, box.w, box.h)) {
      const d = toSvg(segments, map);
      if (!open && element.fill) {
        if (element.fill.kind === 'image') canvas.image(element.fill.image, box.x, box.y, box.w, box.h, element.fill.crop, element.fill.alpha);
        else canvas.fillPath(d, element.fill);
      }
      if (element.stroke) {
        canvas.strokePath(d, element.stroke);
        if (open && (element.stroke.head || element.stroke.tail)) {
          const points = segments.filter((segment) => segment.op !== 'Z').map((segment) => map((segment as { p: Point }).p));
          arrowHeads(canvas, points, element.stroke);
        }
      }
    }
    if (element.text && element.text.paragraphs.some((paragraph) => paragraph.runs.some((run) => run.text.trim() || run.br))) {
      // Text boxes turned a quarter keep their text upright in the turned box.
      const turned = Math.abs(((box.rot % 180) + 180) % 180 - 90) < 1;
      const outer = turned ? { x: box.x + (box.w - box.h) / 2, y: box.y + (box.h - box.w) / 2, w: box.h, h: box.w } : box;
      const inset = textRect(element.geometry, outer.w, outer.h);
      this.text(element.text, { x: outer.x + inset.l, y: outer.y + inset.t, w: outer.w - inset.l - inset.r, h: outer.h - inset.t - inset.b }, canvas);
    }
  }

  private table(element: TableElement, canvas: Canvas) {
    const columns = element.columns;
    const starts = [element.x];
    for (const width of columns) starts.push(starts[starts.length - 1] + width);

    // Rows grow to fit their text.
    const heights = element.rows.map((row) => row.height);
    element.rows.forEach((row, rowIndex) => {
      let column = 0;
      for (const cell of row.cells) {
        const span = Math.max(1, cell.gridSpan);
        if (!cell.merged && cell.rowSpan <= 1) {
          const width = starts[Math.min(starts.length - 1, column + span)] - starts[column];
          heights[rowIndex] = Math.max(heights[rowIndex], this.text(cell.text, { x: 0, y: 0, w: width, h: 0 }));
        }
        column += span;
      }
    });
    // A cell spanning rows that needs more room than they give grows the
    // last of them.
    element.rows.forEach((row, rowIndex) => {
      let column = 0;
      for (const cell of row.cells) {
        const span = Math.max(1, cell.gridSpan);
        if (!cell.merged && cell.rowSpan > 1) {
          const width = starts[Math.min(starts.length - 1, column + span)] - starts[column];
          const last = Math.min(heights.length - 1, rowIndex + cell.rowSpan - 1);
          const available = heights.slice(rowIndex, last + 1).reduce((sum, height) => sum + height, 0);
          const needed = this.text(cell.text, { x: 0, y: 0, w: width, h: 0 });
          if (needed > available) heights[last] += needed - available;
        }
        column += span;
      }
    });
    const tops = [element.y];
    for (const height of heights) tops.push(tops[tops.length - 1] + height);

    const borders: { stroke: Stroke; x1: number; y1: number; x2: number; y2: number }[] = [];
    element.rows.forEach((row, rowIndex) => {
      let column = 0;
      for (const cell of row.cells) {
        const span = Math.max(1, cell.gridSpan);
        if (!cell.merged) {
          const x0 = starts[column];
          const x1 = starts[Math.min(starts.length - 1, column + span)];
          const y0 = tops[rowIndex];
          const y1 = tops[Math.min(tops.length - 1, rowIndex + Math.max(1, cell.rowSpan))];
          if (cell.fill?.kind === 'solid') canvas.fillPath(`M${f(x0)},${f(y0)} L${f(x1)},${f(y0)} L${f(x1)},${f(y1)} L${f(x0)},${f(y1)} Z`, cell.fill);
          this.text(cell.text, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, canvas);
          if (cell.borders.t) borders.push({ stroke: cell.borders.t, x1: x0, y1: y0, x2: x1, y2: y0 });
          if (cell.borders.b) borders.push({ stroke: cell.borders.b, x1: x0, y1: y1, x2: x1, y2: y1 });
          if (cell.borders.l) borders.push({ stroke: cell.borders.l, x1: x0, y1: y0, x2: x0, y2: y1 });
          if (cell.borders.r) borders.push({ stroke: cell.borders.r, x1: x1, y1: y0, x2: x1, y2: y1 });
        }
        column += span;
      }
    });
    // Borders over every fill, so a neighbour's fill cannot hide them.
    for (const border of borders) canvas.strokePath(`M${f(border.x1)},${f(border.y1)} L${f(border.x2)},${f(border.y2)}`, border.stroke);
  }

  slide(slide: Slide, width: number, height: number): LaidOutPage {
    const canvas = new Canvas();
    const background = slide.background;
    if (background?.kind === 'solid') canvas.fillPath(`M0,0 L${f(width)},0 L${f(width)},${f(height)} L0,${f(height)} Z`, background);
    else if (background?.kind === 'image') canvas.image(background.image, 0, 0, width, height, background.crop, background.alpha);

    for (const element of slide.elements) {
      if (element.kind === 'shape') this.shape(element, canvas);
      else if (element.kind === 'picture') {
        const { box } = element;
        // A metafile (a table pasted from Excel, say) is replayed as vectors.
        const metafile = this.metafiles(element.image);
        if (metafile) for (const op of metafile.draw(box, this.faceFor)) canvas.push(op);
        else canvas.image(element.image, box.x, box.y, box.w, box.h, element.crop, element.alpha);
        if (element.stroke) canvas.strokePath(toSvg(outline(element.geometry, box.w, box.h)[0].segments, place(box)), element.stroke);
      } else this.table(element, canvas);
    }
    return { width, height, ops: canvas.ops };
  }
}

/** The deck's pictures that are EMF metafiles, parsed once. */
export function metafilesOf(deck: Deck): (image: string) => Emf | null {
  const cache = new Map<string, Emf | null>();
  return (image) => {
    if (!cache.has(image)) {
      const data = deck.images.get(image);
      cache.set(image, data && data.type === 'other' ? Emf.parse(data.data) : null);
    }
    return cache.get(image) ?? null;
  };
}

export function layoutDeck(deck: Deck, faceFor: FaceFor): LaidOutPage[] {
  const typesetter = new SlideTypesetter(faceFor, metafilesOf(deck));
  return deck.slides.map((slide) => typesetter.slide(slide, deck.width, deck.height));
}
