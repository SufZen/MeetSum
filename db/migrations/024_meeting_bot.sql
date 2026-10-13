-- M7 (024): meeting bot (Vexa sidecar). See docs/parity/m7.md.
-- Depends only on M1-M4 tables (workspaces, meetings, users, calendar_events,
-- media_assets); nothing from the M5 (022) / M6 (023) migrations. Idempotent.
-- bot_rules live in workspace_settings(key='botRules'), so they need no DDL.
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
-- Dev databases created before status_changed_at existed.
alter table bot_sessions add column if not exists status_changed_at timestamptz not null default now();
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
