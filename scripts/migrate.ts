import { resolve } from "node:path"

import pg from "pg"

import { listMigrationFiles, runMigrations } from "../lib/db/migrations"
import { ensureBootstrapWorkspace } from "../lib/workspaces/bootstrap"

const databaseUrl = process.env.DATABASE_URL

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required")
}

const migrationsDir = resolve(process.cwd(), process.argv[2] ?? "db/migrations")

const maxRetries = 10
const retryDelayMs = 2000

let client: pg.Client | undefined

for (let attempt = 1; attempt <= maxRetries; attempt++) {
  const candidate = new pg.Client({ connectionString: databaseUrl })
  try {
    await candidate.connect()
    client = candidate
    break
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (attempt < maxRetries && (code === "EAI_AGAIN" || code === "ECONNREFUSED" || code === "ENOTFOUND")) {
      console.log(`Migration attempt ${attempt}/${maxRetries} failed (${code}), retrying in ${retryDelayMs}ms...`)
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
    } else {
      throw error
    }
  }
}

if (!client) {
  throw new Error("Unable to connect to database after retries")
}

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

  // M2: idempotent bootstrap of ws_default (owner/admins from the env
  // allowlist, DWD subject, legacy ownership/favorites/api-key creators).
  const bootstrap = await ensureBootstrapWorkspace(client, process.env)

  console.log(
    bootstrap.ownerUserId
      ? `Bootstrap: ws_default ready (${Object.keys(bootstrap.userIds).length} allowlisted user(s))`
      : "Bootstrap: skipped (no GOOGLE_WORKSPACE_SUBJECT or MEETSUM_ALLOWED_EMAILS)"
  )
} finally {
  await client.end()
}
