alter table media_assets
  add column if not exists kind text not null default 'original',
  add column if not exists derived_from_asset_id text references media_assets(id) on delete cascade,
  add column if not exists duration_ms integer,
  add column if not exists peaks_storage_key text,
  add column if not exists prepared_at timestamptz,
  add column if not exists prepare_error text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'media_assets_kind_check') then
    alter table media_assets add constraint media_assets_kind_check check (kind in ('original','playback'));
  end if;
end $$;
create index if not exists idx_media_assets_meeting_kind on media_assets(meeting_id, kind, created_at desc);
update media_assets set duration_ms = round((metadata->>'durationMs')::numeric)::int
  where duration_ms is null and (metadata->>'durationMs') ~ '^[0-9.]+$';
update media_assets set duration_ms = round((metadata->>'durationSeconds')::numeric * 1000)::int
  where duration_ms is null and (metadata->>'durationSeconds') ~ '^[0-9.]+$';

alter table meetings
  add column if not exists duration_ms integer,
  add column if not exists transcript_version integer not null default 0;
update meetings m set duration_ms = coalesce(
  (select max(a.duration_ms) from media_assets a where a.meeting_id = m.id),
  (select max(s.end_ms) from transcript_segments s where s.meeting_id = m.id))
  where m.duration_ms is null;

alter table transcript_segments
  add column if not exists revision integer not null default 0,
  add column if not exists edited_at timestamptz,
  add column if not exists edited_by_user_id text references users(id) on delete set null;

create table if not exists transcript_segment_revisions (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  meeting_id text not null references meetings(id) on delete cascade,
  segment_id text not null references transcript_segments(id) on delete cascade,
  revision integer not null,
  text text not null,
  words jsonb,
  speaker_id text,
  source text not null,
  created_by_user_id text references users(id) on delete set null,
  created_at timestamptz not null default now(),
  reverted_at timestamptz
);
create index if not exists idx_segment_revisions_segment on transcript_segment_revisions(segment_id, revision desc);

do $$ declare r record; begin
  for r in
    select c.conname, c.conrelid::regclass::text as tbl, a.attname as col
    from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
    where c.contype = 'f' and c.confrelid = 'meetings'::regclass and c.confdeltype = 'a'
      and c.conrelid::regclass::text in ('media_assets','speakers','transcript_segments','summaries','action_items','ai_runs','agent_runs')
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
    execute format('alter table %s add constraint %I foreign key (%I) references meetings(id) on delete %s',
      r.tbl, r.conname, r.col, case when r.tbl = 'ai_runs' then 'set null' else 'cascade' end);
  end loop;
  for r in
    select c.conname from pg_constraint c
    where c.contype = 'f' and c.conrelid = 'summary_sections'::regclass
      and c.confrelid = 'summaries'::regclass and c.confdeltype = 'a'
  loop
    execute format('alter table summary_sections drop constraint %I', r.conname);
    execute format('alter table summary_sections add constraint %I foreign key (summary_id) references summaries(id) on delete cascade', r.conname);
  end loop;
end $$;
