import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

const read = (path: string) => readFileSync(path, "utf8")
const migration018 = read("db/migrations/018_workspaces.sql")
const migration019 = read("db/migrations/019_workspace_scoping.sql")

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
