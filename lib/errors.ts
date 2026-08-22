import type { ToolSlug } from './tools';

/** Ref: PRD §6 "Matriks galat". Every failure must map to one of these. */
export type ErrorCode =
  | 'E_ENCRYPTED'
  | 'E_CORRUPT'
  | 'E_TOO_LARGE'
  | 'E_TOO_COMPLEX'
  | 'E_OOM'
  | 'E_UNSUPPORTED_TYPE'
  | 'E_SCANNED_NO_TEXT'
  | 'E_QUOTA'
  | 'E_AI_TIMEOUT'
  | 'E_AI_MODEL'
  | 'E_NETWORK'
  | 'E_CANCELED'
  | 'E_UNKNOWN';

export interface ErrorCopy {
  /** What happened, in plain Indonesian. */
  title: string;
  /** What the user should do next. Never omit this. */
  action: string;
  /** Optional in-app route that resolves the problem. */
  href?: string;
  hrefLabel?: string;
}

export const ERROR_COPY: Record<ErrorCode, ErrorCopy> = {
  E_ENCRYPTED: {
    title: 'PDF ini terkunci password.',
    action: 'Buka proteksinya lebih dulu di aplikasi PDF Anda, lalu coba lagi.',
  },
  E_CORRUPT: {
    title: 'Berkas ini tampaknya rusak atau bukan PDF yang valid.',
    action: 'Coba buka di pembaca PDF lain untuk memastikan, atau unggah berkas lain.',
  },
  E_TOO_LARGE: {
    title: 'Berkas melebihi batas 100 MB.',
    action: 'Kecilkan dulu ukurannya, lalu ulangi.',
    href: '/compress',
    hrefLabel: 'Buka Compress PDF',
  },
  // Separate from E_TOO_LARGE because the file size may be perfectly fine —
  // what exceeds the limit is how much *text* it holds, which no one can judge
  // by looking at the file. Saying "too large" would send them off to compress
  // a document whose size was never the problem.
  E_TOO_COMPLEX: {
    title: 'Dokumen ini memuat terlalu banyak teks untuk diindeks sekaligus.',
    action:
      'Pisahkan menjadi beberapa bagian yang lebih kecil, lalu unggah satu per satu. Kuota Anda tidak terpakai.',
    href: '/split',
    hrefLabel: 'Buka Split PDF',
  },

  E_OOM: {
    title: 'Dokumen terlalu berat untuk peramban ini.',
    action:
      'Coba proses lebih sedikit halaman sekaligus, atau gunakan perangkat dengan memori lebih besar.',
  },
  E_UNSUPPORTED_TYPE: {
    title: 'Tipe berkas ini tidak diterima alat yang sedang Anda pakai.',
    action: 'Periksa format berkasnya, atau pilih alat yang sesuai.',
  },
  E_SCANNED_NO_TEXT: {
    title: 'Dokumen ini tampak hasil pindai tanpa lapisan teks.',
    action:
      'AI belum dapat membacanya. Dukungan OCR sedang kami siapkan — sementara ini gunakan PDF yang teksnya dapat diseleksi.',
  },
  E_QUOTA: {
    title: 'Kuota AI harian Anda sudah habis.',
    action: 'Masuk untuk mendapatkan kuota yang lebih besar, atau coba lagi besok.',
    href: '/masuk',
    hrefLabel: 'Masuk',
  },
  E_AI_TIMEOUT: {
    title: 'Asisten sedang tidak merespons.',
    action: 'Coba kirim ulang pertanyaan Anda sebentar lagi. Kuota Anda tidak terpakai.',
  },
  // Distinct from E_AI_TIMEOUT because retrying cannot help: a retired or
  // misconfigured model fails identically every time. Telling the user to wait
  // would send them in circles.
  E_AI_MODEL: {
    title: 'Model AI yang dikonfigurasi tidak tersedia.',
    action:
      'Ini masalah di sisi kami, bukan pada dokumen Anda, dan mengulang tidak akan menolong. Kuota Anda tidak terpakai.',
  },
  E_NETWORK: {
    title: 'Koneksi terputus.',
    action:
      'Alat yang diproses di perangkat tetap berfungsi. Fitur AI memerlukan koneksi internet.',
  },
  E_CANCELED: {
    title: 'Proses dibatalkan.',
    action: 'Tidak ada berkas yang berubah. Anda bisa mengatur ulang lalu menjalankannya kembali.',
  },
  E_UNKNOWN: {
    title: 'Terjadi kendala yang tidak terduga.',
    action: 'Muat ulang halaman dan coba lagi. Jika berulang, laporkan ke kami.',
  },
};

/** Error carrying a code from the matrix above, so the UI never has to guess. */
export class NusaError extends Error {
  readonly code: ErrorCode;
  readonly detail?: string;

  constructor(code: ErrorCode, detail?: string) {
    super(detail ?? ERROR_COPY[code].title);
    this.name = 'NusaError';
    this.code = code;
    this.detail = detail;
  }
}

export function toErrorCode(error: unknown): ErrorCode {
  if (error instanceof NusaError) return error.code;

  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  // pdf-lib and pdfjs surface encryption through message text rather than types.
  if (lower.includes('encrypt') || lower.includes('password')) return 'E_ENCRYPTED';
  if (lower.includes('out of memory') || lower.includes('allocation')) return 'E_OOM';
  if (lower.includes('invalid pdf') || lower.includes('failed to parse')) return 'E_CORRUPT';
  if (lower.includes('abort') || lower.includes('cancel')) return 'E_CANCELED';
  if (lower.includes('fetch') || lower.includes('network')) return 'E_NETWORK';

  return 'E_UNKNOWN';
}

/**
 * Builds the "mungkin maksud Anda X?" recovery hint for a wrong file type.
 * Ref: PRD §13 US1 — dropping a .docx must point at Word to PDF, not just fail.
 */
export function suggestToolForFile(fileName: string): { slug: ToolSlug; label: string } | null {
  const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();

  switch (ext) {
    case '.doc':
    case '.docx':
      return { slug: 'word-to-pdf', label: 'Word to PDF' };
    case '.ppt':
    case '.pptx':
      return { slug: 'powerpoint-to-pdf', label: 'PowerPoint to PDF' };
    case '.xls':
    case '.xlsx':
      return { slug: 'excel-to-pdf', label: 'Excel to PDF' };
    case '.jpg':
    case '.jpeg':
    case '.png':
    case '.webp':
      return { slug: 'jpg-to-pdf', label: 'JPG to PDF' };
    case '.pdf':
      return { slug: 'merge', label: 'Merge PDF' };
    default:
      return null;
  }
}
