'use client';

import { useEffect, useMemo, useState } from 'react';
import { NusaError } from '@/lib/errors';
import { useFileIntake } from '@/lib/hooks/useFileIntake';
import { useToolRun } from '@/lib/hooks/useToolRun';
import { imagesToPdf } from '@/lib/pdf/client';
import type { ImagesToPdfOptions } from '@/lib/pdf/worker';
import { useQueue } from '@/lib/store/queue';
import { getTool } from '@/lib/tools';
import { formatCount, stripExtension } from '@/lib/utils';
import { FileQueueList } from '@/components/tools/FileQueueList';
import { RejectionNotice } from '@/components/tools/RejectionNotice';
import { ToolShell } from '@/components/tools/ToolShell';

const tool = getTool('jpg-to-pdf');

const PAGE_SIZES = [
  { value: 'fit', label: 'Ikut gambar', hint: 'Halaman mengikuti ukuran asli tiap gambar.' },
  { value: 'a4', label: 'A4', hint: 'Ukuran standar Indonesia.' },
  { value: 'letter', label: 'Letter', hint: 'Ukuran standar Amerika Utara.' },
] as const;

const MARGINS = [
  { value: 0, label: 'Tanpa' },
  { value: 24, label: 'Kecil' },
  { value: 48, label: 'Sedang' },
  { value: 72, label: 'Besar' },
] as const;

export function JpgToPdfTool() {
  const files = useQueue((s) => s.files);
  const setFileParsed = useQueue((s) => s.setFileParsed);
  const { onFiles, rejections, dismissRejections } = useFileIntake(tool);
  const { state, run, cancel, reset } = useToolRun();

  const [pageSize, setPageSize] = useState<ImagesToPdfOptions['pageSize']>('fit');
  const [orientation, setOrientation] = useState<ImagesToPdfOptions['orientation']>('auto');
  const [margin, setMargin] = useState<number>(0);

  /**
   * Images are not paginated documents, so the PDF loader never runs here.
   * Marking them ready immediately keeps the shared queue row from sitting on
   * its parsing spinner forever.
   */
  useEffect(() => {
    for (const file of files) {
      if (file.status === 'pending') {
        setFileParsed(file.localId, { pageCount: 1, hasTextLayer: false });
      }
    }
  }, [files, setFileParsed]);

  const ready = files.filter((f) => f.status === 'ready');
  const canRun = ready.length > 0 && state.phase !== 'running';

  const start = () =>
    void run(async (report) => {
      if (ready.length === 0) throw new NusaError('E_UNKNOWN', 'Tidak ada gambar');

      const inputs = [];
      for (const file of ready) {
        inputs.push({
          buffer: await file.file.arrayBuffer(),
          mimeType: file.file.type || 'image/jpeg',
          fileName: file.file.name,
        });
      }

      const bytes = await imagesToPdf(
        inputs,
        { pageSize, orientation, margin },
        (done, total) => report(done, total, 'Menyusun halaman…'),
      );

      return {
        outputs: [
          {
            fileName: `${stripExtension(ready[0].file.name)}${
              ready.length > 1 ? `_dan_${ready.length - 1}_lainnya` : ''
            }.pdf`,
            blob: new Blob([bytes as BlobPart], { type: 'application/pdf' }),
          },
        ],
        originalBytes: ready.reduce((sum, file) => sum + file.file.size, 0),
        note: `${formatCount(ready.length)} gambar menjadi ${formatCount(ready.length)} halaman`,
      };
    }, 'Membaca gambar…');

  return (
    <ToolShell
      tool={tool}
      run={state}
      onFiles={onFiles}
      onRun={start}
      onCancel={cancel}
      onReset={reset}
      canRun={canRun}
      runLabel={
        ready.length > 0 ? `Ubah ${formatCount(ready.length)} gambar jadi PDF` : 'Ubah jadi PDF'
      }
      options={
        <div className="flex flex-col gap-7">
          <fieldset>
            <legend className="text-[17px] font-medium tracking-[-0.01em]">Ukuran halaman</legend>
            <div className="mt-4 flex flex-col gap-1.5">
              {PAGE_SIZES.map((option) => (
                <label
                  key={option.value}
                  className={`cursor-pointer rounded-micro px-4 py-3 transition-colors ${
                    pageSize === option.value ? 'bg-white shadow-nav' : 'hover:bg-white/60'
                  }`}
                >
                  <span className="flex items-start gap-3">
                    <input
                      type="radio"
                      name="page-size"
                      checked={pageSize === option.value}
                      onChange={() => setPageSize(option.value)}
                      className="mt-1 size-4 shrink-0 accent-[var(--color-ink)]"
                    />
                    <span className="min-w-0">
                      <span className="block text-[15px] font-medium">{option.label}</span>
                      <span className="mt-0.5 block text-[13px] leading-snug text-slate">
                        {option.hint}
                      </span>
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {/* Orientation is meaningless when the page hugs the image. */}
          {pageSize !== 'fit' && (
            <fieldset>
              <legend className="text-[17px] font-medium tracking-[-0.01em]">Orientasi</legend>
              <div className="mt-4 flex gap-2">
                {(
                  [
                    { value: 'auto', label: 'Otomatis' },
                    { value: 'portrait', label: 'Tegak' },
                    { value: 'landscape', label: 'Mendatar' },
                  ] as const
                ).map((option) => (
                  <label
                    key={option.value}
                    className={`flex-1 cursor-pointer rounded-pill px-3 py-2.5 text-center text-[14px] font-medium transition-colors ${
                      orientation === option.value
                        ? 'bg-ink text-canvas'
                        : 'bg-white text-granite hover:text-ink'
                    }`}
                  >
                    <input
                      type="radio"
                      name="orientation"
                      checked={orientation === option.value}
                      onChange={() => setOrientation(option.value)}
                      className="sr-only"
                    />
                    {option.label}
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          <fieldset>
            <legend className="text-[17px] font-medium tracking-[-0.01em]">Margin</legend>
            <div className="mt-4 flex gap-2">
              {MARGINS.map((option) => (
                <label
                  key={option.value}
                  className={`flex-1 cursor-pointer rounded-pill px-3 py-2.5 text-center text-[14px] font-medium transition-colors ${
                    margin === option.value
                      ? 'bg-ink text-canvas'
                      : 'bg-white text-granite hover:text-ink'
                  }`}
                >
                  <input
                    type="radio"
                    name="margin"
                    checked={margin === option.value}
                    onChange={() => setMargin(option.value)}
                    className="sr-only"
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      }
    >
      <RejectionNotice rejections={rejections} onDismiss={dismissRejections} />

      {ready.length > 0 && <ImageStrip files={ready.map((f) => f.file)} />}

      <div className="mt-8">
        <FileQueueList files={files} reorderable />
      </div>
    </ToolShell>
  );
}

/** Preview of the images in page order, so "urutannya benar" is verifiable. */
function ImageStrip({ files }: { files: File[] }) {
  const urls = useMemo(() => files.map((file) => URL.createObjectURL(file)), [files]);

  useEffect(() => () => urls.forEach((url) => URL.revokeObjectURL(url)), [urls]);

  return (
    <ul className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-5">
      {urls.map((url, index) => (
        <li key={url}>
          <div className="relative flex aspect-square items-center justify-center overflow-hidden rounded-micro border-2 border-dust/60 bg-white">
            {/* eslint-disable-next-line @next/next/no-img-element -- local blob URL */}
            <img src={url} alt="" className="max-h-full max-w-full object-contain" />
            <span className="absolute top-2 left-2 grid size-6 place-items-center rounded-full bg-ink text-[12px] font-medium text-canvas tabular-nums">
              {index + 1}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}
