/**
 * Polyfills the Uint8Array hex/base64 methods that pdf.js v6 relies on.
 *
 * pdf.js computes a document fingerprint with `Uint8Array.prototype.toHex()`
 * while opening *any* PDF, so on a browser without it every file fails to load
 * and surfaces as "this PDF is invalid" — the user is told their document is
 * broken when the document is fine.
 *
 * These methods shipped in Chrome ~140. Reported from Chrome 133 on Android 9,
 * which is a completely ordinary browser for that hardware; treating it as too
 * old would write off a large share of Indonesian Android users.
 *
 * Written as a self-installing script with no imports or exports so the exact
 * same file can be used two ways, from one source of truth:
 *
 *   1. imported for its side effect on the main thread, before pdf.js loads
 *   2. prepended to the copied pdf.worker.min.mjs by scripts/copy-pdf-worker.mjs
 *
 * The second matters most: the failing call is inside the worker, where a
 * main-thread polyfill has no effect at all.
 */
(() => {
  const proto = Uint8Array.prototype;

  const define = (target, name, value) => {
    if (typeof target[name] === 'function') return;
    Object.defineProperty(target, name, {
      value,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  };

  /* ------------------------------------------------------------------ hex */

  define(proto, 'toHex', function toHex() {
    let out = '';
    for (let i = 0; i < this.length; i++) {
      out += this[i].toString(16).padStart(2, '0');
    }
    return out;
  });

  define(Uint8Array, 'fromHex', function fromHex(text) {
    if (typeof text !== 'string') throw new TypeError('fromHex membutuhkan string');
    if (text.length % 2 !== 0) throw new SyntaxError('Panjang hex harus genap');

    const out = new Uint8Array(text.length / 2);
    for (let i = 0; i < out.length; i++) {
      const byte = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
      if (Number.isNaN(byte)) throw new SyntaxError('Karakter hex tidak valid');
      out[i] = byte;
    }
    return out;
  });

  /* --------------------------------------------------------------- base64 */

  // btoa/atob take strings, and spreading a large array into String.fromCharCode
  // overflows the argument limit — hence the chunking.
  const CHUNK = 0x8000;

  const toBinaryString = (bytes) => {
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return binary;
  };

  define(proto, 'toBase64', function toBase64(options) {
    const base64 = btoa(toBinaryString(this));
    const alphabet = options && options.alphabet;

    let result = alphabet === 'base64url' ? base64.replace(/\+/g, '-').replace(/\//g, '_') : base64;
    if (options && options.omitPadding) result = result.replace(/=+$/, '');
    return result;
  });

  define(Uint8Array, 'fromBase64', function fromBase64(text, options) {
    if (typeof text !== 'string') throw new TypeError('fromBase64 membutuhkan string');

    let input = text;
    if (options && options.alphabet === 'base64url') {
      input = input.replace(/-/g, '+').replace(/_/g, '/');
    }
    // atob rejects unpadded input that the spec accepts.
    const padding = input.length % 4;
    if (padding === 2) input += '==';
    else if (padding === 3) input += '=';

    const binary = atob(input);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  });

  define(proto, 'setFromBase64', function setFromBase64(text, options) {
    const decoded = Uint8Array.fromBase64(text, options);
    const written = Math.min(decoded.length, this.length);
    this.set(decoded.subarray(0, written));
    return { read: text.length, written };
  });

  define(proto, 'setFromHex', function setFromHex(text) {
    const decoded = Uint8Array.fromHex(text);
    const written = Math.min(decoded.length, this.length);
    this.set(decoded.subarray(0, written));
    return { read: text.length, written };
  });
})();
