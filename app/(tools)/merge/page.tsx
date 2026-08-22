import type { Metadata } from 'next';
import { MergeTool } from '@/components/tools/MergeTool';
import { getTool } from '@/lib/tools';

const tool = getTool('merge');

export const metadata: Metadata = {
  title: tool.name,
  description: tool.description,
};

export default function MergePage() {
  return <MergeTool />;
}
