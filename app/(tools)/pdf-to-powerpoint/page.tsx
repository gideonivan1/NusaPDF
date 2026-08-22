import type { Metadata } from 'next';
import { PdfToOfficeTool } from '@/components/tools/PdfToOfficeTool';
import { getTool } from '@/lib/tools';

const tool = getTool('pdf-to-powerpoint');

export const metadata: Metadata = {
  title: tool.name,
  description: tool.description,
};

export default function PdfToPowerpointPage() {
  return <PdfToOfficeTool target="powerpoint" />;
}
