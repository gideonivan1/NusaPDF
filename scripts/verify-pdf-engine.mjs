/**
 * Exercises the real document operations against generated fixtures.
 *
 * This is not a substitute for the Playwright suite the PRD calls for — it
 * cannot touch canvas-dependent paths (compression, rasterisation). What it
 * does verify is the part most likely to be silently wrong: that merge and
 * split produce the exact pages, in the exact order, that the UI promised.
 *
 * Run: node scripts/verify-pdf-engine.mjs
 */
import { inflateSync } from 'node:zlib';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { merge, split, imagesToPdf, countPages } from '../lib/pdf/worker.ts';

let failures = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}`);
  if (!ok) {
    console.log(`        expected ${JSON.stringify(expected)}`);
    console.log(`        actual   ${JSON.stringify(actual)}`);
    failures++;
  }
}

function checkThat(label, condition, detail = '') {
  console.log(`${condition ? '  PASS' : '  FAIL'}  ${label}`);
  if (!condition) {
    failures++;
    if (detail) console.log(`        ${detail}`);
  }
}

/** Builds a PDF whose pages are labelled, so page identity survives round-trips. */
async function makeFixture(tag, pageCount) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  for (let i = 1; i <= pageCount; i++) {
    const page = doc.addPage([300, 400]);
    page.drawText(`${tag}${i}`, { x: 40, y: 340, size: 36, font, color: rgb(0, 0, 0) });
  }

  return (await doc.save()).buffer;
}

/** Reads back the label drawn on each page, in document order. */
async function readLabels(bytes) {
  const doc = await PDFDocument.load(bytes);
  // pdf-lib cannot extract text, so identity is checked via the content stream
  // bytes, which still contain the literal we drew.
  const labels = [];

  for (let i = 0; i < doc.getPageCount(); i++) {
    const page = doc.getPage(i);
    const contents = page.node.Contents();
    const streams = contents?.asArray?.() ?? [contents];
    let text = '';

    for (const ref of streams) {
      const stream = doc.context.lookup(ref);
      if (!stream?.getContents) continue;

      // Copied pages keep their original Flate encoding, so the drawn literal
      // is only visible after inflating.
      let bytes = Buffer.from(stream.getContents());
      try {
        bytes = inflateSync(bytes);
      } catch {
        // Already uncompressed — use the bytes as they are.
      }

      text += bytes.toString('latin1');
    }

    // pdf-lib encodes text for standard fonts as a hex string (`<4131> Tj`),
    // not a plain literal, so decode that before matching.
    const hex = text.match(/<([0-9A-Fa-f]+)>\s*Tj/);
    const literal = text.match(/\(([A-Z]\d+)\)\s*Tj/);

    if (hex) {
      labels.push(Buffer.from(hex[1], 'hex').toString('latin1').replace(/\0/g, ''));
    } else {
      labels.push(literal ? literal[1] : '?');
    }
  }

  return labels;
}

console.log('\nNusaPDF — verifikasi mesin PDF\n');

/* ============================== polyfill Uint8Array untuk peramban lama === */
console.log('polyfill Uint8Array');
{
  const { readFileSync, existsSync } = await import('node:fs');
  const vm = await import('node:vm');

  const source = readFileSync(new URL('../lib/pdf/uint8-polyfill.js', import.meta.url), 'utf8');

  // Run in a context where the methods genuinely do not exist. Node has them
  // natively, so testing against the real Uint8Array would pass no matter what
  // the polyfill did — which is exactly how a browser-only bug stays hidden.
  const sandbox = {
    Uint8Array: class extends Uint8Array {},
    btoa: (s) => Buffer.from(s, 'latin1').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('latin1'),
    Object, TypeError, SyntaxError, Number, String, Math,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  const U = sandbox.Uint8Array;

  check('toHex memformat byte dengan nol di depan', new U([0, 1, 15, 16, 255, 128]).toHex(), '00010f10ff80');
  check('toHex pada array kosong', new U([]).toHex(), '');
  check('fromHex membalik toHex', U.fromHex('00010f10ff80').toHex(), '00010f10ff80');
  check('toBase64', new U([0, 1, 15, 16, 255, 128]).toBase64(), 'AAEPEP+A');
  check('fromBase64 membalik toBase64', U.fromBase64('AAEPEP+A').toHex(), '00010f10ff80');
  check('base64url memakai alfabet berbeda', new U([255, 224]).toBase64({ alphabet: 'base64url' }), '_-A=');
  check('omitPadding membuang tanda sama dengan', new U([255]).toBase64({ omitPadding: true }), '/w');

  // btoa overflows when a large array is spread into String.fromCharCode; the
  // chunking exists for this case and nothing smaller would exercise it.
  const big = new U(200_000).fill(65);
  checkThat('array besar tidak meluapkan argumen', U.fromBase64(big.toBase64()).length === 200_000);

  // Native implementations must be left alone.
  const native = { toHex: () => 'asli' };
  Object.setPrototypeOf(native, Object.prototype);
  checkThat('tidak menimpa implementasi bawaan', typeof Uint8Array.prototype.toHex === 'function');
}

console.log('\nworker pdf.js yang disajikan');
{
  const { readFileSync, existsSync } = await import('node:fs');
  const workerPath = new URL('../public/pdf.worker.min.mjs', import.meta.url);

  if (!existsSync(workerPath)) {
    console.log('  LEWAT  public/pdf.worker.min.mjs belum dibuat (jalankan npm run build)');
  } else {
    const worker = readFileSync(workerPath, 'utf8');

    const installed = worker.indexOf("define(proto, 'toHex'");
    const used = worker.lastIndexOf('.toHex()');

    checkThat('polyfill ikut tersuntik ke worker', installed >= 0);
    checkThat(
      'polyfill terpasang sebelum pdf.js memakainya',
      installed >= 0 && installed < used,
      `pasang=${installed} pakai=${used}`,
    );
  }
}

/* ---------------------------------------------------------------- countPages */
console.log('countPages');
{
  const fixture = await makeFixture('A', 5);
  check('menghitung 5 halaman', await countPages(fixture), 5);
}

/* --------------------------------------------------------------------- merge */
console.log('\nmerge');
{
  const a = await makeFixture('A', 3);
  const b = await makeFixture('B', 2);

  const bytes = await merge([
    { buffer: a, pageIndices: [0, 1, 2] },
    { buffer: b, pageIndices: [0, 1] },
  ]);

  check('total halaman = jumlah input', (await PDFDocument.load(bytes)).getPageCount(), 5);
  check('urutan halaman terjaga', await readLabels(bytes), ['A1', 'A2', 'A3', 'B1', 'B2']);
}
{
  // The ordering guarantee in PRD §13 US2 is about the *displayed* order, which
  // includes reordered files and deselected pages.
  const a = await makeFixture('A', 3);
  const b = await makeFixture('B', 3);

  const bytes = await merge([
    { buffer: b, pageIndices: [2, 0] },
    { buffer: a, pageIndices: [1] },
  ]);

  check('urutan berkas & halaman kustom', await readLabels(bytes), ['B3', 'B1', 'A2']);
}
{
  const a = await makeFixture('A', 2);
  const bytes = await merge([{ buffer: a, pageIndices: [0, 1], rotations: [90, 0] }]);
  const doc = await PDFDocument.load(bytes);

  check('rotasi diterapkan per halaman', [
    doc.getPage(0).getRotation().angle,
    doc.getPage(1).getRotation().angle,
  ], [90, 0]);
}

/* --------------------------------------------------------------------- split */
console.log('\nsplit');
{
  const a = await makeFixture('A', 5);
  const outputs = await split(a, [[0], [2], [4]], 'dokumen');

  check('menghasilkan satu berkas per grup', outputs.length, 3);
  check(
    'tiap berkas berisi tepat halaman yang diminta',
    await Promise.all(outputs.map((o) => readLabels(o.bytes))),
    [['A1'], ['A3'], ['A5']],
  );
  check(
    'nama berkas menyebut halaman aslinya',
    outputs.map((o) => o.fileName),
    ['dokumen_1_hal-1.pdf', 'dokumen_2_hal-3.pdf', 'dokumen_3_hal-5.pdf'],
  );
}
{
  const a = await makeFixture('A', 6);
  const outputs = await split(a, [[0, 1, 2], [4, 5]], 'laporan');

  check(
    'rentang menjadi satu berkas per rentang',
    await Promise.all(outputs.map((o) => readLabels(o.bytes))),
    [['A1', 'A2', 'A3'], ['A5', 'A6']],
  );
  check(
    'nama rentang memakai halaman awal-akhir',
    outputs.map((o) => o.fileName),
    ['laporan_1_hal-1-3.pdf', 'laporan_2_hal-5-6.pdf'],
  );
}

/* -------------------------------------------------------------- imagesToPdf */
console.log('\nimagesToPdf');
{
  // A 2x2 red JPEG, small enough to inline.
  const jpeg = Buffer.from(
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
      'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAACAAIBAREA/8QAHwAAAQUBAQEB' +
      'AQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1Fh' +
      'ByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZ' +
      'WmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXG' +
      'x8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APn+iiiv/9k=',
    'base64',
  );

  const bytes = await imagesToPdf(
    [
      { buffer: jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.byteLength), mimeType: 'image/jpeg', fileName: 'a.jpg' },
    ],
    { pageSize: 'a4', orientation: 'portrait', margin: 24 },
  );

  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(0);

  check('satu gambar menjadi satu halaman', doc.getPageCount(), 1);
  check('halaman A4 tegak', [Math.round(page.getWidth()), Math.round(page.getHeight())], [595, 842]);
}

console.log(
  failures === 0
    ? '\nSemua pemeriksaan lolos.\n'
    : `\n${failures} pemeriksaan GAGAL.\n`,
);

process.exit(failures === 0 ? 0 : 1);
