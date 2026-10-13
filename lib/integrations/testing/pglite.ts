/**
 * Test helper: a PGlite database with every migration applied (001–027),
 * exposed as a `Queryable`. Returns undefined when PGlite cannot load on
 * this host (tests then skip their Postgres half). Owner: Package A.
 */
import type { Queryable } from "@/lib/db/client"
import { listMigrationFiles } from "@/lib/db/migrations"

export type TestPg = Queryable & {
  exec(sql: string): Promise<unknown>
  close(): Promise<void>
}

type PGliteLike = {
  exec(sql: string): Promise<unknown>
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>
  close(): Promise<void>
}

export async function createMigratedPglite(): Promise<{ db?: TestPg; error?: unknown }> {
  let pg: PGliteLike

  try {
    const { PGlite } = await import("@electric-sql/pglite")
    const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm")

    pg = (await PGlite.create({ extensions: { pg_trgm } })) as unknown as PGliteLike
  } catch (error) {
    return { error }
  }

  for (const migration of listMigrationFiles("db/migrations")) {
    await pg.exec(migration.sql)
  }

  return {
    db: {
      query: (text, values) => pg.query(text, values),
      exec: (sql) => pg.exec(sql),
      close: () => pg.close(),
    },
  }
}

/** Two workspaces, users and meetings for isolation tests. */
export async function seedIntegrationFixtures(db: TestPg): Promise<void> {
  await db.exec(`
    insert into workspaces (id, name, slug) values ('ws_a', 'A', 'int-a'), ('ws_b', 'B', 'int-b')
      on conflict (id) do nothing;
    insert into users (id, email) values
      ('user_owner', 'owner@example.com'), ('user_admin', 'admin@example.com'), ('user_member', 'member@example.com')
      on conflict (id) do nothing;
    insert into meetings (id, title, source, language, status, retention, started_at, workspace_id, owner_user_id, visibility)
      values
      ('m_a', 'Meeting A', 'upload', 'he', 'completed', 'audio', now(), 'ws_a', 'user_owner', 'workspace'),
      ('m_b', 'Meeting B', 'upload', 'en', 'completed', 'audio', now(), 'ws_b', 'user_owner', 'workspace')
      on conflict (id) do nothing;
  `)
}
