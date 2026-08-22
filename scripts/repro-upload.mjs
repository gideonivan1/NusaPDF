/**
 * Reproduces the AI PDF upload flow outside the browser, holding cookies in a
 * jar exactly as a browser would, and reports which user id the server resolves
 * at each step.
 *
 * The point is to tell two very different failures apart: an RLS policy that
 * rejects the owner, versus a session that is not stable across requests. RLS
 * already checked out, so this isolates the session.
 *
 * Run: npm run repro:upload   (dev server must be running)
 */
import { readFile } from 'node:fs/promises';
import { createBrowserClient } from '@supabase/ssr';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const raw = await readFile(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of raw.split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && m[2].trim()) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '');
}

const BASE = process.env.REPRO_BASE_URL ?? 'http://localhost:3000';

/* ------------------------------------------------------------- cookie jar */
const jar = new Map();

const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  {
    cookies: {
      getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
      setAll: (list) => {
        for (const { name, value } of list) jar.set(name, value);
      },
    },
  },
);

const cookieHeader = () =>
  [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');

/** Mirrors what a browser does with Set-Cookie so rotation is followed. */
function absorb(response) {
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';');
    const index = pair.indexOf('=');
    if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
}

async function call(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), cookie: cookieHeader() },
  });
  absorb(response);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 200);
  }
  return { status: response.status, body };
}

/* ------------------------------------------------------------------- run */
console.log('\nNusaPDF — reproduksi alur unggah AI PDF\n');

const { data: signIn, error: signInError } = await supabase.auth.signInAnonymously();
if (signInError) {
  console.log('GAGAL sign-in anonim:', signInError.message);
  process.exit(1);
}

const clientUid = signIn.user?.id;
console.log(`  klien   uid setelah sign-in : ${clientUid}`);
console.log(`  klien   cookie di jar       : ${[...jar.keys()].join(', ') || '(kosong)'}`);

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const page = doc.addPage([420, 300]);
page.drawText(
  'Anggaran naik dua belas persen pada tahun 2024 sementara kapasitas terpasang tetap sama sejak 2019 sehingga kesenjangan layanan melebar cukup jauh.',
  { x: 20, y: 250, size: 10, font, color: rgb(0, 0, 0), maxWidth: 380, lineHeight: 14 },
);
const pdfBytes = await doc.save();

const upload = await call('/api/documents/upload-url', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ fileName: 'repro.pdf', sizeBytes: pdfBytes.byteLength }),
});

console.log(`\n  POST upload-url          : ${upload.status}`);
if (upload.status !== 200) {
  console.log('  body:', JSON.stringify(upload.body).slice(0, 300));
  process.exit(1);
}

const { documentId, path, token } = upload.body;
console.log(`  documentId               : ${documentId}`);

const { error: putError } = await supabase.storage
  .from('ai-documents')
  .uploadToSignedUrl(path, token, new Blob([pdfBytes], { type: 'application/pdf' }));

console.log(`  unggah ke storage        : ${putError ? `GAGAL ${putError.message}` : 'OK'}`);
if (putError) process.exit(1);

const ingest = await call(`/api/documents/${documentId}/ingest`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ hasTextLayer: true }),
});

console.log(`\n  POST ingest              : ${ingest.status}`);
console.log('  body:', JSON.stringify(ingest.body).slice(0, 400));

if (ingest.status !== 200) process.exit(1);

const conversation = await call('/api/ai/conversations', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ documentIds: [documentId] }),
});
console.log(`\n  POST conversations       : ${conversation.status}`);
if (conversation.status !== 200) {
  console.log('  body:', JSON.stringify(conversation.body).slice(0, 300));
  process.exit(1);
}

/* ------------------------------------------------------------- ask a question */
// The SSE endpoint is the last untested link: retrieval, the generation model,
// and citation extraction all run here.
const question = 'Berapa persen kenaikan anggaran, dan sejak tahun berapa kapasitas tidak berubah?';
console.log(`\n  Bertanya: "${question}"`);

const answerResponse = await fetch(
  `${BASE}/api/ai/conversations/${conversation.body.id}/messages`,
  {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookieHeader() },
    body: JSON.stringify({ question }),
  },
);

console.log(`  POST messages            : ${answerResponse.status} ${answerResponse.headers.get('content-type')}`);

if (!answerResponse.body) {
  console.log('  (tidak ada body stream)');
  process.exit(1);
}

const reader = answerResponse.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
let answer = '';
let done = null;
let failure = null;

while (true) {
  const { done: finished, value } = await reader.read();
  if (finished) break;
  buffer += decoder.decode(value, { stream: true });
  const chunks = buffer.split('\n\n');
  buffer = chunks.pop() ?? '';
  for (const chunk of chunks) {
    const event = chunk.match(/^event:\s*(.+)$/m)?.[1]?.trim();
    const data = chunk.match(/^data:\s*(.+)$/m)?.[1];
    if (!event || !data) continue;
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      continue;
    }
    if (event === 'delta') answer += payload.text ?? '';
    if (event === 'done') done = payload;
    if (event === 'error') failure = payload;
  }
}

if (failure) {
  console.log(`\n  GAGAL menjawab: ${failure.code}`);
  console.log('  detail:', String(failure.detail).replace(/\s+/g, ' ').slice(0, 300));
  process.exit(1);
}

console.log(`\n  Jawaban:\n    ${answer.trim().replace(/\n/g, '\n    ')}`);
console.log(`\n  Potongan diambil         : ${done?.retrieved ?? '?'}`);
console.log(`  Sitasi                   : ${JSON.stringify(done?.citations ?? [])}`);
console.log(`  Sisa kuota pesan         : ${done?.quota?.messagesRemaining ?? '?'}`);
console.log();
