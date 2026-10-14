/**
 * M9 Step 0 (docs/parity/m9.md, "Migration 030_i18n_notifications_onboarding.sql"):
 * per-user locale/time zone/preferences, notification links and dedupe,
 * onboarding progress, analytics indexes, share passwords and turn-undo
 * groups, and the pt/es/it → he rewrite of stored UI locales.
 * Static checks always run; the PGlite part applies 001–029, seeds legacy
 * locale settings, applies 030 twice, and is skipped if PGlite cannot load.
 */
import { readFileSync } from "node:fs"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { listMigrationFiles } from "@/lib/db/migrations"

const SQL = readFileSync("db/migrations/030_i18n_notifications_onboarding.sql", "utf8").replace(/\r\n/g, "\n")
const flat = (sql: string) => sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").toLowerCase()

describe("migration 030 (static)", () => {
  const sql = flat(SQL)

  it("adds the user locale, time zone and preferences with a he/en check", () => {
    expect(sql).toContain("add column if not exists locale text")
    expect(sql).toContain("add column if not exists time_zone text")
    expect(sql).toContain("add column if not exists preferences jsonb not null default '{}'::jsonb")
    expect(sql).toContain("check (locale is null or locale in ('he','en'))")
  })

  it("guards every constraint with a pg_constraint lookup", () => {
    for (const name of ["users_locale_check", "notifications_kind_check"]) {
      expect(sql).toContain(`if not exists (select 1 from pg_constraint where conname='${name}')`)
    }
  })

  it("lists all eight notification kinds, not valid so legacy rows survive", () => {
    expect(sql).toContain(
      "check (kind in ('mention','reply','task_assigned','integration_reauth','invited','meeting_processed','meeting_failed','bot_blocked')) not valid"
    )
  })

  it("uses partial-index predicates for dedupe, unread and revision groups", () => {
    expect(sql).toContain(
      "create unique index if not exists uq_notifications_dedupe on notifications(user_id, dedupe_key) where dedupe_key is not null"
    )
    expect(sql).toContain("create index if not exists idx_notifications_unread on notifications(user_id) where read_at is null")
    expect(sql).toContain(
      "create index if not exists idx_segment_revisions_group on transcript_segment_revisions(meeting_id, edit_group_id) where edit_group_id is not null"
    )
  })

  it("adds the M4 carry-over columns", () => {
    expect(sql).toContain("alter table meeting_shares add column if not exists password_hash text")
    expect(sql).toContain("alter table transcript_segment_revisions add column if not exists edit_group_id text")
  })

  it("rewrites legacy UI locales to he in both settings tables", () => {
    expect(sql).toContain(
      "update app_settings set value = '\"he\"'::jsonb where key = 'defaultlocale' and value #>> '{}' in ('pt','es','it')"
    )
    expect(sql).toContain(
      "update workspace_settings set value = '\"he\"'::jsonb where key = 'defaultlocale' and value #>> '{}' in ('pt','es','it')"
    )
  })
})

type PGliteLike = {
  exec(sql: string): Promise<unknown>
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>
  close(): Promise<void>
}

let db: PGliteLike | undefined
let loadError: unknown

beforeAll(async () => {
  try {
    const { PGlite } = await import("@electric-sql/pglite")
    const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm")

    db = (await PGlite.create({ extensions: { pg_trgm } })) as unknown as PGliteLike
  } catch (error) {
    loadError = error
    return
  }

  for (const migration of listMigrationFiles("db/migrations").filter((file) => file.version < "030")) {
    await db.exec(migration.sql)
  }

  await db.exec(`
    insert into workspaces (id, name, slug) values ('ws_m9_a', 'A', 'm9-a'), ('ws_m9_b', 'B', 'm9-b')
      on conflict (id) do nothing;
    insert into users (id, email) values ('usr_m9', 'm9@example.com') on conflict (id) do nothing;
    insert into app_settings (key, value) values ('defaultLocale', '"pt"'::jsonb)
      on conflict (key) do update set value = excluded.value;
    insert into workspace_settings (workspace_id, key, value) values
      ('ws_m9_a', 'defaultLocale', '"es"'::jsonb),
      ('ws_m9_b', 'defaultLocale', '"en"'::jsonb);
    insert into notifications (id, workspace_id, user_id, kind, payload)
      values ('ntf_legacy', 'ws_m9_a', 'usr_m9', 'legacy_kind', '{}'::jsonb);
  `)
}, 120_000)

afterAll(async () => {
  await db?.close()
})

describe("migration 030 on PGlite", () => {
  it("applies on M8 data, rewrites legacy locales and re-runs as a no-op", async (context) => {
    if (!db) {
      context.skip(`PGlite did not load: ${String(loadError)}`)
      return
    }

    await db.exec(SQL)
    await db.exec(SQL)

    const app = await db.query<{ value: string }>("select value #>> '{}' as value from app_settings where key = 'defaultLocale'")
    const ws = await db.query<{ workspace_id: string; value: string }>(
      "select workspace_id, value #>> '{}' as value from workspace_settings where key = 'defaultLocale' order by workspace_id"
    )

    expect(app.rows[0]?.value).toBe("he")
    expect(ws.rows).toEqual([
      { workspace_id: "ws_m9_a", value: "he" },
      { workspace_id: "ws_m9_b", value: "en" },
    ])
  })

  it("enforces the locale check and the notification dedupe index", async (context) => {
    if (!db) {
      context.skip(`PGlite did not load: ${String(loadError)}`)
      return
    }

    await expect(db.query("update users set locale = 'pt' where id = 'usr_m9'")).rejects.toThrow(/users_locale_check/)
    await db.query("update users set locale = 'he', time_zone = 'Asia/Jerusalem' where id = 'usr_m9'")

    await db.query(
      "insert into notifications (id, workspace_id, user_id, kind, payload, dedupe_key) values ('ntf_1', 'ws_m9_a', 'usr_m9', 'invited', '{}'::jsonb, 'inv:1')"
    )
    await expect(
      db.query(
        "insert into notifications (id, workspace_id, user_id, kind, payload, dedupe_key) values ('ntf_2', 'ws_m9_a', 'usr_m9', 'invited', '{}'::jsonb, 'inv:1')"
      )
    ).rejects.toThrow(/uq_notifications_dedupe/)
    await expect(
      db.query(
        "insert into notifications (id, workspace_id, user_id, kind, payload) values ('ntf_3', 'ws_m9_a', 'usr_m9', 'not_a_kind', '{}'::jsonb)"
      )
    ).rejects.toThrow(/notifications_kind_check/)
  })

  it("creates onboarding_progress keyed by workspace and user", async (context) => {
    if (!db) {
      context.skip(`PGlite did not load: ${String(loadError)}`)
      return
    }

    await db.query("insert into onboarding_progress (workspace_id, user_id, skipped) values ('ws_m9_a', 'usr_m9', '{glossary}')")
    await expect(
      db.query("insert into onboarding_progress (workspace_id, user_id) values ('ws_m9_a', 'usr_m9')")
    ).rejects.toThrow(/duplicate key/)

    const columns = await db.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
        where (table_name = 'meeting_shares' and column_name = 'password_hash')
           or (table_name = 'transcript_segment_revisions' and column_name = 'edit_group_id')
        order by table_name`
    )

    expect(columns.rows).toEqual([
      { table_name: "meeting_shares", column_name: "password_hash" },
      { table_name: "transcript_segment_revisions", column_name: "edit_group_id" },
    ])
  })
})
