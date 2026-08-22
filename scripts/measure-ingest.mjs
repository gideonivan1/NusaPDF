/**
 * Measures how long ingest actually takes, so the page and chunk limits are
 * derived from observed throughput rather than guessed.
 *
 * Vercel's Hobby plan kills a function at 60s. Picking a limit by intuition
 * would either waste headroom or let documents fail halfway through — which is
 * the worse outcome, because a killed function leaves the document stuck in
 * `processing` with no error the user can act on.
 *
 * Uses real Gemini embedding calls, so it consumes a little quota.
 *
 * Run: npm run measure:ingest
 */
import { readFile } from 'node:fs/promises';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const raw = await readFile(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of raw.split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && m[2].trim()) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '');
}

const { extractPageTexts, chunkPages } = await import('../lib/ai/extract.ts');
const { embedDocuments } = await import('../lib/ai/embed.ts');

/** A page with roughly the text density of a real report. */
async function makePdf(pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const paragraph =
    'Anggaran sektor persampahan naik dua belas persen pada tahun 2024, sementara kapasitas terpasang tetap sama sejak 2019 sehingga kesenjangan pelayanan melebar di hampir seluruh kabupaten. Timbulan harian tercatat 1.250 ton dengan tingkat pelayanan 79 persen. ';

  for (let i = 1; i <= pages; i++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Halaman ${i}. ${paragraph.repeat(6)}`, {
      x: 50, y: 780, size: 10, font, color: rgb(0, 0, 0),
      maxWidth: 495, lineHeight: 14,
    });
  }

  return new Uint8Array(await doc.save());
}

console.log('\nNusaPDF — pengukuran waktu ingest\n');

// The first extraction pays for loading the pdf.js module. Without a warm-up
// that one-off cost lands entirely on the smallest sample and makes the derived
// per-page cost come out negative.
process.stdout.write('  memanaskan modul… ');
await extractPageTexts(await makePdf(2));
console.log('selesai\n');

console.log('  halaman   ekstraksi   potongan   embedding   total');
console.log('  ' + '-'.repeat(52));

const samples = [];

for (const pageCount of [20, 60]) {
  const bytes = await makePdf(pageCount);

  const t0 = performance.now();
  const pages = await extractPageTexts(bytes);
  const t1 = performance.now();

  const chunks = chunkPages(pages);
  const t2 = performance.now();

  await embedDocuments(chunks.map((c) => c.content));
  const t3 = performance.now();

  const extract = t1 - t0;
  const embed = t3 - t2;
  const total = t3 - t0;

  samples.push({ pageCount, chunks: chunks.length, extract, embed, total });

  console.log(
    `  ${String(pageCount).padStart(7)}   ${(extract / 1000).toFixed(1).padStart(8)}s   ` +
      `${String(chunks.length).padStart(8)}   ${(embed / 1000).toFixed(1).padStart(8)}s   ` +
      `${(total / 1000).toFixed(1).padStart(5)}s`,
  );
}

/* ------------------------------------------------------------- extrapolate */
const [small, large] = samples;

const BATCH = 32; // must match embed.ts

const msPerPage = (large.extract - small.extract) / (large.pageCount - small.pageCount);
const chunksPerPage = large.chunks / large.pageCount;

// Embedding cost is dominated by round trips, not by how many strings ride in
// each one, so the useful unit is the batch.
const batchesOf = (chunks) => Math.ceil(chunks / BATCH);
const msPerBatch =
  (large.embed - small.embed) / (batchesOf(large.chunks) - batchesOf(small.chunks));

console.log('\n  Turunan:');
console.log(`    ekstraksi   ~${msPerPage.toFixed(0)} ms per halaman`);
console.log(`    potongan    ~${chunksPerPage.toFixed(1)} per halaman`);
console.log(`    embedding   ~${(msPerBatch / 1000).toFixed(2)} s per batch (${BATCH} potongan)`);

for (const [label, budgetMs] of [
  ['Hobby (60s), margin 40%', 60_000 * 0.6],
  ['Pro (300s), margin 40%', 300_000 * 0.6],
]) {
  // Solve for pages: pages*msPerPage + ceil(pages*chunksPerPage/BATCH)*msPerBatch <= budget
  let pages = 0;
  while (
    pages * msPerPage + batchesOf(Math.ceil((pages + 1) * chunksPerPage)) * msPerBatch <
    budgetMs
  ) {
    pages++;
    if (pages > 5000) break;
  }
  console.log(
    `\n  ${label}: aman hingga ~${pages} halaman (~${Math.ceil(pages * chunksPerPage)} potongan)`,
  );
}

console.log(
  '\n  Catatan: dokumen padat menghasilkan lebih banyak potongan per halaman,\n' +
    '  dan latensi Vercel→Google berbeda dari mesin ini. Ambil margin.',
);

console.log();
