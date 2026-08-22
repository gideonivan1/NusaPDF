import { getServiceSupabase } from '@/lib/supabase/server';
import { QUOTA } from '@/lib/supabase/config';
import type { PlanTier } from '@/lib/ai/types';

/**
 * Quota lives entirely server-side (PRD §10). The meter in the UI is a display
 * of this, never the enforcement of it — a client-side limit is a suggestion.
 */

/** Quota days roll over at Jakarta midnight, not UTC. */
function jakartaDate(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function nextJakartaMidnight(): string {
  const now = new Date();
  const jakartaNow = new Date(
    now.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }),
  );
  const reset = new Date(jakartaNow);
  reset.setHours(24, 0, 0, 0);
  return new Date(now.getTime() + (reset.getTime() - jakartaNow.getTime())).toISOString();
}

export interface QuotaStatus {
  messagesRemaining: number;
  documentsRemaining: number;
  resetsAt: string;
  plan: PlanTier;
}

export async function getQuota(ownerId: string, plan: PlanTier): Promise<QuotaStatus> {
  const supabase = getServiceSupabase();
  const limits = QUOTA[plan];

  const { data } = await supabase
    .from('ai_quota')
    .select('messages_used, documents_uploaded')
    .eq('owner_id', ownerId)
    .eq('quota_date', jakartaDate())
    .maybeSingle();

  return {
    messagesRemaining: Math.max(0, limits.messagesPerDay - (data?.messages_used ?? 0)),
    documentsRemaining: Math.max(0, limits.documentsPerDay - (data?.documents_uploaded ?? 0)),
    resetsAt: nextJakartaMidnight(),
    plan,
  };
}

/**
 * Reserves quota before the expensive call. Consuming up front and refunding on
 * failure is what keeps a burst of parallel requests from all passing a
 * check-then-use race.
 */
export async function consumeQuota(
  ownerId: string,
  plan: PlanTier,
  kind: 'message' | 'document',
): Promise<{ allowed: boolean; status: QuotaStatus }> {
  const supabase = getServiceSupabase();
  const limits = QUOTA[plan];
  const today = jakartaDate();
  const column = kind === 'message' ? 'messages_used' : 'documents_uploaded';
  const ceiling = kind === 'message' ? limits.messagesPerDay : limits.documentsPerDay;

  const { data: existing } = await supabase
    .from('ai_quota')
    .select('messages_used, documents_uploaded')
    .eq('owner_id', ownerId)
    .eq('quota_date', today)
    .maybeSingle();

  const used = (existing?.[column as keyof typeof existing] as number | undefined) ?? 0;

  if (used >= ceiling) {
    return { allowed: false, status: await getQuota(ownerId, plan) };
  }

  await supabase.from('ai_quota').upsert(
    {
      owner_id: ownerId,
      quota_date: today,
      messages_used: existing?.messages_used ?? 0,
      documents_uploaded: existing?.documents_uploaded ?? 0,
      [column]: used + 1,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'owner_id,quota_date' },
  );

  return { allowed: true, status: await getQuota(ownerId, plan) };
}

/** Returns quota after a failed call — PRD §13 US6 promises no charge on error. */
export async function refundQuota(
  ownerId: string,
  kind: 'message' | 'document',
): Promise<void> {
  const supabase = getServiceSupabase();
  const today = jakartaDate();
  const column = kind === 'message' ? 'messages_used' : 'documents_uploaded';

  const { data } = await supabase
    .from('ai_quota')
    .select('messages_used, documents_uploaded')
    .eq('owner_id', ownerId)
    .eq('quota_date', today)
    .maybeSingle();

  if (!data) return;

  const current = (data[column as keyof typeof data] as number | undefined) ?? 0;
  if (current <= 0) return;

  await supabase
    .from('ai_quota')
    .update({ [column]: current - 1, updated_at: new Date().toISOString() })
    .eq('owner_id', ownerId)
    .eq('quota_date', today);
}
