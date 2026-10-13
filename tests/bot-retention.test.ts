import { describe, expect, it, vi } from "vitest"

import { runBotRetention } from "@/lib/bot/retention"
import { createMemoryBotSessionStore } from "@/lib/bot/store-memory"
import type { BotSessionRecord } from "@/lib/bot/types"
import { VexaError, type BotProvider } from "@/lib/bot/vexa/types"

/** M7 B6: purge Vexa artifacts after the retention window; prune event payloads. */

const NOW = new Date("2026-10-20T00:00:00Z")
const OLD = "2026-10-10T00:00:00.000Z"

async function seed() {
  const store = createMemoryBotSessionStore()
  const make = async (workspaceId: string, vexaMeetingId: string, patch: Partial<BotSessionRecord>) => {
    const session = await store.create({
      workspaceId,
      origin: "manual",
      platform: "google_meet",
      nativeMeetingId: `n-${vexaMeetingId}`,
      botName: "MeetSum Notetaker",
    })

    store.sessions.set(session.id, { ...session, vexaMeetingId, updatedAt: OLD, ...patch })
    return session.id
  }

  return {
    store,
    ids: {
      imported: await make("ws_1", "v_imported", { status: "completed", recordingStatus: "imported" }),
      blocked: await make("ws_2", "v_blocked", { status: "blocked" }),
      conflict: await make("ws_1", "v_conflict", { status: "completed", recordingStatus: "imported" }),
      gone: await make("ws_2", "v_gone", { status: "failed", recordingStatus: "missing" }),
      fresh: await make("ws_1", "v_fresh", {
        status: "completed",
        recordingStatus: "imported",
        updatedAt: "2026-10-19T12:00:00.000Z",
      }),
      awaitingFinalize: await make("ws_1", "v_wait", { status: "completed", recordingStatus: "none" }),
      live: await make("ws_1", "v_live", { status: "active" }),
    },
  }
}

describe("runBotRetention", () => {
  it("purges eligible sessions, treats 404 as purged and skips 409", async () => {
    const { store, ids } = await seed()
    const deleteMeeting = vi.fn(async (id: string) => {
      if (id === "v_conflict") throw new VexaError("conflict", "bot still in meeting", { status: 409 })
      if (id === "v_gone") throw new VexaError("not_found", "gone", { status: 404 })
    })
    const result = await runBotRetention({
      provider: { deleteMeeting } as unknown as BotProvider,
      store,
      now: NOW,
      retentionHours: 72,
    })

    expect(deleteMeeting.mock.calls.map((call) => call[0]).sort()).toEqual([
      "v_blocked",
      "v_conflict",
      "v_gone",
      "v_imported",
    ])
    expect(result).toMatchObject({ purged: 3, skipped: 1 })

    const purgedAt = (id: string) => store.sessions.get(id)?.vexaPurgedAt

    expect(purgedAt(ids.imported)).toBe(NOW.toISOString())
    expect(purgedAt(ids.blocked)).toBe(NOW.toISOString())
    expect(purgedAt(ids.gone)).toBe(NOW.toISOString())
    expect(purgedAt(ids.conflict)).toBeNull()
    expect(purgedAt(ids.fresh)).toBeNull()
    expect(purgedAt(ids.awaitingFinalize)).toBeNull()
    expect(purgedAt(ids.live)).toBeNull()
  })

  it("prunes bot_events payloads older than 30 days", async () => {
    const store = createMemoryBotSessionStore()

    await store.recordEvent({
      workspaceId: "ws_1",
      source: "webhook",
      eventType: "meeting.completed",
      payload: { a: 1 },
      receivedAt: "2026-09-01T00:00:00.000Z",
    })
    await store.recordEvent({
      workspaceId: "ws_1",
      source: "webhook",
      eventType: "meeting.status_change",
      payload: { b: 2 },
      receivedAt: "2026-10-19T00:00:00.000Z",
    })

    const result = await runBotRetention({
      provider: { deleteMeeting: vi.fn() } as unknown as BotProvider,
      store,
      now: NOW,
    })

    expect(result.prunedEvents).toBe(1)
    expect(store.events.map((event) => event.payload)).toEqual([{}, { b: 2 }])
  })

  it("clears passcodes left on terminal sessions (rows that ended before the transition cleared them)", async () => {
    const store = createMemoryBotSessionStore()
    const make = async (status: BotSessionRecord["status"], nativeMeetingId: string) => {
      const session = await store.create({
        workspaceId: "ws_1",
        origin: "manual",
        platform: "zoom",
        nativeMeetingId,
        botName: "MeetSum Notetaker",
      })

      store.sessions.set(session.id, { ...session, status, passcodeEnc: "sealed", updatedAt: OLD })
      return session.id
    }
    const ended = await make("completed", "111")
    const cancelled = await make("cancelled", "222")
    const scheduled = await make("scheduled", "333")
    const live = await make("active", "444")

    const result = await runBotRetention({
      provider: { deleteMeeting: vi.fn() } as unknown as BotProvider,
      store,
      now: NOW,
    })

    expect(result.passcodesCleared).toBe(2)
    expect(store.sessions.get(ended)?.passcodeEnc).toBeNull()
    expect(store.sessions.get(cancelled)?.passcodeEnc).toBeNull()
    expect(store.sessions.get(scheduled)?.passcodeEnc).toBe("sealed")
    expect(store.sessions.get(live)?.passcodeEnc).toBe("sealed")
  })
})

describe("passcodes end with the session", () => {
  it("a transition to a terminal status nulls passcode_enc; a live one keeps it", async () => {
    const store = createMemoryBotSessionStore()
    const session = await store.create({
      workspaceId: "ws_1",
      origin: "manual",
      platform: "zoom",
      nativeMeetingId: "555",
      passcodeEnc: "sealed",
      botName: "MeetSum Notetaker",
      status: "requested",
    })
    const at = new Date("2026-10-14T09:00:00.000Z")

    await store.transition(session.id, { status: "active", at, source: "webhook", workspaceId: "ws_1" })
    expect((await store.get(session.id, { workspaceId: "ws_1" }))?.passcodeEnc).toBe("sealed")

    await store.transition(session.id, { status: "completed", at, source: "webhook", workspaceId: "ws_1" })
    expect((await store.get(session.id, { workspaceId: "ws_1" }))?.passcodeEnc).toBeNull()
  })
})
