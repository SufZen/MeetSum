-- M9 follow-up (share-link verify throttle; lib/sharing/share-verify-throttle.ts):
-- per-share failure state on the share row (shared by every app instance,
-- never evicted, only for real shares) and the share_attempts notification
-- kind (the meeting owner is told at 50 failures in an hour).
-- Transactional and idempotent.
alter table meeting_shares
  add column if not exists verify_failures integer not null default 0,
  add column if not exists verify_window_started_at timestamptz,
  add column if not exists verify_next_allowed_at timestamptz;

do $$ begin
  alter table notifications drop constraint if exists notifications_kind_check;
  alter table notifications add constraint notifications_kind_check check (kind in
    ('mention','reply','task_assigned','integration_reauth','invited','meeting_processed','meeting_failed','bot_blocked','share_attempts')) not valid;
end $$;
