import { describe, expect, it } from "vitest"

import { BotSessionConflictError, type BotSessionStore } from "@/lib/bot/store"
import { createMemoryBotSessionStore } from "@/lib/bot/store-memory"
import { createPostgresBotSessionStore } from "@/lib/bot/store-postgres"

/**
 * M7 B1 bot store against a recording Queryable (statement shapes, workspace
 * filters, the transition transaction order, the rank guard, event dedupe,
 * unique-violation mapping) plus the W1/W2 isolation contract on both
 * stores: a session id of another workspace is "not found" and nothing
 * changes.
 */

type Statement = { text: string; values: unknown[] }
type Row = Record<string, unknown>

function sessionRow(overrides: Row = {}): Row {
  return {
    id: "bot_1",
    workspace_id: "ws_1",
    meeting_id: "meet_1",
    origin: "manual",
    platform: "google_meet",
    native_meeting_id: "abc-defg-hij",
    meeting_url_redacted: "https://meet.google.com/abc-defg-hij",
    passcode_enc: null,
    teams_base_host: null,
    vexa_meeting_id: "4242",
    status: "requested",
    status_rank: 1,
    status_reason: null,
    requested_by_user_id: null,
    calendar_event_id: null,
    scheduled_start: null,
    scheduled_end: null,
    dispatch_at: null,
    dispatch_rev: 0,
    bot_name: "MeetSum Notetaker",
    language: "he",
    recording_enabled: true,
    transcribe_enabled: false,
    consent_status: "pending",
    requested_at: null,
    joined_at: null,
    left_at: null,
    last_event_at: null,
    recording_status: "none",
    recording_storage_key: null,
    media_asset_id: null,
    ingest_job_id: null,
    speaker_timeline: null,
    vexa_purged_at: null,
    error: null,
    attempts: 0,
    created_at: new Date("2026-10-13T09:00:00Z"),
    updated_at: new Date("2026-10-13T09:00:00Z"),
    ...overrides,
  }
}

function recordingDb(options: {
  rows?: Row[]
  duplicateEvent?: boolean
  uniqueViolation?: string
  withConnect?: boolean
} = {}) {
  const statements: Statement[] = []
  const rows = options.rows ?? [sessionRow()]
  let released = 0

  async function query(text: string, values: unknown[] = []) {
    const sql = text.replace(/\s+/g, " ").trim()

    statements.push({ text: sql, values })

    if (/^(begin|commit|rollback)$/.test(sql)) return { rows: [] }
    if (sql.startsWith("insert into bot_sessions")) {
      if (options.uniqueViolation) {
        throw Object.assign(new Error("duplicate key"), {
          code: "23505",
          constraint: options.uniqueViolation,
        })
      }
      return { rows: [sessionRow({ id: values[0], workspace_id: values[1], status: values[9] })] }
    }
    if (sql.startsWith("insert into bot_events")) {
      return options.duplicateEvent
        ? { rows: [] }
        : {
            rows: [
              {
                id: values[0],
                bot_session_id: values[1],
                workspace_id: values[2],
                source: values[3],
                vexa_meeting_id: values[4],
                vexa_event_id: values[5],
                event_type: values[6],
                vexa_status: values[7],
                applied: values[8],
                payload: values[9],
                received_at: new Date(),
              },
            ],
          }
    }
    if (sql.startsWith("update bot_events")) return { rows: [] }
    if (/^select \* from bot_sessions where id = \$1 and workspace_id = \$2/.test(sql)) {
      return { rows: rows.filter((row) => row.id === values[0] && row.workspace_id === values[1]) }
    }
    if (sql.startsWith("select * from bot_sessions where vexa_meeting_id = $1")) {
      return { rows: rows.filter((row) => row.vexa_meeting_id === values[0]) }
    }
    if (sql.startsWith("select * from bot_sessions where platform = $1")) {
      return {
        rows: rows.filter(
          (row) => row.platform === values[0] && row.native_meeting_id === values[1]
        ),
      }
    }
    if (sql.startsWith("update bot_sessions set status = $3")) {
      const row = rows.find((item) => item.id === values[0] && item.workspace_id === values[1])

      return { rows: row ? [{ ...row, status: values[2], status_rank: values[3] }] : [] }
    }
    if (sql.startsWith("update bot_sessions")) {
      const row = rows.find((item) => item.id === values[0] && item.workspace_id === values[1])

      return { rows: row ? [row] : [] }
    }
    if (sql.startsWith("select count(*)")) return { rows: [{ count: 3 }] }

    return { rows: [] }
  }

  const db = options.withConnect
    ? {
        query,
        connect: async () => ({ query, release: () => (released += 1) }),
      }
    : { query }

  return { db, statements, released: () => released }
}

describe("postgres bot store (recording queryable)", () => {
  it("scopes get by workspace and refuses an unscoped call", async () => {
    const { db, statements } = recordingDb()
    const store = createPostgresBotSessionStore(db)

    expect((await store.get("bot_1", { workspaceId: "ws_1" }))?.id).toBe("bot_1")
    expect(await store.get("bot_1", { workspaceId: "ws_2" })).toBeUndefined()
    expect(statements[0].text).toBe(
      "select * from bot_sessions where id = $1 and workspace_id = $2"
    )
    expect(statements[1].values).toEqual(["bot_1", "ws_2"])
    await expect(
      store.get("bot_1", undefined as unknown as { workspaceId: string })
    ).rejects.toThrow(/workspaceId is required/)
  })

  it("runs transition as begin, select for update, rank check, update, event insert, commit", async () => {
    const { db, statements, released } = recordingDb({ withConnect: true })
    const store = createPostgresBotSessionStore(db)
    const result = await store.transition("bot_1", {
      status: "active",
      at: "2026-10-13T10:00:00Z",
      source: "webhook",
      workspaceId: "ws_1",
      event: { eventType: "meeting.status_change", vexaStatus: "active" },
    })

    expect(result?.applied).toBe(true)
    expect(result?.session.status).toBe("active")
    expect(statements.map((statement) => statement.text.split(" (")[0].slice(0, 40))).toEqual([
      "begin",
      "select * from bot_sessions where id = $1",
      "update bot_sessions set status = $3, sta",
      "insert into bot_events",
      "commit",
    ])
    expect(statements[1].text).toMatch(/for update$/)
    expect(statements[1].values).toEqual(["bot_1", "ws_1"])
    expect(statements[2].text).toContain("joined_at = case when $3 = 'active'")
    expect(statements[2].text).toContain("where id = $1 and workspace_id = $2")
    expect(statements[3].values[2]).toBe("ws_1")
    expect(statements[3].values[8]).toBe(true)
    expect(released()).toBe(1)
  })

  it("applies the rank guard: a late joining after active only bumps last_event_at", async () => {
    const { db, statements } = recordingDb({ rows: [sessionRow({ status: "active", status_rank: 4 })] })
    const store = createPostgresBotSessionStore(db)
    const result = await store.transition("bot_1", {
      status: "joining",
      at: new Date("2026-10-13T10:05:00Z"),
      source: "webhook",
      workspaceId: "ws_1",
    })

    expect(result?.applied).toBe(false)
    expect(statements.some((statement) => statement.text.startsWith("update bot_sessions set status"))).toBe(false)
    expect(statements.find((statement) => statement.text.startsWith("update bot_sessions"))?.text).toContain(
      "set last_event_at = $3"
    )
    expect(statements.find((statement) => statement.text.startsWith("insert into bot_events"))?.values[8]).toBe(false)
  })

  it("marks an already-recorded webhook event applied within the workspace", async () => {
    const { db, statements } = recordingDb()
    const store = createPostgresBotSessionStore(db)

    await store.transition("bot_1", {
      status: "joining",
      at: new Date(),
      source: "webhook",
      workspaceId: "ws_1",
      event: { eventId: "botevt_1" },
    })

    const mark = statements.find((statement) => statement.text.startsWith("update bot_events"))

    expect(mark?.text).toContain("where id = $1 and workspace_id = $2")
    expect(mark?.values).toEqual(["botevt_1", "ws_1", true, "bot_1"])
  })

  it("dedupes events through on conflict do nothing", async () => {
    const { db, statements } = recordingDb({ duplicateEvent: true })
    const store = createPostgresBotSessionStore(db)
    const result = await store.recordEvent({
      workspaceId: "ws_1",
      source: "webhook",
      vexaMeetingId: "4242",
      eventType: "meeting.status_change",
      vexaStatus: "active",
    })

    expect(result).toEqual({ duplicate: true })
    expect(statements[0].text).toContain("on conflict do nothing returning *")
  })

  it("maps workspace-scoped unique violations to BotSessionConflictError", async () => {
    const { db } = recordingDb({ uniqueViolation: "uq_bot_sessions_ws_live_target" })
    const store = createPostgresBotSessionStore(db)
    const error = await store
      .create({
        workspaceId: "ws_1",
        origin: "manual",
        platform: "google_meet",
        nativeMeetingId: "abc-defg-hij",
        botName: "MeetSum Notetaker",
      })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(BotSessionConflictError)
    expect((error as BotSessionConflictError).constraint).toBe("uq_bot_sessions_ws_live_target")
  })

  it("scopes update by workspace and the expected dispatch rev", async () => {
    const { db, statements } = recordingDb()
    const store = createPostgresBotSessionStore(db)

    await store.update(
      "bot_1",
      { status: "scheduled", dispatchRev: 2, speakerTimeline: [{ name: "Dana", startMs: 0, endMs: 1 }] },
      { workspaceId: "ws_1", expectedRev: 1 }
    )

    const update = statements[0]

    expect(update.text).toMatch(/where id = \$1 and workspace_id = \$2 and dispatch_rev = \$\d+ returning \*$/)
    expect(update.text).toContain("status_rank = $")
    expect(update.text).toContain("speaker_timeline = $")
    expect(update.values.slice(0, 2)).toEqual(["bot_1", "ws_1"])
    expect(update.values.at(-1)).toBe(1)
  })

  it("filters every workspace read by workspace_id", async () => {
    const { db, statements } = recordingDb()
    const store = createPostgresBotSessionStore(db)

    await store.findByCalendarEvent("ws_1", "gcal_1")
    await store.listForMeeting("ws_1", "meet_1")
    await store.listActive("ws_1", { meetingIds: ["meet_1"], since: new Date() })
    await store.countLive({ workspaceId: "ws_1" })
    await store.countCreatedSince("ws_1", new Date())

    for (const statement of statements) {
      expect(statement.text).toContain("workspace_id = $1")
      expect(statement.values[0]).toBe("ws_1")
    }
  })

  it("resolves webhooks only from stored rows and never guesses between workspaces", async () => {
    const { db } = recordingDb({
      rows: [
        sessionRow({ id: "bot_1", workspace_id: "ws_1", vexa_meeting_id: null }),
        sessionRow({ id: "bot_2", workspace_id: "ws_2", vexa_meeting_id: "77" }),
      ],
    })
    const store = createPostgresBotSessionStore(db)

    expect((await store.getForWebhook({ vexaMeetingId: "77" }))?.workspaceId).toBe("ws_2")
    expect(
      await store.getForWebhook({ platform: "google_meet", nativeMeetingId: "abc-defg-hij" })
    ).toBeUndefined()
    expect(await store.getForWebhook({ vexaMeetingId: "nope" })).toBeUndefined()
  })
})

async function seedTwoWorkspaces(store: BotSessionStore) {
  const base = {
    origin: "manual" as const,
    platform: "google_meet" as const,
    nativeMeetingId: "abc-defg-hij",
    botName: "MeetSum Notetaker",
  }
  const w1 = await store.create({ ...base, workspaceId: "ws_1", status: "requested" })
  const w2 = await store.create({ ...base, workspaceId: "ws_2", status: "requested" })

  return { w1, w2 }
}

describe("memory bot store workspace isolation (W1/W2)", () => {
  it("treats a W2 session id under W1 as not found and changes nothing", async () => {
    const store = createMemoryBotSessionStore()
    const { w2 } = await seedTwoWorkspaces(store)
    const before = structuredClone(store.sessions.get(w2.id))
    const eventsBefore = store.events.length
    const W1 = { workspaceId: "ws_1" }

    expect(await store.get(w2.id, W1)).toBeUndefined()
    expect(await store.withTransaction((tx) => store.getForUpdate(w2.id, tx, W1))).toBeUndefined()
    expect(await store.update(w2.id, { botName: "pwned", vexaMeetingId: "x" }, W1)).toBeUndefined()
    expect(
      await store.transition(w2.id, {
        status: "cancelled",
        reason: "user_opt_out",
        at: new Date(),
        source: "api",
        workspaceId: "ws_1",
      })
    ).toBeUndefined()
    expect(await store.listForMeeting("ws_1", "meet_x")).toEqual([])
    expect(store.sessions.get(w2.id)).toEqual(before)
    expect(store.events.length).toBe(eventsBefore)
  })

  it("requires a workspace on every per-session call", async () => {
    const store = createMemoryBotSessionStore()
    const { w1 } = await seedTwoWorkspaces(store)

    await expect(store.get(w1.id, {} as { workspaceId: string })).rejects.toThrow(/workspaceId/)
    await expect(
      store.update(w1.id, { botName: "x" }, {} as { workspaceId: string })
    ).rejects.toThrow(/workspaceId/)
  })

  it("resolves webhook lookups to the row's own workspace", async () => {
    const store = createMemoryBotSessionStore()
    const { w1, w2 } = await seedTwoWorkspaces(store)

    await store.update(w2.id, { vexaMeetingId: "v2" }, { workspaceId: "ws_2" })

    expect((await store.getForWebhook({ vexaMeetingId: "v2" }))?.workspaceId).toBe("ws_2")
    // Both workspaces have an open session for the target: ambiguous -> none.
    expect(
      await store.getForWebhook({ platform: "google_meet", nativeMeetingId: "abc-defg-hij" })
    ).toBeUndefined()

    await store.transition(w2.id, {
      status: "failed",
      at: new Date(),
      source: "poll",
      workspaceId: "ws_2",
    })

    expect(
      (await store.getForWebhook({ platform: "google_meet", nativeMeetingId: "abc-defg-hij" }))?.id
    ).toBe(w1.id)
  })

  it("serializes withTransaction callbacks", async () => {
    const store = createMemoryBotSessionStore()
    const order: string[] = []

    await Promise.all([
      store.withTransaction(async () => {
        order.push("a:start")
        await new Promise((resolve) => setTimeout(resolve, 5))
        order.push("a:end")
      }),
      store.withTransaction(async () => {
        order.push("b:start")
        order.push("b:end")
      }),
    ])

    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"])
  })
})
