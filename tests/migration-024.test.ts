import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { createMemoryBotSessionStore } from "@/lib/bot/store-memory"

const migration = readFileSync("db/migrations/024_meeting_bot.sql", "utf8").replace(/\r\n/g, "\n")
const schema = readFileSync("db/schema.sql", "utf8").replace(/\r\n/g, "\n")

const LIVE = "('requested','joining','awaiting_admission','needs_help','active','stopping')"

/** Every `create unique index` statement (name -> full statement). */
function uniqueIndexes(sql: string): Map<string, string> {
  const found = new Map<string, string>()

  for (const match of sql.matchAll(/create unique index if not exists (\w+)\s+on ([^;]+);/g)) {
    found.set(match[1], match[2].replace(/\s+/g, " "))
  }

  return found
}

describe("migration 024 (static)", () => {
  it("creates bot_sessions with the documented check constraints", () => {
    expect(migration).toContain("create table if not exists bot_sessions")
    expect(migration).toContain(
      "workspace_id text not null references workspaces(id) on delete cascade"
    )
    expect(migration).toContain("check (origin in ('manual','meeting_request','calendar_rule'))")
    expect(migration).toContain("check (platform in ('google_meet','teams','zoom'))")
    expect(migration).toMatch(
      /check \(status in \('scheduled','requested','joining',\s*'awaiting_admission','needs_help','active','stopping','completed','failed','blocked','cancelled'\)\)/
    )
    expect(migration).toContain(
      "check (consent_status in ('pending','sent','unsupported','failed','disabled'))"
    )
    expect(migration).toContain(
      "check (recording_status in ('none','pending','importing','imported','missing','failed'))"
    )
    expect(migration).toContain("check (source in ('webhook','poll','api'))")
    expect(migration).toContain("passcode_enc text")
  })

  it("scopes every unique key by workspace (no cross-tenant DoS)", () => {
    const indexes = uniqueIndexes(migration)

    expect([...indexes.keys()].sort()).toEqual([
      "uq_bot_events_ws_event_id",
      "uq_bot_events_ws_transition",
      "uq_bot_sessions_calendar",
      "uq_bot_sessions_ws_live_target",
      "uq_bot_sessions_ws_vexa_meeting",
    ])

    for (const [name, statement] of indexes) {
      expect(statement, name).toMatch(/^\w+\(workspace_id, /)
    }

    expect(indexes.get("uq_bot_sessions_ws_live_target")).toBe(
      `bot_sessions(workspace_id, platform, native_meeting_id) where status in ${LIVE}`
    )
    expect(indexes.get("uq_bot_events_ws_transition")).toBe(
      "bot_events(workspace_id, vexa_meeting_id, event_type, coalesce(vexa_status, ''), coalesce(prev_status, '')) where vexa_meeting_id is not null and workspace_id is not null and source = 'webhook'"
    )
    expect(indexes.get("uq_bot_events_ws_event_id")).toBe(
      "bot_events(workspace_id, vexa_event_id) where vexa_event_id is not null and workspace_id is not null"
    )
    // No column-level global unique (vexa_meeting_id is unique per workspace).
    expect(migration).not.toMatch(/vexa_meeting_id text unique/)
    expect(migration).toContain(
      "alter table bot_sessions drop constraint if exists bot_sessions_vexa_meeting_id_key"
    )
    expect(migration).toContain("drop index if exists uq_bot_sessions_live_target;")
    expect(migration).toContain("drop index if exists uq_bot_events_status;")
    expect(migration).toContain("drop index if exists uq_bot_events_event_id;")
    expect(migration).toContain("drop index if exists uq_bot_events_ws_status;")
  })

  it("keeps the open-session and webhook lookup indexes", () => {
    expect(migration).toContain(
      "idx_bot_sessions_open on bot_sessions(status, updated_at)\n  where status not in ('completed','failed','blocked','cancelled')"
    )
    expect(migration).toContain("idx_bot_sessions_vexa_meeting")
    expect(migration).toContain("idx_bot_sessions_target")
  })

  it("is mirrored in db/schema.sql", () => {
    expect([...uniqueIndexes(schema).entries()].filter(([name]) => name.includes("bot_"))).toEqual(
      [...uniqueIndexes(migration).entries()]
    )
    expect(schema).not.toMatch(/vexa_meeting_id text unique/)
  })
})

describe("workspace-scoped bot uniqueness (memory store mirrors 024)", () => {
  it("lets two workspaces schedule and run bots for the same meeting link", async () => {
    const store = createMemoryBotSessionStore()
    const base = {
      origin: "manual" as const,
      platform: "google_meet" as const,
      nativeMeetingId: "abc-defg-hij",
      botName: "MeetSum Notetaker",
    }
    const w1 = await store.create({ ...base, workspaceId: "ws_1", status: "requested" })
    const w2 = await store.create({ ...base, workspaceId: "ws_2", status: "requested" })

    await store.update(w1.id, { vexaMeetingId: "v1" }, { workspaceId: "ws_1" })
    await store.update(w2.id, { vexaMeetingId: "v1" }, { workspaceId: "ws_2" })

    expect(w1.id).not.toBe(w2.id)
    expect(await store.countLive()).toBe(2)
    // Same workspace twice is still refused.
    await expect(
      store.create({ ...base, workspaceId: "ws_1", status: "joining" })
    ).rejects.toMatchObject({ constraint: "uq_bot_sessions_ws_live_target" })
  })

  it("dedupes webhook events per workspace only", async () => {
    const store = createMemoryBotSessionStore()
    const event = {
      source: "webhook" as const,
      vexaMeetingId: "4242",
      eventType: "meeting.status_change",
      vexaStatus: "active",
      vexaEventId: "evt_1",
    }

    expect((await store.recordEvent({ ...event, workspaceId: "ws_1" })).duplicate).toBe(false)
    expect((await store.recordEvent({ ...event, workspaceId: "ws_2" })).duplicate).toBe(false)
    expect((await store.recordEvent({ ...event, workspaceId: "ws_1" })).duplicate).toBe(true)
  })
})
