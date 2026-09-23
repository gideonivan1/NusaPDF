/**
 * Runs the browser's PDF to Word conversion from the command line.
 *
 * Same code path the tool uses — lib/office/pdf-to-docx — with pdf.js's
 * legacy (Node) build and @napi-rs/canvas standing in for <canvas>. Useful for
 * checking a real document end to end without clicking through the UI:
 *
 *   npm run convert:word -- laporan.pdf            -> laporan.docx
 *   npm run convert:word -- laporan.pdf out.docx
 *   npm run convert:word -- laporan.pdf out.docx --pages 3-6
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import * as docx from 'docx';

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const { convertPdfToDocx } = await import('../lib/office/pdf-to-docx/index.ts');

const args = process.argv.slice(2);
const pagesFlag = args.indexOf('--pages');
const range = pagesFlag >= 0 ? args.splice(pagesFlag, 2)[1] : null;
const [input, outputArg] = args;

if (!input) {
  console.error('Pakai: npm run convert:word -- <berkas.pdf> [keluaran.docx] [--pages 1-5]');
  process.exit(1);
}

const output = resolve(outputArg ?? `${basename(input, extname(input))}.docx`);
const pdf = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(input)) }).promise;

let pages = Array.from({ length: pdf.numPages }, (_, index) => index + 1);
if (range) {
  const [from, to] = range.split('-').map(Number);
  pages = pages.filter((page) => page >= from && page <= (to || from));
}

const backend = {
  create: (width, height) => createCanvas(width, height),
  encode: async (canvas, format, quality) =>
    new Uint8Array(format === 'png' ? await canvas.encode('png') : await canvas.encode('jpeg', Math.round(quality * 100))),
};

const started = Date.now();
const { document } = await convertPdfToDocx(pdf, pages, {
  pdfjsOps: pdfjs.OPS,
  docx,
  canvas: backend,
  onProgress: (done, total, label) => process.stdout.write(`\r  ${Math.round((done / total) * 100)}%  ${label ?? ''}`.padEnd(70)),
});

const buffer = await docx.Packer.toBuffer(document);
writeFileSync(output, buffer);
console.log(`\n  ${pages.length} halaman -> ${output} (${(buffer.length / 1024).toFixed(0)} KB, ${Date.now() - started} ms)`);
