import Link from 'next/link';
import { AlertCircle } from 'lucide-react';
import { ERROR_COPY, type ErrorCode } from '@/lib/errors';
import { cn } from '@/lib/utils';

/**
 * PRD §13 US10: every failure states a cause AND a next step. There is
 * deliberately no way to render this component with a generic message — it
 * only accepts codes from the error matrix.
 */
export function ErrorNotice({
  code,
  detail,
  onRetry,
  className,
}: {
  code: ErrorCode;
  detail?: string;
  onRetry?: () => void;
  className?: string;
}) {
  const copy = ERROR_COPY[code];

  return (
    <div
      role="alert"
      className={cn(
        'flex gap-3.5 rounded-stadium border border-signal/25 bg-signal/[0.06] px-6 py-5',
        className,
      )}
    >
      <AlertCircle aria-hidden className="mt-0.5 size-5 shrink-0 text-signal" strokeWidth={1.75} />

      <div className="min-w-0">
        <p className="font-medium tracking-[-0.01em] text-ink">{copy.title}</p>
        <p className="mt-1 text-[15px] leading-[1.45] text-granite">{copy.action}</p>

        {detail && (
          <p className="mt-2 font-mono text-[12px] break-words text-slate">{detail}</p>
        )}

        {(copy.href || onRetry) && (
          <div className="mt-4 flex flex-wrap items-center gap-4">
            {copy.href && (
              <Link
                href={copy.href}
                className="rounded-micro text-[15px] font-medium text-clay underline underline-offset-4 hover:text-signal"
              >
                {copy.hrefLabel}
              </Link>
            )}
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="rounded-micro text-[15px] font-medium text-clay underline underline-offset-4 hover:text-signal"
              >
                Coba lagi
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
