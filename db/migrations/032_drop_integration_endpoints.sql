-- M10: the legacy integration_endpoints table (002) has had no readers since M8
-- (docs/parity/m8.md "Leftovers"). Guarded and idempotent.
do $$ begin
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'integration_endpoints') then
    if exists (select 1 from integration_endpoints limit 1) then
      raise notice 'integration_endpoints has rows; renaming to integration_endpoints_legacy instead of dropping';
      alter table integration_endpoints rename to integration_endpoints_legacy;
    else
      drop table integration_endpoints;
    end if;
  end if;
end $$;
