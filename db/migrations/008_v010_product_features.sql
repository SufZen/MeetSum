alter table meetings
  add column if not exists is_favorite boolean not null default false;

create table if not exists meeting_shares (
  id text primary key,
  meeting_id text not null references meetings(id) on delete cascade,
  token text not null unique,
  visibility text not null default 'public',
  revoked boolean not null default false,
  expires_at timestamptz,
  included_sections jsonb not null default '["summary","decisions","action_items","transcript","participants"]'::jsonb,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists meeting_participants (
  id text primary key,
  meeting_id text not null references meetings(id) on delete cascade,
  name text not null,
  email text,
  role text not null default 'attendee',
  source text not null default 'manual',
  attendance_status text not null default 'unknown',
  speaker_label text,
  confidence numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists export_records (
  id text primary key,
  meeting_id text not null references meetings(id) on delete cascade,
  format text not null,
  status text not null default 'created',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table contexts
  add column if not exists color text,
  add column if not exists kind text not null default 'room';

create index if not exists meetings_favorite_idx
  on meetings(is_favorite, started_at desc);

create index if not exists meeting_participants_meeting_idx
  on meeting_participants(meeting_id);

create index if not exists meeting_shares_meeting_idx
  on meeting_shares(meeting_id);
