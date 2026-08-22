'use client';

import { Fragment } from 'react';
import { Sparkles, User } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ChatMessage as Message } from '@/lib/ai/types';

/**
 * Renders an answer with its inline `[hal. N]` markers turned into clickable
 * chips. Doing this at render time — rather than stripping the markers server
 * side — is what lets the answer stream as plain text and still end up with
 * working citations (PRD §13 US7).
 */
export function ChatMessageBubble({
  message,
  onCite,
}: {
  message: Message;
  onCite: (pageNumber: number) => void;
}) {
  const isUser = message.role === 'user';

  return (
    <article className={cn('flex gap-3.5', isUser && 'flex-row-reverse')}>
      <span
        aria-hidden
        className={cn(
          'grid size-9 shrink-0 place-items-center rounded-full',
          isUser ? 'bg-ink text-canvas' : 'bg-signal-light text-white',
        )}
      >
        {isUser ? (
          <User className="size-4" strokeWidth={2} />
        ) : (
          <Sparkles className="size-4" strokeWidth={2} />
        )}
      </span>

      <div
        className={cn(
          'min-w-0 max-w-[min(46rem,85%)] rounded-stadium px-5 py-4',
          isUser ? 'bg-ink text-canvas' : 'bg-white',
        )}
      >
        <p className="sr-only">{isUser ? 'Anda bertanya' : 'Asisten menjawab'}:</p>

        <div className={cn('text-[15px] leading-[1.55]', isUser && 'text-canvas')}>
          {renderBlocks(message.content, isUser, onCite)}
        </div>

        {message.streaming && (
          <span
            aria-label="Sedang menjawab"
            className="mt-2 inline-block size-2 animate-pulse rounded-full bg-signal-light"
          />
        )}
      </div>
    </article>
  );
}

/**
 * A deliberately small formatter: paragraphs, `- ` bullets, and `**bold**`.
 * The system instruction constrains the model to exactly this vocabulary, so
 * pulling in a full markdown pipeline would add weight for no benefit.
 */
function renderBlocks(
  content: string,
  isUser: boolean,
  onCite: (pageNumber: number) => void,
) {
  const lines = content.split('\n');
  const blocks: React.ReactNode[] = [];
  let bullets: string[] = [];

  const flushBullets = (key: string) => {
    if (bullets.length === 0) return;
    blocks.push(
      <ul key={key} className="my-2 flex list-disc flex-col gap-1.5 pl-5">
        {bullets.map((item, index) => (
          <li key={index}>{renderInline(item, isUser, onCite)}</li>
        ))}
      </ul>,
    );
    bullets = [];
  };

  lines.forEach((line, index) => {
    const trimmed = line.trim();

    if (/^[-*]\s+/.test(trimmed)) {
      bullets.push(trimmed.replace(/^[-*]\s+/, ''));
      return;
    }

    flushBullets(`ul-${index}`);

    if (trimmed.length > 0) {
      blocks.push(
        <p key={`p-${index}`} className="my-1.5 first:mt-0 last:mb-0">
          {renderInline(trimmed, isUser, onCite)}
        </p>,
      );
    }
  });

  flushBullets('ul-end');
  return blocks;
}

function renderInline(
  text: string,
  isUser: boolean,
  onCite: (pageNumber: number) => void,
): React.ReactNode {
  // One pass over both citation markers and bold spans keeps their relative
  // order intact.
  const pattern = /(\[hal\.\s*\d+\])|(\*\*[^*]+\*\*)/gi;
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;

  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > lastIndex) nodes.push(text.slice(lastIndex, start));

    if (match[1]) {
      const page = Number(match[1].replace(/[^\d]/g, ''));
      nodes.push(
        isUser ? (
          <Fragment key={key++}>{match[1]}</Fragment>
        ) : (
          <button
            key={key++}
            type="button"
            onClick={() => onCite(page)}
            aria-label={`Buka halaman ${page} di penampil dokumen`}
            className="mx-0.5 inline-flex items-baseline rounded-pill bg-canvas px-2 py-0.5 align-baseline text-[13px] font-medium text-clay transition-colors hover:bg-signal-light hover:text-white"
          >
            hal. {page}
          </button>
        ),
      );
    } else if (match[2]) {
      nodes.push(
        <strong key={key++} className="font-medium">
          {match[2].slice(2, -2)}
        </strong>,
      );
    }

    lastIndex = start + match[0].length;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}
