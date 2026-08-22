'use client';

import { useRef, useState } from 'react';
import { ChevronDown, ChevronUp, FileText, GripVertical, Loader2, X } from 'lucide-react';
import { ERROR_COPY } from '@/lib/errors';
import { useQueue, type QueuedFile } from '@/lib/store/queue';
import { cn, formatBytes, formatCount, truncateMiddle } from '@/lib/utils';
import { IconButton } from '@/components/ui/Button';

interface Props {
  files: QueuedFile[];
  /** Merge cares about file order; single-file tools do not. */
  reorderable?: boolean;
}

export function FileQueueList({ files, reorderable = false }: Props) {
  const moveFile = useQueue((s) => s.moveFile);
  const reorderFiles = useQueue((s) => s.reorderFiles);
  const removeFile = useQueue((s) => s.removeFile);

  /**
   * Reordering is invisible to screen readers unless it is announced, and the
   * announcement has to name the item, its new position, and the total — PRD
   * §13 US2.
   */
  const [announcement, setAnnouncement] = useState('');
  const dragIndex = useRef<number | null>(null);

  const move = (file: QueuedFile, index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= files.length) return;
    moveFile(file.localId, delta);
    setAnnouncement(
      `${file.file.name} dipindah ke posisi ${target + 1} dari ${files.length}`,
    );
  };

  return (
    <>
      <ul className="flex flex-col gap-3">
        {files.map((file, index) => (
          <li
            key={file.localId}
            draggable={reorderable}
            onDragStart={() => {
              dragIndex.current = index;
            }}
            onDragOver={(event) => {
              if (reorderable) event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (dragIndex.current !== null) reorderFiles(dragIndex.current, index);
              dragIndex.current = null;
            }}
            onKeyDown={(event) => {
              // Alt+Arrow is the keyboard equivalent of dragging the row.
              if (!reorderable || !event.altKey) return;
              if (event.key === 'ArrowUp') {
                event.preventDefault();
                move(file, index, -1);
              }
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                move(file, index, 1);
              }
            }}
            tabIndex={reorderable ? 0 : undefined}
            className={cn(
              'group flex items-center gap-4 rounded-stadium border border-dust/70 bg-white px-5 py-4 transition-colors',
              file.status === 'error' && 'border-signal/40 bg-signal/[0.04]',
              reorderable && 'cursor-grab active:cursor-grabbing',
            )}
          >
            {reorderable && (
              <GripVertical
                aria-hidden
                className="size-5 shrink-0 text-dust transition-colors group-hover:text-slate"
              />
            )}

            <span className="grid size-11 shrink-0 place-items-center rounded-full bg-canvas">
              {file.status === 'pending' || file.status === 'parsing' ? (
                <Loader2 aria-hidden className="size-5 animate-spin text-granite" />
              ) : (
                <FileText aria-hidden strokeWidth={1.5} className="size-5 text-granite" />
              )}
            </span>

            <div className="min-w-0 flex-1">
              <p className="truncate font-medium tracking-[-0.01em] text-ink">
                <span className="sr-only">Berkas {index + 1} dari {files.length}: </span>
                {truncateMiddle(file.file.name, 48)}
              </p>

              <p className="mt-0.5 text-[14px] text-slate">
                {formatBytes(file.file.size)}
                {file.pageCount !== null && ` · ${formatCount(file.pageCount)} halaman`}
                {file.status === 'parsing' && ' · membaca…'}
                {file.hasTextLayer === false && ' · tanpa lapisan teks'}
              </p>

              {file.status === 'error' && file.errorCode && (
                <p className="mt-1.5 text-[14px] text-clay">
                  {ERROR_COPY[file.errorCode].title}
                </p>
              )}
            </div>

            {reorderable && (
              <div className="flex shrink-0 items-center">
                <IconButton
                  label={`Pindahkan ${file.file.name} ke atas`}
                  disabled={index === 0}
                  onClick={() => move(file, index, -1)}
                  className="size-9"
                >
                  <ChevronUp aria-hidden className="size-4" />
                </IconButton>
                <IconButton
                  label={`Pindahkan ${file.file.name} ke bawah`}
                  disabled={index === files.length - 1}
                  onClick={() => move(file, index, 1)}
                  className="size-9"
                >
                  <ChevronDown aria-hidden className="size-4" />
                </IconButton>
              </div>
            )}

            <IconButton
              label={`Hapus ${file.file.name} dari antrean`}
              onClick={() => {
                removeFile(file.localId);
                setAnnouncement(`${file.file.name} dihapus dari antrean`);
              }}
              className="size-9 hover:text-signal"
            >
              <X aria-hidden className="size-4" />
            </IconButton>
          </li>
        ))}
      </ul>

      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {reorderable && files.length > 1 && (
        <p className="mt-4 text-[14px] text-slate">
          Seret baris untuk menata ulang, atau tekan{' '}
          <kbd className="rounded-micro bg-white px-1.5 py-0.5 font-sans text-[13px] text-granite">
            Alt
          </kbd>{' '}
          +{' '}
          <kbd className="rounded-micro bg-white px-1.5 py-0.5 font-sans text-[13px] text-granite">
            ↑
          </kbd>{' '}
          <kbd className="rounded-micro bg-white px-1.5 py-0.5 font-sans text-[13px] text-granite">
            ↓
          </kbd>{' '}
          saat baris difokuskan.
        </p>
      )}
    </>
  );
}
