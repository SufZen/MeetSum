-- M9 Step 0 (docs/parity/m9.md, "Migration 030_i18n_notifications_onboarding.sql"):
-- per-user UI locale, time zone and preferences; notification links, dedupe
-- and seen state; onboarding progress; analytics dashboard indexes; and the
-- two M4 carry-overs (share passwords on Postgres, atomic turn undo).
-- Transactional (runMigrations) and idempotent (also runs from
-- docker-entrypoint-initdb.d on fresh volumes).

-- users: UI locale, time zone, personal preferences
alter table users
  add column if not exists locale text,
  add column if not exists time_zone text,
  add column if not exists preferences jsonb not null default '{}'::jsonb;
do $$ begin
  if not exists (select 1 from pg_constraint where conname='users_locale_check') then
    alter table users add constraint users_locale_check check (locale is null or locale in ('he','en'));
  end if;
end $$;

-- notifications: links, dedupe, seen
alter table notifications
  add column if not exists meeting_id text references meetings(id) on delete cascade,
  add column if not exists actor_user_id text references users(id) on delete set null,
  add column if not exists dedupe_key text,
  add column if not exists seen_at timestamptz;
create unique index if not exists uq_notifications_dedupe on notifications(user_id, dedupe_key) where dedupe_key is not null;
create index if not exists idx_notifications_user_ws on notifications(user_id, workspace_id, created_at desc);
create index if not exists idx_notifications_unread on notifications(user_id) where read_at is null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname='notifications_kind_check') then
    alter table notifications add constraint notifications_kind_check check (kind in
      ('mention','reply','task_assigned','integration_reauth','invited','meeting_processed','meeting_failed','bot_blocked')) not valid;
  end if;
end $$;

-- onboarding
create table if not exists onboarding_progress (
  workspace_id text not null references workspaces(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  skipped text[] not null default '{}',
  dismissed_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

-- analytics dashboard
create index if not exists idx_meetings_ws_started on meetings(workspace_id, started_at desc);
create index if not exists idx_action_items_ws_created on action_items(workspace_id, created_at desc);
create index if not exists idx_meeting_analytics_ws on meeting_analytics(workspace_id);

-- carried over from M4: share passwords on Postgres; atomic turn undo
alter table meeting_shares add column if not exists password_hash text;
alter table transcript_segment_revisions add column if not exists edit_group_id text;
create index if not exists idx_segment_revisions_group on transcript_segment_revisions(meeting_id, edit_group_id) where edit_group_id is not null;

-- legacy UI locales → he
update app_settings set value = '"he"'::jsonb where key = 'defaultLocale' and value #>> '{}' in ('pt','es','it');
update workspace_settings set value = '"he"'::jsonb where key = 'defaultLocale' and value #>> '{}' in ('pt','es','it');
