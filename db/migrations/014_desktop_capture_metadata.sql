alter table media_assets
  add column if not exists metadata jsonb not null default '{}'::jsonb;
