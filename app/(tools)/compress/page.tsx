import type { Metadata } from 'next';
import { CompressTool } from '@/components/tools/CompressTool';
import { getTool } from '@/lib/tools';

const tool = getTool('compress');

export const metadata: Metadata = {
  title: tool.name,
  description: tool.description,
};

export default function CompressPage() {
  return <CompressTool />;
}
