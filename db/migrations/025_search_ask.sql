-- M6 Search & AskMeetSum (docs/parity/m6.md, "Migration 025_search_ask.sql").
-- Applies with and without pgvector: the vector part is guarded by a DO block
-- that checks pg_available_extensions (>= 0.8) and never references the
-- vector type statically. Idempotent (also runs from docker-entrypoint-initdb.d).

-- pg_trgm is required (contrib ships with every official and managed image).
create extension if not exists pg_trgm;
do $$ begin
  if coalesce(array_length(show_trgm('תקציב'), 1), 0) = 0 then
    raise warning 'MeetSum M6: pg_trgm produced no Hebrew trigrams (database locale); the trigram leg will be disabled';
  end if;
end $$;

create table if not exists meeting_chunks (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  meeting_id text not null references meetings(id) on delete cascade,
  kind text not null check (kind in ('transcript','summary','item','action_item','chapter','meta')),
  chunk_index integer not null,
  source_id text,                                   -- summary item / action item / chapter id
  segment_ids text[] not null default '{}',
  segment_start_ms integer[] not null default '{}', -- parallel to segment_ids
  segment_offsets integer[] not null default '{}',  -- UTF-16 offset of each segment in text
  overlap_count smallint not null default 0,        -- leading segment_ids that are overlap
  speaker_ids text[] not null default '{}',
  start_ms integer,
  end_ms integer,
  language text,                                    -- he | en | mixed
  text text not null,                               -- display text ("דנה: …" per turn)
  text_norm text not null,                          -- folded raw tokens
  text_stem text not null default '',               -- prefix-stripped / stemmed variants
  tsv tsvector generated always as (
    setweight(to_tsvector('simple', text_norm), 'A') ||
    setweight(to_tsvector('simple', text_stem), 'B')) stored,
  token_estimate integer not null,
  content_hash text not null,                       -- sha256(kind || '\0' || text)
  transcript_version integer not null default 0,
  created_at timestamptz not null default now(),
  unique (meeting_id, kind, chunk_index)
);
create index if not exists idx_meeting_chunks_tsv on meeting_chunks using gin (tsv);
create index if not exists idx_meeting_chunks_trgm on meeting_chunks using gin (text_norm gin_trgm_ops);
create index if not exists idx_meeting_chunks_ws_meeting on meeting_chunks (workspace_id, meeting_id, kind);
create index if not exists idx_meeting_chunks_hash on meeting_chunks (meeting_id, content_hash);
create index if not exists idx_meeting_chunks_speakers on meeting_chunks using gin (speaker_ids);

-- Optional vector support. Keep in sync with lib/search/vector-ddl.ts (static test).
do $$
declare avail text; inst text;
begin
  select default_version into avail from pg_available_extensions where name = 'vector';
  select extversion into inst from pg_extension where extname = 'vector';
  if avail is null then
    raise notice 'MeetSum M6: pgvector not available; search runs lexical (FTS + trigram). Use the pgvector image, then npm run search:vector-setup.';
    return;
  end if;
  if string_to_array(split_part(coalesce(inst, avail), '-', 1), '.')::int[] < array[0,8] then
    raise notice 'MeetSum M6: pgvector % is older than 0.8 (needed for filtered HNSW); lexical only. ALTER EXTENSION vector UPDATE, then npm run search:vector-setup.', coalesce(inst, avail);
    return;
  end if;
  -- A role without CREATE privilege on the database must not abort the
  -- migration: stay lexical-only (NOTICE) and let an admin install vector.
  begin
    create extension if not exists vector;
  exception when insufficient_privilege then
    raise notice 'MeetSum M6: no privilege to create the vector extension; search runs lexical (FTS + trigram). Ask a superuser to install the vector extension, then npm run search:vector-setup.';
    return;
  end;
  execute $ddl$
    create table if not exists meeting_chunk_embeddings (
      workspace_id text not null references workspaces(id) on delete cascade,
      meeting_id text not null references meetings(id) on delete cascade,
      content_hash text not null,
      model text not null,
      dimensions smallint not null check (dimensions between 1 and 2000),
      embedding vector not null,
      created_at timestamptz not null default now(),
      primary key (meeting_id, content_hash, model, dimensions)
    )$ddl$;
  execute $ddl$ create index if not exists idx_mce_ws on meeting_chunk_embeddings (workspace_id, model, dimensions) $ddl$;
  execute $ddl$
    create index if not exists idx_mce_hnsw_gemini_embedding_001_1536 on meeting_chunk_embeddings
      using hnsw ((embedding::vector(1536)) vector_cosine_ops) with (m = 16, ef_construction = 64)
      where model = 'gemini-embedding-001' and dimensions = 1536 $ddl$;
end $$;

alter table meetings
  add column if not exists meeting_type text,                 -- from IntelligenceV2.meetingType (indexer)
  add column if not exists search_index_state text not null default 'pending',
  add column if not exists search_index_mode text,            -- hybrid | lexical
  add column if not exists search_embedding_key text,         -- "<model>:<dims>" used, null when lexical
  add column if not exists search_indexed_at timestamptz,
  add column if not exists search_indexed_version integer,
  add column if not exists search_requested_at timestamptz,
  add column if not exists search_index_error text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'meetings_search_index_state_check') then
    alter table meetings add constraint meetings_search_index_state_check
      check (search_index_state in ('pending','ready','failed','skipped'));
  end if;
end $$;
create index if not exists idx_meetings_search_stale on meetings (workspace_id) where search_index_state <> 'ready';
create index if not exists idx_meetings_meeting_type on meetings (workspace_id, meeting_type) where meeting_type is not null;

create table if not exists chat_threads (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  scope_kind text not null check (scope_kind in ('meeting','room','workspace')),
  meeting_id text references meetings(id) on delete cascade,
  context_id text references contexts(id) on delete cascade,
  title text,
  language text,
  message_count integer not null default 0,
  last_message_at timestamptz,
  archived_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((scope_kind = 'meeting') = (meeting_id is not null)),
  check ((scope_kind = 'room') = (context_id is not null))
);
create index if not exists idx_chat_threads_user on chat_threads (workspace_id, user_id, last_message_at desc) where deleted_at is null;
create index if not exists idx_chat_threads_meeting on chat_threads (meeting_id) where meeting_id is not null;

create table if not exists chat_messages (
  id text primary key,
  thread_id text not null references chat_threads(id) on delete cascade,
  workspace_id text not null references workspaces(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null,
  status text not null default 'complete' check (status in ('streaming','complete','refused','error','aborted')),
  citations jsonb not null default '[]'::jsonb,  -- AskCitation[] (ids + startMs; quote derived from segment text)
  retrieval jsonb,                               -- {mode, chunkIds, legRanks, topSimilarity} (no text)
  grounded boolean,
  language text,
  provider text, model text, ai_run_id text, prompt_version text,
  input_tokens integer, output_tokens integer, cache_read_tokens integer, cache_write_tokens integer,
  cost_estimate numeric,
  feedback smallint check (feedback in (-1, 1)),
  error text,
  created_at timestamptz not null default now()
);
create index if not exists idx_chat_messages_thread on chat_messages (thread_id, created_at);
create index if not exists idx_chat_messages_ws_day on chat_messages (workspace_id, created_at) where role = 'user';
