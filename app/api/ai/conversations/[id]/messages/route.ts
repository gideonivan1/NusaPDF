import { z } from 'zod';
import { apiError, isResponse, requireCaller } from '@/lib/api/guard';
import { askDocument, extractCitations } from '@/lib/ai/gemini';
import { AllKeysExhaustedError } from '@/lib/ai/key-pool';
import { retrieveContext } from '@/lib/ai/retrieve';
import { consumeQuota, refundQuota } from '@/lib/ai/quota';

const bodySchema = z.object({
  question: z.string().min(1).max(4000),
});

/** Streaming needs the Node runtime; the Edge runtime caps execution too low. */
export const runtime = 'nodejs';
export const maxDuration = 60;

function sse(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * A retired or misspelled model returns 404 and will keep doing so forever, so
 * it must not be reported as a timeout — that tells the user to retry into a
 * wall. Google retired `gemini-2.5-flash` mid-project and this is exactly how
 * it first surfaced.
 */
function classifyAiFailure(error: unknown): 'E_QUOTA' | 'E_AI_MODEL' | 'E_AI_TIMEOUT' {
  if (error instanceof AllKeysExhaustedError) return 'E_QUOTA';

  const message = error instanceof Error ? error.message : String(error);

  if (/"code":\s*404|not_found|no longer available|is not found for api version/i.test(message)) {
    return 'E_AI_MODEL';
  }

  return 'E_AI_TIMEOUT';
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const caller = await requireCaller();
  if (isResponse(caller)) return caller;

  const { id } = await params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError('E_UNKNOWN', 400, 'Pertanyaan tidak valid');

  const question = parsed.data.question;

  const { data: conversation } = await caller.supabase
    .from('conversations')
    .select('id, document_ids')
    .eq('id', id)
    .maybeSingle();

  if (!conversation) return apiError('E_UNKNOWN', 404, 'Percakapan tidak ditemukan');

  const { data: documents } = await caller.supabase
    .from('documents')
    .select('id, chunk_count, status')
    .in('id', conversation.document_ids);

  if (!documents || documents.length === 0) {
    return apiError('E_UNKNOWN', 404, 'Dokumen percakapan tidak ditemukan');
  }

  if (documents.every((document) => (document.chunk_count ?? 0) === 0)) {
    return apiError('E_UNKNOWN', 409, 'Dokumen belum selesai diindeks');
  }

  // Reserve before spending any Gemini call; refunded on every failure below.
  const quota = await consumeQuota(caller.userId, caller.plan, 'message');
  if (!quota.allowed) return apiError('E_QUOTA', 429, 'Kuota pesan harian habis');

  /* ------------------------------------------------------------- retrieval */
  let retrieval;
  try {
    retrieval = await retrieveContext(caller.supabase, conversation.document_ids, question);
  } catch (error) {
    await refundQuota(caller.userId, 'message');
    const code = classifyAiFailure(error);
    return apiError(
      code,
      code === 'E_QUOTA' ? 429 : code === 'E_AI_MODEL' ? 500 : 502,
      error instanceof Error ? error.message : undefined,
    );
  }

  const { data: history } = await caller.supabase
    .from('messages')
    .select('role, content')
    .eq('conversation_id', id)
    .order('created_at', { ascending: true })
    .limit(20);

  await caller.supabase.from('messages').insert({
    conversation_id: id,
    role: 'user',
    content: question,
  });

  const startedAt = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let answer = '';
      let closed = false;

      // A mutated record rather than a reassigned variable: the assignment
      // happens inside a callback, which the compiler cannot follow, so a
      // `let … | null` would narrow to `null` at every read site.
      const usage: {
        modelId: string | null;
        tokensIn: number | null;
        tokensOut: number | null;
      } = { modelId: null, tokensIn: null, tokensOut: null };

      const close = () => {
        if (!closed) {
          closed = true;
          controller.close();
        }
      };

      try {
        const generator = askDocument(
          {
            chunks: retrieval.chunks,
            history: (history ?? []).map((turn) => ({
              role: turn.role as 'user' | 'assistant',
              content: turn.content,
            })),
            question,
            signal: request.signal,
          },
          (result) => {
            usage.modelId = result.modelId;
            usage.tokensIn = result.tokensIn;
            usage.tokensOut = result.tokensOut;
          },
        );

        for await (const delta of generator) {
          answer += delta;
          controller.enqueue(sse('delta', { text: delta }));
        }

        // Restricted to pages the model was actually shown: a citation that
        // jumps to the wrong page is worse than none, because it looks verified.
        const citations = extractCitations(answer, retrieval.allowedPages).map((citation) => ({
          ...citation,
          documentId: documents[0].id,
        }));

        const { data: saved } = await caller.supabase
          .from('messages')
          .insert({
            conversation_id: id,
            role: 'assistant',
            content: answer,
            citations,
            model_id: usage.modelId,
            tokens_in: usage.tokensIn,
            tokens_out: usage.tokensOut,
            latency_ms: Date.now() - startedAt,
          })
          .select('id')
          .single();

        for (const citation of citations) {
          controller.enqueue(sse('cite', citation));
        }

        controller.enqueue(
          sse('done', {
            messageId: saved?.id ?? null,
            citations,
            quota: quota.status,
            retrieved: retrieval.chunks.length,
          }),
        );
      } catch (error) {
        // The user asked and got nothing usable back, so the quota is returned.
        await refundQuota(caller.userId, 'message');
        controller.enqueue(
          sse('error', {
            code: classifyAiFailure(error),
            detail: error instanceof Error ? error.message : undefined,
          }),
        );
      } finally {
        close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Proxies buffer SSE by default, which defeats streaming entirely.
      'X-Accel-Buffering': 'no',
    },
  });
}
