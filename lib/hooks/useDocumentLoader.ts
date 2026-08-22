'use client';

import { useEffect, useRef } from 'react';
import { closeDocument, openDocument } from '@/lib/pdf/render';
import { toErrorCode } from '@/lib/errors';
import { useQueue, type QueuedFile } from '@/lib/store/queue';

/**
 * Opens every queued PDF exactly once and writes page count / text-layer
 * presence back into the store. Documents are closed when they leave the queue
 * so the pdf.js parser worker and its page cache are released rather than
 * accumulating for the lifetime of the tab.
 */
export function useDocumentLoader(files: QueuedFile[], enabled = true) {
  const setFileParsed = useQueue((s) => s.setFileParsed);
  const setFileError = useQueue((s) => s.setFileError);
  const opened = useRef(new Set<string>());

  useEffect(() => {
    if (!enabled) return;

    for (const file of files) {
      if (file.status !== 'pending' || opened.current.has(file.localId)) continue;
      opened.current.add(file.localId);

      void (async () => {
        try {
          const info = await openDocument(file.localId, file.file);
          setFileParsed(file.localId, {
            pageCount: info.pageCount,
            hasTextLayer: info.hasTextLayer,
          });
        } catch (error) {
          setFileError(file.localId, toErrorCode(error));
        }
      })();
    }

    // Release documents that are no longer in the queue.
    const live = new Set(files.map((f) => f.localId));
    for (const id of opened.current) {
      if (!live.has(id)) {
        closeDocument(id);
        opened.current.delete(id);
      }
    }
  }, [files, enabled, setFileParsed, setFileError]);

  useEffect(() => {
    const openedIds = opened.current;
    return () => {
      for (const id of openedIds) closeDocument(id);
      openedIds.clear();
    };
  }, []);
}
