'use client';

import { useState } from 'react';
import { NusaError } from '@/lib/errors';
import type { SlideMode } from '@/lib/office/convert';
import { useDocumentLoader } from '@/lib/hooks/useDocumentLoader';
import { useFileIntake } from '@/lib/hooks/useFileIntake';
import { useToolRun } from '@/lib/hooks/useToolRun';
import { pdfToExcel, pdfToPowerpoint, pdfToWord } from '@/lib/office/convert';
import { useQueue } from '@/lib/store/queue';
import { getTool, type ToolSlug } from '@/lib/tools';
import { formatCount, stripExtension } from '@/lib/utils';
import { FileQueueList } from '@/components/tools/FileQueueList';
import { PagePreviewGrid } from '@/components/tools/PagePreviewGrid';
import { RejectionNotice } from '@/components/tools/RejectionNotice';
import { ToolShell } from '@/components/tools/ToolShell';

type Target = 'word' | 'powerpoint' | 'excel';

const TARGETS: Record<
  Target,
  {
    slug: ToolSlug;
    extension: string;
    mime: string;
    runLabel: string;
    /** What survives the conversion, and what does not. Stated up front. */
    expectation: string;
    caveat: string;
  }
> = {
  word: {
    slug: 'pdf-to-word',
    extension: 'docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    runLabel: 'Ubah jadi Word',
    expectation:
      'Teks tiap halaman disusun ulang menjadi paragraf yang siap diedit. Halaman yang tata letaknya berbentuk tabel dikenali dan dibuat sebagai tabel Word sungguhan.',
    caveat:
      'Gambar di dalam PDF belum ikut terbawa, dan tata letak asli — kolom, kotak teks, posisi gambar — tidak direkonstruksi.',
  },
  powerpoint: {
    slug: 'pdf-to-powerpoint',
    extension: 'pptx',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    runLabel: 'Ubah jadi PowerPoint',
    expectation:
      'Setiap halaman menjadi satu slide. Pilih di atas apakah slide berisi gambar halaman atau teks yang bisa diedit.',
    caveat:
      'Mode gambar menjaga tampilan tetapi teksnya tidak bisa diedit; mode teks sebaliknya. Gambar di dalam PDF tidak ikut pada mode teks.',
  },
  excel: {
    slug: 'pdf-to-excel',
    extension: 'xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    runLabel: 'Ubah jadi Excel',
    expectation:
      'Posisi teks di tiap halaman dianalisis untuk menebak batas kolom, lalu dituang jadi satu lembar per halaman.',
    caveat:
      'Paling akurat untuk tabel yang kolomnya rapi sejajar. Halaman berisi paragraf biasa akan jatuh menjadi satu kolom.',
  },
};

export function PdfToOfficeTool({ target }: { target: Target }) {
  const config = TARGETS[target];
  const tool = getTool(config.slug);

  const files = useQueue((s) => s.files);
  const { onFiles, rejections, dismissRejections } = useFileIntake(tool);
  const { state, run, cancel, reset } = useToolRun();

  // Only PDF to PowerPoint offers a choice; the other two have nothing to pick.
  const [slideMode, setSlideMode] = useState<SlideMode>('gambar');

  useDocumentLoader(files);

  const file = files.findLast((f) => f.status === 'ready') ?? null;
  const selected = file?.pages.filter((p) => p.selected) ?? [];
  const canRun = Boolean(file) && selected.length > 0 && state.phase !== 'running';

  const start = () =>
    void run(async (report) => {
      if (!file) throw new NusaError('E_UNKNOWN', 'Tidak ada dokumen');

      const pageNumbers = selected.map((page) => page.index + 1);
      const progress = (done: number, total: number, label?: string) =>
        report(done, total, label);

      const blob =
        target === 'word'
          ? await pdfToWord(file.localId, pageNumbers, progress)
          : target === 'powerpoint'
            ? await pdfToPowerpoint(file.localId, pageNumbers, slideMode, progress)
            : await pdfToExcel(file.localId, pageNumbers, progress);

      return {
        outputs: [
          {
            fileName: `${stripExtension(file.file.name)}.${config.extension}`,
            blob: blob.type ? blob : new Blob([blob], { type: config.mime }),
          },
        ],
        originalBytes: file.file.size,
        note: `${formatCount(pageNumbers.length)} halaman dikonversi`,
      };
    }, 'Menyiapkan dokumen…');

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
          ? `${config.runLabel} (${formatCount(selected.length)} halaman)`
          : config.runLabel
      }
      options={
        <div>
          {target === 'powerpoint' && (
            <fieldset className="mb-7">
              <legend className="text-[17px] font-medium tracking-[-0.01em]">Bentuk slide</legend>
              <div className="mt-4 flex flex-col gap-1.5">
                {(
                  [
                    {
                      value: 'gambar' as const,
                      label: 'Gambar halaman',
                      hint: 'Tampilan persis seperti PDF aslinya, tetapi teksnya tidak bisa diedit.',
                    },
                    {
                      value: 'teks' as const,
                      label: 'Teks yang bisa diedit',
                      hint: 'Judul dan poin jadi kotak teks. Tata letak asli tidak dipertahankan.',
                    },
                  ]
                ).map((option) => (
                  <label
                    key={option.value}
                    className={`cursor-pointer rounded-micro px-4 py-3 transition-colors ${
                      slideMode === option.value ? 'bg-white shadow-nav' : 'hover:bg-white/60'
                    }`}
                  >
                    <span className="flex items-start gap-3">
                      <input
                        type="radio"
                        name="slide-mode"
                        checked={slideMode === option.value}
                        onChange={() => setSlideMode(option.value)}
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
              {/* Neither option is strictly better, and pretending otherwise
                  would set the wrong expectation for whichever they pick. */}
              <p className="mt-3 text-[13px] leading-snug text-slate">
                Tidak ada pilihan yang memberi keduanya sekaligus — itu memerlukan mesin tata
                letak yang tidak dimiliki peramban.
              </p>
            </fieldset>
          )}

          <h2 className="text-[17px] font-medium tracking-[-0.01em]">Cara kerjanya</h2>
          <p className="mt-3 text-[15px] leading-[1.45] text-granite">{config.expectation}</p>

          {/* Setting the limit before conversion, not after, is what stops the
              result feeling like a failure rather than a trade-off. */}
          <p className="mt-4 rounded-micro bg-white px-4 py-3 text-[14px] leading-[1.45] text-clay">
            {config.caveat}
          </p>

          {file && (
            <dl className="mt-6 flex flex-col gap-2 border-t border-dust/60 pt-5 text-[15px]">
              <div className="flex justify-between">
                <dt className="text-granite">Halaman terpilih</dt>
                <dd className="font-medium tabular-nums">{formatCount(selected.length)}</dd>
              </div>
            </dl>
          )}
        </div>
      }
    >
      <RejectionNotice rejections={rejections} onDismiss={dismissRejections} />
      <FileQueueList files={files} />

      {file && (
        <div className="mt-10">
          <PagePreviewGrid file={file} rotatable={false} />
        </div>
      )}
    </ToolShell>
  );
}
