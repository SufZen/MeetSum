-- meetsum:breaking workspace_id becomes NOT NULL and the tags unique key
-- becomes per-workspace: a release older than 019 (v0.6.x) inserts meetings
-- and tags without workspace_id and uses `on conflict (name)` on tags, so its
-- writes fail once this runs. scripts/deploy-vps.sh
-- therefore stops app + worker before migrating across it (maintenance mode;
-- docs/runbooks/upgrade-0.6-to-0.7.md).
alter table meetings
  add column if not exists workspace_id text references workspaces(id),
  add column if not exists owner_user_id text references users(id) on delete set null,
  add column if not exists visibility text not null default 'workspace';
alter table contexts add column if not exists workspace_id text references workspaces(id) on delete cascade;
alter table tags add column if not exists workspace_id text references workspaces(id) on delete cascade;
alter table media_assets add column if not exists workspace_id text references workspaces(id);
alter table jobs add column if not exists workspace_id text references workspaces(id) on delete cascade;
alter table webhook_subscriptions add column if not exists workspace_id text references workspaces(id) on delete cascade;
alter table api_keys
  add column if not exists workspace_id text references workspaces(id) on delete cascade,
  add column if not exists scopes jsonb not null default '["read"]'::jsonb,
  add column if not exists created_by_user_id text references users(id) on delete set null;
alter table api_keys alter column scopes set default '["read"]'::jsonb;
alter table audit_logs
  add column if not exists workspace_id text references workspaces(id) on delete cascade,
  add column if not exists actor_user_id text,
  add column if not exists actor_api_key_id text;
alter table google_identities add column if not exists workspace_id text references workspaces(id) on delete set null;
alter table capture_subscriptions add column if not exists workspace_id text references workspaces(id) on delete cascade;

update meetings set workspace_id = 'ws_default' where workspace_id is null;
update contexts set workspace_id = 'ws_default' where workspace_id is null;
update tags set workspace_id = 'ws_default' where workspace_id is null;
update webhook_subscriptions set workspace_id = 'ws_default' where workspace_id is null;
update api_keys set workspace_id = 'ws_default' where workspace_id is null;
update audit_logs set workspace_id = 'ws_default' where workspace_id is null;
update capture_subscriptions set workspace_id = 'ws_default' where workspace_id is null;
update media_assets a set workspace_id = m.workspace_id from meetings m
  where m.id = a.meeting_id and a.workspace_id is null;
update jobs j set workspace_id = coalesce(
  (select m.workspace_id from meetings m where m.id = j.meeting_id), 'ws_default')
  where j.workspace_id is null and j.name <> 'teams.subscription.renew';
update api_keys set scopes = '["read","write","admin"]'::jsonb
  where scopes is null or scopes = '[]'::jsonb;
update meetings m set visibility = 'link' where exists (
  select 1 from meeting_shares s where s.meeting_id = m.id and s.revoked = false
    and (s.expires_at is null or s.expires_at > now()));

alter table meetings alter column workspace_id set not null;
alter table contexts alter column workspace_id set not null;
alter table tags alter column workspace_id set not null;
alter table media_assets alter column workspace_id set not null;
alter table webhook_subscriptions alter column workspace_id set not null;
alter table api_keys alter column workspace_id set not null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'meetings_visibility_check') then
    alter table meetings add constraint meetings_visibility_check
      check (visibility in ('private','workspace','link'));
  end if;
end $$;

do $$ declare c text; begin
  for c in select conname from pg_constraint where conrelid = 'tags'::regclass and contype = 'u' loop
    execute format('alter table tags drop constraint %I', c);
  end loop;
end $$;
create unique index if not exists uq_tags_workspace_name on tags(workspace_id, name);

drop index if exists uq_meetings_external_ref;
create unique index if not exists uq_meetings_external_ref
  on meetings(workspace_id, external_source, external_id) where external_id is not null;

create index if not exists idx_meetings_workspace_started on meetings(workspace_id, started_at desc);
create index if not exists idx_meetings_owner on meetings(owner_user_id);
create index if not exists idx_contexts_workspace on contexts(workspace_id, name);
create index if not exists idx_jobs_workspace on jobs(workspace_id, created_at desc);
create index if not exists idx_webhook_subscriptions_workspace on webhook_subscriptions(workspace_id);
create index if not exists idx_api_keys_workspace_active on api_keys(workspace_id) where revoked_at is null;
create index if not exists idx_audit_logs_workspace on audit_logs(workspace_id, created_at desc);
create index if not exists idx_media_assets_workspace on media_assets(workspace_id, created_at desc);
create index if not exists idx_google_identities_workspace on google_identities(workspace_id);
