import type { LucideIcon } from 'lucide-react';
import {
  Combine,
  FileImage,
  FileSpreadsheet,
  FileText,
  Images,
  Minimize2,
  PenLine,
  Presentation,
  Scissors,
  Sparkles,
} from 'lucide-react';

/** Every tool NusaPDF offers or intends to offer. Ref: PRD §3. */
export type ToolSlug =
  | 'ai-pdf'
  | 'merge'
  | 'split'
  | 'compress'
  | 'pdf-to-jpg'
  | 'jpg-to-pdf'
  | 'pdf-to-word'
  | 'pdf-to-powerpoint'
  | 'pdf-to-excel'
  | 'word-to-pdf'
  | 'powerpoint-to-pdf'
  | 'excel-to-pdf'
  | 'edit';

/**
 * Where the work happens.
 * `client` is the privacy contract: the file's bytes never leave the device.
 */
export type ProcessingMode = 'client' | 'server';

export type ToolCategory = 'ai' | 'organize' | 'optimize' | 'convert' | 'edit';

export interface ToolDefinition {
  slug: ToolSlug;
  /** Route segment. AI PDF lives outside the (tools) group. */
  href: string;
  name: string;
  /** Eyebrow label — always uppercase, always preceded by the accent dot. */
  category: ToolCategory;
  description: string;
  mode: ProcessingMode;
  icon: LucideIcon;
  available: boolean;
  /** File types the dropzone accepts, as an `accept` attribute value. */
  accept: string;
  /** Whether the tool is meaningful with a single file. */
  minFiles: number;
}

export const CATEGORY_LABEL: Record<ToolCategory, string> = {
  ai: 'AI',
  organize: 'ATUR',
  optimize: 'OPTIMASI',
  convert: 'KONVERSI',
  edit: 'EDIT',
};

const PDF_ACCEPT = 'application/pdf,.pdf';
const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp';

// Only the OOXML formats. The legacy .doc/.ppt/.xls are binary OLE containers,
// not zipped XML, so the readers here genuinely cannot open them — accepting
// them would turn a clear "unsupported" into a confusing failure mid-conversion.
const DOCX_ACCEPT =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx';
const PPTX_ACCEPT =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation,.pptx';
const XLSX_ACCEPT =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.xlsx';

export const TOOLS: ToolDefinition[] = [
  {
    slug: 'ai-pdf',
    href: '/ai-pdf',
    name: 'AI PDF',
    category: 'ai',
    description:
      'Chat dengan PDF Anda. Ajukan pertanyaan, dapatkan ringkasan, dan temukan jawaban instan dari dokumen apa pun.',
    mode: 'server',
    icon: Sparkles,
    available: true,
    accept: PDF_ACCEPT,
    minFiles: 1,
  },
  {
    slug: 'merge',
    href: '/merge',
    name: 'Merge PDF',
    category: 'organize',
    description:
      'Gabungkan beberapa PDF sesuai urutan yang diinginkan dengan alat penggabungan PDF yang paling mudah digunakan.',
    mode: 'client',
    icon: Combine,
    available: true,
    accept: PDF_ACCEPT,
    minFiles: 2,
  },
  {
    slug: 'split',
    href: '/split',
    name: 'Split PDF',
    category: 'organize',
    description:
      'Pisahkan satu halaman atau seluruh kumpulan halaman dari sebuah PDF menjadi beberapa file PDF yang terpisah.',
    mode: 'client',
    icon: Scissors,
    available: true,
    accept: PDF_ACCEPT,
    minFiles: 1,
  },
  {
    slug: 'compress',
    href: '/compress',
    name: 'Compress PDF',
    category: 'optimize',
    description:
      'Kurangi ukuran file PDF sambil tetap mengoptimalkan kualitas dokumen.',
    mode: 'client',
    icon: Minimize2,
    available: true,
    accept: PDF_ACCEPT,
    minFiles: 1,
  },
  {
    slug: 'pdf-to-jpg',
    href: '/pdf-to-jpg',
    name: 'PDF to JPG',
    category: 'convert',
    description:
      'Konversikan setiap halaman PDF menjadi gambar JPG atau ekstrak seluruh gambar yang terdapat di dalam PDF.',
    mode: 'client',
    icon: FileImage,
    available: true,
    accept: PDF_ACCEPT,
    minFiles: 1,
  },
  {
    slug: 'jpg-to-pdf',
    href: '/jpg-to-pdf',
    name: 'JPG to PDF',
    category: 'convert',
    description:
      'Konversikan gambar JPG menjadi file PDF dalam hitungan detik. Atur orientasi dan margin dengan mudah.',
    mode: 'client',
    icon: Images,
    available: true,
    accept: IMAGE_ACCEPT,
    minFiles: 1,
  },

  /* ---- Conversions. Like the rest, these run entirely in the browser ----
     (see lib/office/convert.ts for the fidelity trade-off that entails). */
  {
    slug: 'pdf-to-word',
    href: '/pdf-to-word',
    name: 'PDF to Word',
    category: 'convert',
    description:
      'Konversikan file PDF menjadi dokumen Word (.docx) yang teksnya siap diedit.',
    mode: 'client',
    icon: FileText,
    available: true,
    accept: PDF_ACCEPT,
    minFiles: 1,
  },
  {
    slug: 'pdf-to-powerpoint',
    href: '/pdf-to-powerpoint',
    name: 'PDF to PowerPoint',
    category: 'convert',
    description: 'Ubah setiap halaman PDF menjadi slide PowerPoint (.pptx) yang siap dipresentasikan.',
    mode: 'client',
    icon: Presentation,
    available: true,
    accept: PDF_ACCEPT,
    minFiles: 1,
  },
  {
    slug: 'pdf-to-excel',
    href: '/pdf-to-excel',
    name: 'PDF to Excel',
    category: 'convert',
    description:
      'Ekstrak data langsung dari PDF ke lembar kerja Excel dalam hitungan detik.',
    mode: 'client',
    icon: FileSpreadsheet,
    available: true,
    accept: PDF_ACCEPT,
    minFiles: 1,
  },
  {
    slug: 'word-to-pdf',
    href: '/word-to-pdf',
    name: 'Word to PDF',
    category: 'convert',
    description:
      'Buat dokumen Word (.docx) lebih mudah dibagikan dengan mengonversinya ke format PDF.',
    mode: 'client',
    icon: FileText,
    available: true,
    accept: DOCX_ACCEPT,
    minFiles: 1,
  },
  {
    slug: 'powerpoint-to-pdf',
    href: '/powerpoint-to-pdf',
    name: 'PowerPoint to PDF',
    category: 'convert',
    description:
      'Permudah berbagi dan melihat presentasi PowerPoint (.pptx) dengan mengonversinya ke format PDF.',
    mode: 'client',
    icon: Presentation,
    available: true,
    accept: PPTX_ACCEPT,
    minFiles: 1,
  },
  {
    slug: 'excel-to-pdf',
    href: '/excel-to-pdf',
    name: 'Excel to PDF',
    category: 'convert',
    description:
      'Permudah berbagi dan melihat spreadsheet Excel (.xlsx) dengan mengonversinya ke format PDF.',
    mode: 'client',
    icon: FileSpreadsheet,
    available: true,
    accept: XLSX_ACCEPT,
    minFiles: 1,
  },
  {
    slug: 'edit',
    href: '/edit',
    name: 'Edit PDF',
    category: 'edit',
    description:
      'Tambahkan teks, gambar, bentuk, atau anotasi gambar tangan ke dokumen PDF.',
    mode: 'client',
    icon: PenLine,
    available: false,
    accept: PDF_ACCEPT,
    minFiles: 1,
  },
];

export const AVAILABLE_TOOLS = TOOLS.filter((t) => t.available);

export function getTool(slug: ToolSlug): ToolDefinition {
  const tool = TOOLS.find((t) => t.slug === slug);
  if (!tool) throw new Error(`Unknown tool: ${slug}`);
  return tool;
}
