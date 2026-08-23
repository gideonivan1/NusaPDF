// pdfjs-dist ships its parser as a separate worker bundle. Rather than relying
// on bundler-specific `new URL(..., import.meta.url)` handling, we copy the
// worker into /public and load it from a stable, absolute path. This keeps the
// setup identical across dev (Turbopack), production builds, and Vercel.
//
// The copy also carries a polyfill, which is the whole reason this is a build
// step rather than a plain static asset — see below.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs');
const polyfillPath = resolve(root, 'lib/pdf/uint8-polyfill.js');
const target = resolve(root, 'public/pdf.worker.min.mjs');

/**
 * pdf.js computes a document fingerprint with `Uint8Array.prototype.toHex()`
 * inside the worker while opening any PDF. That method arrived in Chrome ~140,
 * so on older-but-current browsers every file failed with "n.toHex is not a
 * function" — reported from Chrome 133 on Android 9.
 *
 * The polyfill has to live *inside* the worker: it runs in its own global
 * scope, so installing it on the main thread does nothing for it. Prepending
 * keeps one copy of the polyfill source shared with the main-thread import.
 */
const [worker, polyfill] = await Promise.all([
  readFile(source, 'utf8'),
  readFile(polyfillPath, 'utf8'),
]);

const banner = `/* NusaPDF: polyfill Uint8Array hex/base64 untuk peramban < Chrome 140.
   Disuntikkan oleh scripts/copy-pdf-worker.mjs — jangan sunting berkas ini. */\n`;

await mkdir(dirname(target), { recursive: true });
await writeFile(target, banner + polyfill + '\n' + worker, 'utf8');

const kb = (text) => `${(Buffer.byteLength(text) / 1024).toFixed(0)} KB`;
console.log(
  `[nusapdf] pdf.worker.min.mjs -> public/ (worker ${kb(worker)} + polyfill ${kb(polyfill)})`,
);
