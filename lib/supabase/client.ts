'use client';

import { createBrowserClient } from '@supabase/ssr';
import { isSupabaseConfigured, SUPABASE_ANON_KEY, SUPABASE_URL } from './config';

let client: ReturnType<typeof createBrowserClient> | null = null;

export function getBrowserSupabase() {
  if (!isSupabaseConfigured) return null;
  client ??= createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return client;
}

/**
 * Ensures the visitor has an identity before any AI request.
 *
 * Anonymous sign-in is what lets a single set of RLS policies cover guests and
 * registered users alike (PRD §3). `linkIdentity()` later upgrades this same
 * uid, which is why conversations survive sign-up.
 */
export async function ensureSession() {
  const supabase = getBrowserSupabase();
  if (!supabase) return null;

  const { data } = await supabase.auth.getSession();
  if (data.session) return data.session;

  const { data: created, error } = await supabase.auth.signInAnonymously();
  if (error) throw error;

  return created.session;
}
