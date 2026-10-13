/**
 * PGlite with migrations 001–027 for M8 Package B tests, plus a `pg`-like
 * `query(sql, params)` adapter. Returns undefined when PGlite cannot load.
 */
import { listMigrationFiles } from "@/lib/db/migrations"

export type PgLike = {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number }>
  exec(sql: string): Promise<unknown>
  close(): Promise<void>
}

export async function createM8Database(): Promise<PgLike | undefined> {
  let db: PgLike

  try {
    const { PGlite } = await import("@electric-sql/pglite")
    const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm")

    db = (await PGlite.create({ extensions: { pg_trgm } })) as unknown as PgLike
  } catch {
    return undefined
  }

  for (const migration of listMigrationFiles("db/migrations").filter((file) => file.version <= "027")) {
    await db.exec(migration.sql)
  }

  return db
}

/** W1/W2 workspaces, users, memberships and personal Microsoft connections. */
export async function seedM8Workspaces(db: PgLike): Promise<void> {
  await db.exec(`
    insert into workspaces (id, name, slug) values ('ws_1', 'W1', 'w1'), ('ws_2', 'W2', 'w2') on conflict do nothing;
    insert into users (id, email) values
      ('usr_yossi', 'Yossi@acme.co.il'), ('usr_dana', 'dana@acme.co.il'), ('usr_w2', 'other@w2.example')
      on conflict do nothing;
    insert into memberships (workspace_id, user_id, role) values
      ('ws_1', 'usr_yossi', 'member'), ('ws_1', 'usr_dana', 'owner'), ('ws_2', 'usr_w2', 'owner')
      on conflict do nothing;
    insert into integration_connections (id, workspace_id, provider, user_id, account_label, external_account_id, config)
      values
      ('intc_ms_1', 'ws_1', 'microsoft', 'usr_yossi', 'yossi@acme.co.il', 'tid:oid1', '{"calendarSyncEnabled":true}'),
      ('intc_ms_revoked', 'ws_1', 'microsoft', 'usr_dana', 'dana@acme.co.il', 'tid:oid2', '{}'),
      ('intc_ms_w2', 'ws_2', 'microsoft', 'usr_w2', 'other@w2.example', 'tid:oid3', '{}')
      on conflict do nothing;
    update integration_connections set status = 'revoked' where id = 'intc_ms_revoked';
  `)
}
