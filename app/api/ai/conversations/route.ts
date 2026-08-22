import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AI_LIMITS } from '@/lib/supabase/config';
import { apiError, isResponse, requireCaller } from '@/lib/api/guard';

const bodySchema = z.object({
  documentIds: z
    .array(z.string().uuid())
    .min(1)
    .max(AI_LIMITS.maxDocumentsPerConversation),
});

export async function POST(request: Request) {
  const caller = await requireCaller();
  if (isResponse(caller)) return caller;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return apiError(
      'E_UNKNOWN',
      400,
      `Maksimal ${AI_LIMITS.maxDocumentsPerConversation} dokumen per percakapan`,
    );
  }

  // Verify every document exists, belongs to the caller (via RLS), and is
  // actually usable before opening a conversation against it.
  const { data: documents } = await caller.supabase
    .from('documents')
    .select('id, file_name, status')
    .in('id', parsed.data.documentIds);

  if (!documents || documents.length !== parsed.data.documentIds.length) {
    return apiError('E_UNKNOWN', 404, 'Sebagian dokumen tidak ditemukan');
  }

  if (documents.some((document) => document.status !== 'ready')) {
    return apiError('E_UNKNOWN', 409, 'Dokumen belum siap dipakai');
  }

  const { data: conversation, error } = await caller.supabase
    .from('conversations')
    .insert({
      owner_id: caller.userId,
      document_ids: parsed.data.documentIds,
      title: documents[0].file_name,
    })
    .select('id, title, document_ids, message_count, last_message_at')
    .single();

  if (error || !conversation) return apiError('E_UNKNOWN', 500, error?.message);

  return NextResponse.json({
    id: conversation.id,
    title: conversation.title,
    documentIds: conversation.document_ids,
    messageCount: conversation.message_count,
    lastMessageAt: conversation.last_message_at,
  });
}

export async function GET() {
  const caller = await requireCaller();
  if (isResponse(caller)) return caller;

  const { data } = await caller.supabase
    .from('conversations')
    .select('id, title, document_ids, message_count, last_message_at')
    .order('last_message_at', { ascending: false })
    .limit(50);

  return NextResponse.json({
    conversations: (data ?? []).map((row) => ({
      id: row.id,
      title: row.title,
      documentIds: row.document_ids,
      messageCount: row.message_count,
      lastMessageAt: row.last_message_at,
    })),
  });
}
