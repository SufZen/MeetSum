alter table jobs
  add column if not exists retry_of_job_id text references jobs(id) on delete set null,
  add column if not exists max_attempts integer not null default 3;

alter table media_assets
  add column if not exists source text,
  add column if not exists source_file_id text,
  add column if not exists checksum_sha256 text;

alter table ai_runs
  add column if not exists model text,
  add column if not exists latency_ms integer,
  add column if not exists cost_estimate numeric,
  add column if not exists confidence numeric,
  add column if not exists input_hash text;

alter table google_sync_states
  add column if not exists status text not null default 'idle',
  add column if not exists last_error text,
  add column if not exists last_synced_at timestamptz;

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

alter table meetings
  add column if not exists google_meet_link text;

create table if not exists meeting_drive_files (
  meeting_id text not null references meetings(id) on delete cascade,
  drive_file_id text not null references drive_files(id) on delete cascade,
  match_method text not null default 'time_window',
  confidence numeric,
  created_at timestamptz not null default now(),
  primary key (meeting_id, drive_file_id)
);

create index if not exists idx_media_assets_source_file
  on media_assets(source, source_file_id);

create index if not exists idx_calendar_events_calendar_id
  on calendar_events(calendar_id, starts_at desc);

create index if not exists idx_drive_files_modified_time
  on drive_files(modified_time desc);
