import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AI_LIMITS } from '@/lib/supabase/config';
import { apiError, isResponse, requireCaller } from '@/lib/api/guard';
import { chunkPages, estimateTokens, extractPageTexts } from '@/lib/ai/extract';
import { embedDocuments } from '@/lib/ai/embed';
import { AllKeysExhaustedError } from '@/lib/ai/key-pool';
import { refundQuota } from '@/lib/ai/quota';

/** Indexing a long PDF is the slowest operation in the app. */
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * Separates "this document is broken" from "this server is broken".
 *
 * Treating every extraction failure as E_CORRUPT once told users their
 * perfectly valid PDF was damaged when the real cause was a bundling problem
 * with the pdf.js worker. Blaming the user's file for our own misconfiguration
 * is exactly the kind of message PRD §6 rules out.
 */
function classifyExtractionFailure(message: string): {
  code: 'E_ENCRYPTED' | 'E_CORRUPT' | 'E_UNKNOWN';
  status: number;
} {
  if (/password|encrypt/i.test(message)) {
    return { code: 'E_ENCRYPTED', status: 422 };
  }

  // Worker setup, module resolution, missing files — all environment faults.
  if (
    /fake worker|worker.*(fail|not found)|cannot find module|failed to resolve|import.*not found|ERR_MODULE_NOT_FOUND/i.test(
      message,
    )
  ) {
    return { code: 'E_UNKNOWN', status: 500 };
  }

  if (/invalid pdf|structure|xref|corrupt|unexpected/i.test(message)) {
    return { code: 'E_CORRUPT', status: 422 };
  }

  // Unrecognised: assume ours, not theirs. A 500 prompts us to look at logs;
  // a 422 would quietly send the user away thinking their file is bad.
  return { code: 'E_UNKNOWN', status: 500 };
}

const bodySchema = z.object({
  /**
   * Text-layer detection also runs in the browser, which has already parsed the
   * PDF for the preview. Treated as a hint only — the authoritative check is
   * whether extraction below actually yields text.
   */
  hasTextLayer: z.boolean(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const caller = await requireCaller();
  if (isResponse(caller)) return caller;

  const { id } = await params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError('E_UNKNOWN', 400, 'Body tidak valid');

  // RLS restricts this to the caller's own rows.
  const { data: document } = await caller.supabase
    .from('documents')
    .select('id, storage_path, file_name, status')
    .eq('id', id)
    .maybeSingle();

  if (!document) return apiError('E_UNKNOWN', 404, 'Dokumen tidak ditemukan');

  const fail = async (
    code: Parameters<typeof apiError>[0],
    status: number,
    detail?: string,
  ) => {
    await caller.supabase
      .from('documents')
      .update({ status: 'failed', error_code: code })
      .eq('id', id);
    await refundQuota(caller.userId, 'document');
    return apiError(code, status, detail);
  };

  if (!parsed.data.hasTextLayer) {
    // Rejected before any Gemini call, so the message quota stays untouched
    // (PRD §13 US6).
    return fail('E_SCANNED_NO_TEXT', 422);
  }

  const { data: blob, error: downloadError } = await caller.supabase.storage
    .from('ai-documents')
    .download(document.storage_path);

  if (downloadError || !blob) return fail('E_UNKNOWN', 500, downloadError?.message);

  await caller.supabase.from('documents').update({ status: 'processing' }).eq('id', id);

  /* ------------------------------------------------------------ extraction */
  let pages;
  try {
    pages = await extractPageTexts(new Uint8Array(await blob.arrayBuffer()));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const { code, status } = classifyExtractionFailure(message);
    return fail(code, status, message);
  }

  if (pages.length > AI_LIMITS.maxPages) {
    return fail('E_TOO_LARGE', 422, `Maksimal ${AI_LIMITS.maxPages} halaman`);
  }

  const chunks = chunkPages(pages);

  // The real scanned-document check: a PDF of page images parses fine and
  // yields nothing extractable.
  if (chunks.length === 0) return fail('E_SCANNED_NO_TEXT', 422);

  /* ------------------------------------------------------------- embedding */
  let embeddings: number[][];
  try {
    embeddings = await embedDocuments(chunks.map((chunk) => chunk.content));
  } catch (error) {
    if (error instanceof AllKeysExhaustedError) {
      return fail('E_QUOTA', 429, 'Seluruh kunci Gemini sedang mencapai batas');
    }
    return fail('E_AI_TIMEOUT', 502, error instanceof Error ? error.message : undefined);
  }

  /* --------------------------------------------------------------- storage */
  // Re-indexing must not leave stale chunks behind.
  await caller.supabase.from('document_chunks').delete().eq('document_id', id);

  const rows = chunks.map((chunk, index) => ({
    document_id: id,
    owner_id: caller.userId,
    page_number: chunk.pageNumber,
    chunk_index: chunk.chunkIndex,
    content: chunk.content,
    token_estimate: estimateTokens(chunk.content),
    embedding: embeddings[index],
  }));

  // Inserted in batches: a single statement carrying thousands of 768-float
  // vectors exceeds the request size limit on large documents.
  const INSERT_BATCH = 200;
  for (let index = 0; index < rows.length; index += INSERT_BATCH) {
    const { error: insertError } = await caller.supabase
      .from('document_chunks')
      .insert(rows.slice(index, index + INSERT_BATCH));

    if (insertError) return fail('E_UNKNOWN', 500, insertError.message);
  }

  const { data: updated, error: updateError } = await caller.supabase
    .from('documents')
    .update({
      status: 'ready',
      page_count: pages.length,
      has_text_layer: true,
      chunk_count: chunks.length,
      indexed_at: new Date().toISOString(),
      error_code: null,
    })
    .eq('id', id)
    .select('id, file_name, size_bytes, page_count, chunk_count, status, created_at')
    .single();

  if (updateError || !updated) return apiError('E_UNKNOWN', 500, updateError?.message);

  return NextResponse.json({
    id: updated.id,
    fileName: updated.file_name,
    sizeBytes: updated.size_bytes,
    pageCount: updated.page_count,
    chunkCount: updated.chunk_count,
    hasTextLayer: true,
    status: updated.status,
    createdAt: updated.created_at,
  });
}
