/**
 * Exercises the parts of the AI pipeline that do not need credentials:
 * text extraction, chunking, and key-pool failover.
 *
 * Failover in particular is logic that fails silently — a pool that never
 * rotates looks identical to a healthy one until the primary key runs dry.
 *
 * Run: npm run verify:ai
 * (needs --conditions=react-server so the `server-only` guard resolves)
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { chunkPages, extractPageTexts } from '../lib/ai/extract.ts';
import {
  AllKeysExhaustedError,
  isOverloadError,
  isQuotaError,
  poolStatus,
  resetPool,
  withGeminiKey,
} from '../lib/ai/key-pool.ts';

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

console.log('\nNusaPDF — verifikasi pipeline AI\n');

/* ==================================================== extraction & chunking */
console.log('extractPageTexts');
{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const perPage = [
    'Anggaran naik dua belas persen pada tahun 2024',
    'Kapasitas terpasang tetap sama sejak 2019',
    'Tenggat pelaporan jatuh pada 31 Maret',
  ];

  for (const line of perPage) {
    const page = doc.addPage([420, 300]);
    page.drawText(line, { x: 20, y: 250, size: 12, font, color: rgb(0, 0, 0) });
  }

  const pages = await extractPageTexts(new Uint8Array(await doc.save()));

  check('mengembalikan satu entri per halaman', pages.length, 3);
  check(
    'nomor halaman 1-indexed dan berurutan',
    pages.map((p) => p.pageNumber),
    [1, 2, 3],
  );
  checkThat(
    'teks tiap halaman terbaca utuh',
    pages.every((p, i) => p.text.includes(perPage[i].split(' ')[0])),
    JSON.stringify(pages.map((p) => p.text)),
  );
  checkThat(
    'teks halaman tidak bocor ke halaman lain',
    !pages[0].text.includes('Kapasitas') && !pages[1].text.includes('Anggaran'),
  );
}

console.log('\nchunkPages');
{
  // Two long pages, each well past the 1200-char target so they must split.
  const long = (word) => `${word} `.repeat(500).trim();
  const chunks = chunkPages([
    { pageNumber: 4, text: long('empat') },
    { pageNumber: 9, text: long('sembilan') },
  ]);

  checkThat('halaman panjang dipecah jadi beberapa potongan', chunks.length > 4);

  checkThat(
    'setiap potongan hanya memuat teks dari satu halaman',
    chunks.every((c) =>
      c.pageNumber === 4 ? !c.content.includes('sembilan') : !c.content.includes('empat'),
    ),
    'potongan lintas halaman akan membuat sitasi [hal. N] salah',
  );

  check(
    'hanya halaman asli yang muncul',
    [...new Set(chunks.map((c) => c.pageNumber))].sort((a, b) => a - b),
    [4, 9],
  );

  checkThat(
    'chunkIndex unik dan menaik',
    chunks.every((c, i) => (i === 0 ? true : c.chunkIndex > chunks[i - 1].chunkIndex)),
  );

  checkThat(
    'tiap potongan berada dalam batas ukuran wajar',
    chunks.every((c) => c.content.length <= 1400),
    JSON.stringify(chunks.map((c) => c.content.length)),
  );
}

{
  // A page too short to be worth indexing should be dropped, not emitted empty.
  const chunks = chunkPages([
    { pageNumber: 1, text: 'hal' },
    { pageNumber: 2, text: 'Kalimat yang cukup panjang untuk dijadikan potongan indeks. '.repeat(3) },
  ]);
  check('halaman nyaris kosong diabaikan', [...new Set(chunks.map((c) => c.pageNumber))], [2]);
}

/* ============================================================== key pool == */
console.log('\nisQuotaError');
{
  checkThat('mengenali status 429', isQuotaError(Object.assign(new Error('x'), { status: 429 })));
  checkThat('mengenali RESOURCE_EXHAUSTED', isQuotaError(new Error('RESOURCE_EXHAUSTED')));
  checkThat('mengenali pesan kuota', isQuotaError(new Error('Quota exceeded for model')));
  checkThat('BUKAN kuota untuk galat lain', !isQuotaError(new Error('invalid argument')));
}

console.log('\nisOverloadError');
{
  checkThat('mengenali status 503', isOverloadError(Object.assign(new Error('x'), { status: 503 })));
  checkThat(
    'mengenali pesan high demand',
    isOverloadError(new Error('This model is currently experiencing high demand')),
  );
  checkThat('BUKAN overload untuk galat kuota', !isOverloadError(new Error('quota exceeded')));
}

console.log('\nwithGeminiKey — failover');

const quotaError = () => Object.assign(new Error('RESOURCE_EXHAUSTED: quota'), { status: 429 });
const overloadError = () =>
  Object.assign(new Error('503 UNAVAILABLE: experiencing high demand'), { status: 503 });

{
  process.env.GEMINI_API_KEY = 'key-a';
  process.env.GEMINI_API_KEY_2 = 'key-b';
  process.env.GEMINI_API_KEY_3 = 'key-c';
  process.env.GEMINI_API_KEY_4 = 'key-d';
  resetPool();

  check('memuat keempat kunci', poolStatus().length, 4);
}

{
  resetPool();
  const tried = [];

  // First two keys are spent; the third answers.
  const result = await withGeminiKey(async (_client, slot) => {
    tried.push(slot.label);
    if (tried.length < 3) throw quotaError();
    return 'ok';
  });

  check('berpindah kunci sampai berhasil', result, 'ok');
  check('mencoba tepat tiga kunci', tried.length, 3);
  checkThat('kunci yang dicoba berbeda-beda', new Set(tried).size === 3, tried.join(','));
}

{
  resetPool();
  // Every key spent -> a typed error the route can turn into E_QUOTA.
  let caught = null;
  try {
    await withGeminiKey(async () => {
      throw quotaError();
    });
  } catch (error) {
    caught = error;
  }

  checkThat(
    'melempar AllKeysExhaustedError saat semua kunci habis',
    caught instanceof AllKeysExhaustedError,
    String(caught),
  );
  check('menandai keempat kunci tidak tersedia', poolStatus().filter((s) => !s.available).length, 4);
  checkThat(
    'cooldown tercatat dalam hitungan detik',
    poolStatus().every((s) => s.cooldownSeconds > 0),
  );
}

{
  resetPool();
  // A malformed request must NOT burn the pool.
  const tried = [];
  let caught = null;

  try {
    await withGeminiKey(async (_client, slot) => {
      tried.push(slot.label);
      throw new Error('invalid argument: contents required');
    });
  } catch (error) {
    caught = error;
  }

  check('galat non-kuota hanya mencoba satu kunci', tried.length, 1);
  checkThat(
    'galat non-kuota diteruskan apa adanya',
    caught instanceof Error && caught.message.includes('invalid argument'),
  );
  check('tidak ada kunci yang ditandai habis', poolStatus().filter((s) => !s.available).length, 0);
}

{
  resetPool();
  // Overload is the model being busy, not the key being spent: retry the same
  // key rather than rotating, and never mark it exhausted.
  const tried = [];
  const result = await withGeminiKey(async (_client, slot) => {
    tried.push(slot.label);
    if (tried.length < 3) throw overloadError();
    return 'ok';
  });

  check('mencoba ulang saat model sibuk', result, 'ok');
  check('mengulang pada kunci yang SAMA', new Set(tried).size, 1);
  check('kunci tidak ditandai habis karena overload', poolStatus().filter((s) => !s.available).length, 0);
}

{
  resetPool();
  // Retries are bounded; a permanently busy model must surface, not hang.
  let caught = null;
  const tried = [];
  try {
    await withGeminiKey(async (_client, slot) => {
      tried.push(slot.label);
      throw overloadError();
    });
  } catch (error) {
    caught = error;
  }

  check('percobaan ulang dibatasi', tried.length, 3);
  checkThat(
    'overload permanen dilempar apa adanya, bukan AllKeysExhausted',
    caught instanceof Error && !(caught instanceof AllKeysExhaustedError),
    String(caught),
  );
  check('tidak menghanguskan kolam kunci', poolStatus().filter((s) => !s.available).length, 0);
}

{
  resetPool();
  // Rotation should spread load rather than always starting at key 1.
  const firstTried = [];
  for (let i = 0; i < 4; i++) {
    await withGeminiKey(async (_client, slot) => {
      firstTried.push(slot.label);
      return null;
    });
  }
  checkThat(
    'kunci awal berputar antar permintaan',
    new Set(firstTried).size === 4,
    firstTried.join(','),
  );
}

{
  // Duplicate keys in env should collapse to one slot.
  // Note: `process.env.X = undefined` stores the STRING "undefined" in Node,
  // so unsetting has to be a delete.
  process.env.GEMINI_API_KEY = 'same';
  process.env.GEMINI_API_KEY_2 = 'same';
  process.env.GEMINI_API_KEY_3 = '';
  delete process.env.GEMINI_API_KEY_4;
  resetPool();
  check('kunci duplikat tidak dihitung dua kali', poolStatus().length, 1);
}

{
  // The literal strings a broken env template produces must not become keys.
  process.env.GEMINI_API_KEY = 'real-key';
  process.env.GEMINI_API_KEY_2 = 'undefined';
  process.env.GEMINI_API_KEY_3 = 'null';
  delete process.env.GEMINI_API_KEY_4;
  resetPool();
  check('nilai placeholder tidak dianggap kunci', poolStatus().length, 1);
}

console.log(
  failures === 0 ? '\nSemua pemeriksaan lolos.\n' : `\n${failures} pemeriksaan GAGAL.\n`,
);

process.exit(failures === 0 ? 0 : 1);
