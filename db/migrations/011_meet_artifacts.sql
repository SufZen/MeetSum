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
