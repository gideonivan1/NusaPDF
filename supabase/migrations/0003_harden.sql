-- ============================================================================
-- NusaPDF — hardening pass
--
-- Everything here came out of Supabase's security advisor after 0001 and 0002
-- were applied. Kept as its own migration rather than folded into the earlier
-- files so the repo mirrors the order the database actually ran.
-- ============================================================================

-- ------------------------------------------------- 1. trigger functions ----
-- PostgREST exposes every function in `public` as an RPC endpoint, so
-- `handle_new_user` and `bump_conversation` were reachable at
-- /rest/v1/rpc/... by anonymous callers. They are trigger functions and have
-- no business being invoked directly.
--
-- Note the `from public`: EXECUTE is granted to the PUBLIC role by default and
-- anon/authenticated inherit it, so revoking from those two roles alone is a
-- no-op. PUBLIC is the actual source of the privilege.
--
-- Triggers keep working: EXECUTE on a trigger function is checked when the
-- trigger is created, not each time it fires.
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.bump_conversation() from public, anon, authenticated;

-- ---------------------------------------------------- 2. retrieval RPC ----
-- This one must stay callable, but only for a signed-in session. Supabase's
-- anonymous sign-in issues a real `authenticated` JWT, so ordinary visitors
-- are covered; the `anon` role means "no session at all", which never applies
-- to an AI PDF request.
revoke execute on function
  public.match_document_chunks(vector, uuid[], integer, double precision)
  from public, anon;

grant execute on function
  public.match_document_chunks(vector, uuid[], integer, double precision)
  to authenticated;

-- ------------------------------------------------- 3. extension schema ----
-- `create extension vector` in 0002 lands in `public` on a fresh database.
-- Supabase's convention is the `extensions` schema, and the advisor flags the
-- public install. Safe to move because `match_document_chunks` already sets
-- `search_path = public, extensions` — which is precisely why both schemas are
-- listed there.
--
-- The `vector(768)` column type and the HNSW index follow the extension and
-- need no changes.
--
-- Guarded because `ALTER EXTENSION ... SET SCHEMA` errors when the extension is
-- already there, which would make this migration fail on a re-run.
do $$
begin
  if exists (
    select 1
    from pg_extension e
    join pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'vector' and n.nspname <> 'extensions'
  ) then
    execute 'alter extension vector set schema extensions';
  end if;
end
$$;

-- ============================================================================
-- Deliberately NOT changed
--
-- * `ai_quota` has RLS enabled with zero policies, which the advisor reports as
--   INFO. That is the intended design: quota is enforced server-side and the
--   table is reachable only by the service role. Zero policies means the
--   client is denied by default — exactly right.
--
-- * `public.rls_auto_enable()` is also flagged, but it belongs to Supabase's
--   "automatic RLS" project setting, not to NusaPDF. Left alone so the
--   platform feature keeps working.
-- ============================================================================
