'use client';

import { useEffect } from 'react';
import { Lock, Trash2, X } from 'lucide-react';
import { CATEGORY_LABEL, type ToolDefinition } from '@/lib/tools';
import { useQueue } from '@/lib/store/queue';
import { cn, formatCount } from '@/lib/utils';
import { Button } from '@/components/ui/Button';
import { Dropzone } from '@/components/tools/Dropzone';
import { ErrorNotice } from '@/components/tools/ErrorNotice';
import { ResultPanel } from '@/components/tools/ResultPanel';
import type { RunState } from '@/lib/hooks/useToolRun';

interface Props {
  tool: ToolDefinition;
  run: RunState;
  /** Options panel content — rendered in the right rail on desktop. */
  options?: React.ReactNode;
  /** Queue / preview content — rendered in the main column. */
  children?: React.ReactNode;
  onFiles: (files: File[]) => void;
  onRun: () => void;
  onCancel: () => void;
  onReset: () => void;
  canRun: boolean;
  /** Why the run button is disabled, shown next to it. */
  blockedReason?: string;
  runLabel: string;
}

export function ToolShell({
  tool,
  run,
  options,
  children,
  onFiles,
  onRun,
  onCancel,
  onReset,
  canRun,
  blockedReason,
  runLabel,
}: Props) {
  const files = useQueue((s) => s.files);
  const clear = useQueue((s) => s.clear);
  const undo = useQueue((s) => s.undo);
  const redo = useQueue((s) => s.redo);

  const empty = files.length === 0;
  const busy = run.phase === 'running';

  // Clear the queue when leaving the tool. Files are session-only by design
  // (PRD §10) and carrying them between tools would be surprising.
  useEffect(() => () => clear(), [clear]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const meta = event.ctrlKey || event.metaKey;

      if (meta && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }

      if (meta && event.key === 'Enter' && canRun && !busy) {
        event.preventDefault();
        onRun();
        return;
      }

      if (event.key === 'Escape' && busy) {
        event.preventDefault();
        onCancel();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, canRun, busy, onRun, onCancel]);

  return (
    <div className="container-page pb-24">
      {/* ------------------------------------------------------------ Header */}
      <header className="max-w-3xl pt-6 pb-12">
        <p className="flex items-center gap-2 text-eyebrow font-bold text-slate uppercase">
          <span aria-hidden className="size-[6px] rounded-full bg-signal-light" />
          {CATEGORY_LABEL[tool.category]}
        </p>

        <h1 className="mt-5 text-[clamp(34px,5vw,52px)] leading-[1.05] font-medium tracking-[-0.02em]">
          {tool.name}
        </h1>

        <p className="mt-5 max-w-xl text-[17px] leading-[1.5] text-granite">
          {tool.description}
        </p>

        {tool.mode === 'client' && (
          <p className="mt-7 inline-flex items-center gap-2.5 rounded-pill bg-white px-5 py-2.5 text-[14px] font-medium text-clay shadow-nav">
            <Lock aria-hidden className="size-4" strokeWidth={2} />
            Diproses di perangkat Anda — berkas tidak diunggah
          </p>
        )}
      </header>

      {/* ------------------------------------------------------------ Result */}
      {run.phase === 'done' && run.result ? (
        <ResultPanel
          result={run.result}
          onReset={() => {
            onReset();
            clear();
          }}
        />
      ) : empty ? (
        <Dropzone tool={tool} onFiles={onFiles} />
      ) : (
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
          <div className="min-w-0">
            {children}

            <div className="mt-8">
              <Dropzone tool={tool} onFiles={onFiles} compact />
            </div>

            <button
              type="button"
              onClick={clear}
              className="mt-5 inline-flex items-center gap-2 rounded-micro text-[14px] text-slate transition-colors hover:text-signal"
            >
              <Trash2 aria-hidden className="size-4" />
              Kosongkan antrean ({formatCount(files.length)})
            </button>
          </div>

          {/* Options rail. Sticks on desktop; becomes a normal block on mobile
              so it never covers the preview it is describing. */}
          <aside className="lg:sticky lg:top-32">
            <div className="rounded-stadium bg-lifted p-7 shadow-card">
              {options && <div className="mb-7">{options}</div>}

              {run.phase === 'error' && run.errorCode && (
                <ErrorNotice
                  code={run.errorCode}
                  detail={run.errorDetail ?? undefined}
                  onRetry={onRun}
                  className="mb-6"
                />
              )}

              {busy ? (
                <ProgressPanel run={run} onCancel={onCancel} />
              ) : (
                <>
                  <Button
                    onClick={onRun}
                    disabled={!canRun}
                    size="lg"
                    className="w-full"
                  >
                    {runLabel}
                  </Button>

                  {!canRun && blockedReason && (
                    <p className="mt-3 text-center text-[14px] text-slate">{blockedReason}</p>
                  )}

                  <p className="mt-4 text-center text-[13px] text-slate">
                    atau tekan{' '}
                    <kbd className="rounded-micro bg-white px-1.5 py-0.5 font-sans">Ctrl</kbd>{' '}
                    +{' '}
                    <kbd className="rounded-micro bg-white px-1.5 py-0.5 font-sans">Enter</kbd>
                  </p>
                </>
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

function ProgressPanel({ run, onCancel }: { run: RunState; onCancel: () => void }) {
  return (
    <div>
      <div
        role="progressbar"
        aria-valuenow={run.progress}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={run.label}
        className="h-2 w-full overflow-hidden rounded-pill bg-canvas"
      >
        <div
          className="h-full rounded-pill bg-ink transition-[width] duration-300 ease-out"
          style={{ width: `${run.progress}%` }}
        />
      </div>

      <p className="mt-4 text-[15px] text-granite">
        {run.label}{' '}
        <span className="tabular-nums text-slate">{run.progress}%</span>
      </p>

      {/* Announced at coarse intervals rather than every tick, so the screen
          reader is not flooded (PRD §6 accessibility notes). */}
      <p aria-live="polite" className="sr-only">
        {run.progress >= 100
          ? 'Selesai'
          : run.progress >= 75
            ? 'Tujuh puluh lima persen'
            : run.progress >= 50
              ? 'Lima puluh persen'
              : run.progress >= 25
                ? 'Dua puluh lima persen'
                : ''}
      </p>

      <Button variant="secondary" onClick={onCancel} className={cn('mt-6 w-full')}>
        <X aria-hidden className="size-4" />
        Batalkan
      </Button>
    </div>
  );
}
