/**
 * v0.7.1: migrations that the previous release cannot run against carry a
 * `-- meetsum:breaking <reason>` line. scripts/breaking-migrations.sh lists
 * the marked migrations that are not yet in schema_migrations (applied
 * versions on stdin); deploy-vps.sh enters maintenance mode when the list is
 * not empty.
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { describe, expect, it } from "vitest"

const root = path.resolve(__dirname, "..")
const hasSh = spawnSync("sh", ["-c", "exit 0"], { stdio: "ignore" }).status === 0
const MIGRATIONS = path.join(root, "db/migrations")

function pending(applied: string[], dir = "db/migrations") {
  const result = spawnSync("sh", ["scripts/breaking-migrations.sh", dir], {
    cwd: root,
    input: applied.join("\n") + (applied.length ? "\n" : ""),
    encoding: "utf8",
  })

  expect(result.status, result.stderr).toBe(0)
  return result.stdout.split("\n").filter(Boolean)
}

const versions = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => String(from + index).padStart(3, "0"))

describe("breaking migrations", () => {
  it("019 (workspace_id NOT NULL) is the only migration marked breaking", () => {
    const marked = readdirSync(MIGRATIONS)
      .filter((name) => name.endsWith(".sql"))
      .filter((name) => /^-- meetsum:breaking\b/m.test(readFileSync(path.join(MIGRATIONS, name), "utf8")))

    expect(marked).toEqual(["019_workspace_scoping.sql"])
  })

  it.runIf(hasSh)("v0.6.0 production (001-014 applied) has 019 pending", () => {
    expect(pending(versions(1, 14))).toEqual(["019_workspace_scoping.sql"])
  })

  it.runIf(hasSh)("nothing is pending once 019 is applied, or on a database that is ahead", () => {
    expect(pending(versions(1, 32))).toEqual([])
    expect(pending([...versions(1, 40)])).toEqual([])
  })

  it.runIf(hasSh)("an empty schema_migrations lists every marked migration", () => {
    expect(pending([])).toEqual(["019_workspace_scoping.sql"])
  })

  it.runIf(hasSh)("tolerates psql output with blanks and CRLF, and only reads the marker at line start", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "meetsum-migrations-"))

    writeFileSync(path.join(dir, "001_a.sql"), "-- meetsum:breaking reason\nselect 1;\n")
    writeFileSync(path.join(dir, "002_b.sql"), "select 1; -- meetsum:breaking is only a comment here\n")
    writeFileSync(path.join(dir, "003_c.sql"), "-- meetsum:breaking another\nselect 1;\n")
    writeFileSync(path.join(dir, "notes.txt"), "-- meetsum:breaking\n")

    expect(pending([" 001 \r"], dir)).toEqual(["003_c.sql"])
    expect(pending([], dir)).toEqual(["001_a.sql", "003_c.sql"])
  })
})
