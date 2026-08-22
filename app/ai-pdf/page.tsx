import type { Metadata } from 'next';
import { AiPdfTool } from '@/components/ai/AiPdfTool';
import { isGeminiConfigured, isSupabaseConfigured } from '@/lib/supabase/config';
import { getTool } from '@/lib/tools';

const tool = getTool('ai-pdf');

export const metadata: Metadata = {
  title: tool.name,
  description: tool.description,
};

export default function AiPdfPage() {
  // Resolved on the server so the client never has to probe for credentials
  // and the "not configured" state renders on the first paint.
  return <AiPdfTool configured={isSupabaseConfigured && isGeminiConfigured} />;
}
