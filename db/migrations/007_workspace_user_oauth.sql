alter table google_identities
  add column if not exists oauth_refresh_token text,
  add column if not exists oauth_scope text,
  add column if not exists oauth_connected_at timestamptz,
  add column if not exists oauth_last_error text;

create index if not exists idx_google_identities_oauth_connected
  on google_identities(oauth_connected_at desc)
  where oauth_refresh_token is not null;
