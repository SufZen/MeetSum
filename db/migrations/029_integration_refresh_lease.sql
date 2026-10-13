-- M8 review fix (docs/parity/m8.md, "Token refresh"): a short refresh lease
-- on integration_connections replaces the `select … for update`
-- transaction that used to be held across the provider's token call.
-- A refresher sets `refresh_lease_until = now + 45 s` with a conditional
-- update (status = 'active', same token_generation, no live lease), calls
-- the provider WITHOUT any open transaction or row lock, then writes the new
-- tokens with a compare-and-set on the generation and clears the lease.
-- Others wait for the lease (single flight across processes); an expired
-- lease (crashed holder) is taken over.
-- Transactional (runMigrations) and idempotent (also runs from
-- docker-entrypoint-initdb.d on fresh volumes).

alter table integration_connections
  add column if not exists refresh_lease_until timestamptz;
