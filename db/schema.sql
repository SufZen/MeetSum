create table if not exists users (
  id text primary key,
  email text not null unique,
  display_name text,
  created_at timestamptz not null default now()
);

create table if not exists workspace_accounts (
  id text primary key,
  domain text not null,
  admin_email text not null,
  auth_model text not null default 'domain_wide_delegation',
  created_at timestamptz not null default now()
);

create table if not exists google_identities (
  id text primary key,
  workspace_account_id text not null references workspace_accounts(id),
  subject_email text not null,
  google_user_id text,
  sync_enabled boolean not null default true
);

create table if not exists google_sync_states (
  id text primary key,
  google_identity_id text not null references google_identities(id),
  source text not null,
  cursor_value text,
  watch_channel_id text,
  watch_expires_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists calendar_events (
  id text primary key,
  google_identity_id text not null references google_identities(id),
  google_event_id text not null,
  title text not null,
  starts_at timestamptz,
  ends_at timestamptz,
  meet_link text,
  raw jsonb not null default '{}'::jsonb
);

create table if not exists gmail_threads (
  id text primary key,
  google_identity_id text not null references google_identities(id),
  google_thread_id text not null,
  subject text,
  participants jsonb not null default '[]'::jsonb,
  raw jsonb not null default '{}'::jsonb
);

create table if not exists drive_files (
  id text primary key,
  google_identity_id text not null references google_identities(id),
  google_file_id text not null,
  name text not null,
  mime_type text,
  web_view_link text,
  raw jsonb not null default '{}'::jsonb
);

create table if not exists meetings (
  id text primary key,
  calendar_event_id text references calendar_events(id),
  title text not null,
  source text not null,
  language text not null default 'he',
  status text not null,
  retention text not null default 'audio',
  started_at timestamptz not null,
  participants jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists media_assets (
  id text primary key,
  meeting_id text not null references meetings(id),
  storage_key text not null,
  content_type text not null,
  size_bytes bigint not null,
  retention text not null default 'audio'
);

create table if not exists speakers (
  id text primary key,
  meeting_id text not null references meetings(id),
  label text not null,
  display_name text
);

create table if not exists transcript_segments (
  id text primary key,
  meeting_id text not null references meetings(id),
  speaker_id text references speakers(id),
  start_ms integer not null,
  end_ms integer not null,
  text text not null,
  confidence numeric
);

create table if not exists summaries (
  id text primary key,
  meeting_id text not null references meetings(id),
  overview text not null,
  language text not null default 'he',
  model_provider text,
  created_at timestamptz not null default now()
);

create table if not exists summary_sections (
  id text primary key,
  summary_id text not null references summaries(id),
  kind text not null,
  content jsonb not null
);

create table if not exists action_items (
  id text primary key,
  meeting_id text not null references meetings(id),
  title text not null,
  owner text,
  status text not null default 'open'
);

create table if not exists ai_runs (
  id text primary key,
  meeting_id text references meetings(id),
  provider text not null,
  task text not null,
  status text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists agent_runs (
  id text primary key,
  meeting_id text references meetings(id),
  agent text not null,
  status text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists webhook_subscriptions (
  id text primary key,
  url text not null,
  events jsonb not null default '[]'::jsonb,
  secret_ref text,
  created_at timestamptz not null default now()
);

create table if not exists webhook_deliveries (
  id text primary key,
  webhook_subscription_id text not null references webhook_subscriptions(id),
  event_name text not null,
  status text not null,
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now()
);

create table if not exists mcp_clients (
  id text primary key,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists api_keys (
  id text primary key,
  name text not null,
  key_hash text not null,
  scopes jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

alter table meetings
  add column if not exists language_metadata jsonb not null default '{}'::jsonb;

alter table action_items
  add column if not exists due_date timestamptz,
  add column if not exists priority text not null default 'normal',
  add column if not exists confidence numeric,
  add column if not exists source_quote text,
  add column if not exists source_start_ms integer,
  add column if not exists kind text not null default 'explicit';

create table if not exists tags (
  id text primary key,
  name text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists meeting_tags (
  meeting_id text not null references meetings(id) on delete cascade,
  tag_id text not null references tags(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (meeting_id, tag_id)
);

create table if not exists contexts (
  id text primary key,
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists meeting_contexts (
  meeting_id text not null references meetings(id) on delete cascade,
  context_id text not null references contexts(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (meeting_id, context_id)
);

create table if not exists intelligence_runs (
  id text primary key,
  meeting_id text not null references meetings(id) on delete cascade,
  provider text not null,
  model text not null,
  input jsonb not null default '{}'::jsonb,
  output jsonb not null default '{}'::jsonb,
  status text not null,
  created_at timestamptz not null default now()
);

create table if not exists suggested_agent_runs (
  id text primary key,
  meeting_id text not null references meetings(id) on delete cascade,
  target text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'suggested',
  created_at timestamptz not null default now()
);

create table if not exists integration_endpoints (
  id text primary key,
  name text not null,
  kind text not null,
  base_url text,
  auth_type text not null default 'none',
  config jsonb not null default '{}'::jsonb,
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists google_identities_workspace_subject_idx
  on google_identities(workspace_account_id, subject_email);

create unique index if not exists google_sync_states_identity_source_idx
  on google_sync_states(google_identity_id, source);

create unique index if not exists calendar_events_identity_google_event_idx
  on calendar_events(google_identity_id, google_event_id);

create unique index if not exists gmail_threads_identity_google_thread_idx
  on gmail_threads(google_identity_id, google_thread_id);

create unique index if not exists drive_files_identity_google_file_idx
  on drive_files(google_identity_id, google_file_id);

create index if not exists meetings_started_at_idx
  on meetings(started_at desc);

create index if not exists meetings_status_idx
  on meetings(status);

create index if not exists transcript_segments_meeting_start_idx
  on transcript_segments(meeting_id, start_ms);

create index if not exists summaries_meeting_created_idx
  on summaries(meeting_id, created_at desc);

create index if not exists action_items_open_meeting_idx
  on action_items(meeting_id)
  where status = 'open';

create unique index if not exists api_keys_key_hash_idx
  on api_keys(key_hash);

create index if not exists idx_meetings_language_metadata
  on meetings using gin (language_metadata);

create index if not exists idx_intelligence_runs_meeting_id
  on intelligence_runs(meeting_id, created_at desc);

create index if not exists idx_suggested_agent_runs_meeting_id
  on suggested_agent_runs(meeting_id, created_at desc);
