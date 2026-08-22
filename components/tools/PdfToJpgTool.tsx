'use client';

import { useState } from 'react';
import { NusaError } from '@/lib/errors';
import { useDocumentLoader } from '@/lib/hooks/useDocumentLoader';
import { useFileIntake } from '@/lib/hooks/useFileIntake';
import { useToolRun } from '@/lib/hooks/useToolRun';
import { pagesToImages } from '@/lib/pdf/render';
import { useQueue } from '@/lib/store/queue';
import { getTool } from '@/lib/tools';
import { formatCount, stripExtension } from '@/lib/utils';
import { FileQueueList } from '@/components/tools/FileQueueList';
import { PagePreviewGrid } from '@/components/tools/PagePreviewGrid';
import { RejectionNotice } from '@/components/tools/RejectionNotice';
import { ToolShell } from '@/components/tools/ToolShell';

const tool = getTool('pdf-to-jpg');

/** `scale` is relative to the PDF's native 72dpi. */
const QUALITIES = [
  { value: 1, label: 'Layar', hint: '72 dpi — ringan, untuk ditampilkan di layar' },
  { value: 2, label: 'Standar', hint: '144 dpi — pilihan terbaik untuk sebagian besar kebutuhan' },
  { value: 4, label: 'Cetak', hint: '288 dpi — berkas besar, untuk dicetak' },
] as const;

export function PdfToJpgTool() {
  const files = useQueue((s) => s.files);
  const { onFiles, rejections, dismissRejections } = useFileIntake(tool);
  const { state, run, cancel, reset } = useToolRun();

  const [scale, setScale] = useState<number>(2);
  const [format, setFormat] = useState<'image/jpeg' | 'image/png'>('image/jpeg');

  useDocumentLoader(files);

  const file = files.findLast((f) => f.status === 'ready') ?? null;
  const selected = file?.pages.filter((p) => p.selected) ?? [];
  const canRun = Boolean(file) && selected.length > 0 && state.phase !== 'running';

  const start = () =>
    void run(async (report, signal) => {
      if (!file) throw new NusaError('E_UNKNOWN', 'Tidak ada dokumen');

      const extension = format === 'image/png' ? 'png' : 'jpg';
      const baseName = stripExtension(file.file.name);
      const pad = String(file.pages.length).length;

      const images = await pagesToImages(
        file.localId,
        selected.map((page) => page.index + 1),
        {
          format,
          scale,
          quality: 0.9,
          signal,
          onProgress: (done, total) =>
            report(done, total, `Merender halaman ${done} dari ${total}…`),
        },
      );

      return {
        outputs: images.map((image) => ({
          fileName: `${baseName}_hal-${String(image.pageNumber).padStart(pad, '0')}.${extension}`,
          blob: image.blob,
        })),
        originalBytes: file.file.size,
        archiveName: `${baseName}_gambar`,
        note: `${formatCount(images.length)} gambar pada ${scale * 72} dpi`,
      };
    }, 'Menyiapkan halaman…');

  return (
    <ToolShell
      tool={tool}
      run={state}
      onFiles={onFiles}
      onRun={start}
      onCancel={cancel}
      onReset={reset}
      canRun={canRun}
      blockedReason={file && selected.length === 0 ? 'Pilih minimal satu halaman' : undefined}
      runLabel={
        selected.length > 0
          ? `Ubah ${formatCount(selected.length)} halaman jadi gambar`
          : 'Ubah jadi gambar'
      }
      options={
        <div className="flex flex-col gap-7">
          <fieldset>
            <legend className="text-[17px] font-medium tracking-[-0.01em]">Resolusi</legend>
            <div className="mt-4 flex flex-col gap-1.5">
              {QUALITIES.map((option) => (
                <label
                  key={option.value}
                  className={`cursor-pointer rounded-micro px-4 py-3 transition-colors ${
                    scale === option.value ? 'bg-white shadow-nav' : 'hover:bg-white/60'
                  }`}
                >
                  <span className="flex items-start gap-3">
                    <input
                      type="radio"
                      name="scale"
                      checked={scale === option.value}
                      onChange={() => setScale(option.value)}
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

          <fieldset>
            <legend className="text-[17px] font-medium tracking-[-0.01em]">Format</legend>
            <div className="mt-4 flex gap-2">
              {(
                [
                  { value: 'image/jpeg', label: 'JPG' },
                  { value: 'image/png', label: 'PNG' },
                ] as const
              ).map((option) => (
                <label
                  key={option.value}
                  className={`flex-1 cursor-pointer rounded-pill px-5 py-2.5 text-center text-[15px] font-medium transition-colors ${
                    format === option.value
                      ? 'bg-ink text-canvas'
                      : 'bg-white text-granite hover:text-ink'
                  }`}
                >
                  <input
                    type="radio"
                    name="format"
                    checked={format === option.value}
                    onChange={() => setFormat(option.value)}
                    className="sr-only"
                  />
                  {option.label}
                </label>
              ))}
            </div>
            <p className="mt-3 text-[13px] leading-snug text-slate">
              PNG lebih tajam untuk halaman berisi teks dan garis, tetapi ukurannya jauh
              lebih besar.
            </p>
          </fieldset>
        </div>
      }
    >
      <RejectionNotice rejections={rejections} onDismiss={dismissRejections} />
      <FileQueueList files={files} />

      {file && (
        <div className="mt-10">
          <PagePreviewGrid file={file} />
        </div>
      )}
    </ToolShell>
  );
}
