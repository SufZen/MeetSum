-- M1-B: Microsoft Graph (Teams) change-notification subscriptions.
create table if not exists capture_subscriptions (
  id text primary key,
  platform text not null,
  external_subscription_id text not null unique,
  resource text not null,
  change_type text not null,
  notification_url text not null,
  lifecycle_notification_url text,
  expires_at timestamptz not null,
  status text not null default 'active',
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_capture_subscriptions_platform_expires
  on capture_subscriptions(platform, status, expires_at);
