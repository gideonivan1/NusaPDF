// pdfjs-dist ships its parser as a separate worker bundle. Rather than relying
// on bundler-specific `new URL(..., import.meta.url)` handling, we copy the
// worker into /public and load it from a stable, absolute path. This keeps the
// setup identical across dev (Turbopack), production builds, and Vercel.
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs');
const target = resolve(root, 'public/pdf.worker.min.mjs');

await mkdir(dirname(target), { recursive: true });
await copyFile(source, target);

console.log('[nusapdf] pdf.worker.min.mjs -> public/');
