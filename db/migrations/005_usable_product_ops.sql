alter table google_sync_states
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists next_poll_at timestamptz;

alter table jobs
  add column if not exists started_at timestamptz,
  add column if not exists completed_at timestamptz;

alter table suggested_agent_runs
  add column if not exists response jsonb not null default '{}'::jsonb,
  add column if not exists last_error text,
  add column if not exists updated_at timestamptz not null default now();

alter table webhook_subscriptions
  add column if not exists secret_hash text,
  add column if not exists enabled boolean not null default true;

alter table webhook_deliveries
  add column if not exists event_payload jsonb not null default '{}'::jsonb,
  add column if not exists response_status integer,
  add column if not exists updated_at timestamptz not null default now();

create index if not exists idx_google_sync_states_next_poll
  on google_sync_states(next_poll_at);

create index if not exists idx_jobs_started_completed
  on jobs(started_at, completed_at);
