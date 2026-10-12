alter table webhook_subscriptions add column if not exists secret_ciphertext text;
alter table webhook_deliveries
  add column if not exists max_attempts integer not null default 6,
  add column if not exists delivered_at timestamptz,
  add column if not exists duration_ms integer;
