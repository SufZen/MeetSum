alter table action_items
  add column if not exists created_at timestamptz not null default now();
