-- ============================================================================
-- NusaPDF — initial schema
-- Ref: PRD §8 (Data Models) and its RLS table.
--
-- Design note: anonymous visitors get a real `auth.uid()` via Supabase's
-- anonymous sign-in, so every policy below is a plain owner check. There is no
-- separate "guest" code path to keep in sync, and upgrading an account with
-- linkIdentity() preserves the same id — which is what makes the AI history
-- survive sign-up (PRD §13 US8).
--
-- Client-side tools deliberately have NO tables here. Their files never reach
-- the server, so there is nothing to store.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- enums ----
create type plan_tier as enum ('anonymous', 'free', 'pro');

create type document_status as enum (
  'uploading', 'processing', 'ready', 'failed', 'expired'
);

create type job_status as enum (
  'queued', 'processing', 'succeeded', 'failed', 'canceled'
);

create type processing_mode as enum ('client', 'server');

-- ------------------------------------------------------------- profiles ----
create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  email        text,
  display_name text,
  avatar_url   text,
  plan         plan_tier    not null default 'anonymous',
  is_anonymous boolean      not null default true,
  locale_tag   text         not null default 'id-ID',
  created_at   timestamptz  not null default now(),
  updated_at   timestamptz  not null default now()
);

comment on table public.profiles is
  'One row per auth user, including anonymous ones.';

-- Keep profiles in step with auth.users automatically.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, is_anonymous, plan)
  values (
    new.id,
    new.email,
    coalesce(new.is_anonymous, false),
    case when coalesce(new.is_anonymous, false) then 'anonymous'::public.plan_tier
         else 'free'::public.plan_tier end
  )
  on conflict (id) do update
    set email        = excluded.email,
        is_anonymous = excluded.is_anonymous,
        plan         = excluded.plan,
        updated_at   = now();
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert or update of email, is_anonymous on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------ documents ----
-- Only files that genuinely must reach a server land here (MVP: AI PDF).
create table public.documents (
  id                      uuid primary key default gen_random_uuid(),
  owner_id                uuid not null references public.profiles (id) on delete cascade,
  storage_path            text not null,
  file_name               text not null,
  mime_type               text not null,
  size_bytes              bigint not null,
  page_count              integer,
  has_text_layer          boolean,
  gemini_file_uri         text,
  -- The Gemini Files API expires uploads after roughly 48 hours; storing this
  -- lets us re-upload transparently instead of failing an old conversation.
  gemini_file_expires_at  timestamptz,
  status                  document_status not null default 'uploading',
  error_code              text,
  expires_at              timestamptz not null default (now() + interval '24 hours'),
  created_at              timestamptz not null default now()
);

create index documents_owner_created_idx on public.documents (owner_id, created_at desc);
create index documents_expires_idx        on public.documents (expires_at)
  where status <> 'expired';

-- -------------------------------------------------------- conversations ----
create table public.conversations (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references public.profiles (id) on delete cascade,
  title           text not null default 'Percakapan baru',
  document_ids    uuid[] not null default '{}',
  message_count   integer not null default 0,
  last_message_at timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint conversations_document_limit check (cardinality(document_ids) <= 3)
);

create index conversations_owner_recent_idx
  on public.conversations (owner_id, last_message_at desc);

-- ------------------------------------------------------------- messages ----
create table public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  role            text not null check (role in ('user', 'assistant')),
  content         text not null,
  -- [{ documentId, pageNumber, snippet }] — drives the citation chips.
  citations       jsonb,
  model_id        text,
  tokens_in       integer,
  tokens_out      integer,
  latency_ms      integer,
  finish_reason   text,
  created_at      timestamptz not null default now()
);

create index messages_conversation_idx on public.messages (conversation_id, created_at);

-- Denormalised counters, maintained here so the history list needs one query.
create or replace function public.bump_conversation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.conversations
     set message_count   = message_count + 1,
         last_message_at = new.created_at,
         updated_at      = now()
   where id = new.conversation_id;
  return new;
end;
$$;

create trigger on_message_created
  after insert on public.messages
  for each row execute function public.bump_conversation();

-- ----------------------------------------------------------------- jobs ----
-- Phase 2 (Office conversions). Defined now so the schema does not need a
-- breaking change later; nothing writes to it in the MVP.
create table public.jobs (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references public.profiles (id) on delete cascade,
  tool          text not null,
  status        job_status not null default 'queued',
  progress      integer not null default 0 check (progress between 0 and 100),
  input_paths   text[] not null default '{}',
  output_path   text,
  error_code    text,
  error_message text,
  attempts      integer not null default 0,
  started_at    timestamptz,
  finished_at   timestamptz,
  expires_at    timestamptz not null default (now() + interval '24 hours'),
  created_at    timestamptz not null default now()
);

create index jobs_owner_created_idx on public.jobs (owner_id, created_at desc);

-- --------------------------------------------------------- usage_events ----
-- Telemetry only. For mode = 'client' NO file content is ever transmitted —
-- only the metadata below. This is the privacy contract in table form.
create table public.usage_events (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references public.profiles (id) on delete cascade,
  tool        text not null,
  mode        processing_mode not null,
  file_count  integer not null default 0,
  total_bytes bigint  not null default 0,
  page_count  integer,
  duration_ms integer not null default 0,
  succeeded   boolean not null default true,
  error_code  text,
  created_at  timestamptz not null default now()
);

create index usage_events_tool_created_idx on public.usage_events (tool, created_at desc);

-- ------------------------------------------------------------- ai_quota ----
-- One row per user per Jakarta day. Never readable by the client: the meter in
-- the UI comes from an endpoint, and the limit is enforced server-side.
create table public.ai_quota (
  owner_id            uuid not null references public.profiles (id) on delete cascade,
  quota_date          date not null,
  messages_used       integer not null default 0,
  documents_uploaded  integer not null default 0,
  updated_at          timestamptz not null default now(),
  primary key (owner_id, quota_date)
);

-- ============================================================================
-- Row Level Security — PRD §8. Every table is locked by default.
-- ============================================================================

alter table public.profiles      enable row level security;
alter table public.documents     enable row level security;
alter table public.conversations enable row level security;
alter table public.messages      enable row level security;
alter table public.jobs          enable row level security;
alter table public.usage_events  enable row level security;
alter table public.ai_quota      enable row level security;

create policy "profiles: owner reads"   on public.profiles
  for select using ((select auth.uid()) = id);
create policy "profiles: owner updates" on public.profiles
  for update using ((select auth.uid()) = id);

create policy "documents: owner all" on public.documents
  for all using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);

create policy "conversations: owner all" on public.conversations
  for all using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);

-- Messages inherit ownership through their conversation.
create policy "messages: owner all" on public.messages
  for all using (
    exists (
      select 1 from public.conversations c
       where c.id = messages.conversation_id
         and c.owner_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.conversations c
       where c.id = messages.conversation_id
         and c.owner_id = (select auth.uid())
    )
  );

-- Jobs are readable by their owner but only ever written by the service role.
create policy "jobs: owner reads" on public.jobs
  for select using ((select auth.uid()) = owner_id);

-- Telemetry is write-only from the client's perspective.
create policy "usage_events: owner inserts" on public.usage_events
  for insert with check ((select auth.uid()) = owner_id);

-- ai_quota intentionally has NO policies: service role only.

-- ============================================================================
-- Storage
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'ai-documents',
  'ai-documents',
  false,
  52428800, -- 50 MB, matching the AI PDF limit in PRD §3
  array['application/pdf']
)
on conflict (id) do nothing;

-- Objects are namespaced by owner id, so the first path segment is the check.
create policy "ai-documents: owner reads" on storage.objects
  for select using (
    bucket_id = 'ai-documents'
    and (select auth.uid())::text = (storage.foldername(name))[1]
  );

create policy "ai-documents: owner writes" on storage.objects
  for insert with check (
    bucket_id = 'ai-documents'
    and (select auth.uid())::text = (storage.foldername(name))[1]
  );

create policy "ai-documents: owner deletes" on storage.objects
  for delete using (
    bucket_id = 'ai-documents'
    and (select auth.uid())::text = (storage.foldername(name))[1]
  );
