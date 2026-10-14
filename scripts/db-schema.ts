/**
 * Generated schema (docs/parity/m10.md, "Schema (D)").
 *
 *   npm run db:schema:generate  -> writes db/schema.sql from a pg_dump
 *   npm run db:schema:check     -> diffs db/schema.sql against a fresh dump (exit 1 on drift)
 *
 * DATABASE_URL must point at a database where `npm run db:migrate` has applied
 * every file in db/migrations (use an empty database: anything else in it ends
 * up in the dump). The script refuses to dump when schema_migrations is behind
 * the migration files.
 *
 * PG_DUMP_CMD overrides the dump command (default `pg_dump`). The committed
 * file comes from pgvector/pgvector:0.8.1-pg17, so run pg_dump 17 against
 * server 17; in CI it is `docker exec <service id> pg_dump`. When pg_dump runs
 * inside a container whose port is published elsewhere, pass the URL as seen
 * from inside the container with `--dump-url <url>`.
 *
 * The password is never printed; pg_dump receives the URL via --dbname.
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import pg from "pg"

import { migrationRange, normalizeSchemaDump, SCHEMA_DUMP_ARGS, schemaHeader, unifiedDiff } from "../lib/db/schema-dump"

const root = process.cwd()
const schemaPath = path.join(root, "db", "schema.sql")
const migrationsDir = path.join(root, "db", "migrations")

function usage(): never {
  console.error("usage: tsx scripts/db-schema.ts generate|check [--dump-url <url>]")
  process.exit(2)
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name)

  return index === -1 ? undefined : process.argv[index + 1]
}

async function assertMigrated(databaseUrl: string, lastVersion: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl })

  await client.connect()
  try {
    const exists = await client.query("select to_regclass('public.schema_migrations') as t")

    if (!exists.rows[0]?.t) throw new Error("schema_migrations is missing: run `npm run db:migrate` on an empty database first")
    const result = await client.query<{ v: string | null }>("select max(version) as v from schema_migrations")
    const applied = result.rows[0]?.v ?? null

    if (applied !== lastVersion) {
      throw new Error(`schema_migrations is at ${applied ?? "nothing"} but db/migrations ends at ${lastVersion}: run \`npm run db:migrate\` first`)
    }
  } finally {
    await client.end()
  }
}

function runPgDump(dumpUrl: string): string {
  const command = (process.env.PG_DUMP_CMD?.trim() || "pg_dump").split(/\s+/)
  const [file, ...prefix] = command

  return execFileSync(file, [...prefix, ...SCHEMA_DUMP_ARGS, `--dbname=${dumpUrl}`], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  })
}

async function freshDump(): Promise<string> {
  const databaseUrl = process.env.DATABASE_URL

  if (!databaseUrl) throw new Error("DATABASE_URL is required")
  const range = migrationRange(readdirSync(migrationsDir))

  await assertMigrated(databaseUrl, range.last)

  return normalizeSchemaDump(runPgDump(flag("--dump-url") ?? databaseUrl), schemaHeader(range.first, range.last))
}

const command = process.argv[2]

if (command !== "generate" && command !== "check") usage()

try {
  const dump = await freshDump()

  if (command === "generate") {
    writeFileSync(schemaPath, dump)
    console.log(`db:schema:generate: wrote db/schema.sql (${dump.split("\n").length - 1} lines)`)
  } else {
    const committed = readFileSync(schemaPath, "utf8").replace(/\r\n?/g, "\n")
    const diff = unifiedDiff(committed, dump)

    if (!diff) {
      console.log("db:schema:check: db/schema.sql matches a fresh pg_dump")
    } else {
      // SCHEMA_CHECK_OUT names where the fresh dump goes (CI uploads it as an
      // artifact); otherwise a temp directory.
      const outFile = process.env.SCHEMA_CHECK_OUT?.trim() || path.join(mkdtempSync(path.join(tmpdir(), "meetsum-schema-")), "schema.sql")

      mkdirSync(path.dirname(outFile), { recursive: true })
      writeFileSync(outFile, dump)
      const diffLines = diff.split("\n").length

      // A small drift prints as a diff; a large one (e.g. the first generated
      // file replacing the hand-written mirror) prints the whole dump between
      // markers so it can be copied from a CI log.
      if (diffLines <= 400) {
        console.error(diff)
      } else {
        console.error(`(diff is ${diffLines} lines; printing the fresh dump instead)`)
        console.log("----- BEGIN db/schema.sql -----")
        process.stdout.write(dump)
        console.log("----- END db/schema.sql -----")
      }
      console.error(`db:schema:check: db/schema.sql is stale. The fresh dump is at ${outFile}; run \`npm run db:schema:generate\` against a pgvector pg17 database and commit it.`)
      // exitCode, not process.exit(): stdout to a pipe is asynchronous, and
      // exiting here would cut the dump printed above short.
      process.exitCode = 1
    }
  }
} catch (error) {
  // execFileSync errors quote the command line, which carries the URL.
  const message = (error instanceof Error ? error.message : String(error)).replace(/(\/\/[^:/@\s]+:)[^@\s]*@/g, "$1***@")

  console.error(`db:schema:${command}: ${message}`)
  process.exitCode = 1
}
