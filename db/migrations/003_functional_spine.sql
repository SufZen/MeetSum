alter table media_assets
  add column if not exists filename text,
  add column if not exists created_at timestamptz not null default now();

alter table transcript_segments
  add column if not exists language text,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table summaries
  add column if not exists intelligence_run_id text;

alter table action_items
  add column if not exists updated_at timestamptz not null default now();

alter table ai_runs
  add column if not exists job_id text,
  add column if not exists started_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists error text;

create table if not exists jobs (
  id text primary key,
  name text not null,
  status text not null,
  meeting_id text references meetings(id) on delete set null,
  payload jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  error text,
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_jobs_meeting_id
  on jobs(meeting_id, created_at desc);

create index if not exists idx_jobs_status
  on jobs(status, created_at desc);
