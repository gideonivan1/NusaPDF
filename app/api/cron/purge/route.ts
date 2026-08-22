import { NextResponse } from 'next/server';
import { getServiceSupabase } from '@/lib/supabase/server';
import { isSupabaseConfigured } from '@/lib/supabase/config';

/**
 * Deletes AI PDF documents past their retention window.
 *
 * The privacy policy, the UU PDP page, and the upload notice all state that
 * uploaded documents are removed automatically. `expires_at` was written on
 * every row from the start, but nothing ever read it — so the promise was not
 * being kept. This is what keeps it.
 *
 * Storage objects are removed through the storage API rather than by deleting
 * rows from `storage.objects`, because deleting the row leaves the underlying
 * file behind.
 */
export const runtime = 'nodejs';
export const maxDuration = 60;

/** Bounded so one run cannot exceed the function's time budget. */
const BATCH = 200;

function unauthorized() {
  return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
}

export async function GET(request: Request) {
  if (!isSupabaseConfigured) {
    return NextResponse.json({ skipped: 'Supabase belum dikonfigurasi' });
  }

  /**
   * Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Without the check
   * this endpoint would let anyone on the internet trigger a mass delete.
   */
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: 'CRON_SECRET belum diatur; endpoint dinonaktifkan' },
      { status: 503 },
    );
  }
  if (request.headers.get('authorization') !== `Bearer ${secret}`) return unauthorized();

  const supabase = getServiceSupabase();
  const now = new Date().toISOString();

  const { data: expired, error } = await supabase
    .from('documents')
    .select('id, storage_path')
    .lt('expires_at', now)
    .limit(BATCH);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!expired || expired.length === 0) {
    return NextResponse.json({ purged: 0, remaining: 0 });
  }

  const paths = expired.map((document) => document.storage_path).filter(Boolean);
  let storageError: string | null = null;

  if (paths.length > 0) {
    const { error: removeError } = await supabase.storage.from('ai-documents').remove(paths);
    // A missing object is not a reason to keep the row: the goal is that the
    // data is gone, and a file that is already absent satisfies that.
    if (removeError) storageError = removeError.message;
  }

  // Chunks, and any conversation referencing the document, cascade from here.
  const { error: deleteError } = await supabase
    .from('documents')
    .delete()
    .in(
      'id',
      expired.map((document) => document.id),
    );

  if (deleteError) {
    return NextResponse.json({ error: deleteError.message }, { status: 500 });
  }

  // Reported so a backlog larger than one batch is visible rather than silent.
  const { count } = await supabase
    .from('documents')
    .select('id', { count: 'exact', head: true })
    .lt('expires_at', now);

  return NextResponse.json({
    purged: expired.length,
    remaining: count ?? 0,
    storageError,
  });
}
