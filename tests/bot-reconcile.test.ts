import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { type ReconcileDeps, runBotReconcile } from "@/lib/bot/reconcile"
import { createMemoryBotSessionStore } from "@/lib/bot/store-memory"
import type { BotSessionCreateInput } from "@/lib/bot/store"
import { VexaError, type VexaMeeting } from "@/lib/bot/vexa/types"

import { fakeProvider } from "./fixtures/vexa/api/fakes"
import { fakeQueue, testBotConfig } from "./fixtures/vexa/api/harness"

const NOW = new Date("2026-10-14T10:00:00.000Z")
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000)

function input(overrides: Partial<BotSessionCreateInput> = {}): BotSessionCreateInput {
  return {
    workspaceId: "ws_a",
    meetingId: "meet_1",
    origin: "manual",
    platform: "google_meet",
    nativeMeetingId: `abc-defg-${Math.random().toString(36).slice(2, 5)}`,
    botName: "MeetSum Notetaker",
    ...overrides,
  }
}

function setup(provider = fakeProvider()) {
  let clock = minutesAgo(60)
  const store = createMemoryBotSessionStore({ now: () => clock })
  const queue = fakeQueue()
  const applySnapshot = vi.fn<ReconcileDeps["applySnapshot"]>(async (s, session, meeting) => {
    const result = await s.transition(session.id, {
      status: meeting.status === "completed" ? "completed" : "active",
      at: NOW,
      source: "poll",
      workspaceId: session.workspaceId,
    })

    return {
      applied: result?.applied ?? false,
      session: result!.session,
      sideEffects: meeting.status === "completed" ? ["enqueue_finalize" as const] : ["enqueue_consent" as const],
    }
  })
  const deps: Partial<ReconcileDeps> = {
    store,
    provider: () => provider,
    queue: queue.port,
    config: testBotConfig(),
    now: () => NOW,
    applySnapshot,
    resyncRules: vi.fn(async () => undefined),
    dispatchNow: vi.fn(async () => undefined),
  }

  return {
    store,
    provider,
    queue,
    deps,
    applySnapshot,
    at: (date: Date) => {
      clock = date
    },
  }
}

/** Creates a session and moves it to `status` with last_event_at = `when`. */
async function sessionAt(ctx: ReturnType<typeof setup>, overrides: Partial<BotSessionCreateInput>, when: Date) {
  ctx.at(when)

  const { status, ...rest } = overrides
  const created = await ctx.store.create(input(rest))

  if (status && status !== "scheduled") {
    await ctx.store.transition(created.id, { status, at: when, source: "webhook", workspaceId: created.workspaceId })
  }
  return created
}

const meeting = (status: string): VexaMeeting => ({
  id: "4242",
  platform: "google_meet",
  nativeMeetingId: "abc-defg-hij",
  status,
  recordings: [],
  raw: {},
})

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("runBotReconcile", () => {
  it("(a) dispatches due sessions that lost their delayed job", async () => {
    const ctx = setup()
    const due = await sessionAt(ctx, { dispatchAt: minutesAgo(1).toISOString() }, minutesAgo(30))
    const queued = await sessionAt(ctx, { dispatchAt: minutesAgo(1).toISOString() }, minutesAgo(30))

    await sessionAt(ctx, { dispatchAt: new Date(NOW.getTime() + 60_000).toISOString() }, minutesAgo(30))
    await ctx.queue.port.enqueue("bot.dispatch", { sessionId: queued.id, rev: 0, workspaceId: "ws_a" }, {
      jobId: `bot.dispatch:${queued.id}:0`,
    })

    const stats = await runBotReconcile({}, ctx.deps)

    expect(stats.dispatched).toBe(1)
    expect(ctx.deps.dispatchNow).toHaveBeenCalledWith(due.id, "ws_a")
  })

  it("(b) polls stale sessions and applies the snapshot with side effects", async () => {
    const provider = fakeProvider({ getMeeting: vi.fn(async () => meeting("completed")) })
    const ctx = setup(provider)
    const stale = await sessionAt(ctx, { status: "active" }, minutesAgo(11))
    const fresh = await sessionAt(ctx, { status: "active" }, minutesAgo(2))

    await ctx.store.update(stale.id, { vexaMeetingId: "4242" }, { workspaceId: "ws_a" })
    await ctx.store.update(fresh.id, { vexaMeetingId: "4343" }, { workspaceId: "ws_a" })

    const stats = await runBotReconcile({}, ctx.deps)

    expect(stats.polled).toBe(1)
    expect(provider.getMeeting).toHaveBeenCalledWith("4242")
    expect(ctx.applySnapshot).toHaveBeenCalledWith(ctx.store, expect.objectContaining({ id: stale.id }), meeting("completed"), "poll", { at: NOW })
    expect(ctx.queue.jobs).toContainEqual(
      expect.objectContaining({ name: "bot.finalize", id: `bot.finalize-${stale.id}`, payload: { sessionId: stale.id, workspaceId: "ws_a" } })
    )
  })

  it("(b) a 404 from Vexa fails the session as stale", async () => {
    const provider = fakeProvider({
      getMeeting: vi.fn(async () => {
        throw new VexaError("not_found", "Vexa GET /meetings/4242 → 404", { status: 404 })
      }),
    })
    const ctx = setup(provider)
    const session = await sessionAt(ctx, { status: "joining" }, minutesAgo(30))

    await ctx.store.update(session.id, { vexaMeetingId: "4242" }, { workspaceId: "ws_a" })
    expect((await runBotReconcile({}, ctx.deps)).stale).toBe(1)
    expect(await ctx.store.get(session.id, { workspaceId: "ws_a" })).toMatchObject({ status: "failed", statusReason: "stale" })
  })

  it("(b) `requested` for 10+ minutes without a Vexa id → failed/vexa_unavailable", async () => {
    const ctx = setup()
    const old = await sessionAt(ctx, { status: "requested" }, minutesAgo(12))
    const recent = await sessionAt(ctx, { status: "requested" }, minutesAgo(5))

    await ctx.store.update(old.id, { requestedAt: minutesAgo(12).toISOString() }, { workspaceId: "ws_a" })
    await ctx.store.update(recent.id, { requestedAt: minutesAgo(5).toISOString() }, { workspaceId: "ws_a" })

    expect((await runBotReconcile({}, ctx.deps)).unavailable).toBe(1)
    expect(await ctx.store.get(old.id, { workspaceId: "ws_a" })).toMatchObject({ status: "failed", statusReason: "vexa_unavailable" })
    expect((await ctx.store.get(recent.id, { workspaceId: "ws_a" }))?.status).toBe("requested")
  })

  it("(c) awaiting admission past the timeout → stopBot → blocked/not_admitted", async () => {
    const ctx = setup()
    const waiting = await sessionAt(ctx, { status: "awaiting_admission" }, minutesAgo(16))
    const recent = await sessionAt(ctx, { status: "awaiting_admission" }, minutesAgo(5))

    await ctx.store.update(waiting.id, { vexaMeetingId: "4242" }, { workspaceId: "ws_a" })

    const stats = await runBotReconcile({}, ctx.deps)

    expect(stats.notAdmitted).toBe(1)
    expect(ctx.provider.stopBot).toHaveBeenCalledWith("google_meet", waiting.nativeMeetingId)
    expect(await ctx.store.get(waiting.id, { workspaceId: "ws_a" })).toMatchObject({ status: "blocked", statusReason: "not_admitted" })
    expect((await ctx.store.get(recent.id, { workspaceId: "ws_a" }))?.status).toBe("awaiting_admission")
  })

  it("(d) live sessions whose meeting was deleted are stopped", async () => {
    const ctx = setup()
    const orphan = await sessionAt(ctx, { status: "active", meetingId: null }, minutesAgo(1))

    expect((await runBotReconcile({}, ctx.deps)).meetingDeleted).toBe(1)
    expect(ctx.provider.stopBot).toHaveBeenCalledTimes(1)
    expect(await ctx.store.get(orphan.id, { workspaceId: "ws_a" })).toMatchObject({ status: "stopping", statusReason: "meeting_deleted" })

    // Next tick: already stopping, no second stop.
    await runBotReconcile({}, ctx.deps)
    expect(ctx.provider.stopBot).toHaveBeenCalledTimes(1)
  })

  it("(e) completed sessions without a recording import get finalize enqueued", async () => {
    const ctx = setup()
    const completed = await sessionAt(ctx, { status: "active" }, minutesAgo(40))

    await ctx.store.transition(completed.id, { status: "completed", at: minutesAgo(30), source: "webhook", workspaceId: "ws_a" })

    const imported = await sessionAt(ctx, { status: "active" }, minutesAgo(40))

    await ctx.store.transition(imported.id, { status: "completed", at: minutesAgo(30), source: "webhook", workspaceId: "ws_a" })
    await ctx.store.update(imported.id, { recordingStatus: "imported" }, { workspaceId: "ws_a" })

    const neverJoined = await sessionAt(ctx, { status: "requested" }, minutesAgo(40))

    await ctx.store.transition(neverJoined.id, { status: "completed", at: minutesAgo(30), source: "webhook", workspaceId: "ws_a" })

    expect((await runBotReconcile({}, ctx.deps)).finalizeEnqueued).toBe(1)
    expect(ctx.queue.jobs.filter((job) => job.name === "bot.finalize").map((job) => job.payload)).toEqual([
      { sessionId: completed.id, workspaceId: "ws_a" },
    ])
  })

  it("(e) sweeps every workspace and keys each finalize to the session's own workspace", async () => {
    const ctx = setup()
    const w1 = await sessionAt(ctx, { status: "active", nativeMeetingId: "aaa-aaaa-aaa", calendarEventId: "cal_w1" }, minutesAgo(40))
    const w2 = await sessionAt(
      ctx,
      { status: "active", workspaceId: "ws_b", nativeMeetingId: "bbb-bbbb-bbb", calendarEventId: "cal_w2" },
      minutesAgo(40)
    )

    await ctx.store.transition(w1.id, { status: "completed", at: minutesAgo(30), source: "webhook", workspaceId: "ws_a" })
    await ctx.store.transition(w2.id, { status: "completed", at: minutesAgo(30), source: "webhook", workspaceId: "ws_b" })

    expect((await runBotReconcile({}, ctx.deps)).finalizeEnqueued).toBe(2)
    expect(
      ctx.queue.jobs
        .filter((job) => job.name === "bot.finalize")
        .map((job) => job.payload)
        .sort((a, b) => String((a as { workspaceId: string }).workspaceId).localeCompare(String((b as { workspaceId: string }).workspaceId)))
    ).toEqual([
      { sessionId: w1.id, workspaceId: "ws_a" },
      { sessionId: w2.id, workspaceId: "ws_b" },
    ])
  })

  it("(f) resyncRules re-evaluates one workspace only", async () => {
    const ctx = setup()
    const stats = await runBotReconcile({ workspaceId: "ws_a", resyncRules: true }, ctx.deps)

    expect(stats.resynced).toBe(true)
    expect(ctx.deps.resyncRules).toHaveBeenCalledWith("ws_a")
    expect(ctx.deps.dispatchNow).not.toHaveBeenCalled()
  })

  it("one failing session does not stop the tick; errors are redacted", async () => {
    const provider = fakeProvider({
      getMeeting: vi.fn(async () => {
        throw new VexaError("unavailable", "https://vexa/x?token=abc123 down")
      }),
    })
    const ctx = setup(provider)
    const broken = await sessionAt(ctx, { status: "active" }, minutesAgo(30))
    const orphan = await sessionAt(ctx, { status: "active", meetingId: null }, minutesAgo(30))

    await ctx.store.update(broken.id, { vexaMeetingId: "4242" }, { workspaceId: "ws_a" })

    const stats = await runBotReconcile({}, ctx.deps)

    expect(stats.errors).toHaveLength(1)
    expect(stats.errors[0]).not.toContain("abc123")
    expect((await ctx.store.get(orphan.id, { workspaceId: "ws_a" }))?.status).toBe("stopping")
  })
})

describe("side effects", () => {
  it("polled snapshots enqueue consent/finalize once, through the lifecycle helper", async () => {
    const provider = fakeProvider({ getMeeting: vi.fn(async () => meeting("active")) })
    const ctx = setup(provider)
    const session = await sessionAt(ctx, { status: "joining" }, minutesAgo(20))

    await ctx.store.update(session.id, { vexaMeetingId: "4242" }, { workspaceId: "ws_a" })
    await runBotReconcile({}, ctx.deps)
    await runBotReconcile({}, ctx.deps)

    expect(ctx.queue.jobs.map((job) => [job.name, job.id, job.payload])).toEqual([
      ["bot.consent", `bot.consent-${session.id}`, { sessionId: session.id, workspaceId: "ws_a" }],
    ])
  })
})

describe("lobby timeout across real reconcile ticks", () => {
  it.each(["awaiting_admission", "needs_help"] as const)(
    "%s: the stale poll does not reset the timeout; the bot is stopped and blocked/not_admitted",
    async (lobby) => {
      const start = new Date("2026-10-14T09:00:00.000Z")
      let clock = start
      const store = createMemoryBotSessionStore({ now: () => clock })
      const provider = fakeProvider({ getMeeting: vi.fn(async () => meeting(lobby)) })
      const queue = fakeQueue()
      const deps: Partial<ReconcileDeps> = {
        store,
        provider: () => provider,
        queue: queue.port,
        // stale 10 min < lobby timeout 15 min: the poll path runs first.
        config: testBotConfig({
          MEETSUM_BOT_STALE_MINUTES: "10",
          MEETSUM_BOT_AWAITING_ADMISSION_TIMEOUT_MINUTES: "15",
        }),
        now: () => clock,
        resyncRules: vi.fn(async () => undefined),
        dispatchNow: vi.fn(async () => undefined),
      }
      const created = await store.create(input({ status: "requested" }))

      await store.update(created.id, { vexaMeetingId: "4242" }, { workspaceId: "ws_a" })
      await store.transition(created.id, { status: lobby, at: start, source: "webhook", workspaceId: "ws_a" })

      let blockedAt: number | undefined

      for (let minute = 1; minute <= 20 && blockedAt === undefined; minute += 1) {
        clock = new Date(start.getTime() + minute * 60_000)
        await runBotReconcile({}, deps)
        if ((await store.get(created.id, { workspaceId: "ws_a" }))?.status === "blocked") blockedAt = minute
      }

      expect(provider.getMeeting).toHaveBeenCalled()
      expect(blockedAt).toBe(16)
      expect(provider.stopBot).toHaveBeenCalledWith("google_meet", created.nativeMeetingId)
      expect(await store.get(created.id, { workspaceId: "ws_a" })).toMatchObject({
        status: "blocked",
        statusReason: "not_admitted",
      })
    }
  )

  it("an unapplied poll does not bump last_event_at; an applied transition sets status_changed_at", async () => {
    let clock = new Date("2026-10-14T09:00:00.000Z")
    const store = createMemoryBotSessionStore({ now: () => clock })
    const created = await store.create(input({ status: "requested" }))

    await store.transition(created.id, { status: "awaiting_admission", at: clock, source: "webhook", workspaceId: "ws_a" })
    clock = new Date("2026-10-14T09:12:00.000Z")

    const polled = await store.transition(created.id, {
      status: "awaiting_admission",
      at: clock,
      source: "poll",
      workspaceId: "ws_a",
    })

    expect(polled?.applied).toBe(false)
    expect(polled?.session).toMatchObject({
      lastEventAt: "2026-10-14T09:00:00.000Z",
      statusChangedAt: "2026-10-14T09:00:00.000Z",
    })

    const moved = await store.transition(created.id, { status: "needs_help", at: clock, source: "poll", workspaceId: "ws_a" })

    expect(moved?.session).toMatchObject({ status: "needs_help", statusChangedAt: "2026-10-14T09:12:00.000Z" })
  })
})
