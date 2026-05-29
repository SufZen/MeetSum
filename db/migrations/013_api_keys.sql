create table if not exists api_keys (
  id text primary key,
  label text not null default '',
  key_hash text not null,
  key_prefix text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz
);

create index if not exists idx_api_keys_active
  on api_keys(revoked_at) where revoked_at is null;
