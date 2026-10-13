import { describe, expect, it, vi } from "vitest"

import {
  applyBotStatus,
  applyVexaSnapshot,
  mapVexaStatus,
  runBotSideEffects,
} from "@/lib/bot/lifecycle"
import { createMemoryBotSessionStore } from "@/lib/bot/store-memory"
import type { BotSession } from "@/lib/bot/types"

/** M7 B2: the Vexa → MeetSum status mapping table and the shared snapshot apply. */

describe("mapVexaStatus", () => {
  it.each(["requested", "joining", "awaiting_admission", "needs_help", "active", "stopping"])(
    "maps %s one-to-one",
    (status) => {
      expect(mapVexaStatus(status, { wasActive: false })).toEqual({ status, reason: null })
    }
  )

  it.each(["idle", "scheduled", "", "something_new"])("ignores %s", (status) => {
    expect(mapVexaStatus(status, { wasActive: false })).toBeUndefined()
  })

  it.each([
    ["never admitted outcome", { provenance: { botOutcome: "never_admitted" }, wasActive: true }, { status: "blocked", reason: "not_admitted" }],
    ["completed without reaching active", { wasActive: false }, { status: "blocked", reason: "not_admitted" }],
    ["evicted before active", { reason: "evicted", wasActive: false }, { status: "blocked", reason: "removed_by_host" }],
    ["evicted after active", { reason: "evicted", wasActive: true }, { status: "completed", reason: "removed_by_host" }],
    ["left alone", { reason: "left_alone", wasActive: true }, { status: "completed", reason: "left_alone" }],
    ["served", { provenance: { botOutcome: "served" }, wasActive: true }, { status: "completed", reason: null }],
    ["user stop before joining", { wasActive: false, stoppedByUser: true }, { status: "cancelled", reason: "user_stopped" }],
  ] as const)("completed: %s", (_label, context, expected) => {
    expect(mapVexaStatus("completed", context)).toEqual(expected)
  })

  it.each([
    ["zoom_requires_rtms", { status: "blocked", reason: "platform_blocked" }],
    ["auth_session_missing", { status: "blocked", reason: "bot_signed_out" }],
    ["admission_denied", { status: "blocked", reason: "not_admitted" }],
    ["awaiting_admission_timeout", { status: "blocked", reason: "not_admitted" }],
  ] as const)("failed: %s", (reason, expected) => {
    expect(mapVexaStatus("failed", { reason, wasActive: false })).toEqual(expected)
  })

  it("redacts unknown failure reasons", () => {
    const mapped = mapVexaStatus("failed", {
      reason: "crash at https://zoom.us/j/1?pwd=SECRET token=abc",
      wasActive: true,
    })

    expect(mapped?.status).toBe("failed")
    expect(mapped?.reason).toBe("unknown")
    expect(mapped?.error).not.toContain("SECRET")
    expect(mapped?.error).not.toContain("abc")
  })
})

const session = (overrides: Partial<BotSession> = {}) =>
  ({
    status: "active",
    joinedAt: "2026-10-13T10:00:00Z",
    recordingEnabled: true,
    consentStatus: "pending",
    ...overrides,
  }) as BotSession

describe("applyBotStatus", () => {
  it("asks for consent on active and finalize on completed with recording", () => {
    expect(applyBotStatus(session({ status: "joining", joinedAt: null }), { status: "active", reason: null }).sideEffects)
      .toEqual(["notify", "enqueue_consent"])
    expect(applyBotStatus(session(), { status: "completed", reason: null }).sideEffects).toEqual([
      "notify",
      "enqueue_finalize",
    ])
  })

  it("never finalizes blocked, failed or recording-disabled sessions", () => {
    expect(applyBotStatus(session(), { status: "blocked", reason: "not_admitted" }).sideEffects).toEqual(["notify"])
    expect(applyBotStatus(session(), { status: "failed", reason: "unknown", error: "x" }).patch).toEqual({ error: "x" })
    expect(
      applyBotStatus(session({ recordingEnabled: false }), { status: "completed", reason: null }).sideEffects
    ).toEqual(["notify"])
  })
})

describe("applyVexaSnapshot", () => {
  async function seeded() {
    const store = createMemoryBotSessionStore()
    const created = await store.create({
      workspaceId: "ws_1",
      origin: "manual",
      platform: "google_meet",
      nativeMeetingId: "abc-defg-hij",
      botName: "MeetSum Notetaker",
      status: "requested",
    })

    return { store, created }
  }

  it("walks the happy path and finalizes once completed", async () => {
    const { store, created } = await seeded()
    let current = created

    for (const status of ["joining", "awaiting_admission", "active"]) {
      current = (await applyVexaSnapshot(store, current, { id: "4242", status }, "webhook")).session
    }

    expect(current.status).toBe("active")
    expect(current.joinedAt).not.toBeNull()
    expect(current.vexaMeetingId).toBe("4242")

    const done = await applyVexaSnapshot(store, current, { id: "4242", status: "completed" }, "webhook")

    expect(done).toMatchObject({ applied: true, sideEffects: ["notify", "enqueue_finalize"] })
    expect(done.session.leftAt).not.toBeNull()
  })

  it("records a late joining after active as not applied", async () => {
    const { store, created } = await seeded()
    const active = (await applyVexaSnapshot(store, created, { id: "4242", status: "active" }, "webhook")).session
    const late = await applyVexaSnapshot(store, active, { id: "4242", status: "joining" }, "poll")

    expect(late.applied).toBe(false)
    expect(late.session.status).toBe("active")
    expect(store.events.at(-1)).toMatchObject({ applied: false, source: "poll" })
  })

  it("blocks a never-admitted bot without finalize", async () => {
    const { store, created } = await seeded()
    const result = await applyVexaSnapshot(
      store,
      created,
      { id: "4242", status: "completed", serviceProvenance: { botOutcome: "never_admitted" } },
      "webhook"
    )

    expect(result.session).toMatchObject({ status: "blocked", statusReason: "not_admitted" })
    expect(result.sideEffects).toEqual(["notify"])
  })
})

describe("runBotSideEffects", () => {
  it("enqueues consent and finalize with idempotent job ids", async () => {
    const enqueue = vi.fn(async () => undefined)

    await runBotSideEffects({ id: "bot_1", workspaceId: "ws_1" }, ["notify", "enqueue_consent", "enqueue_finalize"], {
      enqueue,
      finalizeAttempts: 8,
    })

    expect(enqueue).toHaveBeenCalledWith(
      "bot.consent",
      { sessionId: "bot_1", workspaceId: "ws_1" },
      { jobId: "bot.consent:bot_1" }
    )
    expect(enqueue).toHaveBeenCalledWith(
      "bot.finalize",
      { sessionId: "bot_1", workspaceId: "ws_1" },
      { jobId: "bot.finalize:bot_1", attempts: 8 }
    )
  })
})
