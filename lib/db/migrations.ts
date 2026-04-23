import { readFileSync, readdirSync } from "node:fs"
import { basename, join } from "node:path"

export type MigrationFile = {
  version: string
  name: string
  path: string
  sql: string
}

const MIGRATION_PATTERN = /^(\d{3,})_[\w-]+\.sql$/

export function listMigrationFiles(directory: string): MigrationFile[] {
  return readdirSync(directory)
    .map((name) => {
      const match = name.match(MIGRATION_PATTERN)

      if (!match) {
        return undefined
      }

      const path = join(directory, name)

      return {
        version: match[1],
        name: basename(name),
        path,
        sql: readFileSync(path, "utf8"),
      }
    })
    .filter((file): file is MigrationFile => Boolean(file))
    .sort((a, b) => a.version.localeCompare(b.version))
}

export function createMigrationPlan(
  appliedVersions: string[],
  migrations: MigrationFile[]
): MigrationFile[] {
  const applied = new Set(appliedVersions)

  return migrations.filter((migration) => !applied.has(migration.version))
}

export async function runMigrations(
  client: {
    query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>
  },
  migrations: MigrationFile[]
) {
  await client.query(`
    create table if not exists schema_migrations (
      version text primary key,
      name text not null,
      applied_at timestamptz not null default now()
    )
  `)

  const applied = await client.query("select version from schema_migrations")
  const appliedVersions = applied.rows.map(
    (row) => (row as { version: string }).version
  )
  const plan = createMigrationPlan(appliedVersions, migrations)

  for (const migration of plan) {
    await client.query("begin")

    try {
      await client.query(migration.sql)
      await client.query(
        "insert into schema_migrations (version, name) values ($1, $2)",
        [migration.version, migration.name]
      )
      await client.query("commit")
    } catch (error) {
      await client.query("rollback")
      throw error
    }
  }

  return plan
}
