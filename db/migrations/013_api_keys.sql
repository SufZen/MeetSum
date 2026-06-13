-- Reconcile the api_keys table with the admin key-management schema.
--
-- The base table is created in 001 (id, name, key_hash, scopes, created_at).
-- The original 013 used `create table if not exists` with the new shape, which
-- is a no-op when the table already exists and then failed creating an index on
-- the not-yet-added `revoked_at` column. This version is idempotent: it adds the
-- expected columns whether the table pre-exists (old shape) or is brand new.

create table if not exists api_keys (
  id text primary key,
  key_hash text not null
);

alter table api_keys add column if not exists label text not null default '';
alter table api_keys add column if not exists key_prefix text not null default '';
alter table api_keys add column if not exists created_at timestamptz not null default now();
alter table api_keys add column if not exists expires_at timestamptz;
alter table api_keys add column if not exists revoked_at timestamptz;
alter table api_keys add column if not exists last_used_at timestamptz;

-- The legacy `name` column (from migration 001) is NOT NULL with no default and
-- is no longer written by the key-management code; relax it so inserts that only
-- set `label` succeed.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'api_keys' and column_name = 'name'
  ) then
    execute 'alter table api_keys alter column name drop not null';
  end if;
end $$;

create index if not exists idx_api_keys_active
  on api_keys(revoked_at) where revoked_at is null;
