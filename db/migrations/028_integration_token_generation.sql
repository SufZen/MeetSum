-- M8 Integration step (docs/parity/m8.md): a real token generation column on
-- integration_connections. Package A kept the generation inside
-- `config._gen`; it is bumped by every disconnect and reconnect, and token
-- writes are compare-and-set on (status = 'active', token_generation), so a
-- refresh racing a disconnect can never resurrect tokens.
-- Transactional (runMigrations) and idempotent (also runs from
-- docker-entrypoint-initdb.d on fresh volumes).

alter table integration_connections
  add column if not exists token_generation integer not null default 0;

-- Carry over any generation stored by 027-era code, then strip the key.
update integration_connections
   set token_generation = greatest(token_generation, coalesce((config->>'_gen')::int, 0)),
       config = config - '_gen'
 where config ? '_gen'
   and (config->>'_gen') ~ '^[0-9]{1,9}$';

update integration_connections
   set config = config - '_gen'
 where config ? '_gen';
