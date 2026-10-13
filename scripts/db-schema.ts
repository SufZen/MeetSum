/**
 * M10 Step 0 stub (docs/parity/m10.md, "Schema (D)").
 *
 *   npm run db:schema:generate  -> writes db/schema.sql from a pg_dump of 001-032
 *   npm run db:schema:check     -> diffs db/schema.sql against a fresh dump
 *
 * Package D replaces this file. Until then `check` exits 0 with a notice so the
 * CI `schema` job stays green, and `generate` is a no-op.
 */
const command = process.argv[2]

if (command === "check") {
  console.log("db:schema:check: not implemented (M10 D); skipping the schema diff until D lands")
} else if (command === "generate") {
  console.log("not implemented (M10 D)")
} else {
  console.error("usage: tsx scripts/db-schema.ts generate|check")
  process.exit(1)
}
