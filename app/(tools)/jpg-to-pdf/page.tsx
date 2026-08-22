import type { Metadata } from 'next';
import { JpgToPdfTool } from '@/components/tools/JpgToPdfTool';
import { getTool } from '@/lib/tools';

const tool = getTool('jpg-to-pdf');

export const metadata: Metadata = {
  title: tool.name,
  description: tool.description,
};

export default function JpgToPdfPage() {
  return <JpgToPdfTool />;
}
