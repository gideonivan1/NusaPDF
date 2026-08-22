'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { FilePlus2, Lock } from 'lucide-react';
import { cn, formatBytes } from '@/lib/utils';
import { MAX_FILE_BYTES, MAX_FILES } from '@/lib/store/queue';
import type { ToolDefinition } from '@/lib/tools';

interface Props {
  tool: ToolDefinition;
  onFiles: (files: File[]) => void;
  /** Compact variant shown once the queue already has files. */
  compact?: boolean;
}

export function Dropzone({ tool, onFiles, compact = false }: Props) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  // Nested dragenter/dragleave events fire constantly; counting them is the
  // only reliable way to know when the pointer has truly left the zone.
  const dragDepth = useRef(0);

  const emit = useCallback(
    (list: FileList | null) => {
      if (!list || list.length === 0) return;
      onFiles(Array.from(list));
    },
    [onFiles],
  );

  // Ctrl/Cmd+O opens the picker — PRD §6 keyboard shortcuts.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        inputRef.current?.click();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Pasting a file straight from the clipboard is faster than any file picker.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length > 0) {
        event.preventDefault();
        onFiles(files);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [onFiles]);

  return (
    <div
      onDragEnter={(event) => {
        event.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        event.preventDefault();
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) {
          dragDepth.current = 0;
          setDragging(false);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        emit(event.dataTransfer.files);
      }}
      className={cn(
        'relative rounded-stadium border-2 border-dashed transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
        dragging
          ? 'scale-[1.01] border-signal-light bg-lifted'
          : 'border-dust bg-lifted/50 hover:border-slate',
        compact ? 'px-6 py-8' : 'px-8 py-20',
      )}
    >
      {/* A real file input, visually hidden but focusable and label-linked.
          Building this out of a div with handlers is the classic way these
          dropzones become unusable with a keyboard or screen reader. */}
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        multiple={tool.minFiles > 1 || tool.slug !== 'compress'}
        accept={tool.accept}
        onChange={(event) => {
          emit(event.target.files);
          // Reset so re-picking the same file still fires a change event.
          event.target.value = '';
        }}
        className="sr-only"
      />

      <div className="flex flex-col items-center text-center">
        {!compact && (
          <span className="mb-6 grid size-20 place-items-center rounded-full bg-canvas">
            <FilePlus2 aria-hidden strokeWidth={1.25} className="size-8 text-granite" />
          </span>
        )}

        <label
          htmlFor={inputId}
          className={cn(
            'inline-flex cursor-pointer items-center justify-center gap-2 rounded-btn border-[1.5px] border-ink bg-ink font-medium tracking-[-0.02em] text-canvas transition-transform active:scale-[0.98]',
            compact ? 'px-6 py-2.5 text-[15px]' : 'px-8 py-3.5 text-[17px]',
          )}
        >
          {compact ? 'Tambah berkas' : 'Pilih berkas'}
        </label>

        <p className={cn('text-granite', compact ? 'mt-3 text-[14px]' : 'mt-5 text-[16px]')}>
          atau jatuhkan di sini
          <span className="hidden sm:inline"> · tempel dengan Ctrl+V</span>
        </p>

        {!compact && (
          <>
            <p className="mt-2 text-[14px] text-slate">
              Maksimal {MAX_FILES} berkas, {formatBytes(MAX_FILE_BYTES)} per berkas
            </p>

            {tool.mode === 'client' && (
              <p className="mt-8 flex items-center gap-2 text-[14px] font-medium text-clay">
                <Lock aria-hidden className="size-4" strokeWidth={2} />
                Diproses di perangkat Anda — berkas tidak diunggah
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
