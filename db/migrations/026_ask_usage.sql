-- M6 review: durable AskMeetSum daily cap (docs/parity/m6.md, C7).
-- One atomic counter per (workspace, principal, UTC day), reserved before
-- the LLM call with `insert … on conflict do update set count = count + 1
-- where count < limit returning count` (lib/ask/usage.ts). Counts every ask:
-- persisted or not, user or API key (principal_key = 'user:<id>', or
-- 'api_key:<id>' for a key without a creator). Idempotent.

create table if not exists ask_usage (
  workspace_id text not null references workspaces(id) on delete cascade,
  principal_key text not null,
  day date not null,
  count integer not null default 0 check (count >= 0),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, principal_key, day)
);
-- Pruning old days.
create index if not exists idx_ask_usage_day on ask_usage (day);
