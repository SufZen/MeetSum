/**
 * M8 Step 0 (docs/parity/m8.md, "Migration 027_integrations.sql"): the
 * integrations tables, the Outlook columns on calendar_events with the
 * Google iCalUID/workspace backfill, and webhook payload versioning.
 * Static checks always run; the PGlite part applies 001–026, seeds M7 data,
 * applies 027 twice, and is skipped if PGlite cannot load on this host.
 */
import { readFileSync } from "node:fs"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { listMigrationFiles } from "@/lib/db/migrations"

const SQL = readFileSync("db/migrations/027_integrations.sql", "utf8").replace(/\r\n/g, "\n")
const flat = (sql: string) => sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").toLowerCase()

const TABLES = [
  "integration_connections",
  "integration_oauth_states",
  "integration_rules",
  "integration_deliveries",
  "integration_links",
  "meeting_integration_prefs",
  "email_recap_unsubscribes",
]

describe("migration 027 (static)", () => {
  it("creates every integrations table with a workspace column", () => {
    for (const table of TABLES) {
      const start = flat(SQL).indexOf(`create table if not exists ${table} (`)
      const body = flat(SQL).slice(start, flat(SQL).indexOf(");", start))

      expect(start, table).toBeGreaterThan(-1)
      expect(body, table).toContain("workspace_id text not null references workspaces(id) on delete cascade")
    }
  })

  it("keeps tokens in encrypted columns only and enforces the connection shape", () => {
    const sql = flat(SQL)

    expect(sql).toContain("access_token_enc text")
    expect(sql).toContain("refresh_token_enc text")
    expect(sql).not.toMatch(/\baccess_token text|\brefresh_token text/)
    expect(sql).toContain("check ((provider in ('microsoft','google_drive')) = (user_id is not null))")
    expect(sql).toContain("check ((provider = 'email') = (connection_id is null))")
    expect(sql).toContain("unique (workspace_id, idempotency_key)")
    expect(sql).toContain("unique (connection_id, meeting_id, object_kind, destination_key, action_item_id)")
    expect(sql).toContain("on integration_rules(workspace_id) where provider = 'email'")
  })

  it("is mirrored in db/schema.sql", () => {
    const schema = flat(readFileSync("db/schema.sql", "utf8"))

    expect(schema).toContain(flat(SQL))
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

  for (const migration of listMigrationFiles("db/migrations").filter((file) => file.version < "027")) {
    await db.exec(migration.sql)
  }

  await db.exec(`
    insert into workspaces (id, name, slug) values ('ws_m8_a', 'A', 'm8-a'), ('ws_m8_b', 'B', 'm8-b')
      on conflict (id) do nothing;
    insert into users (id, email) values ('usr_m8', 'm8@example.com') on conflict (id) do nothing;
    insert into workspace_accounts (id, domain, admin_email) values ('wa_m8', 'example.com', 'admin@example.com');
    insert into google_identities (id, workspace_account_id, subject_email, workspace_id)
      values ('gi_m8', 'wa_m8', 'admin@example.com', 'ws_m8_a');
    insert into calendar_events (id, google_identity_id, google_event_id, title, raw) values
      ('ce_with_uid', 'gi_m8', 'g1', 'With iCalUID', '{"iCalUID":"uid-1@google.com"}'::jsonb),
      ('ce_without_uid', 'gi_m8', 'g2', 'Without iCalUID', '{}'::jsonb);
  `)
}, 120_000)

afterAll(async () => {
  await db?.close()
})

describe("migration 027 on PGlite (M7 data)", () => {
  it("applies on M7 data, backfills Google rows and re-runs as a no-op", async (context) => {
    if (!db) {
      context.skip(`PGlite did not load: ${String(loadError)}`)
      return
    }

    await db.exec(SQL)
    await db.exec(SQL)

    const rows = await db.query<{ id: string; provider: string; workspace_id: string | null; ical_uid: string | null }>(
      "select id, provider, workspace_id, ical_uid from calendar_events where id like 'ce_%' order by id"
    )

    expect(rows.rows).toEqual([
      { id: "ce_with_uid", provider: "google", workspace_id: "ws_m8_a", ical_uid: "uid-1@google.com" },
      { id: "ce_without_uid", provider: "google", workspace_id: "ws_m8_a", ical_uid: null },
    ])

    const versions = await db.query<{ payload_version: number }>(
      "select column_default as payload_version from information_schema.columns where table_name = 'webhook_subscriptions' and column_name = 'payload_version'"
    )

    expect(String(versions.rows[0]?.payload_version)).toBe("1")
  })

  it("rejects a Microsoft calendar row without a connection, and accepts one with it", async (context) => {
    if (!db) {
      context.skip(`PGlite did not load: ${String(loadError)}`)
      return
    }

    await expect(
      db.query(
        "insert into calendar_events (id, provider, workspace_id, external_event_id, title) values ('ce_ms_bad', 'microsoft', 'ws_m8_a', 'ev1', 'Outlook')"
      )
    ).rejects.toThrow(/calendar_events_provider_check/)

    await db.query(
      `insert into integration_connections (id, workspace_id, provider, user_id, account_label, external_account_id)
       values ('intc_ms', 'ws_m8_a', 'microsoft', 'usr_m8', 'm8@example.com', 'tid:oid')`
    )
    await db.query(
      `insert into calendar_events (id, provider, workspace_id, integration_connection_id, external_event_id, ical_uid, title)
       values ('ce_ms_ok', 'microsoft', 'ws_m8_a', 'intc_ms', 'ev1', 'uid-1@google.com', 'Outlook')`
    )

    const dupes = await db.query<{ n: number }>(
      "select count(*)::int as n from calendar_events where workspace_id = 'ws_m8_a' and ical_uid = 'uid-1@google.com'"
    )

    expect(dupes.rows[0]?.n).toBe(2)
  })

  it("enforces personal vs workspace connections and one email rule per workspace", async (context) => {
    if (!db) {
      context.skip(`PGlite did not load: ${String(loadError)}`)
      return
    }

    // Slack is workspace-level: a user_id is refused; Microsoft needs one.
    await expect(
      db.query(
        `insert into integration_connections (id, workspace_id, provider, user_id, account_label, external_account_id)
         values ('intc_bad1', 'ws_m8_a', 'slack', 'usr_m8', 'Team', 'T1')`
      )
    ).rejects.toThrow()
    await expect(
      db.query(
        `insert into integration_connections (id, workspace_id, provider, account_label, external_account_id)
         values ('intc_bad2', 'ws_m8_a', 'microsoft', 'x', 'tid:oid2')`
      )
    ).rejects.toThrow()

    await db.query(
      "insert into integration_rules (id, workspace_id, provider, name, trigger_event) values ('intr_e1', 'ws_m8_a', 'email', 'Recap', 'meeting.completed')"
    )
    await expect(
      db.query(
        "insert into integration_rules (id, workspace_id, provider, name, trigger_event) values ('intr_e2', 'ws_m8_a', 'email', 'Recap 2', 'meeting.completed')"
      )
    ).rejects.toThrow(/uq_integration_rules_email/)
    // Another workspace has its own singleton.
    await db.query(
      "insert into integration_rules (id, workspace_id, provider, name, trigger_event) values ('intr_e3', 'ws_m8_b', 'email', 'Recap', 'meeting.completed')"
    )
  })
})
