import 'server-only';

/**
 * Minimal DOM globals that pdf.js needs to *evaluate* under Node.
 *
 * `pdf.mjs` runs `const SCALE_MATRIX = new DOMMatrix()` at module scope, so the
 * class must exist before the module is imported or the import throws
 * `ReferenceError: DOMMatrix is not defined`.
 *
 * pdf.js's own answer is to borrow the class from `@napi-rs/canvas`:
 *
 *     try { canvas = require("@napi-rs/canvas"); } catch (ex) { warn(...) }
 *     if (!globalThis.DOMMatrix) globalThis.DOMMatrix = canvas.DOMMatrix;
 *
 * That works locally but not on Vercel: the package is an *optional* dependency
 * required inside a try/catch, which Next's dependency tracing does not follow
 * into the deployed function bundle. The result was a failure that only ever
 * appeared in production.
 *
 * Pulling in a ~15 MB native canvas binary would fix it, but the server side of
 * NusaPDF never rasterises anything — rendering happens in the browser. All the
 * server does is extract text. So the classes below exist purely to let the
 * module load, and they are defined *before* pdf.js is imported, which also
 * makes pdf.js skip its own `require` entirely.
 *
 * The matrix maths is real rather than stubbed: if a future pdf.js version does
 * use DOMMatrix on a text path, correct results are better than silently wrong
 * ones.
 */

interface Matrix2D {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

/** Standard 2D affine matrix, matching the DOMMatrix constructor contract. */
class NodeDOMMatrix implements Matrix2D {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;

  constructor(init?: number[] | string) {
    if (Array.isArray(init) && init.length >= 6) {
      [this.a, this.b, this.c, this.d, this.e, this.f] = init;
    }
    // A string initialiser is a CSS transform; pdf.js never passes one on the
    // paths reachable from text extraction, so it is treated as identity.
  }

  get isIdentity(): boolean {
    return (
      this.a === 1 && this.b === 0 && this.c === 0 &&
      this.d === 1 && this.e === 0 && this.f === 0
    );
  }

  private static from(m: Matrix2D): NodeDOMMatrix {
    const out = new NodeDOMMatrix();
    out.a = m.a; out.b = m.b; out.c = m.c; out.d = m.d; out.e = m.e; out.f = m.f;
    return out;
  }

  /** this × other, in the same order the DOM specifies. */
  multiply(other: Matrix2D): NodeDOMMatrix {
    return NodeDOMMatrix.from({
      a: this.a * other.a + this.c * other.b,
      b: this.b * other.a + this.d * other.b,
      c: this.a * other.c + this.c * other.d,
      d: this.b * other.c + this.d * other.d,
      e: this.a * other.e + this.c * other.f + this.e,
      f: this.b * other.e + this.d * other.f + this.f,
    });
  }

  multiplySelf(other: Matrix2D): this {
    Object.assign(this, this.multiply(other));
    return this;
  }

  preMultiplySelf(other: Matrix2D): this {
    Object.assign(this, NodeDOMMatrix.from(other).multiply(this));
    return this;
  }

  translate(tx = 0, ty = 0): NodeDOMMatrix {
    return this.multiply({ a: 1, b: 0, c: 0, d: 1, e: tx, f: ty });
  }

  scale(sx = 1, sy = sx): NodeDOMMatrix {
    return this.multiply({ a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 });
  }

  invertSelf(): this {
    const determinant = this.a * this.d - this.b * this.c;

    if (determinant === 0) {
      // The DOM marks a non-invertible matrix by filling it with NaN rather
      // than throwing.
      Object.assign(this, { a: NaN, b: NaN, c: NaN, d: NaN, e: NaN, f: NaN });
      return this;
    }

    const { a, b, c, d, e, f } = this;
    Object.assign(this, {
      a: d / determinant,
      b: -b / determinant,
      c: -c / determinant,
      d: a / determinant,
      e: (c * f - d * e) / determinant,
      f: (b * e - a * f) / determinant,
    });
    return this;
  }

  transformPoint(point: { x?: number; y?: number } = {}) {
    const x = point.x ?? 0;
    const y = point.y ?? 0;
    return { x: this.a * x + this.c * y + this.e, y: this.b * x + this.d * y + this.f };
  }

  toString(): string {
    return `matrix(${this.a}, ${this.b}, ${this.c}, ${this.d}, ${this.e}, ${this.f})`;
  }
}

/**
 * Path2D is referenced alongside DOMMatrix in the same module. Nothing on the
 * text-extraction path draws, so recording the calls is enough to let the
 * module evaluate.
 */
class NodePath2D {
  addPath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  bezierCurveTo(): void {}
  quadraticCurveTo(): void {}
  closePath(): void {}
  rect(): void {}
}

/** Idempotent: safe to call from every entry point that touches pdf.js. */
export function installPdfDomGlobals(): void {
  const target = globalThis as Record<string, unknown>;
  target.DOMMatrix ??= NodeDOMMatrix;
  target.Path2D ??= NodePath2D;
}
