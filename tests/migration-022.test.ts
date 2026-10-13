import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

const migration = readFileSync("db/migrations/022_intelligence_parity.sql", "utf8")
const schema = readFileSync("db/schema.sql", "utf8")
const REACTION_KEY = "primary key (workspace_id, meeting_id, target_type, target_id, user_id, emoji)"

describe("migration 022 (static): reactions key", () => {
  it("keys reactions by workspace and meeting, not only by target", () => {
    expect(migration).toContain(REACTION_KEY)
    expect(schema).toContain(REACTION_KEY)
    expect(migration).not.toContain("primary key (target_type, target_id, user_id, emoji)")
    expect(schema).not.toContain("primary key (target_type, target_id, user_id, emoji)")
  })

  it("re-keys a reactions table created by an earlier draft, idempotently", () => {
    expect(migration).toMatch(/c\.conrelid = 'reactions'::regclass and c\.contype = 'p'/)
    expect(migration).toMatch(/if pk_name is not null and pk_cols <> 6 then/)
    expect(migration).toMatch(/alter table reactions drop constraint %I/)
    expect(migration).toContain(`alter table reactions add constraint reactions_pkey\n      ${REACTION_KEY}`.replace(/\n/g, migration.includes("\r\n") ? "\r\n" : "\n"))
  })
})
