import type { Metadata } from 'next';
import { PdfToOfficeTool } from '@/components/tools/PdfToOfficeTool';
import { getTool } from '@/lib/tools';

const tool = getTool('pdf-to-word');

export const metadata: Metadata = {
  title: tool.name,
  description: tool.description,
};

export default function PdfToWordPage() {
  return <PdfToOfficeTool target="word" />;
}
