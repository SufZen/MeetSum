alter table action_items
  add column if not exists edited_by_user boolean not null default false,
  add column if not exists origin text not null default 'ai',
  add column if not exists original_title text,
  add column if not exists completed_at timestamptz;

update action_items set original_title = title where original_title is null;

alter table meetings
  add column if not exists external_source text,
  add column if not exists external_id text;

create unique index if not exists uq_meetings_external_ref
  on meetings(external_source, external_id) where external_id is not null;

do $$ begin
  if not exists (
    select 1 from media_assets
    where source in ('desktop_capture','zoom','teams') and source_file_id is not null
    group by meeting_id, source, source_file_id having count(*) > 1
  ) then
    create unique index if not exists uq_media_assets_meeting_capture
      on media_assets(meeting_id, source, source_file_id)
      where source in ('desktop_capture','zoom','teams') and source_file_id is not null;
  else
    raise notice 'uq_media_assets_meeting_capture skipped: duplicate capture assets exist';
  end if;
end $$;
