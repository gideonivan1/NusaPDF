'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Loader2, Send, ServerOff, Upload } from 'lucide-react';
import { AI_LIMITS } from '@/lib/supabase/config';
import { ensureSession, getBrowserSupabase } from '@/lib/supabase/client';
import { openDocument } from '@/lib/pdf/render';
import { NusaError, toErrorCode, type ErrorCode } from '@/lib/errors';
import { getTool } from '@/lib/tools';
import { formatBytes, formatCount } from '@/lib/utils';
import { Button } from '@/components/ui/Button';
import { Dropzone } from '@/components/tools/Dropzone';
import { ErrorNotice } from '@/components/tools/ErrorNotice';
import { ChatMessageBubble } from '@/components/ai/ChatMessage';
import { PdfViewer } from '@/components/ai/PdfViewer';
import type { ChatMessage, QuotaView } from '@/lib/ai/types';

const tool = getTool('ai-pdf');

const SUGGESTED_PROMPTS = [
  'Ringkas dokumen ini dalam 5 poin utama.',
  'Apa saja angka dan tanggal penting di dokumen ini?',
  'Adakah kewajiban atau tenggat yang harus saya perhatikan?',
];

type Phase = 'empty' | 'preparing' | 'ready';

interface PreparedDocument {
  documentId: string;
  conversationId: string;
  localId: string;
  fileName: string;
  pageCount: number;
}

export function AiPdfTool({ configured }: { configured: boolean }) {
  const [phase, setPhase] = useState<Phase>('empty');
  const [step, setStep] = useState('');
  const [document, setDocument] = useState<PreparedDocument | null>(null);
  const [errorCode, setErrorCode] = useState<ErrorCode | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState('');
  const [sending, setSending] = useState(false);
  const [quota, setQuota] = useState<QuotaView | null>(null);

  const [page, setPage] = useState(1);
  const [highlight, setHighlight] = useState(false);

  const threadRef = useRef<HTMLDivElement>(null);

  // Keep the newest turn in view without yanking the page while the user reads.
  useEffect(() => {
    threadRef.current?.scrollTo({
      top: threadRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [messages]);

  const fail = (error: unknown) => {
    setErrorCode(toErrorCode(error));
    setErrorDetail(error instanceof NusaError ? (error.detail ?? null) : String(error));
    setPhase('empty');
  };

  const prepare = useCallback(async (files: File[]) => {
    const file = files[0];
    if (!file) return;

    setErrorCode(null);
    setErrorDetail(null);
    setPhase('preparing');

    try {
      if (file.size > AI_LIMITS.maxFileBytes) throw new NusaError('E_TOO_LARGE');

      const supabase = getBrowserSupabase();
      if (!supabase) throw new NusaError('E_NETWORK');

      setStep('Membaca dokumen di perangkat Anda…');
      const localId = `ai-${Date.now()}`;
      const info = await openDocument(localId, file);

      if (!info.hasTextLayer) throw new NusaError('E_SCANNED_NO_TEXT');
      if (info.pageCount > AI_LIMITS.maxPages) {
        throw new NusaError('E_TOO_LARGE', `Maksimal ${AI_LIMITS.maxPages} halaman`);
      }

      setStep('Menyiapkan sesi…');
      await ensureSession();

      setStep('Mengunggah ke ruang aman…');
      const urlResponse = await fetch('/api/documents/upload-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: file.name, sizeBytes: file.size }),
      });

      if (!urlResponse.ok) throw await toError(urlResponse);
      const { documentId, path, token } = await urlResponse.json();

      const { error: uploadError } = await supabase.storage
        .from('ai-documents')
        .uploadToSignedUrl(path, token, file);

      if (uploadError) throw new NusaError('E_NETWORK', uploadError.message);

      setStep('Mempelajari isi dokumen…');
      const ingestResponse = await fetch(`/api/documents/${documentId}/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hasTextLayer: info.hasTextLayer }),
      });

      if (!ingestResponse.ok) throw await toError(ingestResponse);

      const conversationResponse = await fetch('/api/ai/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentIds: [documentId] }),
      });

      if (!conversationResponse.ok) throw await toError(conversationResponse);
      const conversation = await conversationResponse.json();

      setDocument({
        documentId,
        conversationId: conversation.id,
        localId,
        fileName: file.name,
        pageCount: info.pageCount,
      });
      setPage(1);
      setMessages([]);
      setPhase('ready');

      void fetch('/api/quota')
        .then((response) => (response.ok ? response.json() : null))
        .then(setQuota)
        .catch(() => {});
    } catch (error) {
      fail(error);
    }
  }, []);

  const ask = async (text: string) => {
    if (!document || sending || !text.trim()) return;

    const trimmed = text.trim();
    setQuestion('');
    setSending(true);
    setErrorCode(null);

    const assistantId = `pending-${Date.now()}`;

    setMessages((current) => [
      ...current,
      {
        id: `user-${Date.now()}`,
        role: 'user',
        content: trimmed,
        citations: null,
        createdAt: new Date().toISOString(),
      },
      {
        id: assistantId,
        role: 'assistant',
        content: '',
        citations: null,
        createdAt: new Date().toISOString(),
        streaming: true,
      },
    ]);

    try {
      const response = await fetch(
        `/api/ai/conversations/${document.conversationId}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: trimmed }),
        },
      );

      if (!response.ok || !response.body) throw await toError(response);

      await readSse(response.body, {
        onDelta: (delta) =>
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantId
                ? { ...message, content: message.content + delta }
                : message,
            ),
          ),
        onDone: (payload) => {
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantId
                ? {
                    ...message,
                    id: payload.messageId ?? message.id,
                    citations: payload.citations ?? null,
                    streaming: false,
                  }
                : message,
            ),
          );
          if (payload.quota) setQuota(payload.quota);
        },
        onError: (code, detail) => {
          setMessages((current) => current.filter((message) => message.id !== assistantId));
          setErrorCode(code);
          setErrorDetail(detail ?? null);
        },
      });
    } catch (error) {
      setMessages((current) => current.filter((message) => message.id !== assistantId));
      setErrorCode(toErrorCode(error));
      setErrorDetail(error instanceof NusaError ? (error.detail ?? null) : null);
    } finally {
      setSending(false);
    }
  };

  const jumpToPage = (target: number) => {
    if (!document) return;
    setPage(Math.min(Math.max(1, target), document.pageCount));
    setHighlight(true);
    window.setTimeout(() => setHighlight(false), 1500);
  };

  /* ------------------------------------------------------- Not configured */
  if (!configured) {
    return (
      <div className="container-page pb-24">
        <Header />
        <div className="max-w-2xl rounded-stadium bg-lifted p-10 shadow-card">
          <span className="grid size-14 place-items-center rounded-full bg-canvas">
            <ServerOff aria-hidden className="size-6 text-granite" strokeWidth={1.5} />
          </span>
          <h2 className="mt-6 text-cardtitle">AI PDF belum diaktifkan di server ini</h2>
          <p className="mt-3 text-[16px] leading-[1.5] text-granite">
            Modul ini memerlukan kredensial Supabase dan Gemini. Isi{' '}
            <code className="rounded-micro bg-white px-1.5 py-0.5 text-[14px]">.env.local</code>{' '}
            mengikuti{' '}
            <code className="rounded-micro bg-white px-1.5 py-0.5 text-[14px]">.env.example</code>
            , lalu jalankan ulang server.
          </p>
          <p className="mt-4 text-[16px] leading-[1.5] text-granite">
            Seluruh alat lain tetap berfungsi penuh — semuanya berjalan di peramban Anda dan
            tidak memerlukan server sama sekali.
          </p>
          <Button asChild variant="secondary" size="lg" className="mt-8">
            <Link href="/#perkakas">Lihat alat lainnya</Link>
          </Button>
        </div>
      </div>
    );
  }

  /* ------------------------------------------------------------ Workspace */
  if (phase === 'ready' && document) {
    return (
      <div className="container-page pb-16">
        <div className="flex flex-wrap items-center justify-between gap-4 pt-2 pb-6">
          <div className="min-w-0">
            <h1 className="truncate text-[24px] font-medium tracking-[-0.02em]">
              {document.fileName}
            </h1>
            <p className="mt-1 text-[14px] text-slate">
              {formatCount(document.pageCount)} halaman
              {quota && ` · sisa ${formatCount(quota.messagesRemaining)} pertanyaan hari ini`}
            </p>
          </div>

          <Button
            variant="secondary"
            onClick={() => {
              setPhase('empty');
              setDocument(null);
              setMessages([]);
            }}
          >
            Ganti dokumen
          </Button>
        </div>

        <div className="grid gap-6 lg:h-[calc(100dvh-16rem)] lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <section
            aria-label="Penampil dokumen"
            className="order-2 min-h-0 overflow-hidden rounded-stadium bg-lifted shadow-card lg:order-1"
          >
            <PdfViewer
              docId={document.localId}
              pageCount={document.pageCount}
              page={page}
              onPageChange={setPage}
              highlight={highlight}
            />
          </section>

          <section
            aria-label="Percakapan"
            className="order-1 flex min-h-[26rem] flex-col overflow-hidden rounded-stadium bg-canvas lg:order-2"
          >
            <div ref={threadRef} className="min-h-0 flex-1 overflow-y-auto p-1">
              {messages.length === 0 ? (
                <div className="flex h-full flex-col justify-end gap-3 p-4">
                  <p className="text-[15px] text-granite">
                    Ajukan pertanyaan tentang dokumen ini. Setiap jawaban akan menyertakan
                    nomor halaman yang bisa Anda klik untuk memeriksanya sendiri.
                  </p>
                  <ul className="flex flex-col gap-2">
                    {SUGGESTED_PROMPTS.map((prompt) => (
                      <li key={prompt}>
                        <button
                          type="button"
                          onClick={() => void ask(prompt)}
                          className="w-full rounded-pill bg-white px-5 py-3 text-left text-[15px] text-ink transition-colors hover:bg-lifted"
                        >
                          {prompt}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div className="flex flex-col gap-5 p-3">
                  {messages.map((message) => (
                    <ChatMessageBubble
                      key={message.id}
                      message={message}
                      onCite={jumpToPage}
                    />
                  ))}
                </div>
              )}
            </div>

            {errorCode && (
              <ErrorNotice
                code={errorCode}
                detail={errorDetail ?? undefined}
                className="mx-3 mb-3"
              />
            )}

            <form
              onSubmit={(event) => {
                event.preventDefault();
                void ask(question);
              }}
              className="flex items-end gap-2 border-t border-dust/60 p-3"
            >
              <label htmlFor="pertanyaan" className="sr-only">
                Pertanyaan Anda
              </label>
              <textarea
                id="pertanyaan"
                rows={1}
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void ask(question);
                  }
                }}
                placeholder="Tanyakan sesuatu tentang dokumen ini…"
                className="max-h-40 min-h-12 flex-1 resize-none rounded-stadium border border-dust bg-white px-5 py-3.5 text-[15px] outline-none focus:border-ink"
              />
              <Button
                type="submit"
                disabled={sending || question.trim().length === 0}
                className="h-12 px-5"
              >
                {sending ? (
                  <Loader2 aria-hidden className="size-4 animate-spin" />
                ) : (
                  <Send aria-hidden className="size-4" />
                )}
                <span className="sr-only">Kirim pertanyaan</span>
              </Button>
            </form>
          </section>
        </div>
      </div>
    );
  }

  /* --------------------------------------------------------- Upload / prep */
  return (
    <div className="container-page pb-24">
      <Header />

      {errorCode && (
        <ErrorNotice
          code={errorCode}
          detail={errorDetail ?? undefined}
          className="mb-8 max-w-2xl"
        />
      )}

      {phase === 'preparing' ? (
        <div className="max-w-2xl rounded-stadium bg-lifted p-10 shadow-card">
          <Loader2 aria-hidden className="size-6 animate-spin text-granite" />
          <p aria-live="polite" className="mt-5 text-[17px] font-medium">
            {step}
          </p>
          <p className="mt-2 text-[15px] text-granite">
            Ini biasanya memakan waktu beberapa detik.
          </p>
        </div>
      ) : (
        <>
          {/* AI PDF is the one MVP flow that uploads. Saying so plainly, right
              above the dropzone, is the whole point of the privacy promise. */}
          <div className="mb-8 flex max-w-2xl gap-3.5 rounded-stadium border border-clay/25 bg-clay/[0.05] px-6 py-5">
            <Upload aria-hidden className="mt-0.5 size-5 shrink-0 text-clay" strokeWidth={1.75} />
            <div>
              <p className="font-medium tracking-[-0.01em]">
                Berbeda dari alat lain, dokumen ini akan diunggah.
              </p>
              <p className="mt-1 text-[15px] leading-[1.45] text-granite">
                Untuk dapat menjawab, asisten perlu membaca dokumen di server. Berkas Anda
                disimpan terenkripsi, hanya dapat diakses oleh akun Anda, dan dihapus
                otomatis dalam 24 jam. Maksimal {formatBytes(AI_LIMITS.maxFileBytes)} dan{' '}
                {formatCount(AI_LIMITS.maxPages)} halaman.
              </p>
            </div>
          </div>

          <Dropzone tool={tool} onFiles={(files) => void prepare(files)} />
        </>
      )}
    </div>
  );
}

function Header() {
  return (
    <header className="max-w-3xl pt-6 pb-10">
      <p className="flex items-center gap-2 text-eyebrow font-bold text-slate uppercase">
        <span aria-hidden className="size-[6px] rounded-full bg-signal-light" />
        AI
      </p>
      <h1 className="mt-5 text-[clamp(34px,5vw,52px)] leading-[1.05] font-medium tracking-[-0.02em]">
        AI PDF
      </h1>
      <p className="mt-5 max-w-xl text-[17px] leading-[1.5] text-granite">
        {tool.description}
      </p>
    </header>
  );
}

/* -------------------------------------------------------------- helpers -- */

async function toError(response: Response): Promise<NusaError> {
  const body = await response.json().catch(() => null);
  const code = (body?.error?.code as ErrorCode | undefined) ?? 'E_UNKNOWN';
  return new NusaError(code, body?.error?.detail);
}

interface SseHandlers {
  onDelta: (text: string) => void;
  onDone: (payload: {
    messageId?: string | null;
    citations?: { pageNumber: number }[];
    quota?: QuotaView;
  }) => void;
  onError: (code: ErrorCode, detail?: string) => void;
}

/** Minimal SSE reader — the payloads here are simple enough not to need a lib. */
async function readSse(body: ReadableStream<Uint8Array>, handlers: SseHandlers) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Events are separated by a blank line; a partial tail stays in the buffer.
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';

    for (const chunk of chunks) {
      const eventLine = chunk.match(/^event:\s*(.+)$/m);
      const dataLine = chunk.match(/^data:\s*(.+)$/m);
      if (!eventLine || !dataLine) continue;

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(dataLine[1]);
      } catch {
        continue;
      }

      switch (eventLine[1].trim()) {
        case 'delta':
          handlers.onDelta(String(payload.text ?? ''));
          break;
        case 'done':
          handlers.onDone(payload as Parameters<SseHandlers['onDone']>[0]);
          break;
        case 'error':
          handlers.onError(
            (payload.code as ErrorCode | undefined) ?? 'E_AI_TIMEOUT',
            payload.detail as string | undefined,
          );
          break;
      }
    }
  }
}
