-- ============================================================================
-- NusaPDF — retrieval-augmented generation for AI PDF
--
-- Replaces whole-document context stuffing with chunk retrieval. Three reasons:
--
-- 1. Cost. Re-sending a 500-page PDF on every turn multiplies token spend
--    (PRD risk R5). Retrieval sends only the passages that matter.
-- 2. Citation accuracy. Each chunk carries the page it came from, so a page
--    reference is a recorded fact rather than something the model recalls.
-- 3. Multi-document. Ranking across several documents at once falls out of the
--    same query.
-- ============================================================================

create extension if not exists vector;

-- 768 dimensions: gemini-embedding-001 truncates cleanly to this size, and it
-- indexes far more cheaply than the 3072 default with no measurable retrieval
-- loss at our document sizes.
create table public.document_chunks (
  id          uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents (id) on delete cascade,
  owner_id    uuid not null references public.profiles (id) on delete cascade,
  -- 1-indexed, matching what the viewer displays.
  page_number integer not null check (page_number > 0),
  chunk_index integer not null,
  content     text    not null,
  token_estimate integer,
  embedding   vector(768),
  created_at  timestamptz not null default now()
);

create index document_chunks_document_idx on public.document_chunks (document_id);
create index document_chunks_owner_idx    on public.document_chunks (owner_id);

-- HNSW over cosine distance. Built after ingest volume exists in production;
-- at MVP scale the planner may still prefer a sequential scan, which is fine.
create index document_chunks_embedding_idx
  on public.document_chunks
  using hnsw (embedding vector_cosine_ops);

alter table public.document_chunks enable row level security;

create policy "document_chunks: owner all" on public.document_chunks
  for all using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);

-- ---------------------------------------------------------------- retrieval --
-- SECURITY INVOKER (the default) so the caller's RLS still applies: a user can
-- only ever match against chunks they own, even though they pass document ids
-- in directly.
create or replace function public.match_document_chunks(
  query_embedding     vector(768),
  target_document_ids uuid[],
  match_count         integer default 8,
  min_similarity      double precision default 0.25
)
returns table (
  id          uuid,
  document_id uuid,
  page_number integer,
  content     text,
  similarity  double precision
)
language sql
stable
-- NOT `search_path = ''`, which is the usual hardening advice: the `<=>`
-- operator and the `vector` type live in the extension's schema, and an empty
-- search_path leaves them unresolvable ("operator does not exist: vector <=>
-- vector") at query time. Both schemas are listed because `create extension`
-- lands in `public` on a fresh database but in `extensions` when Supabase's
-- dashboard enabled it first.
--
-- Safe here because the function is SECURITY INVOKER (the default), so it runs
-- with the caller's own privileges and RLS still applies.
set search_path = public, extensions
as $$
  select
    c.id,
    c.document_id,
    c.page_number,
    c.content,
    1 - (c.embedding <=> query_embedding) as similarity
  from public.document_chunks c
  where c.document_id = any(target_document_ids)
    and c.embedding is not null
    and 1 - (c.embedding <=> query_embedding) >= min_similarity
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

-- Documents now carry their extraction/embedding state as well as upload state.
alter table public.documents
  add column if not exists chunk_count integer,
  add column if not exists indexed_at  timestamptz;

comment on column public.documents.chunk_count is
  'Number of embedded chunks. NULL until indexing completes.';
