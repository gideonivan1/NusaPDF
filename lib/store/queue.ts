'use client';

import { nanoid } from 'nanoid';
import { create } from 'zustand';
import type { ErrorCode } from '@/lib/errors';
import type { Rotation } from '@/lib/pdf/client';

export const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MB — PRD §3
export const WARN_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_FILES = 20;
const HISTORY_LIMIT = 20; // PRD §6 "Undo/redo"

export interface PageState {
  /** 0-indexed internally; the UI always displays index + 1. */
  index: number;
  selected: boolean;
  rotation: Rotation;
  /** Object URL. Must be revoked when the page or file leaves the queue. */
  thumbnailUrl: string | null;
}

export interface QueuedFile {
  localId: string;
  /**
   * The original File handle. For client-side tools these bytes are read into
   * a worker and never touch the network — this field IS the privacy contract.
   */
  file: File;
  status: 'pending' | 'parsing' | 'ready' | 'error';
  pageCount: number | null;
  hasTextLayer: boolean | null;
  errorCode: ErrorCode | null;
  pages: PageState[];
}

/** Only the parts worth undoing — never the File handles themselves. */
interface Snapshot {
  order: string[];
  pages: Record<string, { selected: boolean; rotation: Rotation }[]>;
}

interface QueueState {
  files: QueuedFile[];
  past: Snapshot[];
  future: Snapshot[];

  addFiles: (files: File[]) => { added: number; rejected: { name: string; code: ErrorCode }[] };
  removeFile: (localId: string) => void;
  clear: () => void;

  moveFile: (localId: string, delta: -1 | 1) => void;
  reorderFiles: (fromIndex: number, toIndex: number) => void;

  setFileParsed: (
    localId: string,
    info: { pageCount: number; hasTextLayer: boolean },
  ) => void;
  setFileError: (localId: string, code: ErrorCode) => void;
  setThumbnail: (localId: string, pageIndex: number, url: string) => void;

  togglePage: (localId: string, pageIndex: number) => void;
  setAllPages: (localId: string, selected: boolean) => void;
  setPageRange: (localId: string, pageNumbers: number[]) => void;
  rotatePage: (localId: string, pageIndex: number) => void;

  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
}

function snapshot(files: QueuedFile[]): Snapshot {
  return {
    order: files.map((f) => f.localId),
    pages: Object.fromEntries(
      files.map((f) => [
        f.localId,
        f.pages.map((p) => ({ selected: p.selected, rotation: p.rotation })),
      ]),
    ),
  };
}

function applySnapshot(files: QueuedFile[], snap: Snapshot): QueuedFile[] {
  const byId = new Map(files.map((f) => [f.localId, f]));
  return snap.order
    .map((id) => byId.get(id))
    .filter((f): f is QueuedFile => Boolean(f))
    .map((f) => {
      const saved = snap.pages[f.localId];
      if (!saved) return f;
      return {
        ...f,
        pages: f.pages.map((page, i) =>
          saved[i] ? { ...page, selected: saved[i].selected, rotation: saved[i].rotation } : page,
        ),
      };
    });
}

function revokeThumbnails(file: QueuedFile): void {
  for (const page of file.pages) {
    if (page.thumbnailUrl) URL.revokeObjectURL(page.thumbnailUrl);
  }
}

export const useQueue = create<QueueState>((set, get) => {
  /** Records an undoable checkpoint, then applies `mutate`. */
  const commit = (mutate: (files: QueuedFile[]) => QueuedFile[]) =>
    set((state) => ({
      files: mutate(state.files),
      past: [...state.past, snapshot(state.files)].slice(-HISTORY_LIMIT),
      future: [],
    }));

  return {
    files: [],
    past: [],
    future: [],

    addFiles: (incoming) => {
      const rejected: { name: string; code: ErrorCode }[] = [];
      const current = get().files;
      const accepted: QueuedFile[] = [];

      for (const file of incoming) {
        if (current.length + accepted.length >= MAX_FILES) {
          rejected.push({ name: file.name, code: 'E_TOO_LARGE' });
          continue;
        }
        if (file.size > MAX_FILE_BYTES) {
          rejected.push({ name: file.name, code: 'E_TOO_LARGE' });
          continue;
        }
        if (file.size === 0) {
          rejected.push({ name: file.name, code: 'E_CORRUPT' });
          continue;
        }

        accepted.push({
          localId: nanoid(10),
          file,
          status: 'pending',
          pageCount: null,
          hasTextLayer: null,
          errorCode: null,
          pages: [],
        });
      }

      if (accepted.length > 0) {
        commit((files) => [...files, ...accepted]);
      }

      return { added: accepted.length, rejected };
    },

    removeFile: (localId) =>
      commit((files) => {
        const target = files.find((f) => f.localId === localId);
        if (target) revokeThumbnails(target);
        return files.filter((f) => f.localId !== localId);
      }),

    clear: () => {
      for (const file of get().files) revokeThumbnails(file);
      set({ files: [], past: [], future: [] });
    },

    moveFile: (localId, delta) =>
      commit((files) => {
        const from = files.findIndex((f) => f.localId === localId);
        const to = from + delta;
        if (from < 0 || to < 0 || to >= files.length) return files;
        const next = [...files];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        return next;
      }),

    reorderFiles: (fromIndex, toIndex) =>
      commit((files) => {
        if (
          fromIndex === toIndex ||
          fromIndex < 0 ||
          toIndex < 0 ||
          fromIndex >= files.length ||
          toIndex >= files.length
        ) {
          return files;
        }
        const next = [...files];
        const [moved] = next.splice(fromIndex, 1);
        next.splice(toIndex, 0, moved);
        return next;
      }),

    // Parse results are not undoable — they describe the file, not the user's edits.
    setFileParsed: (localId, info) =>
      set((state) => ({
        files: state.files.map((f) =>
          f.localId === localId
            ? {
                ...f,
                status: 'ready',
                pageCount: info.pageCount,
                hasTextLayer: info.hasTextLayer,
                pages: Array.from({ length: info.pageCount }, (_, index) => ({
                  index,
                  selected: true,
                  rotation: 0 as Rotation,
                  thumbnailUrl: null,
                })),
              }
            : f,
        ),
      })),

    setFileError: (localId, code) =>
      set((state) => ({
        files: state.files.map((f) =>
          f.localId === localId ? { ...f, status: 'error', errorCode: code } : f,
        ),
      })),

    setThumbnail: (localId, pageIndex, url) =>
      set((state) => ({
        files: state.files.map((f) => {
          if (f.localId !== localId) return f;
          return {
            ...f,
            pages: f.pages.map((page) => {
              if (page.index !== pageIndex) return page;
              // Replacing an existing thumbnail would otherwise leak its blob.
              if (page.thumbnailUrl) URL.revokeObjectURL(page.thumbnailUrl);
              return { ...page, thumbnailUrl: url };
            }),
          };
        }),
      })),

    togglePage: (localId, pageIndex) =>
      commit((files) =>
        files.map((f) =>
          f.localId === localId
            ? {
                ...f,
                pages: f.pages.map((p) =>
                  p.index === pageIndex ? { ...p, selected: !p.selected } : p,
                ),
              }
            : f,
        ),
      ),

    setAllPages: (localId, selected) =>
      commit((files) =>
        files.map((f) =>
          f.localId === localId
            ? { ...f, pages: f.pages.map((p) => ({ ...p, selected })) }
            : f,
        ),
      ),

    setPageRange: (localId, pageNumbers) =>
      commit((files) =>
        files.map((f) => {
          if (f.localId !== localId) return f;
          const wanted = new Set(pageNumbers.map((n) => n - 1));
          return { ...f, pages: f.pages.map((p) => ({ ...p, selected: wanted.has(p.index) })) };
        }),
      ),

    rotatePage: (localId, pageIndex) =>
      commit((files) =>
        files.map((f) =>
          f.localId === localId
            ? {
                ...f,
                pages: f.pages.map((p) =>
                  p.index === pageIndex
                    ? { ...p, rotation: (((p.rotation + 90) % 360) as Rotation) }
                    : p,
                ),
              }
            : f,
        ),
      ),

    undo: () =>
      set((state) => {
        const previous = state.past.at(-1);
        if (!previous) return state;
        return {
          files: applySnapshot(state.files, previous),
          past: state.past.slice(0, -1),
          future: [snapshot(state.files), ...state.future].slice(0, HISTORY_LIMIT),
        };
      }),

    redo: () =>
      set((state) => {
        const [next, ...rest] = state.future;
        if (!next) return state;
        return {
          files: applySnapshot(state.files, next),
          past: [...state.past, snapshot(state.files)].slice(-HISTORY_LIMIT),
          future: rest,
        };
      }),

    canUndo: () => get().past.length > 0,
    canRedo: () => get().future.length > 0,
  };
});

/** Total selected pages across the queue — drives the process button's label. */
export function selectedPageCount(files: QueuedFile[]): number {
  return files.reduce((sum, f) => sum + f.pages.filter((p) => p.selected).length, 0);
}
