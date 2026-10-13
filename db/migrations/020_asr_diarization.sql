alter table speakers
  add column if not exists workspace_id text references workspaces(id) on delete cascade,
  add column if not exists source text not null default 'asr',
  add column if not exists participant_id text references meeting_participants(id) on delete set null,
  add column if not exists profile_id text,
  add column if not exists mapping_status text not null default 'unmapped',
  add column if not exists suggestion jsonb,
  add column if not exists talk_time_ms integer not null default 0,
  add column if not exists word_count integer not null default 0,
  add column if not exists segment_count integer not null default 0,
  add column if not exists first_start_ms integer,
  add column if not exists embedding real[],
  add column if not exists embedding_model text,
  add column if not exists confirmed_by_user_id text references users(id) on delete set null,
  add column if not exists confirmed_at timestamptz,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();
update speakers s set workspace_id = m.workspace_id from meetings m
  where m.id = s.meeting_id and s.workspace_id is null;
update speakers s set mapping_status = 'confirmed', participant_id = p.id
  from meeting_participants p
  where p.meeting_id = s.meeting_id and p.speaker_label = s.label
    and p.source <> 'transcript' and s.participant_id is null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'speakers_mapping_status_check') then
    alter table speakers add constraint speakers_mapping_status_check
      check (mapping_status in ('unmapped','suggested','confirmed','rejected'));
  end if;
  if not exists (select 1 from speakers group by meeting_id, label having count(*) > 1) then
    create unique index if not exists uq_speakers_meeting_label on speakers(meeting_id, label);
  else raise notice 'uq_speakers_meeting_label skipped: duplicates'; end if;
end $$;

alter table transcript_segments
  add column if not exists words jsonb,
  add column if not exists turn_index integer,
  add column if not exists source text not null default 'asr',
  add column if not exists asr_run_id text;
create index if not exists idx_transcript_segments_speaker on transcript_segments(speaker_id);

create table if not exists speaker_profiles (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  display_name text not null,
  email text,
  user_id text references users(id) on delete set null,
  aliases text[] not null default '{}',
  confirmed_count integer not null default 0,
  last_meeting_id text references meetings(id) on delete set null,
  last_confirmed_at timestamptz,
  voice_embedding real[],
  embedding_model text,
  embedding_samples integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists uq_speaker_profiles_email
  on speaker_profiles(workspace_id, lower(email)) where email is not null;
create unique index if not exists uq_speaker_profiles_name
  on speaker_profiles(workspace_id, lower(display_name)) where email is null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'speakers_profile_fk') then
    alter table speakers add constraint speakers_profile_fk
      foreign key (profile_id) references speaker_profiles(id) on delete set null;
  end if;
end $$;

alter table ai_runs
  add column if not exists workspace_id text references workspaces(id) on delete cascade,
  add column if not exists audio_duration_ms integer;
update ai_runs r set workspace_id = m.workspace_id from meetings m
  where m.id = r.meeting_id and r.workspace_id is null;
create index if not exists idx_ai_runs_workspace_task on ai_runs(workspace_id, task, started_at desc);

update meeting_participants set speaker_label = null
  where source = 'transcript' and speaker_label ~ '^Speaker [0-9]+$';
