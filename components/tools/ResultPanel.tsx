'use client';

import { useState } from 'react';
import { zip } from 'fflate';
import { ArrowRight, Check, Download, FileArchive, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { downloadBlob, formatBytes, formatCount, truncateMiddle } from '@/lib/utils';

export interface ToolOutput {
  fileName: string;
  blob: Blob;
}

export interface ToolResult {
  outputs: ToolOutput[];
  /** Combined input size, so the panel can state the before/after honestly. */
  originalBytes?: number;
  /** Tool-specific line, e.g. "12 gambar dikompres ulang". */
  note?: string;
  /** Shown when compression made things worse and the original was kept. */
  warning?: string;
  /** Base name used for the zip when there are many outputs. */
  archiveName?: string;
}

export function ResultPanel({
  result,
  onReset,
}: {
  result: ToolResult;
  onReset: () => void;
}) {
  const [zipping, setZipping] = useState(false);

  const totalBytes = result.outputs.reduce((sum, output) => sum + output.blob.size, 0);
  const multiple = result.outputs.length > 1;

  const delta =
    result.originalBytes && result.originalBytes > 0
      ? Math.round((1 - totalBytes / result.originalBytes) * 100)
      : null;

  const downloadAll = async () => {
    if (!multiple) {
      downloadBlob(result.outputs[0].blob, result.outputs[0].fileName);
      return;
    }

    setZipping(true);
    try {
      const entries: Record<string, Uint8Array> = {};
      for (const output of result.outputs) {
        entries[output.fileName] = new Uint8Array(await output.blob.arrayBuffer());
      }

      const archive = await new Promise<Uint8Array>((resolve, reject) => {
        // level 0: the payloads are already-compressed PDFs and JPEGs, so
        // deflating them again costs seconds and saves almost nothing.
        zip(entries, { level: 0 }, (error, data) =>
          error ? reject(error) : resolve(data),
        );
      });

      downloadBlob(
        new Blob([archive as BlobPart], { type: 'application/zip' }),
        `${result.archiveName ?? 'nusapdf'}.zip`,
      );
    } finally {
      setZipping(false);
    }
  };

  return (
    <div className="rounded-stadium bg-lifted p-8 shadow-card md:p-10">
      <div className="flex items-start gap-4">
        <span className="grid size-12 shrink-0 place-items-center rounded-full bg-ink">
          <Check aria-hidden className="size-6 text-canvas" strokeWidth={2.5} />
        </span>

        <div className="min-w-0 flex-1">
          <h2 className="text-cardtitle">Selesai</h2>

          <p className="mt-1.5 text-[15px] text-granite">
            {multiple
              ? `${formatCount(result.outputs.length)} berkas · ${formatBytes(totalBytes)}`
              : formatBytes(totalBytes)}

            {delta !== null && (
              <>
                {' · '}
                <span className={delta > 0 ? 'font-medium text-clay' : 'text-slate'}>
                  {delta > 0 ? `${delta}% lebih kecil` : 'ukuran tidak berkurang'}
                </span>{' '}
                <span className="text-slate">
                  (dari {formatBytes(result.originalBytes!)})
                </span>
              </>
            )}
          </p>

          {result.note && <p className="mt-1 text-[14px] text-slate">{result.note}</p>}

          {result.warning && (
            <p className="mt-3 rounded-micro bg-signal/[0.08] px-4 py-3 text-[14px] text-clay">
              {result.warning}
            </p>
          )}
        </div>
      </div>

      <div className="mt-8 flex flex-wrap items-center gap-3">
        <Button onClick={() => void downloadAll()} size="lg" disabled={zipping}>
          {multiple ? (
            <FileArchive aria-hidden className="size-4" />
          ) : (
            <Download aria-hidden className="size-4" />
          )}
          {zipping
            ? 'Menyiapkan arsip…'
            : multiple
              ? `Unduh semua (${formatCount(result.outputs.length)})`
              : 'Unduh hasil'}
        </Button>

        <Button variant="secondary" size="lg" onClick={onReset}>
          <RotateCcw aria-hidden className="size-4" />
          Mulai lagi
        </Button>
      </div>

      {multiple && (
        <ul className="mt-8 flex flex-col divide-y divide-dust/60 border-t border-dust/60">
          {result.outputs.map((output) => (
            <li
              key={output.fileName}
              className="flex items-center justify-between gap-4 py-3"
            >
              <span className="min-w-0 truncate text-[15px] text-granite">
                {truncateMiddle(output.fileName, 44)}
              </span>
              <span className="flex shrink-0 items-center gap-4">
                <span className="text-[14px] text-slate">{formatBytes(output.blob.size)}</span>
                <button
                  type="button"
                  onClick={() => downloadBlob(output.blob, output.fileName)}
                  className="inline-flex items-center gap-1.5 rounded-micro text-[14px] font-medium text-clay hover:text-signal"
                >
                  Unduh
                  <ArrowRight aria-hidden className="size-3.5" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
