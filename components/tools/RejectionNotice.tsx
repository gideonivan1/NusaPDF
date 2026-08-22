'use client';

import Link from 'next/link';
import { AlertCircle, X } from 'lucide-react';
import { ERROR_COPY } from '@/lib/errors';
import { truncateMiddle } from '@/lib/utils';
import type { Rejection } from '@/lib/hooks/useFileIntake';

export function RejectionNotice({
  rejections,
  onDismiss,
}: {
  rejections: Rejection[];
  onDismiss: () => void;
}) {
  if (rejections.length === 0) return null;

  return (
    <div
      role="alert"
      className="mb-8 flex gap-3.5 rounded-stadium border border-signal/25 bg-signal/[0.06] px-6 py-5"
    >
      <AlertCircle aria-hidden className="mt-0.5 size-5 shrink-0 text-signal" strokeWidth={1.75} />

      <div className="min-w-0 flex-1">
        <p className="font-medium tracking-[-0.01em] text-ink">
          {rejections.length === 1
            ? '1 berkas tidak dapat ditambahkan'
            : `${rejections.length} berkas tidak dapat ditambahkan`}
        </p>

        <ul className="mt-2.5 flex flex-col gap-2">
          {rejections.map((rejection, index) => (
            <li key={`${rejection.fileName}-${index}`} className="text-[15px] text-granite">
              <span className="font-medium text-ink">
                {truncateMiddle(rejection.fileName, 36)}
              </span>{' '}
              — {ERROR_COPY[rejection.code].title}
              {rejection.suggestion && (
                <>
                  {' '}
                  Mungkin maksud Anda{' '}
                  <Link
                    href={rejection.suggestion.href}
                    className="rounded-micro font-medium text-clay underline underline-offset-4 hover:text-signal"
                  >
                    {rejection.suggestion.label}
                  </Link>
                  ?
                </>
              )}
            </li>
          ))}
        </ul>
      </div>

      <button
        type="button"
        onClick={onDismiss}
        aria-label="Tutup pemberitahuan"
        className="grid size-8 shrink-0 place-items-center rounded-full text-granite transition-colors hover:bg-white hover:text-ink"
      >
        <X aria-hidden className="size-4" />
      </button>
    </div>
  );
}
