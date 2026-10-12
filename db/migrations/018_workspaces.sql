alter table users
  add column if not exists name text,
  add column if not exists picture_url text,
  add column if not exists last_login_at timestamptz,
  add column if not exists default_workspace_id text,
  add column if not exists disabled_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();
update users set email = lower(trim(email)) where email <> lower(trim(email));
create unique index if not exists uq_users_email_lower on users (lower(email));

create table if not exists workspaces (
  id text primary key,
  name text not null,
  slug text not null unique,
  google_subject text,
  created_by_user_id text references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'users_default_workspace_fk') then
    alter table users add constraint users_default_workspace_fk
      foreign key (default_workspace_id) references workspaces(id) on delete set null;
  end if;
end $$;

create table if not exists memberships (
  workspace_id text not null references workspaces(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  role text not null check (role in ('owner','admin','member','viewer')),
  invited_by_user_id text references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index if not exists idx_memberships_user on memberships(user_id);

create table if not exists invitations (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  email text not null,
  role text not null check (role in ('admin','member','viewer')),
  token_hash text not null unique,
  status text not null default 'pending' check (status in ('pending','accepted','revoked','expired')),
  invited_by_user_id text references users(id) on delete set null,
  accepted_by_user_id text references users(id) on delete set null,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  last_sent_at timestamptz,
  send_count integer not null default 0,
  last_send_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists uq_invitations_pending_email
  on invitations(workspace_id, lower(email)) where status = 'pending';

create table if not exists workspace_settings (
  workspace_id text not null references workspaces(id) on delete cascade,
  key text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, key)
);

create table if not exists meeting_favorites (
  user_id text not null references users(id) on delete cascade,
  meeting_id text not null references meetings(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, meeting_id)
);

insert into workspaces (id, name, slug) values ('ws_default', 'MeetSum', 'default')
  on conflict (id) do nothing;
insert into workspace_settings (workspace_id, key, value, updated_at)
  select 'ws_default', key, value, updated_at from app_settings
  where key not in ('requireApiKeyForMachines', 'aiProviderPreference')
  on conflict do nothing;
-- app_settings left in place (unused after M2; dropped in M10).
