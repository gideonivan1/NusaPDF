'use client';

import { useEffect, useState } from 'react';
import { NusaError } from '@/lib/errors';
import { useDocumentLoader } from '@/lib/hooks/useDocumentLoader';
import { useFileIntake } from '@/lib/hooks/useFileIntake';
import { useToolRun } from '@/lib/hooks/useToolRun';
import { splitPdf } from '@/lib/pdf/client';
import { useQueue } from '@/lib/store/queue';
import { getTool } from '@/lib/tools';
import { formatCount, parsePageRanges, stripExtension } from '@/lib/utils';
import { FileQueueList } from '@/components/tools/FileQueueList';
import { PagePreviewGrid } from '@/components/tools/PagePreviewGrid';
import { RejectionNotice } from '@/components/tools/RejectionNotice';
import { ToolShell } from '@/components/tools/ToolShell';

const tool = getTool('split');

type SplitMode = 'each-selected' | 'extract' | 'every-page' | 'ranges';

const MODES: { value: SplitMode; label: string; hint: string }[] = [
  {
    value: 'each-selected',
    label: 'Tiap halaman terpilih jadi berkas sendiri',
    hint: 'Pilih halaman di pratinjau, masing-masing menjadi satu PDF.',
  },
  {
    value: 'extract',
    label: 'Gabungkan halaman terpilih jadi satu berkas',
    hint: 'Semua halaman yang dipilih dikumpulkan ke dalam satu PDF baru.',
  },
  {
    value: 'every-page',
    label: 'Pecah seluruh halaman',
    hint: 'Setiap halaman dokumen menjadi PDF terpisah.',
  },
  {
    value: 'ranges',
    label: 'Berdasarkan rentang',
    hint: 'Tulis rentang seperti 1-3, 7, 10-12. Tiap rentang jadi satu berkas.',
  },
];

export function SplitTool() {
  const files = useQueue((s) => s.files);
  const setPageRange = useQueue((s) => s.setPageRange);
  const { onFiles, rejections, dismissRejections } = useFileIntake(tool);
  const { state, run, cancel, reset } = useToolRun();

  const [mode, setMode] = useState<SplitMode>('each-selected');
  const [rangeText, setRangeText] = useState('');

  useDocumentLoader(files);

  // Split operates on one document at a time; the newest drop wins.
  const file = files.findLast((f) => f.status === 'ready') ?? null;
  const pageCount = file?.pages.length ?? 0;

  const parsedRanges = file ? parseRangeGroups(rangeText, pageCount) : null;
  const rangeInvalid = mode === 'ranges' && rangeText.trim().length > 0 && !parsedRanges;

  // Reflect the typed ranges in the preview so the two never disagree.
  useEffect(() => {
    if (mode !== 'ranges' || !file || !parsedRanges) return;
    setPageRange(file.localId, parsedRanges.flat().map((index) => index + 1));
  }, [mode, file, parsedRanges, setPageRange]);

  const selected = file?.pages.filter((p) => p.selected) ?? [];

  const groups = buildGroups(mode, selected.map((p) => p.index), pageCount, parsedRanges);

  const canRun = Boolean(file) && groups.length > 0 && !rangeInvalid && state.phase !== 'running';

  const blockedReason = !file
    ? undefined
    : rangeInvalid
      ? 'Format rentang belum benar'
      : groups.length === 0
        ? mode === 'ranges'
          ? 'Tulis rentang halaman terlebih dahulu'
          : 'Pilih minimal satu halaman'
        : undefined;

  const start = () =>
    void run(async (report) => {
      if (!file) throw new NusaError('E_UNKNOWN', 'Tidak ada dokumen');

      const buffer = await file.file.arrayBuffer();
      const baseName = stripExtension(file.file.name);

      const outputs = await splitPdf(buffer, groups, baseName, (done, total) =>
        report(done, total, 'Memisahkan halaman…'),
      );

      return {
        outputs: outputs.map((output) => ({
          fileName: output.fileName,
          blob: new Blob([output.bytes as BlobPart], { type: 'application/pdf' }),
        })),
        originalBytes: file.file.size,
        archiveName: `${baseName}_terpisah`,
        note: `${formatCount(outputs.length)} berkas dari ${formatCount(pageCount)} halaman`,
      };
    }, 'Membaca dokumen…');

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
        groups.length > 0 ? `Pisahkan jadi ${formatCount(groups.length)} berkas` : 'Pisahkan PDF'
      }
      options={
        <fieldset>
          <legend className="text-[17px] font-medium tracking-[-0.01em]">Cara memisahkan</legend>

          <div className="mt-5 flex flex-col gap-1.5">
            {MODES.map((option) => (
              <label
                key={option.value}
                className={`cursor-pointer rounded-micro px-4 py-3 transition-colors ${
                  mode === option.value ? 'bg-white shadow-nav' : 'hover:bg-white/60'
                }`}
              >
                <span className="flex items-start gap-3">
                  <input
                    type="radio"
                    name="split-mode"
                    value={option.value}
                    checked={mode === option.value}
                    onChange={() => setMode(option.value)}
                    className="mt-1 size-4 shrink-0 accent-[var(--color-ink)]"
                  />
                  <span className="min-w-0">
                    <span className="block text-[15px] leading-snug font-medium">
                      {option.label}
                    </span>
                    <span className="mt-1 block text-[13px] leading-snug text-slate">
                      {option.hint}
                    </span>
                  </span>
                </span>
              </label>
            ))}
          </div>

          {mode === 'ranges' && (
            <div className="mt-5">
              <label htmlFor="rentang" className="block text-[14px] font-medium">
                Rentang halaman
              </label>
              <input
                id="rentang"
                type="text"
                inputMode="numeric"
                value={rangeText}
                onChange={(event) => setRangeText(event.target.value)}
                placeholder="1-3, 7, 10-12"
                aria-invalid={rangeInvalid}
                aria-describedby={rangeInvalid ? 'rentang-galat' : undefined}
                className={`mt-2 w-full rounded-pill border bg-white px-5 py-3 text-[15px] outline-none ${
                  rangeInvalid ? 'border-signal' : 'border-ink/50 focus:border-ink'
                }`}
              />
              {rangeInvalid && (
                <p id="rentang-galat" className="mt-2 text-[14px] text-clay">
                  Gunakan format seperti 1-3, 7, 10-12 — dan pastikan nomornya antara 1 dan{' '}
                  {formatCount(pageCount)}.
                </p>
              )}
            </div>
          )}
        </fieldset>
      }
    >
      <RejectionNotice rejections={rejections} onDismiss={dismissRejections} />

      <FileQueueList files={files} />

      {file && (
        <div className="mt-10">
          <PagePreviewGrid file={file} selectable={mode !== 'every-page'} />
        </div>
      )}
    </ToolShell>
  );
}

/** "1-3, 7" -> [[0,1,2],[6]] — one group per comma-separated segment. */
function parseRangeGroups(input: string, pageCount: number): number[][] | null {
  if (!input.trim() || pageCount === 0) return null;

  const groups: number[][] = [];

  for (const segment of input.split(',')) {
    if (!segment.trim()) continue;
    const pages = parsePageRanges(segment, pageCount);
    if (!pages) return null;
    groups.push(pages.map((page) => page - 1));
  }

  return groups.length > 0 ? groups : null;
}

function buildGroups(
  mode: SplitMode,
  selectedIndices: number[],
  pageCount: number,
  parsedRanges: number[][] | null,
): number[][] {
  switch (mode) {
    case 'each-selected':
      return selectedIndices.map((index) => [index]);
    case 'extract':
      return selectedIndices.length > 0 ? [selectedIndices] : [];
    case 'every-page':
      return Array.from({ length: pageCount }, (_, index) => [index]);
    case 'ranges':
      return parsedRanges ?? [];
  }
}
