'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, RotateCw } from 'lucide-react';
import { renderPage } from '@/lib/pdf/render';
import { useQueue, type PageState, type QueuedFile } from '@/lib/store/queue';
import { cn, formatCount } from '@/lib/utils';

interface Props {
  file: QueuedFile;
  /** Split needs per-page selection; compress does not. */
  selectable?: boolean;
  rotatable?: boolean;
}

export function PagePreviewGrid({ file, selectable = true, rotatable = true }: Props) {
  const setAllPages = useQueue((s) => s.setAllPages);
  const selected = file.pages.filter((p) => p.selected).length;
  const allSelected = selected === file.pages.length;

  if (file.pages.length === 0) return null;

  return (
    <section aria-label={`Halaman dari ${file.file.name}`}>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
        <p className="text-[15px] text-granite">
          {selectable ? (
            <>
              <span className="font-medium text-ink">{formatCount(selected)}</span> dari{' '}
              {formatCount(file.pages.length)} halaman dipilih
            </>
          ) : (
            <>{formatCount(file.pages.length)} halaman</>
          )}
        </p>

        {selectable && (
          <button
            type="button"
            onClick={() => setAllPages(file.localId, !allSelected)}
            className="rounded-micro text-[15px] font-medium text-clay underline underline-offset-4 hover:text-signal"
          >
            {allSelected ? 'Batalkan semua pilihan' : 'Pilih semua halaman'}
          </button>
        )}
      </div>

      <ul
        role={selectable ? 'group' : 'list'}
        className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5"
      >
        {file.pages.map((page) => (
          <li key={page.index}>
            <PageThumbnail
              localId={file.localId}
              page={page}
              total={file.pages.length}
              selectable={selectable}
              rotatable={rotatable}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function PageThumbnail({
  localId,
  page,
  total,
  selectable,
  rotatable,
}: {
  localId: string;
  page: PageState;
  total: number;
  selectable: boolean;
  rotatable: boolean;
}) {
  const setThumbnail = useQueue((s) => s.setThumbnail);
  const togglePage = useQueue((s) => s.togglePage);
  const rotatePage = useQueue((s) => s.rotatePage);

  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const requested = useRef(false);

  /**
   * Thumbnails are only rasterised once the tile approaches the viewport.
   * Rendering all 500 pages of a large document up front is what makes these
   * tools fall over on mid-range devices (PRD risk R6).
   */
  useEffect(() => {
    const element = ref.current;
    if (!element || visible) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '600px 0px' },
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible || page.thumbnailUrl || requested.current) return;
    requested.current = true;

    const controller = new AbortController();

    void (async () => {
      try {
        const blob = await renderPage(localId, page.index + 1, {
          width: 240,
          signal: controller.signal,
        });
        if (!controller.signal.aborted) {
          setThumbnail(localId, page.index, URL.createObjectURL(blob));
        }
      } catch {
        // A page that will not render leaves its placeholder in place; the
        // document as a whole is still perfectly usable.
        requested.current = false;
      }
    })();

    return () => controller.abort();
  }, [visible, page.thumbnailUrl, page.index, localId, setThumbnail]);

  const label = `Halaman ${page.index + 1} dari ${total}`;

  return (
    <div ref={ref} className="group relative">
      <div
        {...(selectable
          ? {
              role: 'checkbox' as const,
              'aria-checked': page.selected,
              tabIndex: 0,
              onClick: () => togglePage(localId, page.index),
              onKeyDown: (event: React.KeyboardEvent) => {
                if (event.key === ' ' || event.key === 'Enter') {
                  event.preventDefault();
                  togglePage(localId, page.index);
                }
              },
            }
          : {})}
        aria-label={selectable ? `${label}${page.selected ? ', terpilih' : ''}` : undefined}
        className={cn(
          'relative flex aspect-[3/4] items-center justify-center overflow-hidden rounded-micro border-2 bg-white transition-all',
          selectable && 'cursor-pointer',
          page.selected && selectable
            ? 'border-ink shadow-nav'
            : 'border-dust/60 group-hover:border-slate',
          selectable && !page.selected && 'opacity-55',
        )}
      >
        {page.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- blob URL from
          // an in-memory render; next/image would try to optimise it remotely.
          <img
            src={page.thumbnailUrl}
            alt=""
            className="max-h-full max-w-full object-contain transition-transform duration-300"
            style={{ transform: `rotate(${page.rotation}deg)` }}
          />
        ) : (
          <div className="size-full animate-pulse bg-canvas" aria-hidden />
        )}

        {selectable && (
          <span
            aria-hidden
            className={cn(
              'absolute top-2 left-2 grid size-6 place-items-center rounded-full border-2 transition-colors',
              page.selected ? 'border-ink bg-ink text-canvas' : 'border-dust bg-white/90',
            )}
          >
            {page.selected && <Check className="size-3.5" strokeWidth={3} />}
          </span>
        )}

        {rotatable && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              rotatePage(localId, page.index);
            }}
            aria-label={`Putar ${label.toLowerCase()}`}
            className="absolute top-2 right-2 grid size-8 place-items-center rounded-full bg-white/95 text-ink opacity-0 shadow-nav transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          >
            <RotateCw aria-hidden className="size-4" />
          </button>
        )}
      </div>

      <p className="mt-2 text-center text-[13px] text-slate">{page.index + 1}</p>
    </div>
  );
}
