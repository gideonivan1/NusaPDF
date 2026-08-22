'use client';

import { useEffect } from 'react';
import { NusaError } from '@/lib/errors';
import { useFileIntake } from '@/lib/hooks/useFileIntake';
import { useToolRun } from '@/lib/hooks/useToolRun';
import { excelToPdf, powerpointToPdf, wordToPdf } from '@/lib/office/convert';
import { useQueue } from '@/lib/store/queue';
import { getTool, type ToolSlug } from '@/lib/tools';
import { formatCount, stripExtension } from '@/lib/utils';
import { FileQueueList } from '@/components/tools/FileQueueList';
import { RejectionNotice } from '@/components/tools/RejectionNotice';
import { ToolShell } from '@/components/tools/ToolShell';

type Source = 'word' | 'powerpoint' | 'excel';

const SOURCES: Record<
  Source,
  { slug: ToolSlug; runLabel: string; expectation: string; caveat: string; legacy: string }
> = {
  word: {
    slug: 'word-to-pdf',
    runLabel: 'Ubah jadi PDF',
    expectation:
      'Judul, paragraf, daftar, dan tabel dibaca dari dokumen lalu ditata ulang ke halaman A4.',
    caveat:
      'Hasilnya ditata ulang, bukan disalin persis. Jenis huruf, penomoran halaman asli, header/footer, dan posisi gambar tidak dipertahankan.',
    legacy: '.doc',
  },
  powerpoint: {
    slug: 'powerpoint-to-pdf',
    runLabel: 'Ubah jadi PDF',
    expectation:
      'Teks setiap slide diambil dan disusun menjadi satu halaman per slide, mengikuti rasio deck aslinya.',
    caveat:
      'Yang berpindah adalah teks slide. Latar, gambar, bentuk, dan tema tidak ikut dirender.',
    legacy: '.ppt',
  },
  excel: {
    slug: 'excel-to-pdf',
    runLabel: 'Ubah jadi PDF',
    expectation:
      'Setiap lembar kerja menjadi satu halaman lanskap berisi tabel, dengan lebar kolom mengikuti isinya.',
    caveat:
      'Nilai sel yang dibaca, bukan tampilannya. Warna, format angka, grafik, dan rumus tidak ikut terbawa.',
    legacy: '.xls',
  },
};

export function OfficeToPdfTool({ source }: { source: Source }) {
  const config = SOURCES[source];
  const tool = getTool(config.slug);

  const files = useQueue((s) => s.files);
  const setFileParsed = useQueue((s) => s.setFileParsed);
  const { onFiles, rejections, dismissRejections } = useFileIntake(tool);
  const { state, run, cancel, reset } = useToolRun();

  /**
   * These are not paginated PDFs, so the PDF loader never runs. Marking them
   * ready keeps the shared queue row off its parsing spinner.
   */
  useEffect(() => {
    for (const file of files) {
      if (file.status === 'pending') {
        setFileParsed(file.localId, { pageCount: 0, hasTextLayer: true });
      }
    }
  }, [files, setFileParsed]);

  const ready = files.filter((f) => f.status === 'ready');
  const canRun = ready.length > 0 && state.phase !== 'running';

  const start = () =>
    void run(async (report) => {
      if (ready.length === 0) throw new NusaError('E_UNKNOWN', 'Tidak ada berkas');

      const outputs = [];

      for (const [index, file] of ready.entries()) {
        const progress = (done: number, total: number, label?: string) =>
          // Blend per-file progress into the batch so the bar advances smoothly.
          report(index + (total > 0 ? done / total : 0), ready.length, label);

        const blob =
          source === 'word'
            ? await wordToPdf(file.file, progress)
            : source === 'powerpoint'
              ? await powerpointToPdf(file.file, progress)
              : await excelToPdf(file.file, progress);

        outputs.push({ fileName: `${stripExtension(file.file.name)}.pdf`, blob });
      }

      report(ready.length, ready.length);

      return {
        outputs,
        originalBytes: ready.reduce((sum, file) => sum + file.file.size, 0),
        archiveName: 'nusapdf_konversi',
        note: `${formatCount(outputs.length)} berkas dikonversi`,
      };
    }, 'Membaca berkas…');

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
        ready.length > 1 ? `${config.runLabel} (${formatCount(ready.length)})` : config.runLabel
      }
      options={
        <div>
          <h2 className="text-[17px] font-medium tracking-[-0.01em]">Cara kerjanya</h2>
          <p className="mt-3 text-[15px] leading-[1.45] text-granite">{config.expectation}</p>

          <p className="mt-4 rounded-micro bg-white px-4 py-3 text-[14px] leading-[1.45] text-clay">
            {config.caveat}
          </p>

          {/* The legacy binary formats are a different container entirely, so
              saying so here avoids a puzzling rejection at the dropzone. */}
          <p className="mt-4 text-[13px] leading-snug text-slate">
            Format lama {config.legacy} belum didukung. Buka berkasnya di aplikasi Office
            lalu simpan ulang sebagai {config.legacy}x.
          </p>
        </div>
      }
    >
      <RejectionNotice rejections={rejections} onDismiss={dismissRejections} />
      <FileQueueList files={files} />
    </ToolShell>
  );
}
