import type { Metadata } from 'next';
import { OfficeToPdfTool } from '@/components/tools/OfficeToPdfTool';
import { getTool } from '@/lib/tools';

const tool = getTool('powerpoint-to-pdf');

export const metadata: Metadata = {
  title: tool.name,
  description: tool.description,
};

export default function PowerpointToPdfPage() {
  return <OfficeToPdfTool source="powerpoint" />;
}
