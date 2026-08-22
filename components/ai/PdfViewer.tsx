'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2, ZoomIn, ZoomOut } from 'lucide-react';
import { renderPage } from '@/lib/pdf/render';
import { cn, formatCount } from '@/lib/utils';
import { IconButton } from '@/components/ui/Button';

interface Props {
  docId: string;
  pageCount: number;
  /** 1-indexed. Controlled so citation chips can drive it. */
  page: number;
  onPageChange: (page: number) => void;
  /** Set briefly after a citation jump to draw attention to the page. */
  highlight?: boolean;
}

const ZOOM_STEPS = [0.75, 1, 1.35, 1.75, 2.25];

export function PdfViewer({ docId, pageCount, page, onPageChange, highlight }: Props) {
  const [zoomIndex, setZoomIndex] = useState(1);
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);

  // Render the current page whenever it or the zoom level changes. The
  // previous object URL is revoked in the cleanup so blobs do not pile up as
  // the reader pages through a long document.
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | null = null;

    setLoading(true);

    void (async () => {
      try {
        const width = Math.round(
          (containerRef.current?.clientWidth ?? 720) * ZOOM_STEPS[zoomIndex],
        );
        const blob = await renderPage(docId, page, {
          width: Math.min(width, 2000),
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch {
        if (!controller.signal.aborted) setUrl(null);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [docId, page, zoomIndex]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-dust/60 px-4 py-3">
        <div className="flex items-center gap-1">
          <IconButton
            label="Halaman sebelumnya"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
          >
            <ChevronLeft aria-hidden className="size-5" />
          </IconButton>

          <label className="flex items-center gap-2 text-[14px] text-granite">
            <span className="sr-only">Nomor halaman</span>
            <input
              type="number"
              min={1}
              max={pageCount}
              value={page}
              onChange={(event) => {
                const next = Number(event.target.value);
                if (next >= 1 && next <= pageCount) onPageChange(next);
              }}
              className="w-16 rounded-pill border border-dust bg-white px-3 py-1.5 text-center tabular-nums outline-none focus:border-ink"
            />
            <span className="tabular-nums">dari {formatCount(pageCount)}</span>
          </label>

          <IconButton
            label="Halaman berikutnya"
            disabled={page >= pageCount}
            onClick={() => onPageChange(page + 1)}
          >
            <ChevronRight aria-hidden className="size-5" />
          </IconButton>
        </div>

        <div className="flex items-center gap-1">
          <IconButton
            label="Perkecil"
            disabled={zoomIndex === 0}
            onClick={() => setZoomIndex((i) => Math.max(0, i - 1))}
          >
            <ZoomOut aria-hidden className="size-4" />
          </IconButton>
          <span className="w-12 text-center text-[13px] text-slate tabular-nums">
            {Math.round(ZOOM_STEPS[zoomIndex] * 100)}%
          </span>
          <IconButton
            label="Perbesar"
            disabled={zoomIndex === ZOOM_STEPS.length - 1}
            onClick={() => setZoomIndex((i) => Math.min(ZOOM_STEPS.length - 1, i + 1))}
          >
            <ZoomIn aria-hidden className="size-4" />
          </IconButton>
        </div>
      </div>

      <div ref={containerRef} className="min-h-0 flex-1 overflow-auto bg-canvas p-6">
        <div
          className={cn(
            'mx-auto w-fit rounded-micro bg-white transition-shadow duration-500',
            highlight ? 'shadow-[0_0_0_3px_var(--color-signal-light)]' : 'shadow-card',
          )}
        >
          {loading && !url ? (
            <div className="grid aspect-[3/4] w-[min(100%,720px)] place-items-center">
              <Loader2 aria-hidden className="size-6 animate-spin text-dust" />
            </div>
          ) : url ? (
            // eslint-disable-next-line @next/next/no-img-element -- in-memory blob
            <img
              src={url}
              alt={`Halaman ${page} dari ${formatCount(pageCount)}`}
              className="block max-w-full"
            />
          ) : (
            <div className="grid aspect-[3/4] w-[min(100%,720px)] place-items-center px-8 text-center text-[15px] text-slate">
              Halaman ini tidak dapat ditampilkan.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
