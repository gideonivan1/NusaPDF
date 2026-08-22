/**
 * Environment access in one place.
 *
 * NusaPDF's five client-side tools are fully functional with no backend at all,
 * so a missing Supabase or Gemini configuration must degrade the AI module —
 * not crash the app. Every consumer checks `isSupabaseConfigured` /
 * `isGeminiConfigured` before reaching for a client.
 */

export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

/** Server-only. Never import this from a client component. */
export function getServiceRoleKey(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY belum diatur');
  return key;
}

/**
 * True when at least one Gemini key is present.
 *
 * Deliberately checks the env directly instead of importing the key pool:
 * this module is reachable from client components, and pulling the Gemini SDK
 * in through it would ship the whole thing to the browser.
 */
export const isGeminiConfigured = Boolean(
  process.env.GEMINI_API_KEY ??
    process.env.GEMINI_API_KEY_2 ??
    process.env.GEMINI_API_KEY_3 ??
    process.env.GEMINI_API_KEY_4,
);

/** Quota tiers — provisional numbers, flagged as Q3 in the PRD. */
export const QUOTA = {
  anonymous: { messagesPerDay: 5, documentsPerDay: 2 },
  free: { messagesPerDay: 30, documentsPerDay: 10 },
  pro: { messagesPerDay: 500, documentsPerDay: 100 },
} as const;

export const AI_LIMITS = {
  maxFileBytes: 50 * 1024 * 1024,
  maxPages: 500,
  maxDocumentsPerConversation: 3,
} as const;
