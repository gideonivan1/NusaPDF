'use client';

import { useState } from 'react';
import { useDocumentLoader } from '@/lib/hooks/useDocumentLoader';
import { useFileIntake } from '@/lib/hooks/useFileIntake';
import { useToolRun } from '@/lib/hooks/useToolRun';
import { compressPdf, type CompressionLevel } from '@/lib/pdf/client';
import { useQueue } from '@/lib/store/queue';
import { getTool } from '@/lib/tools';
import { formatBytes, formatCount, stripExtension } from '@/lib/utils';
import { FileQueueList } from '@/components/tools/FileQueueList';
import { RejectionNotice } from '@/components/tools/RejectionNotice';
import { ToolShell } from '@/components/tools/ToolShell';

const tool = getTool('compress');

const LEVELS: {
  value: CompressionLevel;
  label: string;
  hint: string;
  /** Rough expectation, stated as a range because the real figure depends
      entirely on how image-heavy the document is (PRD risk R2). */
  expectation: string;
}[] = [
  {
    value: 'ringan',
    label: 'Ringan',
    hint: 'Perubahan visual hampir tidak terlihat.',
    expectation: 'biasanya 10–25% lebih kecil',
  },
  {
    value: 'seimbang',
    label: 'Seimbang',
    hint: 'Pilihan terbaik untuk sebagian besar dokumen.',
    expectation: 'biasanya 30–55% lebih kecil',
  },
  {
    value: 'maksimal',
    label: 'Maksimal',
    hint: 'Gambar terlihat lebih lunak, teks tetap tajam.',
    expectation: 'biasanya 50–75% lebih kecil',
  },
];

export function CompressTool() {
  const files = useQueue((s) => s.files);
  const { onFiles, rejections, dismissRejections } = useFileIntake(tool);
  const { state, run, cancel, reset } = useToolRun();
  const [level, setLevel] = useState<CompressionLevel>('seimbang');

  useDocumentLoader(files);

  const ready = files.filter((f) => f.status === 'ready');
  const canRun = ready.length > 0 && state.phase !== 'running';
  const totalBytes = ready.reduce((sum, file) => sum + file.file.size, 0);

  const start = () =>
    void run(async (report) => {
      const outputs = [];
      let recompressed = 0;
      let keptAny = false;

      for (const [index, file] of ready.entries()) {
        report(index, ready.length, `Mengompres ${file.file.name}…`);

        const buffer = await file.file.arrayBuffer();
        const result = await compressPdf(buffer, level, (done, total) => {
          // Blend per-image progress into the overall file progress so the bar
          // moves smoothly across a multi-file batch.
          const withinFile = total > 0 ? done / total : 0;
          report(index + withinFile, ready.length, `Mengompres ${file.file.name}…`);
        });

        recompressed += result.imagesRecompressed;
        keptAny ||= result.keptOriginal;

        outputs.push({
          fileName: `${stripExtension(file.file.name)}_kompres.pdf`,
          blob: new Blob([result.bytes as BlobPart], { type: 'application/pdf' }),
        });
      }

      report(ready.length, ready.length);

      return {
        outputs,
        originalBytes: totalBytes,
        archiveName: 'nusapdf_kompres',
        note:
          recompressed > 0
            ? `${formatCount(recompressed)} gambar dikompres ulang · teks tetap dapat diseleksi`
            : 'Tidak ada gambar yang bisa dikompres ulang — dokumen ini didominasi teks',
        warning: keptAny
          ? 'Sebagian berkas justru membesar setelah dikompres, jadi versi aslinya yang kami kembalikan. Dokumen yang isinya hampir seluruhnya teks memang sudah efisien.'
          : undefined,
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
      runLabel={
        ready.length > 1 ? `Kompres ${formatCount(ready.length)} berkas` : 'Kompres PDF'
      }
      options={
        <fieldset>
          <legend className="text-[17px] font-medium tracking-[-0.01em]">
            Tingkat kompresi
          </legend>

          <div className="mt-5 flex flex-col gap-1.5">
            {LEVELS.map((option) => (
              <label
                key={option.value}
                className={`cursor-pointer rounded-micro px-4 py-3 transition-colors ${
                  level === option.value ? 'bg-white shadow-nav' : 'hover:bg-white/60'
                }`}
              >
                <span className="flex items-start gap-3">
                  <input
                    type="radio"
                    name="compression-level"
                    value={option.value}
                    checked={level === option.value}
                    onChange={() => setLevel(option.value)}
                    className="mt-1 size-4 shrink-0 accent-[var(--color-ink)]"
                  />
                  <span className="min-w-0">
                    <span className="block text-[15px] font-medium">{option.label}</span>
                    <span className="mt-0.5 block text-[13px] leading-snug text-slate">
                      {option.hint}
                    </span>
                    <span className="mt-1 block text-[13px] leading-snug text-clay">
                      {option.expectation}
                    </span>
                  </span>
                </span>
              </label>
            ))}
          </div>

          {ready.length > 0 && (
            <dl className="mt-6 flex flex-col gap-2 border-t border-dust/60 pt-5 text-[15px]">
              <div className="flex justify-between">
                <dt className="text-granite">Ukuran sekarang</dt>
                <dd className="font-medium tabular-nums">{formatBytes(totalBytes)}</dd>
              </div>
            </dl>
          )}

          {/* Setting expectations honestly here prevents the "it barely did
              anything" reaction on text-only documents. */}
          <p className="mt-5 text-[13px] leading-snug text-slate">
            Kami mengompres ulang gambar di dalam PDF dan membiarkan teksnya utuh — jadi
            hasilnya tetap bisa diseleksi dan dicari. Dokumen yang isinya hampir semua teks
            hanya akan menyusut sedikit.
          </p>
        </fieldset>
      }
    >
      <RejectionNotice rejections={rejections} onDismiss={dismissRejections} />
      <FileQueueList files={files} />
    </ToolShell>
  );
}
