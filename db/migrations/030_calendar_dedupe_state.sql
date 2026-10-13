-- M8 review fix (docs/parity/m8.md, "Calendar dedupe"): explicit dedupe
-- state on calendar rows, so only a row that was skipped as a duplicate is
-- ever promoted when its canonical event is cancelled.
--   'deferred' : skipped because another calendar's row was canonical; it
--                never had a meeting of its own.
--   'promoted' : was deferred, then got its own meeting after the canonical
--                event was cancelled (never promoted again).
--   null       : a normal row. A row whose meeting the user deleted stays
--                null and is never promoted (no resurrection).
-- Transactional (runMigrations) and idempotent (also runs from
-- docker-entrypoint-initdb.d on fresh volumes).

alter table calendar_events
  add column if not exists dedupe_state text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'calendar_events_dedupe_state_check') then
    alter table calendar_events add constraint calendar_events_dedupe_state_check
      check (dedupe_state is null or dedupe_state in ('deferred', 'promoted'));
  end if;
end $$;

create index if not exists idx_calendar_events_dedupe_deferred
  on calendar_events(workspace_id, ical_uid, starts_at) where dedupe_state = 'deferred';
