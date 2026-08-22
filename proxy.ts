import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { isSupabaseConfigured, SUPABASE_ANON_KEY, SUPABASE_URL } from '@/lib/supabase/config';

/**
 * Refreshes the Supabase session cookie on every matched request.
 *
 * Without this the anonymous session issued in the browser eventually expires
 * server-side, and AI requests start failing with a 401 that looks like a bug
 * rather than an expiry.
 *
 * Lives in `proxy.ts` rather than `middleware.ts`: Next 16 renamed the
 * convention and warns on the old filename.
 */
export async function proxy(request: NextRequest) {
  if (!isSupabaseConfigured) return NextResponse.next();

  let response = NextResponse.next({ request });

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        for (const { name, value } of list) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of list) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // Touching getUser() is what triggers the refresh; the result is unused here.
  await supabase.auth.getUser();

  return response;
}

export const config = {
  matcher: [
    /**
     * Everything except static assets and the pdf.js worker. Running this on
     * the 1.2 MB worker request would add latency to every document open for
     * no benefit.
     */
    '/((?!_next/static|_next/image|favicon.ico|pdf.worker.min.mjs|.*\\.(?:svg|png|jpg|jpeg|gif|webp|woff2?)$).*)',
  ],
};
