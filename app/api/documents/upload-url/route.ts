import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AI_LIMITS } from '@/lib/supabase/config';
import { apiError, isResponse, requireCaller } from '@/lib/api/guard';
import { consumeQuota, refundQuota } from '@/lib/ai/quota';

const bodySchema = z.object({
  fileName: z.string().min(1).max(255),
  sizeBytes: z.number().int().positive().max(AI_LIMITS.maxFileBytes),
});

/**
 * Hands back a signed URL so the browser uploads straight to Storage rather
 * than streaming a 50 MB body through a serverless function.
 */
export async function POST(request: Request) {
  const caller = await requireCaller();
  if (isResponse(caller)) return caller;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return apiError('E_TOO_LARGE', 400, `Berkas maksimal ${AI_LIMITS.maxFileBytes} byte`);
  }

  // Reserve document quota before doing any work; refunded below if the
  // storage call fails, so a server error never costs the user an upload.
  const quota = await consumeQuota(caller.userId, caller.plan, 'document');
  if (!quota.allowed) {
    return apiError('E_QUOTA', 429, 'Kuota dokumen harian habis');
  }

  const { data: document, error: insertError } = await caller.supabase
    .from('documents')
    .insert({
      owner_id: caller.userId,
      storage_path: '',
      file_name: parsed.data.fileName,
      mime_type: 'application/pdf',
      size_bytes: parsed.data.sizeBytes,
      status: 'uploading',
    })
    .select('id')
    .single();

  if (insertError || !document) {
    await refundQuota(caller.userId, 'document');
    return apiError('E_UNKNOWN', 500, insertError?.message);
  }

  // The first path segment is the owner id — that is what the storage RLS
  // policy checks.
  const storagePath = `${caller.userId}/${document.id}.pdf`;

  const { data: signed, error: signError } = await caller.supabase.storage
    .from('ai-documents')
    .createSignedUploadUrl(storagePath);

  if (signError || !signed) {
    await refundQuota(caller.userId, 'document');
    await caller.supabase.from('documents').delete().eq('id', document.id);
    return apiError('E_UNKNOWN', 500, signError?.message);
  }

  await caller.supabase
    .from('documents')
    .update({ storage_path: storagePath })
    .eq('id', document.id);

  return NextResponse.json({
    documentId: document.id,
    path: storagePath,
    token: signed.token,
    quota: quota.status,
  });
}
