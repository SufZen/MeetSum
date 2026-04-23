import { resolve } from "node:path"

import pg from "pg"

import { listMigrationFiles, runMigrations } from "../lib/db/migrations"

const databaseUrl = process.env.DATABASE_URL

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required")
}

const client = new pg.Client({ connectionString: databaseUrl })
const migrationsDir = resolve(process.cwd(), process.argv[2] ?? "db/migrations")

await client.connect()

try {
  const migrations = listMigrationFiles(migrationsDir)
  const applied = await runMigrations(client, migrations)

  if (applied.length === 0) {
    console.log("No pending migrations")
  } else {
    console.log(
      `Applied ${applied.length} migration(s): ${applied
        .map((migration) => migration.name)
        .join(", ")}`
    )
  }
} finally {
  await client.end()
}
