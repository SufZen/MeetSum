import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { listMigrationFiles } from "@/lib/db/migrations"

const flat = (text: string) => text.replace(/\s+/g, " ")
const migration = flat(readFileSync("db/migrations/023_m5_fixups.sql", "utf8"))
const REACTION_KEY = "primary key (workspace_id, meeting_id, target_type, target_id, user_id, emoji)"
const TEMPLATE_INDEX =
  "create unique index if not exists summary_templates_workspace_key_active on summary_templates (workspace_id, key) where archived_at is null"
const DROP_OLD_UNIQUE = "alter table summary_templates drop constraint if exists summary_templates_workspace_id_key_key"

describe("migration 023 (static): M5 fix-ups for databases that ran a draft 022", () => {
  it("is a separate, ordered migration after 022", () => {
    const versions = listMigrationFiles("db/migrations").map((file) => file.version)

    expect(versions).toContain("023")
    expect(versions.indexOf("023")).toBe(versions.indexOf("022") + 1)
  })

  it("re-keys reactions idempotently (adds the key when missing, swaps a 4-column key)", () => {
    expect(migration).toContain("c.conrelid = 'reactions'::regclass and c.contype = 'p'")
    expect(migration).toContain("if pk_name is null then")
    expect(migration).toContain("elsif pk_cols <> 6 then")
    expect(migration).toContain("alter table reactions drop constraint %I")
    expect(migration).toContain(`alter table reactions add constraint reactions_pkey ${REACTION_KEY}`)
  })

  it("makes template keys unique among non-archived templates only", () => {
    expect(migration).toContain(DROP_OLD_UNIQUE)
    expect(migration).toContain(TEMPLATE_INDEX)
  })
})
