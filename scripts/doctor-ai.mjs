/**
 * Checks every prerequisite AI PDF needs, and says exactly which one is missing.
 *
 * Without this, a half-configured setup surfaces as a generic 503 from the API
 * and there is no way to tell whether the key is wrong, the migration never
 * ran, or the bucket does not exist.
 *
 * Run: npm run doctor:ai
 */
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';

/* --------------------------------------------------------- load .env.local */
try {
  const raw = await readFile(new URL('../.env.local', import.meta.url), 'utf8');
  for (const line of raw.split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const value = match[2].replace(/^["']|["']$/g, '').trim();
    if (value) process.env[match[1]] ??= value;
  }
} catch {
  // Reported as a failed check below.
}

// Read from the same place the app does, so the doctor can never drift from
// what actually runs.
const { MODEL_FAST: GENERATION_MODEL } = await import('../lib/ai/gemini.ts');
const { EMBEDDING_MODEL } = await import('../lib/ai/embed.ts');

let problems = 0;

const ok = (label, detail = '') => console.log(`  OK    ${label}${detail ? ` — ${detail}` : ''}`);
const bad = (label, fix) => {
  problems++;
  console.log(`  BELUM ${label}`);
  if (fix) console.log(`        → ${fix}`);
};

console.log('\nNusaPDF — kesiapan AI PDF\n');

/* ------------------------------------------------------------ environment */
console.log('Variabel lingkungan');

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const service = process.env.SUPABASE_SERVICE_ROLE_KEY;

const geminiKeys = [
  ['GEMINI_API_KEY', process.env.GEMINI_API_KEY],
  ['GEMINI_API_KEY_2', process.env.GEMINI_API_KEY_2],
  ['GEMINI_API_KEY_3', process.env.GEMINI_API_KEY_3],
  ['GEMINI_API_KEY_4', process.env.GEMINI_API_KEY_4],
].filter(([, value]) => value && value !== 'undefined' && value !== 'null');

url ? ok('NEXT_PUBLIC_SUPABASE_URL', url) : bad('NEXT_PUBLIC_SUPABASE_URL', 'Salin dari Supabase → Project Settings → Data API');
anon ? ok('NEXT_PUBLIC_SUPABASE_ANON_KEY') : bad('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'Kunci publishable/anon dari halaman yang sama');
service ? ok('SUPABASE_SERVICE_ROLE_KEY') : bad('SUPABASE_SERVICE_ROLE_KEY', 'Kunci secret/service_role — JANGAN diberi awalan NEXT_PUBLIC_');

if (geminiKeys.length > 0) {
  ok(`Kunci Gemini (${geminiKeys.length})`, geminiKeys.map(([name]) => name).join(', '));
} else {
  bad('GEMINI_API_KEY', 'Ambil di https://aistudio.google.com/apikey');
}

/* -------------------------------------------------------------- supabase */
if (url && anon && service) {
  console.log('\nSupabase');
  const admin = createClient(url, service, { auth: { persistSession: false } });

  const tables = [
    'profiles',
    'documents',
    'conversations',
    'messages',
    'ai_quota',
    'document_chunks',
  ];

  let missing = [];
  for (const table of tables) {
    const { error } = await admin.from(table).select('*', { head: true, count: 'exact' }).limit(0);
    if (error) missing.push(table);
  }

  if (missing.length === 0) {
    ok('Seluruh tabel ada', tables.join(', '));
  } else if (missing.includes('document_chunks') && missing.length === 1) {
    bad('Tabel document_chunks belum ada', 'Jalankan supabase/migrations/0002_rag.sql');
  } else {
    bad(`Tabel belum ada: ${missing.join(', ')}`, 'Jalankan 0001_initial_schema.sql lalu 0002_rag.sql');
  }

  // The retrieval RPC is the piece most likely to exist-but-not-work, because
  // a bad search_path only fails when it is actually called.
  if (!missing.includes('document_chunks')) {
    const { error } = await admin.rpc('match_document_chunks', {
      query_embedding: Array.from({ length: 768 }, () => 0),
      target_document_ids: [],
      match_count: 1,
      min_similarity: 0,
    });
    if (error) {
      bad(`Fungsi match_document_chunks gagal: ${error.message}`, 'Jalankan ulang 0002_rag.sql');
    } else {
      ok('Fungsi retrieval match_document_chunks berjalan');
    }
  }

  const { data: buckets, error: bucketError } = await admin.storage.listBuckets();
  if (bucketError) {
    bad(`Tidak bisa membaca bucket: ${bucketError.message}`);
  } else if (buckets.some((bucket) => bucket.id === 'ai-documents')) {
    ok('Bucket ai-documents ada');
  } else {
    bad('Bucket ai-documents belum ada', 'Dibuat oleh 0001_initial_schema.sql');
  }

}

/* ------------------------------------------------------- anonymous sign-in */
// Checked separately from the block above because it needs only the URL and
// the publishable key — so it can be verified before the service role key is
// in place. It also exercises the handle_new_user trigger for real.
if (url && anon) {
  console.log('\nAutentikasi');

  const { data, error } = await createClient(url, anon, {
    auth: { persistSession: false },
  }).auth.signInAnonymously();

  if (error) {
    bad(
      `Sign-in anonim ditolak: ${error.message}`,
      'Aktifkan di Supabase → Authentication → Sign In / Providers → Anonymous sign-ins',
    );
  } else {
    ok('Sign-in anonim aktif', `uid ${data.user?.id?.slice(0, 8)}…`);
  }
}

/* ---------------------------------------------------------------- gemini */
if (geminiKeys.length > 0) {
  console.log('\nGemini');

  for (const [name, key] of geminiKeys) {
    try {
      const response = await new GoogleGenAI({ apiKey: key }).models.embedContent({
        model: EMBEDDING_MODEL,
        contents: ['uji koneksi'],
        config: { outputDimensionality: 768 },
      });
      const length = response.embeddings?.[0]?.values?.length ?? 0;
      if (length === 768) ok(`${name} — embedding`, `${EMBEDDING_MODEL}, 768 dimensi`);
      else bad(`${name} mengembalikan ${length} dimensi`, 'Model tidak mendukung outputDimensionality');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      bad(`${name} gagal: ${message.slice(0, 120)}`, 'Periksa kembali kuncinya di AI Studio');
    }
  }

  /**
   * Generation is checked separately, and this is the check that matters most:
   * embeddings and answers use *different* models, so a working embedding call
   * proves nothing about the chat model. Google retired `gemini-2.5-flash`
   * mid-project and, because only embeddings were verified here, it stayed
   * invisible until a user asked their first question.
   */
  const [firstKeyName, firstKey] = geminiKeys[0];

  try {
    const stream = await new GoogleGenAI({ apiKey: firstKey }).models.generateContentStream({
      model: GENERATION_MODEL,
      contents: [{ role: 'user', parts: [{ text: 'Balas persis satu kata: SIAP' }] }],
      config: { temperature: 0, maxOutputTokens: 2048 },
    });

    let answer = '';
    for await (const chunk of stream) if (chunk.text) answer += chunk.text;

    if (answer.trim()) ok(`${firstKeyName} — generasi`, `${GENERATION_MODEL} menjawab`);
    else bad(`${GENERATION_MODEL} tidak mengembalikan teks`);
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ');
    const retired = /404|no longer available|not found/i.test(message);
    bad(
      `Model generasi ${GENERATION_MODEL} gagal: ${message.slice(0, 110)}`,
      retired
        ? 'Model ini sudah dipensiunkan. Setel GEMINI_MODEL_FAST di .env.local ke model yang masih aktif (mis. gemini-flash-latest).'
        : 'Periksa kuota dan ketersediaan model untuk kunci ini.',
    );
  }
}

console.log(
  problems === 0
    ? '\nSemua prasyarat siap. Jalankan `npm run dev` lalu buka /ai-pdf.\n'
    : `\n${problems} hal masih perlu diselesaikan (lihat tanda BELUM di atas).\n`,
);

process.exit(problems === 0 ? 0 : 1);
