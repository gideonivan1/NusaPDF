/**
 * Exercises the hand-rolled OOXML readers/writers and the PDF layout engine.
 *
 * These are the highest-risk pieces of the conversion work: a subtly malformed
 * .xlsx opens as "unreadable content" in Excel with no clue why, and a slide
 * parser that silently drops shapes looks like an empty deck.
 *
 * DOMParser comes from linkedom, since Node has no DOM.
 *
 * Run: npm run verify:office
 */
import { inflateSync } from 'node:zlib';
import { DOMParser } from 'linkedom';
import { PDFDocument } from 'pdf-lib';
import { strToU8, zipSync } from 'fflate';

globalThis.DOMParser = DOMParser;

const { readWorkbook, writeWorkbook } = await import('../lib/office/xlsx.ts');
const { readDeck } = await import('../lib/office/pptx.ts');
const { renderBlocksToPdf, sanitise, A4_PORTRAIT } = await import('../lib/office/pdf-writer.ts');
const { naturalCompare, indexToColumn, columnToIndex } = await import('../lib/office/ooxml.ts');

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

console.log('\nNusaPDF — verifikasi konversi Office\n');

/* ============================================================ ooxml helpers */
console.log('helper ooxml');
{
  check('indeks kolom -> huruf', [0, 25, 26, 27, 701].map(indexToColumn), ['A', 'Z', 'AA', 'AB', 'ZZ']);
  check('huruf -> indeks kolom', ['A1', 'Z9', 'AA10', 'AB1'].map(columnToIndex), [0, 25, 26, 27]);
  check(
    'urutan alami menempatkan slide2 sebelum slide10',
    ['slide10.xml', 'slide2.xml', 'slide1.xml'].sort(naturalCompare),
    ['slide1.xml', 'slide2.xml', 'slide10.xml'],
  );
}

/* ==================================================================== xlsx */
console.log('\nxlsx — tulis lalu baca ulang');
{
  const rows = [
    ['Wilayah', 'Timbulan (ton/hari)', 'Terlayani'],
    ['Kab. Bandung', '1250.5', 'TRUE'],
    ['Kota Cirebon', '430', 'FALSE'],
    ['DKI Jakarta', '7800.25', 'TRUE'],
  ];

  const blob = writeWorkbook([{ name: 'Ringkasan', rows }]);
  const sheets = readWorkbook(await blob.arrayBuffer());

  check('satu lembar terbaca', sheets.length, 1);
  check('nama lembar bertahan', sheets[0].name, 'Ringkasan');
  check('seluruh isi sel bertahan utuh', sheets[0].rows, rows);
}

{
  // Characters that would break the XML if not escaped.
  const rows = [['A & B', '<tag>', '"kutip"', "'apostrof'", 'baris\nbaru']];
  const sheets = readWorkbook(await writeWorkbook([{ name: 'S', rows }]).arrayBuffer());
  check('karakter khusus XML di-escape dengan benar', sheets[0].rows[0], rows[0]);
}

{
  const rows = [['  spasi depan-belakang  ']];
  const sheets = readWorkbook(await writeWorkbook([{ name: 'S', rows }]).arrayBuffer());
  check('spasi tepi tidak dibuang', sheets[0].rows[0][0], '  spasi depan-belakang  ');
}

{
  // Excel refuses names over 31 chars or containing : \ / ? * [ ]
  const long = 'Nama lembar yang sangat panjang sekali melebihi batas';
  const sheets = readWorkbook(
    await writeWorkbook([{ name: long, rows: [['x']] }]).arrayBuffer(),
  );
  checkThat('nama lembar dipangkas ke 31 karakter', sheets[0].name.length <= 31, sheets[0].name);

  const illegal = readWorkbook(
    await writeWorkbook([{ name: 'A/B:C*D?[E]', rows: [['x']] }]).arrayBuffer(),
  );
  checkThat(
    'karakter terlarang pada nama lembar dibersihkan',
    !/[:\\/?*[\]]/.test(illegal[0].name),
    illegal[0].name,
  );
}

{
  const sheets = readWorkbook(
    await writeWorkbook([
      { name: 'Satu', rows: [['a']] },
      { name: 'Dua', rows: [['b']] },
      { name: 'Tiga', rows: [['c']] },
    ]).arrayBuffer(),
  );
  check(
    'beberapa lembar terbaca berurutan',
    sheets.map((s) => [s.name, s.rows[0][0]]),
    [['Satu', 'a'], ['Dua', 'b'], ['Tiga', 'c']],
  );
}

console.log('\nxlsx — membaca berkas gaya Excel asli');
{
  // Excel writes shared strings and skips empty cells rather than emitting
  // them, so the reader has to place cells by their `r` reference.
  const files = {
    'xl/workbook.xml':
      '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml':
      '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Nama</t></si><si><r><t>Nilai </t></r><r><t>Akhir</t></r></si></sst>',
    'xl/worksheets/sheet1.xml':
      '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>' +
      '<row r="2"><c r="A2" t="inlineStr"><is><t>Budi</t></is></c><c r="C2"><v>88</v></c></row>' +
      '<row r="3"><c r="A3"><v>3.5</v></c><c r="B3" t="b"><v>1</v></c></row>' +
      '</sheetData></worksheet>',
  };

  const buffer = zipSync(
    Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])),
  );
  const sheets = readWorkbook(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));

  check('nama lembar dari workbook.xml', sheets[0].name, 'Data');
  check('shared string terbaca', sheets[0].rows[0][0], 'Nama');
  check('shared string multi-run digabung', sheets[0].rows[0][2], 'Nilai Akhir');
  check('sel kosong yang dilewati tetap menjaga posisi kolom', sheets[0].rows[0][1], '');
  check('inlineStr terbaca', sheets[0].rows[1][0], 'Budi');
  check('angka terbaca', sheets[0].rows[2][0], '3.5');
  check('boolean jadi TRUE', sheets[0].rows[2][1], 'TRUE');
}

/* ==================================================================== pptx */
console.log('\npptx — membaca slide');
{
  const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
  const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

  // Shapes are deliberately authored out of reading order: the body is listed
  // first, the title second, with the title positioned higher on the slide.
  const slide = (bodyLines, title) =>
    `<?xml version="1.0"?><p:sld ${P} ${A}><p:cSld><p:spTree>
      <p:sp><p:spPr><a:xfrm><a:off x="0" y="3000000"/></a:xfrm></p:spPr><p:txBody>
        ${bodyLines.map((l) => `<a:p><a:r><a:t>${l}</a:t></a:r></a:p>`).join('')}
      </p:txBody></p:sp>
      <p:sp><p:spPr><a:xfrm><a:off x="0" y="500000"/></a:xfrm></p:spPr><p:txBody>
        <a:p><a:r><a:t>${title}</a:t></a:r></a:p>
      </p:txBody></p:sp>
    </p:spTree></p:cSld></p:sld>`;

  const files = {
    'ppt/presentation.xml': `<?xml version="1.0"?><p:presentation ${P} ${A}><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`,
    'ppt/slides/slide1.xml': slide(['Poin pertama', 'Poin kedua'], 'Judul Satu'),
    'ppt/slides/slide2.xml': slide(['Isi dua'], 'Judul Dua'),
    'ppt/slides/slide10.xml': slide(['Isi sepuluh'], 'Judul Sepuluh'),
  };

  const buffer = zipSync(
    Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])),
  );
  const deck = readDeck(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));

  check('seluruh slide terbaca', deck.slides.length, 3);
  check(
    'slide10 diurutkan setelah slide2',
    deck.slides.map((s) => s.shapes[0].lines[0]),
    ['Judul Satu', 'Judul Dua', 'Judul Sepuluh'],
  );
  check('shape diurutkan dari atas ke bawah, bukan urutan XML', deck.slides[0].shapes[0].lines, [
    'Judul Satu',
  ]);
  check('isi slide lengkap', deck.slides[0].shapes[1].lines, ['Poin pertama', 'Poin kedua']);
  check('ukuran slide dikonversi EMU ke poin', [deck.widthPt, deck.heightPt], [960, 540]);
}

{
  // Runs split mid-sentence by formatting must be rejoined.
  const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
  const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
  const files = {
    'ppt/presentation.xml': `<?xml version="1.0"?><p:presentation ${P}><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`,
    'ppt/slides/slide1.xml': `<?xml version="1.0"?><p:sld ${P} ${A}><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Anggaran </a:t></a:r><a:r><a:t>naik</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
  };
  const buffer = zipSync(
    Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])),
  );
  const deck = readDeck(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));

  check('run yang terpotong digabung kembali', deck.slides[0].shapes[0].lines, ['Anggaran naik']);
  check('rasio 4:3 terbaca', [deck.widthPt, deck.heightPt], [720, 540]);
}

/* ============================================================== pdf-writer */
console.log('\npdf-writer');
{
  check('kutip miring dipetakan ke ASCII', sanitise('“halo” — ‘dunia’…'), '"halo" - \'dunia\'...');
  // Iteration is per code point, so an astral character such as an emoji
  // becomes a single '?', not one per UTF-16 unit.
  check('karakter di luar WinAnsi diganti', sanitise('emoji 😀 di sini'), 'emoji ? di sini');
  check('dua emoji jadi dua tanda tanya', sanitise('😀😀'), '??');
  checkThat('huruf beraksen dipertahankan', sanitise('Café Ångström') === 'Café Ångström');
}

{
  const bytes = await renderBlocksToPdf(
    [
      { type: 'heading', level: 1, text: 'Laporan Tahunan' },
      { type: 'paragraph', text: 'Ringkasan singkat mengenai capaian tahun ini.' },
      { type: 'list', ordered: true, items: ['Poin satu', 'Poin dua'] },
      { type: 'pagebreak' },
      { type: 'table', headerRow: true, rows: [['Wilayah', 'Nilai'], ['Bandung', '1.250']] },
    ],
    { page: A4_PORTRAIT, title: 'Uji', pageNumbers: true },
  );

  const doc = await PDFDocument.load(bytes);
  check('pagebreak menghasilkan halaman kedua', doc.getPageCount(), 2);
  check('ukuran halaman A4', [Math.round(doc.getPage(0).getWidth()), Math.round(doc.getPage(0).getHeight())], [595, 842]);
  check('judul dokumen tersimpan', doc.getTitle(), 'Uji');
}

{
  // A paragraph long enough to force pagination, plus an unbreakable token.
  const bytes = await renderBlocksToPdf(
    [
      { type: 'paragraph', text: 'Kalimat panjang yang berulang. '.repeat(400) },
      { type: 'paragraph', text: 'x'.repeat(500) },
    ],
    { page: A4_PORTRAIT },
  );
  const doc = await PDFDocument.load(bytes);
  checkThat('teks panjang terpaginasi otomatis', doc.getPageCount() > 2, `halaman: ${doc.getPageCount()}`);
}

{
  // Many columns must shrink to fit rather than run off the page.
  const header = Array.from({ length: 15 }, (_, i) => `Kolom ${i + 1}`);
  const row = Array.from({ length: 15 }, (_, i) => `Nilai ${i + 1}`);
  const bytes = await renderBlocksToPdf([{ type: 'table', headerRow: true, rows: [header, row] }], {
    page: A4_PORTRAIT,
  });
  const doc = await PDFDocument.load(bytes);
  checkThat('tabel lebar tetap menghasilkan PDF valid', doc.getPageCount() >= 1);
}

/* ------------------------------------------------- table frame (the bug) -- */
console.log('\npdf-writer — kerangka tabel');

/** Inflates a page's content stream so drawing operators can be counted. */
async function pageOperators(bytes, pageIndex = 0) {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(pageIndex);
  const contents = page.node.Contents();
  const streams = contents?.asArray?.() ?? [contents];
  let text = '';

  for (const ref of streams) {
    const stream = doc.context.lookup(ref);
    if (!stream?.getContents) continue;
    let raw = Buffer.from(stream.getContents());
    try {
      raw = inflateSync(raw);
    } catch (error) {
      // Only a genuine "not deflate data" is expected here. A bare `catch {}`
      // once swallowed a ReferenceError from a missing import and left this
      // reading compressed bytes, which quietly made every assertion below
      // meaningless.
      if (error instanceof ReferenceError || error instanceof TypeError) throw error;
    }
    text += raw.toString('latin1');
  }

  return text;
}

{
  const rows = [
    ['Wilayah', 'Timbulan', 'Terlayani'],
    ['Kab. Bandung', '1.250', '79%'],
    ['Kota Cirebon', '430', '64%'],
  ];

  const withTable = await renderBlocksToPdf([{ type: 'table', headerRow: true, rows }], {
    page: A4_PORTRAIT,
  });
  const withoutTable = await renderBlocksToPdf(
    [{ type: 'paragraph', text: 'Wilayah Timbulan Terlayani' }],
    { page: A4_PORTRAIT },
  );

  const ops = await pageOperators(withTable);
  const plainOps = await pageOperators(withoutTable);

  // `S` strokes a path; a table with 3 columns and 3 rows needs many of them.
  // The original bug drew exactly one rule, so counting is what distinguishes
  // "has a frame" from "looks vaguely aligned".
  const strokes = (ops.match(/\bS\b/g) ?? []).length;
  const plainStrokes = (plainOps.match(/\bS\b/g) ?? []).length;

  checkThat(
    'tabel menggambar banyak garis (kerangka), bukan satu',
    strokes >= 10,
    `stroke pada tabel: ${strokes}`,
  );
  checkThat(
    'paragraf biasa tidak menggambar garis',
    plainStrokes === 0,
    `stroke pada paragraf: ${plainStrokes}`,
  );
  // pdf-lib emits rectangles as an explicit path closed with `h` and filled
  // with `f`, not as the `re` shorthand — so the fill colour is what proves the
  // header band is there.
  checkThat(
    'baris header diberi latar berwarna',
    ops.includes('0.953 0.941 0.933 rg') && /\bf\b/.test(ops),
  );
}

{
  // A table taller than the page must repeat its header, otherwise the
  // continuation is a grid of unlabelled numbers.
  const rows = [['Wilayah', 'Nilai']];
  for (let i = 1; i <= 90; i++) rows.push([`Wilayah ${i}`, String(i * 10)]);

  const bytes = await renderBlocksToPdf([{ type: 'table', headerRow: true, rows }], {
    page: A4_PORTRAIT,
  });
  const doc = await PDFDocument.load(bytes);

  checkThat('tabel panjang terpaginasi', doc.getPageCount() >= 2, `halaman: ${doc.getPageCount()}`);

  const secondPage = await pageOperators(bytes, 1);
  // Header text is hex-encoded in the content stream.
  const headerHex = Buffer.from('Wilayah', 'latin1').toString('hex').toUpperCase();
  checkThat(
    'header diulang di halaman berikutnya',
    secondPage.toUpperCase().includes(headerHex),
  );
}

/* -------------------------------------------------------------- images --- */
console.log('\npdf-writer — gambar');
{
  // Smallest possible valid PNG: 1x1 red.
  const png =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  const bytes = await renderBlocksToPdf(
    [{ type: 'paragraph', text: 'Sebelum gambar' }, { type: 'image', dataUrl: png }],
    { page: A4_PORTRAIT },
  );

  const raw = Buffer.from(bytes).toString('latin1');
  checkThat('gambar tersisip sebagai XObject', raw.includes('/Image'), 'tidak ada /Image di PDF');

  const ops = await pageOperators(bytes);
  checkThat('gambar benar-benar digambar (operator Do)', /\bDo\b/.test(ops));
}

{
  // EMF/WMF are common in Word (pasted charts) and cannot be embedded. They
  // must leave a visible note, not vanish.
  const bytes = await renderBlocksToPdf(
    [{ type: 'image', dataUrl: 'data:image/x-emf;base64,AAAA' }],
    { page: A4_PORTRAIT },
  );
  const ops = await pageOperators(bytes);
  const hex = Buffer.from('tidak didukung', 'latin1').toString('hex').toUpperCase();
  checkThat('format gambar tak didukung meninggalkan catatan', ops.toUpperCase().includes(hex));
}

{
  const bytes = await renderBlocksToPdf(
    [{ type: 'image', dataUrl: 'bukan-data-uri' }],
    { page: A4_PORTRAIT },
  );
  const doc = await PDFDocument.load(bytes);
  checkThat('data URI rusak tidak menggagalkan konversi', doc.getPageCount() === 1);
}

console.log(
  failures === 0 ? '\nSemua pemeriksaan lolos.\n' : `\n${failures} pemeriksaan GAGAL.\n`,
);

process.exit(failures === 0 ? 0 : 1);
