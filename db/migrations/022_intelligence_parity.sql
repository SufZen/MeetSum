alter table ai_runs
  add column if not exists input_tokens integer,
  add column if not exists output_tokens integer,
  add column if not exists cache_read_tokens integer,
  add column if not exists cache_write_tokens integer,
  add column if not exists prompt_version text,
  add column if not exists template_key text,
  add column if not exists batch boolean not null default false;

alter table meetings
  add column if not exists template_key text,
  add column if not exists title_source text not null default 'source';
alter table summaries
  add column if not exists template_key text,
  add column if not exists prompt_version text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname='meetings_title_source_check') then
    alter table meetings add constraint meetings_title_source_check check (title_source in ('source','ai','user'));
  end if;
end $$;

create table if not exists summary_templates (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  key text not null,                       -- slug; referenced as "custom:<key>"
  name text not null,
  description text,
  language text,                           -- null = any
  base_template text,                      -- built-in key it extends
  prompt text not null,                    -- <= 4000 chars (app-validated)
  sections jsonb not null default '[]'::jsonb, -- SectionSpec[] <= 12
  created_by_user_id text references users(id) on delete set null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, key)
);

alter table action_items
  add column if not exists workspace_id text references workspaces(id) on delete cascade,
  add column if not exists owner_text text,
  add column if not exists owner_participant_id text references meeting_participants(id) on delete set null,
  add column if not exists owner_speaker_id text references speakers(id) on delete set null,
  add column if not exists owner_user_id text references users(id) on delete set null,
  add column if not exists due_on date,
  add column if not exists due_text text,
  add column if not exists due_source text,
  add column if not exists source_segment_id text,
  add column if not exists created_by_user_id text references users(id) on delete set null;
update action_items a set workspace_id = m.workspace_id from meetings m
  where m.id = a.meeting_id and a.workspace_id is null;
update action_items set owner_text = owner where owner_text is null and owner is not null;
update action_items set due_on = (due_date at time zone 'Asia/Jerusalem')::date, due_source = 'ai'
  where due_on is null and due_date is not null;
create index if not exists idx_action_items_ws_status_due on action_items(workspace_id, status, due_on);
create index if not exists idx_action_items_owner_user on action_items(owner_user_id, status) where owner_user_id is not null;

create table if not exists meeting_clips (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  meeting_id text not null references meetings(id) on delete cascade,
  title text not null,
  start_ms integer not null,
  end_ms integer not null,
  segment_ids text[] not null default '{}',
  transcript_excerpt text,
  render_status text not null default 'pending' check (render_status in ('pending','ready','failed')),
  storage_key text,
  render_error text,
  created_by_user_id text references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (end_ms > start_ms and start_ms >= 0)
);
create index if not exists idx_meeting_clips_meeting on meeting_clips(meeting_id, start_ms) where deleted_at is null;

alter table meeting_shares
  add column if not exists scope text not null default 'meeting',
  add column if not exists clip_id text references meeting_clips(id) on delete cascade;
do $$ begin
  if not exists (select 1 from pg_constraint where conname='meeting_shares_scope_check') then
    alter table meeting_shares add constraint meeting_shares_scope_check check (
      (scope='meeting' and clip_id is null) or (scope='clip' and clip_id is not null));
  end if;
end $$;

create table if not exists comments (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  meeting_id text not null references meetings(id) on delete cascade,
  target_type text not null check (target_type in ('segment','summary_item','action_item','clip','chapter','meeting')),
  target_id text not null,
  parent_id text references comments(id) on delete cascade,
  author_user_id text not null references users(id) on delete cascade,
  body text not null,
  mentions text[] not null default '{}',
  anchor jsonb not null default '{}'::jsonb,   -- {startMs?, quote?}
  resolved_at timestamptz,
  resolved_by_user_id text references users(id) on delete set null,
  edited_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_comments_meeting_target on comments(meeting_id, target_type, target_id);

create table if not exists reactions (
  workspace_id text not null references workspaces(id) on delete cascade,
  meeting_id text not null references meetings(id) on delete cascade,
  target_type text not null check (target_type in ('segment','summary_item','action_item','clip','chapter','comment')),
  target_id text not null,
  user_id text not null references users(id) on delete cascade,
  emoji text not null,
  created_at timestamptz not null default now(),
  -- Target ids (e.g. summary-item hashes) repeat across meetings: the key is
  -- per workspace and meeting.
  primary key (workspace_id, meeting_id, target_type, target_id, user_id, emoji)
);
create index if not exists idx_reactions_meeting on reactions(meeting_id);
-- Databases that applied an earlier draft of 022 keyed reactions by
-- (target_type, target_id, user_id, emoji) only, so the same summary item in
-- two meetings collided. Re-key them idempotently.
do $$
declare
  pk_name text;
  pk_cols int;
begin
  select c.conname, array_length(c.conkey, 1) into pk_name, pk_cols
    from pg_constraint c
   where c.conrelid = 'reactions'::regclass and c.contype = 'p';
  if pk_name is not null and pk_cols <> 6 then
    execute format('alter table reactions drop constraint %I', pk_name);
    alter table reactions add constraint reactions_pkey
      primary key (workspace_id, meeting_id, target_type, target_id, user_id, emoji);
  end if;
end $$;

create table if not exists notifications (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  kind text not null,                     -- mention|reply|task_assigned
  payload jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_notifications_user on notifications(user_id, read_at, created_at desc);

create table if not exists meeting_analytics (
  meeting_id text primary key references meetings(id) on delete cascade,
  workspace_id text not null references workspaces(id) on delete cascade,
  version integer not null,
  transcript_hash text not null,
  metrics jsonb not null,
  sentiment jsonb,
  sentiment_ai_run_id text,
  computed_at timestamptz not null default now()
);

create table if not exists meeting_generated_docs (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  meeting_id text not null references meetings(id) on delete cascade,
  kind text not null check (kind in ('prep_brief','follow_up_email')),
  variant text not null,                  -- e.g. 'he:formal'
  input_hash text not null,
  content jsonb not null,
  source_meeting_ids text[] not null default '{}',
  ai_run_id text,
  created_by_user_id text references users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (meeting_id, kind, variant)
);
