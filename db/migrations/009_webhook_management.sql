alter table webhook_subscriptions
  add column if not exists updated_at timestamptz not null default now();

create index if not exists idx_webhook_deliveries_subscription_created
  on webhook_deliveries(webhook_subscription_id, created_at desc);

create index if not exists idx_webhook_deliveries_status_created
  on webhook_deliveries(status, created_at desc);
