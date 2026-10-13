-- M8 (docs/parity/m8.md, "Migration 027_integrations.sql"): integrations.
-- OAuth connections (tokens encrypted with AAD `ws:conn:field`, never in
-- DTOs), single-use OAuth states, admin rules, the delivery log (system of
-- record, idempotent per rule/meeting/event), external object links
-- (re-export updates in place), per-meeting prefs (owner-only private
-- opt-in, email recap override), email recap unsubscribes, Outlook rows in
-- calendar_events (iCalUID dedupe across providers), Graph push columns on
-- capture_subscriptions (stretch) and webhook payload versioning.
-- Transactional (runMigrations) and idempotent (also runs from
-- docker-entrypoint-initdb.d on fresh volumes).

create table if not exists integration_connections (
  id text primary key,                                    -- intc_<uuid>
  workspace_id text not null references workspaces(id) on delete cascade,
  provider text not null check (provider in ('slack','microsoft','notion','hubspot','google_drive')),
  user_id text references users(id) on delete cascade,    -- null = workspace-level
  status text not null default 'active' check (status in ('active','needs_reauth','revoked','error')),
  account_label text not null,
  external_account_id text not null,                      -- slack team, ms tid:oid, notion workspace, hubspot hub_id, google sub
  scopes text[] not null default '{}',
  access_token_enc text,
  refresh_token_enc text,
  token_type text,
  expires_at timestamptz,
  config jsonb not null default '{}'::jsonb,              -- non-secret only (defaultChannelId, defaultDatabaseId, deltaLink, lastSync…)
  created_by_user_id text references users(id) on delete set null,
  last_used_at timestamptz,
  last_refreshed_at timestamptz,
  last_error text,                                        -- redacted, <= 500
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((provider in ('microsoft','google_drive')) = (user_id is not null))
);
create unique index if not exists uq_integration_connections_account
  on integration_connections(workspace_id, provider, coalesce(user_id, ''), external_account_id)
  where status <> 'revoked';
create index if not exists idx_integration_connections_ws
  on integration_connections(workspace_id, provider) where status <> 'revoked';

create table if not exists integration_oauth_states (
  nonce text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  provider text not null,
  code_verifier_enc text,
  return_to text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index if not exists idx_integration_oauth_states_exp on integration_oauth_states(expires_at);

create table if not exists integration_rules (
  id text primary key,                                    -- intr_<uuid>
  workspace_id text not null references workspaces(id) on delete cascade,
  connection_id text references integration_connections(id) on delete cascade, -- null for provider 'email'
  provider text not null check (provider in ('slack','notion','hubspot','email')),
  name text not null,
  enabled boolean not null default true,
  trigger_event text not null check (trigger_event in ('meeting.completed','summary.created','action_item.created')),
  filters jsonb not null default '{}'::jsonb,
  destination jsonb not null default '{}'::jsonb,
  content jsonb not null default '{}'::jsonb,
  include_private boolean not null default false,
  created_by_user_id text references users(id) on delete set null,
  disabled_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((provider = 'email') = (connection_id is null))
);
create index if not exists idx_integration_rules_dispatch
  on integration_rules(workspace_id, trigger_event) where enabled;
create unique index if not exists uq_integration_rules_email
  on integration_rules(workspace_id) where provider = 'email';   -- one email-recap rule per workspace

create table if not exists integration_deliveries (
  id text primary key,                                    -- intd_<uuid>
  workspace_id text not null references workspaces(id) on delete cascade,
  rule_id text references integration_rules(id) on delete set null,
  connection_id text references integration_connections(id) on delete set null,
  provider text not null,
  origin text not null check (origin in ('rule','manual')),
  event_name text,
  event_id text,
  meeting_id text references meetings(id) on delete cascade,
  action_item_id text,
  idempotency_key text not null,
  status text not null default 'queued' check (status in
    ('queued','running','retrying','sent','partial','skipped','failed','cancelled')),
  skip_reason text,
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  progress jsonb not null default '{}'::jsonb,            -- resumable sub-steps, ids/hashes only
  external_ref jsonb not null default '{}'::jsonb,        -- ids/urls only
  last_error text,                                        -- redacted, <= 500
  requested_by_user_id text references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (workspace_id, idempotency_key)
);
create index if not exists idx_integration_deliveries_ws on integration_deliveries(workspace_id, created_at desc);
create index if not exists idx_integration_deliveries_rule on integration_deliveries(rule_id, created_at desc);
create index if not exists idx_integration_deliveries_meeting on integration_deliveries(meeting_id, created_at desc);

create table if not exists integration_links (
  id text primary key,                                    -- intl_<uuid>
  workspace_id text not null references workspaces(id) on delete cascade,
  connection_id text not null references integration_connections(id) on delete cascade,
  provider text not null,
  meeting_id text not null references meetings(id) on delete cascade,
  object_kind text not null check (object_kind in
    ('slack_message','notion_page','hubspot_engagement','hubspot_task','google_doc')),
  destination_key text not null default '',               -- channel id, database id, deal id…
  action_item_id text not null default '',                -- '' unless object_kind = hubspot_task
  external_id text not null,
  external_url text,
  content_hash text,                                      -- sha256 of the rendered payload; skip no-op updates
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, meeting_id, object_kind, destination_key, action_item_id)
);
create index if not exists idx_integration_links_meeting on integration_links(workspace_id, meeting_id);

create table if not exists meeting_integration_prefs (
  meeting_id text primary key references meetings(id) on delete cascade,
  workspace_id text not null references workspaces(id) on delete cascade,
  allow_private_push boolean not null default false,      -- owner-only opt-in for a private meeting
  allow_private_set_by_user_id text references users(id) on delete set null,
  email_recap text not null default 'inherit' check (email_recap in ('inherit','on','off')),
  updated_by_user_id text references users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table if not exists email_recap_unsubscribes (
  workspace_id text not null references workspaces(id) on delete cascade,
  email_lower text not null,
  source text not null default 'link' check (source in ('link','one_click','admin')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, email_lower)
);

-- Outlook events share calendar_events; meetings keep linking via meetings.calendar_event_id.
alter table calendar_events
  alter column google_identity_id drop not null,
  alter column google_event_id drop not null,
  add column if not exists provider text not null default 'google',
  add column if not exists workspace_id text references workspaces(id) on delete cascade,
  add column if not exists integration_connection_id text references integration_connections(id) on delete cascade,
  add column if not exists external_event_id text,
  add column if not exists ical_uid text,
  add column if not exists updated_at timestamptz not null default now();
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'calendar_events_provider_check') then
    alter table calendar_events add constraint calendar_events_provider_check check (
      (provider = 'google' and google_identity_id is not null and google_event_id is not null) or
      (provider = 'microsoft' and integration_connection_id is not null and external_event_id is not null
        and workspace_id is not null));
  end if;
end $$;
-- Backfill Google rows so iCalUID dedupe works across providers.
update calendar_events ce set workspace_id = gi.workspace_id
  from google_identities gi
 where ce.google_identity_id = gi.id and ce.workspace_id is null;
update calendar_events set ical_uid = raw->>'iCalUID'
 where ical_uid is null and raw ? 'iCalUID';
create unique index if not exists uq_calendar_events_ms
  on calendar_events(integration_connection_id, external_event_id) where provider = 'microsoft';
create index if not exists idx_calendar_events_ws_ical
  on calendar_events(workspace_id, ical_uid) where ical_uid is not null;

-- Graph calendar push (stretch) reuses the M1 subscription store.
alter table capture_subscriptions
  add column if not exists workspace_id text references workspaces(id) on delete cascade,
  add column if not exists integration_connection_id text references integration_connections(id) on delete cascade,
  add column if not exists client_state_hash text;

-- Webhook catalog versioning: existing subscriptions keep v1 payloads.
alter table webhook_subscriptions
  add column if not exists payload_version smallint not null default 1 check (payload_version in (1, 2));
alter table webhook_deliveries
  add column if not exists payload_version smallint not null default 1;
