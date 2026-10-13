create table if not exists users (
  id text primary key,
  email text not null unique,
  display_name text,
  name text,
  picture_url text,
  last_login_at timestamptz,
  default_workspace_id text,
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists uq_users_email_lower on users (lower(email));

-- M2 tenancy (018_workspaces.sql). Workspace = tenant.
create table if not exists workspaces (
  id text primary key,
  name text not null,
  slug text not null unique,
  google_subject text,
  created_by_user_id text references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'users_default_workspace_fk') then
    alter table users add constraint users_default_workspace_fk
      foreign key (default_workspace_id) references workspaces(id) on delete set null;
  end if;
end $$;

create table if not exists memberships (
  workspace_id text not null references workspaces(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  role text not null check (role in ('owner','admin','member','viewer')),
  invited_by_user_id text references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table if not exists invitations (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  email text not null,
  role text not null check (role in ('admin','member','viewer')),
  token_hash text not null unique,
  status text not null default 'pending' check (status in ('pending','accepted','revoked','expired')),
  invited_by_user_id text references users(id) on delete set null,
  accepted_by_user_id text references users(id) on delete set null,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  last_sent_at timestamptz,
  send_count integer not null default 0,
  last_send_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists workspace_settings (
  workspace_id text not null references workspaces(id) on delete cascade,
  key text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, key)
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
  sync_enabled boolean not null default true,
  oauth_refresh_token text,
  oauth_scope text,
  oauth_connected_at timestamptz,
  oauth_last_error text,
  workspace_id text references workspaces(id) on delete set null
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
  is_favorite boolean not null default false,
  language_metadata jsonb not null default '{}'::jsonb,
  google_meet_link text,
  external_source text,
  external_id text,
  -- M2: no default, so an unscoped insert fails loudly.
  workspace_id text not null references workspaces(id),
  owner_user_id text references users(id) on delete set null,
  visibility text not null default 'workspace'
    constraint meetings_visibility_check check (visibility in ('private','workspace','link')),
  -- M4 (021): media duration, else max(transcript_segments.end_ms).
  duration_ms integer,
  transcript_version integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists meeting_drive_files (
  meeting_id text not null references meetings(id) on delete cascade,
  drive_file_id text not null references drive_files(id) on delete cascade,
  match_method text not null default 'time_window',
  confidence numeric,
  created_at timestamptz not null default now(),
  primary key (meeting_id, drive_file_id)
);

create table if not exists meet_conference_records (
  id text primary key,
  google_identity_id text not null references google_identities(id) on delete cascade,
  conference_record_name text not null unique,
  meeting_id text references meetings(id) on delete set null,
  calendar_event_id text references calendar_events(id) on delete set null,
  space_name text,
  start_time timestamptz,
  end_time timestamptz,
  expire_time timestamptz,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists meet_artifacts (
  id text primary key,
  conference_record_id text not null references meet_conference_records(id) on delete cascade,
  artifact_type text not null,
  artifact_name text not null,
  drive_file_id text references drive_files(id) on delete set null,
  document_name text,
  state text,
  start_time timestamptz,
  end_time timestamptz,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (conference_record_id, artifact_type, artifact_name)
);

create table if not exists meeting_favorites (
  user_id text not null references users(id) on delete cascade,
  meeting_id text not null references meetings(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, meeting_id)
);

create table if not exists media_assets (
  id text primary key,
  meeting_id text not null references meetings(id) on delete cascade,
  storage_key text not null,
  filename text,
  content_type text not null,
  size_bytes bigint not null,
  retention text not null default 'audio',
  source text,
  source_file_id text,
  checksum_sha256 text,
  metadata jsonb not null default '{}'::jsonb,
  workspace_id text not null references workspaces(id),
  -- M4 (021): playback renditions, peaks and preparation state.
  kind text not null default 'original'
    constraint media_assets_kind_check check (kind in ('original','playback')),
  derived_from_asset_id text references media_assets(id) on delete cascade,
  duration_ms integer,
  peaks_storage_key text,
  prepared_at timestamptz,
  prepare_error text,
  created_at timestamptz not null default now()
);

create table if not exists speakers (
  id text primary key,
  meeting_id text not null references meetings(id) on delete cascade,
  label text not null,
  display_name text,
  workspace_id text references workspaces(id) on delete cascade,
  source text not null default 'asr',
  -- FKs to meeting_participants / speaker_profiles are added below, after
  -- those tables are declared (020).
  participant_id text,
  profile_id text,
  mapping_status text not null default 'unmapped',
  suggestion jsonb,
  talk_time_ms integer not null default 0,
  word_count integer not null default 0,
  segment_count integer not null default 0,
  first_start_ms integer,
  embedding real[],
  embedding_model text,
  confirmed_by_user_id text references users(id) on delete set null,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint speakers_mapping_status_check
    check (mapping_status in ('unmapped','suggested','confirmed','rejected'))
);

create table if not exists transcript_segments (
  id text primary key,
  meeting_id text not null references meetings(id) on delete cascade,
  speaker_id text references speakers(id),
  start_ms integer not null,
  end_ms integer not null,
  text text not null,
  confidence numeric,
  language text,
  metadata jsonb not null default '{}'::jsonb,
  words jsonb,
  turn_index integer,
  source text not null default 'asr',
  asr_run_id text,
  -- M4 (021): transcript editing.
  revision integer not null default 0,
  edited_at timestamptz,
  edited_by_user_id text references users(id) on delete set null
);

-- M4 (021): prior states of edited segments (undo).
create table if not exists transcript_segment_revisions (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  meeting_id text not null references meetings(id) on delete cascade,
  segment_id text not null references transcript_segments(id) on delete cascade,
  revision integer not null,
  text text not null,
  words jsonb,
  speaker_id text,
  source text not null,
  created_by_user_id text references users(id) on delete set null,
  created_at timestamptz not null default now(),
  reverted_at timestamptz
);

create table if not exists summaries (
  id text primary key,
  meeting_id text not null references meetings(id) on delete cascade,
  overview text not null,
  language text not null default 'he',
  model_provider text,
  intelligence_run_id text,
  created_at timestamptz not null default now()
);

create table if not exists summary_sections (
  id text primary key,
  summary_id text not null references summaries(id) on delete cascade,
  kind text not null,
  content jsonb not null
);

create table if not exists action_items (
  id text primary key,
  meeting_id text not null references meetings(id) on delete cascade,
  title text not null,
  owner text,
  status text not null default 'open',
  due_date timestamptz,
  priority text not null default 'normal',
  confidence numeric,
  source_quote text,
  source_start_ms integer,
  kind text not null default 'explicit',
  edited_by_user boolean not null default false,
  origin text not null default 'ai',
  original_title text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists ai_runs (
  id text primary key,
  -- M4 (021): runs survive a meeting delete with a null meeting_id.
  meeting_id text references meetings(id) on delete set null,
  provider text not null,
  task text not null,
  status text not null,
  metadata jsonb not null default '{}'::jsonb,
  job_id text,
  model text,
  latency_ms integer,
  cost_estimate numeric,
  confidence numeric,
  input_hash text,
  started_at timestamptz,
  completed_at timestamptz,
  error text,
  workspace_id text references workspaces(id) on delete cascade,
  audio_duration_ms integer,
  created_at timestamptz not null default now()
);

create table if not exists agent_runs (
  id text primary key,
  meeting_id text references meetings(id) on delete cascade,
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
  secret_hash text,
  secret_ciphertext text,
  enabled boolean not null default true,
  workspace_id text not null references workspaces(id) on delete cascade,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists webhook_deliveries (
  id text primary key,
  webhook_subscription_id text not null references webhook_subscriptions(id),
  event_name text not null,
  status text not null,
  attempts integer not null default 0,
  max_attempts integer not null default 6,
  last_error text,
  event_payload jsonb not null default '{}'::jsonb,
  response_status integer,
  delivered_at timestamptz,
  duration_ms integer,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists mcp_clients (
  id text primary key,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists api_keys (
  id text primary key,
  name text,
  label text not null default '',
  key_prefix text not null default '',
  key_hash text not null,
  scopes jsonb not null default '["read"]'::jsonb,
  workspace_id text not null references workspaces(id) on delete cascade,
  created_by_user_id text references users(id) on delete set null,
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists audit_logs (
  id text primary key,
  action text not null,
  actor text,
  target_type text,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  workspace_id text references workspaces(id) on delete cascade,
  actor_user_id text,
  actor_api_key_id text,
  created_at timestamptz not null default now()
);

-- Unused since M2 (settings live in workspace_settings); dropped in M10.
create table if not exists app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists capture_subscriptions (
  id text primary key,
  platform text not null,
  external_subscription_id text not null unique,
  resource text not null,
  change_type text not null,
  notification_url text not null,
  lifecycle_notification_url text,
  expires_at timestamptz not null,
  status text not null default 'active',
  last_error text,
  workspace_id text references workspaces(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists jobs (
  id text primary key,
  name text not null,
  status text not null,
  meeting_id text references meetings(id) on delete set null,
  payload jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  error text,
  attempts integer not null default 0,
  retry_of_job_id text references jobs(id) on delete set null,
  max_attempts integer not null default 3,
  started_at timestamptz,
  completed_at timestamptz,
  -- Nullable only for instance-level jobs (teams.subscription.renew).
  workspace_id text references workspaces(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table google_sync_states
  add column if not exists status text not null default 'idle',
  add column if not exists last_error text,
  add column if not exists last_synced_at timestamptz,
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists next_poll_at timestamptz;

alter table calendar_events
  add column if not exists calendar_id text,
  add column if not exists status text,
  add column if not exists organizer_email text,
  add column if not exists attendees jsonb not null default '[]'::jsonb;

alter table drive_files
  add column if not exists calendar_event_id text references calendar_events(id) on delete set null,
  add column if not exists created_time timestamptz,
  add column if not exists modified_time timestamptz,
  add column if not exists size_bytes bigint,
  add column if not exists imported_at timestamptz;

create table if not exists tags (
  id text primary key,
  name text not null,
  workspace_id text not null references workspaces(id) on delete cascade,
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
  workspace_id text not null references workspaces(id) on delete cascade,
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
  response jsonb not null default '{}'::jsonb,
  status text not null default 'suggested',
  last_error text,
  updated_at timestamptz not null default now(),
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

create table if not exists meeting_shares (
  id text primary key,
  meeting_id text not null references meetings(id) on delete cascade,
  token text not null unique,
  visibility text not null default 'public',
  revoked boolean not null default false,
  expires_at timestamptz,
  included_sections jsonb not null default '["summary","decisions","action_items","transcript","participants"]'::jsonb,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists meeting_participants (
  id text primary key,
  meeting_id text not null references meetings(id) on delete cascade,
  name text not null,
  email text,
  role text not null default 'attendee',
  source text not null default 'manual',
  attendance_status text not null default 'unknown',
  speaker_label text,
  confidence numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists export_records (
  id text primary key,
  meeting_id text not null references meetings(id) on delete cascade,
  format text not null,
  status text not null default 'created',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists speaker_profiles (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  display_name text not null,
  email text,
  user_id text references users(id) on delete set null,
  aliases text[] not null default '{}',
  confirmed_count integer not null default 0,
  last_meeting_id text references meetings(id) on delete set null,
  last_confirmed_at timestamptz,
  voice_embedding real[],
  embedding_model text,
  embedding_samples integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'speakers_participant_id_fkey') then
    alter table speakers add constraint speakers_participant_id_fkey
      foreign key (participant_id) references meeting_participants(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'speakers_profile_fk') then
    alter table speakers add constraint speakers_profile_fk
      foreign key (profile_id) references speaker_profiles(id) on delete set null;
  end if;
end $$;

alter table contexts
  add column if not exists color text,
  add column if not exists kind text not null default 'room';

create unique index if not exists google_identities_workspace_subject_idx
  on google_identities(workspace_account_id, subject_email);

create index if not exists idx_google_identities_oauth_connected
  on google_identities(oauth_connected_at desc)
  where oauth_refresh_token is not null;

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

create index if not exists meetings_favorite_idx
  on meetings(is_favorite, started_at desc);

create index if not exists idx_memberships_user on memberships(user_id);

create unique index if not exists uq_invitations_pending_email
  on invitations(workspace_id, lower(email)) where status = 'pending';

create index if not exists idx_meetings_workspace_started
  on meetings(workspace_id, started_at desc);

create index if not exists idx_meetings_owner on meetings(owner_user_id);

create unique index if not exists uq_tags_workspace_name on tags(workspace_id, name);

create index if not exists idx_contexts_workspace on contexts(workspace_id, name);

create index if not exists idx_jobs_workspace on jobs(workspace_id, created_at desc);

create index if not exists idx_webhook_subscriptions_workspace
  on webhook_subscriptions(workspace_id);

create index if not exists idx_api_keys_active
  on api_keys(revoked_at) where revoked_at is null;

create index if not exists idx_api_keys_workspace_active
  on api_keys(workspace_id) where revoked_at is null;

create index if not exists idx_audit_logs_workspace
  on audit_logs(workspace_id, created_at desc);

create index if not exists idx_media_assets_workspace
  on media_assets(workspace_id, created_at desc);

create index if not exists idx_media_assets_meeting_kind
  on media_assets(meeting_id, kind, created_at desc);

create index if not exists idx_segment_revisions_segment
  on transcript_segment_revisions(segment_id, revision desc);

create index if not exists idx_google_identities_workspace
  on google_identities(workspace_id);

create index if not exists meet_conference_records_identity_time_idx
  on meet_conference_records(google_identity_id, start_time desc);

create index if not exists meet_conference_records_meeting_idx
  on meet_conference_records(meeting_id);

create index if not exists meet_conference_records_calendar_idx
  on meet_conference_records(calendar_event_id);

create index if not exists meet_artifacts_conference_type_idx
  on meet_artifacts(conference_record_id, artifact_type);

create index if not exists meet_artifacts_drive_file_idx
  on meet_artifacts(drive_file_id);

create index if not exists transcript_segments_meeting_start_idx
  on transcript_segments(meeting_id, start_ms);

create index if not exists idx_transcript_segments_speaker
  on transcript_segments(speaker_id);

create unique index if not exists uq_speakers_meeting_label
  on speakers(meeting_id, label);

create unique index if not exists uq_speaker_profiles_email
  on speaker_profiles(workspace_id, lower(email)) where email is not null;

create unique index if not exists uq_speaker_profiles_name
  on speaker_profiles(workspace_id, lower(display_name)) where email is null;

create index if not exists idx_ai_runs_workspace_task
  on ai_runs(workspace_id, task, started_at desc);

create index if not exists meeting_participants_meeting_idx
  on meeting_participants(meeting_id);

create index if not exists meeting_shares_meeting_idx
  on meeting_shares(meeting_id);

create index if not exists summaries_meeting_created_idx
  on summaries(meeting_id, created_at desc);

create index if not exists action_items_open_meeting_idx
  on action_items(meeting_id)
  where status = 'open';

create unique index if not exists api_keys_key_hash_idx
  on api_keys(key_hash);

create index if not exists idx_jobs_meeting_id
  on jobs(meeting_id, created_at desc);

create index if not exists idx_jobs_status
  on jobs(status, created_at desc);

create index if not exists idx_jobs_started_completed
  on jobs(started_at, completed_at);

create index if not exists idx_google_sync_states_next_poll
  on google_sync_states(next_poll_at);

create index if not exists idx_media_assets_source_file
  on media_assets(source, source_file_id);

create unique index if not exists uq_media_assets_meeting_capture
  on media_assets(meeting_id, source, source_file_id)
  where source in ('desktop_capture','zoom','teams') and source_file_id is not null;

create unique index if not exists uq_meetings_external_ref
  on meetings(workspace_id, external_source, external_id) where external_id is not null;

create index if not exists idx_capture_subscriptions_platform_expires
  on capture_subscriptions(platform, status, expires_at);

create index if not exists idx_calendar_events_calendar_id
  on calendar_events(calendar_id, starts_at desc);

create index if not exists idx_drive_files_modified_time
  on drive_files(modified_time desc);

create index if not exists idx_meetings_language_metadata
  on meetings using gin (language_metadata);

create index if not exists idx_intelligence_runs_meeting_id
  on intelligence_runs(meeting_id, created_at desc);

create index if not exists idx_suggested_agent_runs_meeting_id
  on suggested_agent_runs(meeting_id, created_at desc);

create index if not exists idx_webhook_deliveries_subscription_created
  on webhook_deliveries(webhook_subscription_id, created_at desc);

create index if not exists idx_webhook_deliveries_status_created
  on webhook_deliveries(status, created_at desc);

create index if not exists idx_audit_logs_action_created
  on audit_logs(action, created_at desc);

create index if not exists idx_audit_logs_target_created
  on audit_logs(target_type, target_id, created_at desc);

-- M7 (024): meeting bot sessions and their event log.
create table if not exists bot_sessions (
  id text primary key,                                   -- bot_<ulid>
  workspace_id text not null references workspaces(id) on delete cascade,
  meeting_id text references meetings(id) on delete set null,
  origin text not null check (origin in ('manual','meeting_request','calendar_rule')),
  platform text not null check (platform in ('google_meet','teams','zoom')),
  native_meeting_id text not null,
  meeting_url_redacted text,                              -- canonical URL, secrets stripped
  passcode_enc text,                                      -- encryptSecret(); never returned by APIs
  teams_base_host text,
  vexa_meeting_id text,                                   -- unique per workspace (index below)
  status text not null default 'scheduled' check (status in ('scheduled','requested','joining',
    'awaiting_admission','needs_help','active','stopping','completed','failed','blocked','cancelled')),
  status_rank smallint not null default 0,
  status_reason text,
  requested_by_user_id text references users(id) on delete set null,
  calendar_event_id text references calendar_events(id) on delete set null,
  scheduled_start timestamptz,
  scheduled_end timestamptz,
  dispatch_at timestamptz,
  dispatch_rev integer not null default 0,
  bot_name text not null,
  language text,
  recording_enabled boolean not null default true,
  transcribe_enabled boolean not null default false,
  consent_status text not null default 'pending'
    check (consent_status in ('pending','sent','unsupported','failed','disabled')),
  requested_at timestamptz,
  joined_at timestamptz,
  left_at timestamptz,
  last_event_at timestamptz,
  status_changed_at timestamptz not null default now(), -- applied status changes only
  recording_status text not null default 'none'
    check (recording_status in ('none','pending','importing','imported','missing','failed')),
  recording_storage_key text,
  media_asset_id text references media_assets(id) on delete set null,
  ingest_job_id text,
  speaker_timeline jsonb,                                 -- MeetTimelineEntry[] (bot-observed names)
  vexa_purged_at timestamptz,
  error text,                                             -- redacted, <= 500 chars
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists uq_bot_sessions_calendar
  on bot_sessions(workspace_id, calendar_event_id) where calendar_event_id is not null;
-- Every unique key is workspace-scoped: a session in one workspace must never
-- block another workspace from sending its own bot to the same meeting
-- (security review M7). Vexa itself 409s a second bot in the same meeting;
-- that surfaces as blocked/already_in_meeting without leaking the owner.
alter table bot_sessions drop constraint if exists bot_sessions_vexa_meeting_id_key;
drop index if exists uq_bot_sessions_live_target;
create unique index if not exists uq_bot_sessions_ws_live_target
  on bot_sessions(workspace_id, platform, native_meeting_id)
  where status in ('requested','joining','awaiting_admission','needs_help','active','stopping');
create unique index if not exists uq_bot_sessions_ws_vexa_meeting
  on bot_sessions(workspace_id, vexa_meeting_id) where vexa_meeting_id is not null;
-- Webhook resolution (system lookups; the workspace comes from the row).
create index if not exists idx_bot_sessions_vexa_meeting
  on bot_sessions(vexa_meeting_id) where vexa_meeting_id is not null;
create index if not exists idx_bot_sessions_target
  on bot_sessions(platform, native_meeting_id, created_at desc)
  where status not in ('completed','failed','blocked','cancelled');
create index if not exists idx_bot_sessions_ws_status on bot_sessions(workspace_id, status, scheduled_start);
create index if not exists idx_bot_sessions_meeting on bot_sessions(meeting_id, created_at desc);
create index if not exists idx_bot_sessions_open on bot_sessions(status, updated_at)
  where status not in ('completed','failed','blocked','cancelled');

create table if not exists bot_events (
  id text primary key,
  bot_session_id text references bot_sessions(id) on delete cascade,
  workspace_id text references workspaces(id) on delete cascade,
  source text not null check (source in ('webhook','poll','api')),
  vexa_meeting_id text,
  vexa_event_id text,
  event_type text not null,
  vexa_status text,
  prev_status text,                                       -- status before the event (webhook dedupe key)
  applied boolean not null default false,
  payload jsonb not null default '{}'::jsonb,             -- redacted
  received_at timestamptz not null default now()
);
alter table bot_events add column if not exists prev_status text;
drop index if exists uq_bot_events_status;
drop index if exists uq_bot_events_event_id;
-- The previous status is part of the key: awaiting_admission → needs_help →
-- awaiting_admission are three events, while a redelivery is one.
drop index if exists uq_bot_events_ws_status;
create unique index if not exists uq_bot_events_ws_transition
  on bot_events(workspace_id, vexa_meeting_id, event_type, coalesce(vexa_status, ''), coalesce(prev_status, ''))
  where vexa_meeting_id is not null and workspace_id is not null and source = 'webhook';
create unique index if not exists uq_bot_events_ws_event_id
  on bot_events(workspace_id, vexa_event_id)
  where vexa_event_id is not null and workspace_id is not null;
create index if not exists idx_bot_events_session on bot_events(bot_session_id, received_at desc);

-- The workspace every pre-M2 row belongs to (018).
insert into workspaces (id, name, slug) values ('ws_default', 'MeetSum', 'default')
  on conflict (id) do nothing;
