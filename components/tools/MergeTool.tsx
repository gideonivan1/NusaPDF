'use client';

import { useState } from 'react';
import { NusaError } from '@/lib/errors';
import { useDocumentLoader } from '@/lib/hooks/useDocumentLoader';
import { useFileIntake } from '@/lib/hooks/useFileIntake';
import { useToolRun } from '@/lib/hooks/useToolRun';
import { mergePdfs } from '@/lib/pdf/client';
import type { MergeInput } from '@/lib/pdf/worker';
import { useQueue } from '@/lib/store/queue';
import { getTool } from '@/lib/tools';
import { formatCount, stripExtension } from '@/lib/utils';
import { FileQueueList } from '@/components/tools/FileQueueList';
import { PagePreviewGrid } from '@/components/tools/PagePreviewGrid';
import { RejectionNotice } from '@/components/tools/RejectionNotice';
import { ToolShell } from '@/components/tools/ToolShell';

const tool = getTool('merge');

export function MergeTool() {
  const files = useQueue((s) => s.files);
  const { onFiles, rejections, dismissRejections } = useFileIntake(tool);
  const { state, run, cancel, reset } = useToolRun();
  const [expanded, setExpanded] = useState<string | null>(null);

  useDocumentLoader(files);

  const ready = files.filter((f) => f.status === 'ready');
  const totalPages = ready.reduce(
    (sum, file) => sum + file.pages.filter((p) => p.selected).length,
    0,
  );

  const canRun = ready.length >= tool.minFiles && totalPages > 0 && state.phase !== 'running';

  const blockedReason =
    files.length > 0 && ready.length < tool.minFiles
      ? files.some((f) => f.status === 'error')
        ? 'Butuh minimal 2 berkas yang dapat dibaca'
        : 'Butuh minimal 2 berkas'
      : totalPages === 0
        ? 'Pilih minimal satu halaman'
        : undefined;

  const start = () =>
    void run(async (report) => {
      const inputs: MergeInput[] = [];

      // Read sequentially: holding twenty 100 MB ArrayBuffers at once is a
      // reliable way to hit the memory ceiling on mid-range devices (risk R6).
      for (const file of ready) {
        const selected = file.pages.filter((page) => page.selected);
        if (selected.length === 0) continue;

        inputs.push({
          buffer: await file.file.arrayBuffer(),
          pageIndices: selected.map((page) => page.index),
          rotations: selected.map((page) => page.rotation),
        });
      }

      if (inputs.length < 2) {
        throw new NusaError('E_UNKNOWN', 'Butuh minimal dua berkas dengan halaman terpilih');
      }

      const bytes = await mergePdfs(inputs, (done, total) =>
        report(done, total, 'Menggabungkan halaman…'),
      );

      const originalBytes = ready.reduce((sum, file) => sum + file.file.size, 0);

      return {
        outputs: [
          {
            fileName: `${stripExtension(ready[0].file.name)}_gabungan.pdf`,
            blob: new Blob([bytes as BlobPart], { type: 'application/pdf' }),
          },
        ],
        originalBytes,
        note: `${formatCount(totalPages)} halaman dari ${formatCount(inputs.length)} berkas`,
      };
    }, 'Menyiapkan berkas…');

  return (
    <ToolShell
      tool={tool}
      run={state}
      onFiles={onFiles}
      onRun={start}
      onCancel={cancel}
      onReset={reset}
      canRun={canRun}
      blockedReason={blockedReason}
      runLabel={
        totalPages > 0 ? `Gabungkan ${formatCount(totalPages)} halaman` : 'Gabungkan PDF'
      }
      options={
        <div>
          <h2 className="text-[17px] font-medium tracking-[-0.01em]">Urutan berkas</h2>
          <p className="mt-2 text-[15px] leading-[1.45] text-granite">
            Berkas digabung dari atas ke bawah. Seret baris atau pakai tombol panah untuk
            menata ulang.
          </p>

          {ready.length > 0 && (
            <dl className="mt-6 flex flex-col gap-2 border-t border-dust/60 pt-5 text-[15px]">
              <div className="flex justify-between">
                <dt className="text-granite">Berkas</dt>
                <dd className="font-medium tabular-nums">{formatCount(ready.length)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-granite">Halaman terpilih</dt>
                <dd className="font-medium tabular-nums">{formatCount(totalPages)}</dd>
              </div>
            </dl>
          )}
        </div>
      }
    >
      <RejectionNotice rejections={rejections} onDismiss={dismissRejections} />

      <FileQueueList files={files} reorderable />

      {/* Page-level control is opt-in per file: showing every page of every
          file at once would bury the file ordering that this tool is about. */}
      {ready.length > 0 && (
        <div className="mt-10 flex flex-col gap-4">
          {ready.map((file) => (
            <div key={file.localId} className="rounded-stadium bg-lifted p-6">
              <button
                type="button"
                onClick={() =>
                  setExpanded((current) => (current === file.localId ? null : file.localId))
                }
                aria-expanded={expanded === file.localId}
                className="flex w-full items-center justify-between gap-4 rounded-micro text-left"
              >
                <span className="min-w-0 truncate text-[15px] font-medium">
                  {file.file.name}
                </span>
                <span className="shrink-0 text-[14px] text-clay underline underline-offset-4">
                  {expanded === file.localId ? 'Sembunyikan halaman' : 'Pilih halaman'}
                </span>
              </button>

              {expanded === file.localId && (
                <div className="mt-6">
                  <PagePreviewGrid file={file} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </ToolShell>
  );
}
