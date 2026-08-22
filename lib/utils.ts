import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Indonesian number conventions: thousands with `.`, decimals with `,`. */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  const decimals = i === 0 ? 0 : value < 10 ? 1 : 0;
  return `${value.toLocaleString('id-ID', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })} ${units[i]}`;
}

export function formatCount(n: number): string {
  return n.toLocaleString('id-ID');
}

/** "Laporan Tahunan.pdf" -> "Laporan Tahunan" */
export function stripExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

/** Truncates in the middle so both the name start and the extension stay visible. */
export function truncateMiddle(text: string, max = 32): string {
  if (text.length <= max) return text;
  const keep = Math.floor((max - 1) / 2);
  return `${text.slice(0, keep)}…${text.slice(-keep)}`;
}

/**
 * Parses "1-3, 7, 10-12" into a sorted, de-duplicated list of 1-indexed pages.
 * Returns null when the expression is malformed so the UI can explain why.
 */
export function parsePageRanges(input: string, pageCount: number): number[] | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const pages = new Set<number>();

  for (const part of trimmed.split(',')) {
    const chunk = part.trim();
    if (!chunk) continue;

    const range = chunk.match(/^(\d+)\s*[-–]\s*(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start < 1 || end > pageCount || start > end) return null;
      for (let p = start; p <= end; p++) pages.add(p);
      continue;
    }

    const single = chunk.match(/^(\d+)$/);
    if (single) {
      const page = Number(single[1]);
      if (page < 1 || page > pageCount) return null;
      pages.add(page);
      continue;
    }

    return null;
  }

  return pages.size > 0 ? [...pages].sort((a, b) => a - b) : null;
}

/** Triggers a browser download from an in-memory blob. No network involved. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke on the next frame so Safari has time to start the download.
  requestAnimationFrame(() => URL.revokeObjectURL(url));
}
