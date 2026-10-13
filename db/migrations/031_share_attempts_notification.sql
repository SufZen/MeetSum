-- M9 follow-up: the share_attempts notification kind (repeated wrong
-- passwords on a meeting's share link; lib/sharing/share-verify-throttle.ts).
-- Transactional and idempotent: the kind check is replaced with the full list.
do $$ begin
  alter table notifications drop constraint if exists notifications_kind_check;
  alter table notifications add constraint notifications_kind_check check (kind in
    ('mention','reply','task_assigned','integration_reauth','invited','meeting_processed','meeting_failed','bot_blocked','share_attempts')) not valid;
end $$;
