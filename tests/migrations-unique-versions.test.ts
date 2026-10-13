import { describe, expect, it } from "vitest"

import { listMigrationFiles } from "@/lib/db/migrations"

/**
 * M6 Step 0 (docs/parity/m6.md, "Migration numbering"): `runMigrations`
 * silently skips a version that is already recorded, so a duplicate version
 * number would never apply. Every file must also be safe to re-run (the
 * compose image runs `db/migrations` from docker-entrypoint-initdb.d too).
 */

/**
 * Versions that may be missing on a branch because another branch owns them:
 * 024 is M7 (`024_meeting_bot.sql`, PR #23). Any other gap is a mistake.
 */
const RESERVED_GAPS = new Set(["024"])

const migrations = listMigrationFiles("db/migrations")

/** SQL without `--` line comments, whitespace collapsed, lower case. */
function flatSql(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase()
}

/** [start, end) offsets of every `do $$ … $$` block (any `$tag$`). */
function doBlocks(sql: string): [number, number][] {
  const blocks: [number, number][] = []
  const opener = /\bdo\s+(\$[a-z_]*\$)/g
  let match: RegExpExecArray | null

  while ((match = opener.exec(sql))) {
    const tag = match[1]
    const end = sql.indexOf(tag, match.index + match[0].length)

    blocks.push([match.index, end === -1 ? sql.length : end + tag.length])
    opener.lastIndex = end === -1 ? sql.length : end + tag.length
  }

  return blocks
}

describe("migration versions (M6 Step 0)", () => {
  it("finds the migrations, including 025", () => {
    expect(migrations.length).toBeGreaterThan(20)
    expect(migrations.map((file) => file.name)).toContain("025_search_ask.sql")
  })

  it("never reuses a version number", () => {
    const seen = new Map<string, string[]>()

    for (const file of migrations) {
      seen.set(file.version, [...(seen.get(file.version) ?? []), file.name])
    }

    const duplicates = [...seen.entries()]
      .filter(([, names]) => names.length > 1)
      .map(([version, names]) => `${version}: ${names.join(", ")}`)

    expect(duplicates).toEqual([])
  })

  it("has no gaps other than versions reserved by other branches", () => {
    const versions = new Set(migrations.map((file) => Number(file.version)))
    const max = Math.max(...versions)
    const gaps: string[] = []

    for (let version = 1; version < max; version += 1) {
      const padded = String(version).padStart(3, "0")

      if (!versions.has(version) && !RESERVED_GAPS.has(padded)) gaps.push(padded)
    }

    expect(gaps).toEqual([])
  })

  it("marks every create/add statement idempotent (static check)", () => {
    const offenders = migrations.flatMap((file) => {
      const sql = flatSql(file.sql)
      const found: string[] = []
      const statements =
        /\b(create (?:unique )?index|create table|create extension|add column)\b(?! if not exists)[^;(]{0,60}/g

      for (const match of sql.matchAll(statements)) {
        found.push(`${file.name}: ${match[0].trim()}`)
      }

      const blocks = doBlocks(sql)

      for (const match of sql.matchAll(/\badd constraint\b/g)) {
        const at = match.index ?? 0

        if (!blocks.some(([start, end]) => at > start && at < end)) {
          found.push(`${file.name}: add constraint outside a guarded DO block`)
        }
      }

      return found
    })

    expect(offenders).toEqual([])
  })

  it("keeps the vector part of 025 behind the pgvector availability check", () => {
    const sql = flatSql(migrations.find((file) => file.version === "025")?.sql ?? "")
    const guard = sql.indexOf("from pg_available_extensions where name = 'vector'")
    const createVector = sql.indexOf("create extension if not exists vector")

    expect(sql).toContain("create extension if not exists pg_trgm")
    expect(guard).toBeGreaterThan(-1)
    expect(createVector).toBeGreaterThan(guard)
    expect(sql).toContain("< array[0,8]")
    // No static reference to the vector type outside the dynamic DDL strings.
    const outsideDdl = sql.replace(/\$ddl\$[\s\S]*?\$ddl\$/g, "")

    expect(outsideDdl).not.toMatch(/\bvector\s*\(|\bembedding vector\b/)
  })
})
