import type { Metadata } from 'next';
import { SplitTool } from '@/components/tools/SplitTool';
import { getTool } from '@/lib/tools';

const tool = getTool('split');

export const metadata: Metadata = {
  title: tool.name,
  description: tool.description,
};

export default function SplitPage() {
  return <SplitTool />;
}
