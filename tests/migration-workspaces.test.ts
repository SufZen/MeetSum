import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

const read = (path: string) => readFileSync(path, "utf8")
const migration018 = read("db/migrations/018_workspaces.sql")
const migration019 = read("db/migrations/019_workspace_scoping.sql")
const schema = read("db/schema.sql")

const SCOPED_TABLES = [
  "meetings",
  "contexts",
  "tags",
  "media_assets",
  "jobs",
  "webhook_subscriptions",
  "api_keys",
  "audit_logs",
] as const

function tableBlock(sql: string, table: string): string {
  const match = sql.match(
    new RegExp(`create table if not exists ${table} \\(([\\s\\S]*?)\\n\\);`)
  )

  if (!match) throw new Error(`table ${table} not found`)
  return match[1]
}

describe("M2 workspace migrations (static)", () => {
  it("creates the tenancy tables and the default workspace", () => {
    for (const table of [
      "workspaces",
      "memberships",
      "invitations",
      "workspace_settings",
      "meeting_favorites",
    ]) {
      expect(migration018).toContain(`create table if not exists ${table}`)
    }
    expect(migration018).toMatch(/insert into workspaces[\s\S]*'ws_default'/)
  })

  it("adds workspace_id without a default and makes it required where rows must belong", () => {
    for (const table of SCOPED_TABLES) {
      expect(migration019).toMatch(
        new RegExp(`alter table ${table}[\\s\\S]*?add column if not exists workspace_id text references workspaces\\(id\\)`)
      )
    }
    expect(migration019).not.toMatch(/workspace_id text[^,;\n]*default/)
    for (const table of ["meetings", "contexts", "tags", "media_assets", "webhook_subscriptions", "api_keys"]) {
      expect(migration019).toContain(`alter table ${table} alter column workspace_id set not null`)
    }
  })

  it("makes uniqueness per workspace (tags, external refs)", () => {
    expect(migration019).toContain("on tags(workspace_id, name)")
    expect(migration019).toContain(
      "on meetings(workspace_id, external_source, external_id) where external_id is not null"
    )
  })
})

describe("db/schema.sql", () => {
  it("declares every referenced table before it is referenced", () => {
    const declared = new Set<string>()
    const statements = schema.split(";")

    for (const statement of statements) {
      for (const match of statement.matchAll(/references (\w+)\(/g)) {
        const own = statement.match(/create table if not exists (\w+)/)?.[1]

        if (match[1] !== own) {
          expect(declared.has(match[1]), `${match[1]} referenced before declaration`).toBe(true)
        }
      }

      const created = statement.match(/create table if not exists (\w+)/)

      if (created) declared.add(created[1])
    }
  })

  it("mirrors the M2 workspace columns and per-workspace indexes", () => {
    for (const table of SCOPED_TABLES) {
      expect(tableBlock(schema, table), table).toMatch(
        /workspace_id text( not null)? references workspaces\(id\)/
      )
    }
    expect(tableBlock(schema, "meetings")).toContain("visibility text not null default 'workspace'")
    expect(tableBlock(schema, "meetings")).toContain("owner_user_id text references users(id)")
    expect(tableBlock(schema, "tags")).not.toContain("unique")
    expect(schema).toContain("on tags(workspace_id, name)")
    expect(schema).toContain(
      "on meetings(workspace_id, external_source, external_id) where external_id is not null"
    )
    expect(schema).toContain("create table if not exists meeting_favorites")
    expect(schema).toContain("create table if not exists workspace_settings")
  })
})
