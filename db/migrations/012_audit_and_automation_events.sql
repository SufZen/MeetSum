create table if not exists audit_logs (
  id text primary key,
  action text not null,
  actor text,
  target_type text,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_audit_logs_action_created
  on audit_logs(action, created_at desc);

create index if not exists idx_audit_logs_target_created
  on audit_logs(target_type, target_id, created_at desc);
