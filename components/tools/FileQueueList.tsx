'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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

/** Pointer travel before a press becomes a drag, so a click stays a click. */
const DRAG_THRESHOLD = 4;
/** Distance from the viewport edge where the page starts scrolling by itself. */
const EDGE = 72;
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
const SETTLE_MS = 240;

/** Geometry captured when the drag starts, in page coordinates. */
interface Slot {
  id: string;
  top: number;
  height: number;
}

interface DragState {
  id: string;
  /** Where the card started, so Escape can put it back. */
  fromIndex: number;
  /** Where the gap currently is, among the other files. */
  overIndex: number;
  width: number;
  height: number;
}

interface Pointer {
  pointerId: number;
  startX: number;
  startY: number;
  /** Grab point inside the card, so it does not jump to the cursor. */
  offsetX: number;
  offsetY: number;
  clientX: number;
  clientY: number;
  slots: Slot[];
  started: boolean;
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
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
  const [drag, setDrag] = useState<DragState | null>(null);

  const pointer = useRef<Pointer | null>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<string, HTMLElement>());
  const scrollFrame = useRef<number | null>(null);

  /* ------------------------------------------------------------ FLIP */

  /**
   * Every reorder — a drag, the arrow buttons, Alt+Arrow, undo — animates the
   * same way: measure where each row *is* on screen before React commits the
   * new order, then after the commit play each row from its old place to its
   * new one. Reading positions during render is deliberate: it is the last
   * moment the old layout is still on screen, including rows caught
   * mid-animation, so a quick second move continues smoothly instead of
   * snapping.
   */
  const before = useRef(new Map<string, DOMRect>());
  const landing = useRef<{ id: string; rect: DOMRect } | null>(null);

  const snapshot = new Map<string, DOMRect>();
  for (const [id, element] of rows.current) snapshot.set(id, element.getBoundingClientRect());
  before.current = snapshot;

  useLayoutEffect(() => {
    const reduce = prefersReducedMotion();

    for (const [id, element] of rows.current) {
      const previous = landing.current?.id === id ? landing.current.rect : before.current.get(id);
      if (!previous) continue;

      for (const animation of element.getAnimations()) animation.cancel();
      const next = element.getBoundingClientRect();
      const dx = previous.left - next.left;
      const dy = previous.top - next.top;
      if (reduce || (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5)) continue;

      const isLanding = landing.current?.id === id;
      element.animate(
        [
          {
            transform: `translate(${dx}px, ${dy}px)${isLanding ? ' scale(1.02)' : ''}`,
            boxShadow: isLanding ? '0 24px 48px 0 rgb(0 0 0 / 0.14)' : undefined,
          },
          { transform: 'translate(0, 0)', boxShadow: isLanding ? '0 0 0 0 rgb(0 0 0 / 0)' : undefined },
        ],
        { duration: SETTLE_MS, easing: EASE },
      );
    }

    landing.current = null;
  });

  /* ------------------------------------------------------ drag logic */

  // Mirrors of state for the window listeners, which outlive any one render.
  const dragRef = useRef<DragState | null>(null);
  const filesRef = useRef(files);
  filesRef.current = files;

  const setDragState = (next: DragState | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  const placeOverlay = useCallback(() => {
    const p = pointer.current;
    const element = overlay.current;
    if (!p || !element) return;
    element.style.transform = `translate(${p.clientX - p.offsetX}px, ${p.clientY - p.offsetY}px) scale(1.02)`;
  }, []);

  /**
   * The gap goes after every other file whose resting centre is above the
   * dragged card's centre. Using the positions captured at drag start (not
   * the live, animating ones) keeps the target from flickering while rows
   * slide past each other.
   */
  const updateTarget = useCallback(() => {
    const p = pointer.current;
    const current = dragRef.current;
    if (!p || !current) return;
    const dragged = p.slots.find((slot) => slot.id === current.id);
    if (!dragged) return;
    const centre = p.clientY + window.scrollY - p.offsetY + dragged.height / 2;
    const overIndex = p.slots.filter(
      (slot) => slot.id !== current.id && slot.top + slot.height / 2 < centre,
    ).length;
    if (overIndex !== current.overIndex) setDragState({ ...current, overIndex });
  }, []);

  const stopAutoScroll = () => {
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = null;
  };

  /** Scrolls while the card is held near the top or bottom edge. */
  const autoScroll = useCallback(() => {
    const p = pointer.current;
    if (!p?.started) return;

    const { clientY } = p;
    const speed =
      clientY < EDGE
        ? -Math.ceil(((EDGE - clientY) / EDGE) * 14)
        : clientY > window.innerHeight - EDGE
          ? Math.ceil(((clientY - (window.innerHeight - EDGE)) / EDGE) * 14)
          : 0;

    if (speed !== 0) {
      window.scrollBy(0, speed);
      updateTarget();
    }
    scrollFrame.current = requestAnimationFrame(autoScroll);
  }, [updateTarget]);

  const detach = useRef<() => void>(() => {});

  const finish = useCallback(
    (commit: boolean) => {
      const p = pointer.current;
      pointer.current = null;
      detach.current();
      stopAutoScroll();
      document.body.style.removeProperty('cursor');
      document.body.style.removeProperty('user-select');

      const current = dragRef.current;
      if (!current) return;
      if (!p?.started) {
        setDragState(null);
        return;
      }

      const list = filesRef.current;
      const file = list.find((f) => f.localId === current.id);
      const to = commit ? current.overIndex : current.fromIndex;

      // The card lands from wherever it was released, not from its old slot.
      const rect = overlay.current?.getBoundingClientRect();
      if (rect) landing.current = { id: current.id, rect };

      if (commit && to !== current.fromIndex && file) {
        reorderFiles(current.fromIndex, to);
        setAnnouncement(`${file.file.name} dipindah ke posisi ${to + 1} dari ${list.length}`);
      } else if (file && !commit) {
        setAnnouncement(`Pemindahan ${file.file.name} dibatalkan`);
      }
      setDragState(null);
    },
    [reorderFiles],
  );

  const onPointerDown = (event: React.PointerEvent<HTMLElement>, file: QueuedFile) => {
    if (!reorderable || dragRef.current || pointer.current || event.button !== 0) return;
    // Buttons inside the row keep working as buttons.
    if ((event.target as HTMLElement).closest('button, a, input')) return;
    // On touch the row must stay scrollable; only the grip starts a drag there.
    if (event.pointerType === 'touch' && !(event.target as HTMLElement).closest('[data-grip]')) return;

    const rect = event.currentTarget.getBoundingClientRect();
    const pointerId = event.pointerId;

    pointer.current = {
      pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      clientX: event.clientX,
      clientY: event.clientY,
      slots: files.map((f) => {
        const r = rows.current.get(f.localId)?.getBoundingClientRect();
        return { id: f.localId, top: (r?.top ?? 0) + window.scrollY, height: r?.height ?? rect.height };
      }),
      started: false,
    };

    // Listeners live on the window: the row itself leaves the list the moment
    // it is lifted, and would take any listener or pointer capture with it.
    const onMove = (moveEvent: PointerEvent) => {
      const p = pointer.current;
      if (!p || moveEvent.pointerId !== pointerId) return;
      p.clientX = moveEvent.clientX;
      p.clientY = moveEvent.clientY;

      if (!p.started) {
        if (Math.hypot(p.clientX - p.startX, p.clientY - p.startY) < DRAG_THRESHOLD) return;
        p.started = true;
        const fromIndex = filesRef.current.findIndex((f) => f.localId === file.localId);
        document.body.style.cursor = 'grabbing';
        document.body.style.userSelect = 'none';
        setDragState({ id: file.localId, fromIndex, overIndex: fromIndex, width: rect.width, height: rect.height });
        setAnnouncement(`${file.file.name} diangkat. Geser ke posisi baru, lepas untuk menaruh, Escape untuk batal.`);
        scrollFrame.current = requestAnimationFrame(autoScroll);
      }

      moveEvent.preventDefault();
      placeOverlay();
      updateTarget();
    };
    const onUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId === pointerId) finish(true);
    };
    const onCancel = (cancelEvent: PointerEvent) => {
      if (cancelEvent.pointerId === pointerId) finish(false);
    };
    const onKey = (keyEvent: KeyboardEvent) => {
      // Escape puts the card back where it came from.
      if (keyEvent.key === 'Escape' && pointer.current?.started) {
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        finish(false);
      }
    };

    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
    detach.current = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      detach.current = () => {};
    };
  };

  // Position the floating card as soon as it mounts, before the first move.
  useLayoutEffect(() => {
    if (drag) placeOverlay();
  }, [drag, placeOverlay]);

  // A file removed mid-drag (it failed to parse, say) ends the drag.
  useEffect(() => {
    if (drag && !files.some((f) => f.localId === drag.id)) finish(false);
  }, [files, drag, finish]);

  useEffect(
    () => () => {
      detach.current();
      stopAutoScroll();
    },
    [],
  );

  /* ---------------------------------------------------- keyboard move */

  const move = (file: QueuedFile, index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= files.length) return;
    moveFile(file.localId, delta);
    setAnnouncement(`${file.file.name} dipindah ke posisi ${target + 1} dari ${files.length}`);
  };

  /* ---------------------------------------------------------- render */

  const dragged = drag ? files.find((f) => f.localId === drag.id) ?? null : null;
  const others = drag ? files.filter((f) => f.localId !== drag.id) : files;

  type Entry = { kind: 'file'; file: QueuedFile } | { kind: 'gap' };
  const entries: Entry[] = others.map((file) => ({ kind: 'file' as const, file }));
  if (drag) entries.splice(drag.overIndex, 0, { kind: 'gap' });

  const registerRow = (id: string) => (element: HTMLElement | null) => {
    if (element) rows.current.set(id, element);
    else rows.current.delete(id);
  };

  return (
    <>
      <ul className="flex flex-col gap-3">
        {entries.map((entry) => {
          if (entry.kind === 'gap') {
            // The empty slot the card will drop into. It moves with the
            // pointer, and the rows around it slide to make room.
            return (
              <li
                key="__gap"
                ref={registerRow('__gap')}
                aria-hidden
                className="rounded-stadium border-2 border-dashed border-signal-light/60 bg-signal-light/[0.06]"
                style={{ height: drag?.height }}
              />
            );
          }

          const { file } = entry;
          const index = files.findIndex((f) => f.localId === file.localId);

          return (
            <li
              key={file.localId}
              ref={registerRow(file.localId)}
              onPointerDown={(event) => onPointerDown(event, file)}
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
                reorderable && 'cursor-grab select-none',
              )}
            >
              <RowContent
                file={file}
                index={index}
                total={files.length}
                reorderable={reorderable}
                onMove={(delta) => move(file, index, delta)}
                onRemove={() => {
                  removeFile(file.localId);
                  setAnnouncement(`${file.file.name} dihapus dari antrean`);
                }}
              />
            </li>
          );
        })}
      </ul>

      {/* The lifted card. Rendered outside the list so the list reflows as
          if it were gone, and positioned on every pointer move without a
          React render. */}
      {drag &&
        dragged &&
        createPortal(
          <div
            ref={overlay}
            aria-hidden
            className="pointer-events-none fixed top-0 left-0 z-100 flex cursor-grabbing items-center gap-4 rounded-stadium border border-dust/70 bg-white px-5 py-4 shadow-[0_24px_48px_0_rgb(0_0_0/0.14)]"
            style={{ width: drag.width, height: drag.height, transformOrigin: 'center' }}
          >
            <RowContent
              file={dragged}
              index={drag.overIndex}
              total={files.length}
              reorderable={reorderable}
              inert
            />
          </div>,
          document.body,
        )}

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

/** The inside of a queue row — shared by the row in the list and the lifted card. */
function RowContent({
  file,
  index,
  total,
  reorderable,
  inert = false,
  onMove,
  onRemove,
}: {
  file: QueuedFile;
  index: number;
  total: number;
  reorderable: boolean;
  /** The floating copy shows the controls but never receives input. */
  inert?: boolean;
  onMove?: (delta: -1 | 1) => void;
  onRemove?: () => void;
}) {
  return (
    <>
      {reorderable && (
        <span
          data-grip
          aria-hidden
          // Touch gestures on the grip drag the row instead of scrolling the page.
          className="-m-2 grid touch-none place-items-center p-2"
        >
          <GripVertical
            className={cn(
              'size-5 shrink-0 transition-colors',
              inert ? 'text-slate' : 'text-dust group-hover:text-slate',
            )}
          />
        </span>
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
          <span className="sr-only">
            Berkas {index + 1} dari {total}:{' '}
          </span>
          {truncateMiddle(file.file.name, 48)}
        </p>

        <p className="mt-0.5 text-[14px] text-slate">
          {formatBytes(file.file.size)}
          {file.pageCount !== null && ` · ${formatCount(file.pageCount)} halaman`}
          {file.status === 'parsing' && ' · membaca…'}
          {file.hasTextLayer === false && ' · tanpa lapisan teks'}
        </p>

        {file.status === 'error' && file.errorCode && (
          <p className="mt-1.5 text-[14px] text-clay">{ERROR_COPY[file.errorCode].title}</p>
        )}
      </div>

      {reorderable && (
        <div className="flex shrink-0 items-center">
          <IconButton
            label={`Pindahkan ${file.file.name} ke atas`}
            disabled={inert || index === 0}
            onClick={() => onMove?.(-1)}
            className="size-9"
            tabIndex={inert ? -1 : undefined}
          >
            <ChevronUp aria-hidden className="size-4" />
          </IconButton>
          <IconButton
            label={`Pindahkan ${file.file.name} ke bawah`}
            disabled={inert || index === total - 1}
            onClick={() => onMove?.(1)}
            className="size-9"
            tabIndex={inert ? -1 : undefined}
          >
            <ChevronDown aria-hidden className="size-4" />
          </IconButton>
        </div>
      )}

      <IconButton
        label={`Hapus ${file.file.name} dari antrean`}
        onClick={onRemove}
        className="size-9 hover:text-signal"
        tabIndex={inert ? -1 : undefined}
      >
        <X aria-hidden className="size-4" />
      </IconButton>
    </>
  );
}
