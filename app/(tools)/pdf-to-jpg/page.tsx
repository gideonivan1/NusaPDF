import type { Metadata } from 'next';
import { PdfToJpgTool } from '@/components/tools/PdfToJpgTool';
import { getTool } from '@/lib/tools';

const tool = getTool('pdf-to-jpg');

export const metadata: Metadata = {
  title: tool.name,
  description: tool.description,
};

export default function PdfToJpgPage() {
  return <PdfToJpgTool />;
}
