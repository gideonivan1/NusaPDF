/**
 * Runs the browser's PowerPoint to PDF conversion from the command line.
 *
 * Same code path the tool uses — lib/office/pptx-to-pdf — with fonts read
 * from public/fonts instead of fetched, and linkedom standing in for the
 * browser's DOMParser:
 *
 *   npm run convert:slides -- paparan.pptx           -> paparan.pdf
 *   npm run convert:slides -- paparan.pptx out.pdf
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { DOMParser } from 'linkedom';

globalThis.DOMParser = DOMParser;

const { convertPptxToPdf } = await import('../lib/office/pptx-to-pdf/index.ts');

const [input, outputArg] = process.argv.slice(2);
if (!input) {
  console.error('Pakai: npm run convert:slides -- <berkas.pptx> [keluaran.pdf]');
  process.exit(1);
}

const output = resolve(outputArg ?? `${basename(input, extname(input))}.pdf`);
const fonts = new URL('../public/fonts/', import.meta.url);
const data = readFileSync(input);

const started = Date.now();
const bytes = await convertPptxToPdf(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), {
  loadFont: async (file) => new Uint8Array(readFileSync(new URL(file, fonts))),
  onProgress: (done, total, label) => process.stdout.write(`\r  ${Math.round((done / total) * 100)}%  ${label ?? ''}`.padEnd(60)),
});

writeFileSync(output, bytes);
console.log(`\n  -> ${output} (${(bytes.length / 1024).toFixed(0)} KB, ${Date.now() - started} ms)`);
