import { NextResponse } from 'next/server';
import { isGeminiConfigured, isSupabaseConfigured } from '@/lib/supabase/config';
import { getServerSupabase } from '@/lib/supabase/server';
import type { ErrorCode } from '@/lib/errors';
import type { PlanTier } from '@/lib/ai/types';

export function apiError(code: ErrorCode, status: number, detail?: string) {
  return NextResponse.json({ error: { code, detail } }, { status });
}

export interface Caller {
  userId: string;
  plan: PlanTier;
  supabase: NonNullable<Awaited<ReturnType<typeof getServerSupabase>>>;
}

/**
 * Resolves the caller for an AI endpoint.
 *
 * Returns a NextResponse instead of throwing so routes stay linear. A missing
 * backend configuration is reported as `E_NETWORK` with 503 — the five
 * client-side tools keep working regardless, so this is a degraded feature
 * rather than a broken app.
 */
export async function requireCaller(): Promise<Caller | NextResponse> {
  if (!isSupabaseConfigured || !isGeminiConfigured) {
    return apiError('E_NETWORK', 503, 'Modul AI belum dikonfigurasi di server ini');
  }

  const supabase = await getServerSupabase();
  if (!supabase) return apiError('E_NETWORK', 503, 'Supabase tidak tersedia');

  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    return apiError('E_UNKNOWN', 401, 'Sesi tidak ditemukan');
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('plan')
    .eq('id', data.user.id)
    .maybeSingle();

  return {
    userId: data.user.id,
    plan: (profile?.plan as PlanTier | undefined) ?? 'anonymous',
    supabase,
  };
}

export function isResponse(value: unknown): value is NextResponse {
  return value instanceof NextResponse;
}
