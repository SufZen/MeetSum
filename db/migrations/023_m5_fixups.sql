-- M5 fix-ups for databases that applied a draft of 022 (the runner skips a
-- version it already recorded, so changes to 022 never reach them). Every
-- statement is idempotent: on a fresh install (022 already final) this is a
-- no-op apart from the template index swap.

-- Reactions: an early draft keyed them by (target_type, target_id, user_id,
-- emoji) only, so the same summary item in two meetings collided and
-- POST /api/reactions failed ON CONFLICT. Re-key per workspace and meeting.
do $$
declare
  pk_name text;
  pk_cols int;
begin
  select c.conname, array_length(c.conkey, 1) into pk_name, pk_cols
    from pg_constraint c
   where c.conrelid = 'reactions'::regclass and c.contype = 'p';
  if pk_name is null then
    alter table reactions add constraint reactions_pkey
      primary key (workspace_id, meeting_id, target_type, target_id, user_id, emoji);
  elsif pk_cols <> 6 then
    execute format('alter table reactions drop constraint %I', pk_name);
    alter table reactions add constraint reactions_pkey
      primary key (workspace_id, meeting_id, target_type, target_id, user_id, emoji);
  end if;
end $$;

-- Summary templates: the key is immutable after create and unique only
-- among non-archived templates, so an archived template's key can be reused.
alter table summary_templates drop constraint if exists summary_templates_workspace_id_key_key;
create unique index if not exists summary_templates_workspace_key_active
  on summary_templates (workspace_id, key) where archived_at is null;
