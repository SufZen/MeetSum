import { UnrecoverableError } from "bullmq"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  dispatchNow,
  type DispatchDeps,
  openMeetingSecrets,
  runDispatch,
  scheduleDispatch,
  sealMeetingSecrets,
} from "@/lib/bot/dispatch"
import { parseMeetingLink } from "@/lib/bot/meeting-url"
import { createMemoryBotSessionStore } from "@/lib/bot/store-memory"
import type { BotSessionCreateInput } from "@/lib/bot/store"
import { createVexaClient } from "@/lib/bot/vexa/client"
import { VexaError } from "@/lib/bot/vexa/types"

import { fakeFetch, fakeProvider, json, loadVexaFixture } from "./fixtures/vexa/api/fakes"
import { fakeQueue, type QueuedJob, testBotConfig } from "./fixtures/vexa/api/harness"

const START = new Date("2026-10-14T09:00:00.000Z")
const END = new Date("2026-10-14T10:00:00.000Z")
const postBodies = loadVexaFixture<Record<string, Record<string, unknown>>>("post-bots.json")

function setup(options: { provider?: ReturnType<typeof fakeProvider>; env?: Record<string, string> } = {}) {
  const store = createMemoryBotSessionStore()
  const provider = options.provider ?? fakeProvider({ requestBot: vi.fn(async () => ({ vexaMeetingId: "4242", status: "requested", raw: {} })) })
  let deps: Partial<DispatchDeps> = {}
  const queue = fakeQueue((job: QueuedJob) => {
    if (job.name !== "bot.dispatch") return undefined
    return runDispatch(job.payload as { sessionId: string; rev: number; workspaceId: string }, deps)
  })

  deps = { store, provider: () => provider, queue: queue.port, config: testBotConfig(options.env) }
  return { store, provider, queue, deps }
}

function sessionInput(overrides: Partial<BotSessionCreateInput> = {}): BotSessionCreateInput {
  const link = parseMeetingLink("https://meet.google.com/abc-defg-hij")!

  return {
    workspaceId: "ws_a",
    meetingId: "meet_1",
    origin: "calendar_rule",
    platform: link.platform,
    nativeMeetingId: link.nativeMeetingId,
    meetingUrlRedacted: link.redactedUrl,
    calendarEventId: "cal_1",
    scheduledStart: START.toISOString(),
    scheduledEnd: END.toISOString(),
    dispatchAt: new Date(START.getTime() - 60_000).toISOString(),
    botName: "MeetSum Notetaker",
    language: "he",
    ...overrides,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubEnv("MEETSUM_SESSION_SECRET", "test-session-secret-0123456789")
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe("scheduleDispatch", () => {
  it("fires at dispatch_at = start - 60s", async () => {
    vi.setSystemTime(new Date("2026-10-14T08:00:00.000Z"))

    const { store, provider, queue, deps } = setup()
    const session = await store.create(sessionInput())

    await scheduleDispatch(session, deps)

    expect(queue.jobs[0]).toMatchObject({
      name: "bot.dispatch",
      id: `bot.dispatch-${session.id}-0`,
      payload: { sessionId: session.id, rev: 0, workspaceId: "ws_a" },
      options: { delay: 59 * 60_000 },
    })

    await vi.advanceTimersByTimeAsync(59 * 60_000 - 1)
    expect(provider.requestBot).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(provider.requestBot).toHaveBeenCalledTimes(1)

    const after = await store.get(session.id, { workspaceId: "ws_a" })

    expect(after).toMatchObject({ status: "requested", vexaMeetingId: "4242", attempts: 1 })
    expect(after?.requestedAt).toBe("2026-10-14T08:59:00.000Z")
  })

  it("an event created 5 minutes before start dispatches immediately", async () => {
    vi.setSystemTime(new Date("2026-10-14T08:55:00.000Z"))

    const { store, provider, deps } = setup()
    const session = await store.create(sessionInput({ dispatchAt: "2026-10-14T08:55:00.000Z" }))

    await scheduleDispatch(session, deps)
    await vi.advanceTimersByTimeAsync(0)
    expect(provider.requestBot).toHaveBeenCalledTimes(1)
  })
})

describe("runDispatch", () => {
  beforeEach(() => {
    vi.setSystemTime(new Date("2026-10-14T08:59:00.000Z"))
  })

  it("a stale rev is a no-op", async () => {
    const { store, provider, deps } = setup()
    const session = await store.create(sessionInput())

    await store.update(session.id, { dispatchRev: 1 }, { workspaceId: "ws_a" })
    expect((await runDispatch({ sessionId: session.id, rev: 0, workspaceId: "ws_a" }, deps)).outcome).toBe("skipped")
    expect(provider.requestBot).not.toHaveBeenCalled()
  })

  it("refuses another workspace's session as unrecoverable", async () => {
    const { store, provider, deps } = setup()
    const session = await store.create(sessionInput())

    await expect(runDispatch({ sessionId: session.id, rev: 0, workspaceId: "ws_b" }, deps)).rejects.toBeInstanceOf(
      UnrecoverableError
    )
    expect(provider.requestBot).not.toHaveBeenCalled()
  })

  it("a missed window cancels", async () => {
    vi.setSystemTime(new Date("2026-10-14T09:31:00.000Z"))

    const { store, provider, deps } = setup()
    const session = await store.create(sessionInput())
    const result = await runDispatch({ sessionId: session.id, rev: 0, workspaceId: "ws_a" }, deps)

    expect(result.session).toMatchObject({ status: "cancelled", statusReason: "missed_window" })
    expect(provider.requestBot).not.toHaveBeenCalled()
  })

  it("a meeting_request whose meeting started an hour ago still dispatches (window runs from the request)", async () => {
    vi.setSystemTime(new Date("2026-10-14T10:00:00.000Z"))

    const { store, provider, deps } = setup()
    const session = await store.create(
      sessionInput({
        origin: "meeting_request",
        calendarEventId: null,
        scheduledStart: "2026-10-14T09:00:00.000Z",
        scheduledEnd: null,
        dispatchAt: "2026-10-14T10:00:00.000Z",
      })
    )
    const result = await runDispatch({ sessionId: session.id, rev: 0, workspaceId: "ws_a" }, deps)

    expect(result).toMatchObject({ outcome: "requested", session: { status: "requested", vexaMeetingId: "4242" } })
    expect(provider.requestBot).toHaveBeenCalledTimes(1)
  })

  it("a manual request ignores a past calendar end; it expires late-join minutes after the request", async () => {
    vi.setSystemTime(new Date("2026-10-14T10:30:00.000Z"))

    const { store, deps } = setup()
    const session = await store.create(
      sessionInput({ origin: "manual", calendarEventId: null, dispatchAt: "2026-10-14T10:30:00.000Z" })
    )

    expect((await runDispatch({ sessionId: session.id, rev: 0, workspaceId: "ws_a" }, deps)).outcome).toBe("requested")

    const late = await store.create(
      sessionInput({ origin: "manual", calendarEventId: null, nativeMeetingId: "qqq-qqqq-qqq" })
    )

    vi.setSystemTime(new Date("2026-10-14T11:01:00.000Z"))
    expect((await runDispatch({ sessionId: late.id, rev: 0, workspaceId: "ws_a" }, deps)).session).toMatchObject({
      status: "cancelled",
      statusReason: "missed_window",
    })
  })

  it("re-delays 60 s when capacity is reached", async () => {
    const { store, provider, queue, deps } = setup({ env: { MEETSUM_BOT_MAX_CONCURRENT: "1" } })

    await store.create(sessionInput({ calendarEventId: "cal_other", nativeMeetingId: "zzz-zzzz-zzz", status: "active" }))

    const session = await store.create(sessionInput())
    const result = await runDispatch({ sessionId: session.id, rev: 0, workspaceId: "ws_a" }, deps)

    expect(result.outcome).toBe("redelayed")
    expect(result.session).toMatchObject({ status: "scheduled", dispatchRev: 1, dispatchAt: "2026-10-14T09:00:00.000Z" })
    expect(queue.jobs.at(-1)).toMatchObject({ id: `bot.dispatch-${session.id}-1`, options: { delay: 60_000 } })
    expect(provider.requestBot).not.toHaveBeenCalled()
  })

  it("per-workspace capacity re-delays too, and fails once the window closes", async () => {
    const { store, deps } = setup({ env: { MEETSUM_BOT_MAX_CONCURRENT_PER_WORKSPACE: "1" } })

    await store.create(sessionInput({ calendarEventId: "cal_other", nativeMeetingId: "zzz-zzzz-zzz", status: "joining" }))

    const session = await store.create(sessionInput())

    vi.setSystemTime(new Date("2026-10-14T09:29:30.000Z"))
    expect(await runDispatch({ sessionId: session.id, rev: 0, workspaceId: "ws_a" }, deps)).toMatchObject({
      outcome: "failed",
      session: { status: "failed", statusReason: "capacity" },
    })
  })

  it("Vexa 403 capacity reverts to scheduled and re-delays", async () => {
    const provider = fakeProvider({
      requestBot: vi.fn(async () => {
        throw new VexaError("capacity", "Vexa POST /bots → 403", { status: 403 })
      }),
    })
    const { store, queue, deps } = setup({ provider })
    const session = await store.create(sessionInput())
    const result = await runDispatch({ sessionId: session.id, rev: 0, workspaceId: "ws_a" }, deps)

    expect(result).toMatchObject({ outcome: "redelayed", session: { status: "scheduled", dispatchRev: 1 } })
    expect(queue.jobs.at(-1)?.options.delay).toBe(60_000)
  })

  it("409 adopts our running bot", async () => {
    const provider = fakeProvider({
      requestBot: vi.fn(async () => {
        throw new VexaError("conflict", "409", { status: 409 })
      }),
      findActiveBot: vi.fn(async () => ({ platform: "google_meet", nativeMeetingId: "abc-defg-hij", vexaMeetingId: "777" })),
    })
    const { store, deps } = setup({ provider })
    const session = await store.create(sessionInput())
    const result = await runDispatch({ sessionId: session.id, rev: 0, workspaceId: "ws_a" }, deps)

    expect(result).toMatchObject({ outcome: "adopted", session: { status: "requested", vexaMeetingId: "777" } })
  })

  it("409 for a bot another session owns blocks without detail", async () => {
    const provider = fakeProvider({
      requestBot: vi.fn(async () => {
        throw new VexaError("conflict", "409", { status: 409 })
      }),
      findActiveBot: vi.fn(async () => ({ platform: "google_meet", nativeMeetingId: "abc-defg-hij", vexaMeetingId: "888" })),
    })
    const { store, deps } = setup({ provider })
    const other = await store.create(sessionInput({ workspaceId: "ws_b", calendarEventId: "cal_b", status: "completed" }))

    await store.update(other.id, { vexaMeetingId: "888" }, { workspaceId: "ws_b" })

    const session = await store.create(sessionInput())
    const result = await runDispatch({ sessionId: session.id, rev: 0, workspaceId: "ws_a" }, deps)

    expect(result.session).toMatchObject({ status: "blocked", statusReason: "already_in_meeting", error: null })
    // The other workspace's session is untouched and never named.
    expect(await store.get(other.id, { workspaceId: "ws_b" })).toMatchObject({ status: "completed", vexaMeetingId: "888" })
    expect(JSON.stringify(store.events.filter((event) => event.workspaceId === "ws_a"))).not.toContain(other.id)
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(other.id)
  })

  it("a live session for the same target in the same workspace blocks before any POST", async () => {
    const { store, provider, deps } = setup()

    await store.create(sessionInput({ calendarEventId: "cal_b", status: "active" }))

    const session = await store.create(sessionInput())
    const result = await runDispatch({ sessionId: session.id, rev: 0, workspaceId: "ws_a" }, deps)

    expect(result.session).toMatchObject({ status: "blocked", statusReason: "already_in_meeting" })
    expect(provider.requestBot).not.toHaveBeenCalled()
  })

  it("422 is permanent", async () => {
    const provider = fakeProvider({
      requestBot: vi.fn(async () => {
        throw new VexaError("invalid", "Vexa POST /bots → 422: passcode=[redacted]", { status: 422 })
      }),
    })
    const { store, deps } = setup({ provider })
    const session = await store.create(sessionInput())

    await expect(runDispatch({ sessionId: session.id, rev: 0, workspaceId: "ws_a" }, deps)).rejects.toBeInstanceOf(UnrecoverableError)
    expect(await store.get(session.id, { workspaceId: "ws_a" })).toMatchObject({ status: "failed", statusReason: "invalid_meeting_link" })
  })

  it("config/auth errors mark vexa_misconfigured; auth_session_missing is bot_signed_out", async () => {
    const provider = fakeProvider({
      requestBot: vi
        .fn()
        .mockRejectedValueOnce(new VexaError("config", "no STT", { status: 503 }))
        .mockRejectedValueOnce(new VexaError("auth", "signed out", { status: 403, code: "auth_session_missing" })),
    })
    const { store, deps } = setup({ provider })
    const first = await store.create(sessionInput())
    const second = await store.create(sessionInput({ calendarEventId: "cal_2", nativeMeetingId: "qqq-qqqq-qqq" }))

    expect((await runDispatch({ sessionId: first.id, rev: 0, workspaceId: "ws_a" }, deps)).session).toMatchObject({
      status: "failed",
      statusReason: "vexa_misconfigured",
    })
    expect((await runDispatch({ sessionId: second.id, rev: 0, workspaceId: "ws_a" }, deps)).session).toMatchObject({
      status: "blocked",
      statusReason: "bot_signed_out",
    })
  })

  it("a retry adopts an existing bot instead of a second POST", async () => {
    const provider = fakeProvider({
      requestBot: vi.fn(async () => {
        throw new VexaError("timeout", "Vexa POST /bots timed out")
      }),
      findActiveBot: vi
        .fn()
        .mockResolvedValueOnce({ platform: "google_meet", nativeMeetingId: "abc-defg-hij", vexaMeetingId: "4242" }),
    })
    const { store, deps } = setup({ provider })
    const session = await store.create(sessionInput())

    await expect(runDispatch({ sessionId: session.id, rev: 0, workspaceId: "ws_a" }, deps)).rejects.toMatchObject({ kind: "timeout" })
    expect(await store.get(session.id, { workspaceId: "ws_a" })).toMatchObject({ status: "requested", vexaMeetingId: null })

    // BullMQ retry of the same job.
    const retry = await runDispatch({ sessionId: session.id, rev: 0, workspaceId: "ws_a" }, deps)

    expect(retry).toMatchObject({ outcome: "adopted", session: { vexaMeetingId: "4242" } })
    expect(provider.requestBot).toHaveBeenCalledTimes(1)
  })

  it("a retry with no running bot posts again", async () => {
    const provider = fakeProvider({
      requestBot: vi
        .fn()
        .mockRejectedValueOnce(new VexaError("network", "fetch failed"))
        .mockResolvedValueOnce({ vexaMeetingId: "99", raw: {} }),
    })
    const { store, deps } = setup({ provider })
    const session = await store.create(sessionInput())

    await expect(runDispatch({ sessionId: session.id, rev: 0, workspaceId: "ws_a" }, deps)).rejects.toBeInstanceOf(VexaError)
    expect((await runDispatch({ sessionId: session.id, rev: 0, workspaceId: "ws_a" }, deps)).session).toMatchObject({ vexaMeetingId: "99" })
    expect(provider.findActiveBot).toHaveBeenCalledTimes(1)
  })

  it("a user stop during the in-flight POST stops the new bot instead of recording it as requested", async () => {
    let sessionId = ""
    const provider = fakeProvider({
      requestBot: vi.fn(async () => {
        // The user presses Stop while POST /bots is in flight (service stop path).
        await store.transition(sessionId, {
          status: "stopping",
          reason: "user_stopped",
          at: new Date(),
          source: "api",
          workspaceId: "ws_a",
        })
        return { vexaMeetingId: "4242", status: "requested", raw: {} }
      }),
    })
    const { store, deps } = setup({ provider })
    const session = await store.create(sessionInput())

    sessionId = session.id

    const result = await runDispatch({ sessionId: session.id, rev: 0, workspaceId: "ws_a" }, deps)

    expect(result.outcome).toBe("stopped")
    expect(provider.stopBot).toHaveBeenCalledWith("google_meet", "abc-defg-hij")
    // The id is kept so Vexa's completion resolves to this session.
    expect(await store.get(session.id, { workspaceId: "ws_a" })).toMatchObject({
      status: "stopping",
      statusReason: "user_stopped",
      vexaMeetingId: "4242",
    })
  })

  it("a stop during a 409 adoption stops the adopted bot", async () => {
    let sessionId = ""
    const provider = fakeProvider({
      requestBot: vi.fn(async () => {
        throw new VexaError("conflict", "409", { status: 409 })
      }),
      findActiveBot: vi.fn(async () => {
        await store.transition(sessionId, { status: "stopping", reason: "user_stopped", at: new Date(), source: "api", workspaceId: "ws_a" })
        return { platform: "google_meet", nativeMeetingId: "abc-defg-hij", vexaMeetingId: "777" }
      }),
    })
    const { store, deps } = setup({ provider })
    const session = await store.create(sessionInput())

    sessionId = session.id
    expect((await runDispatch({ sessionId: session.id, rev: 0, workspaceId: "ws_a" }, deps)).outcome).toBe("stopped")
    expect(provider.stopBot).toHaveBeenCalledWith("google_meet", "abc-defg-hij")
  })

  it("a retry after a failed POST for a session the user stopped stops any bot and cancels", async () => {
    const provider = fakeProvider({
      requestBot: vi.fn(async () => {
        throw new VexaError("timeout", "Vexa POST /bots timed out")
      }),
    })
    const { store, deps } = setup({ provider })
    const session = await store.create(sessionInput())

    await expect(runDispatch({ sessionId: session.id, rev: 0, workspaceId: "ws_a" }, deps)).rejects.toMatchObject({ kind: "timeout" })
    await store.transition(session.id, { status: "stopping", reason: "user_stopped", at: new Date(), source: "api", workspaceId: "ws_a" })
    provider.findActiveBot.mockResolvedValueOnce({ platform: "google_meet", nativeMeetingId: "abc-defg-hij", vexaMeetingId: "4242" })

    const retry = await runDispatch({ sessionId: session.id, rev: 0, workspaceId: "ws_a" }, deps)

    expect(retry.session).toMatchObject({ status: "cancelled", statusReason: "user_stopped" })
    expect(provider.stopBot).toHaveBeenCalledWith("google_meet", "abc-defg-hij")
    expect(provider.requestBot).toHaveBeenCalledTimes(1)
  })

  it("two concurrent runs post once", async () => {
    const { store, provider, deps } = setup()
    const session = await store.create(sessionInput())

    await Promise.all([
      runDispatch({ sessionId: session.id, rev: 0, workspaceId: "ws_a" }, deps),
      runDispatch({ sessionId: session.id, rev: 0, workspaceId: "ws_a" }, deps),
    ])
    expect(provider.requestBot).toHaveBeenCalledTimes(1)
  })
})

describe("POST /bots bodies through the real client", () => {
  beforeEach(() => {
    vi.setSystemTime(new Date("2026-10-14T08:59:00.000Z"))
  })

  it.each([
    ["meet", "https://meet.google.com/abc-defg-hij", "he"],
    ["zoom", "https://zoom.us/j/81234567890?pwd=AbC123", "en"],
    ["teamsNumeric", "https://teams.live.com/meet/9384756123456?p=Qw12", null],
    [
      "teamsThread",
      'https://teams.microsoft.com/l/meetup-join/19%3ameeting_NjY4YzEzMzQtZjBkZS00OTk1LWE4ZjAtMTIzNDU2Nzg5MDEy%40thread.v2/0?context={"Tid":"72f988bf-86f1-41af-91ab-2d7cd011db47"}',
      "auto",
    ],
  ] as const)("%s matches the fixture", async (name, url, language) => {
    const fake = fakeFetch({ "POST /bots": () => json({ id: 1 }, { status: 201 }) })
    const vexa = createVexaClient({
      baseUrl: "http://vexa-gateway:8056",
      apiKey: "vexa_test_key_0123456789abcdef",
      fetch: fake.fetch,
    })
    const store = createMemoryBotSessionStore()
    const link = parseMeetingLink(url)!
    const session = await store.create(
      sessionInput({
        platform: link.platform,
        nativeMeetingId: link.nativeMeetingId,
        meetingUrlRedacted: link.redactedUrl,
        passcodeEnc: sealMeetingSecrets(link),
        teamsBaseHost: link.teamsBaseHost ?? null,
        language,
      })
    )

    expect(session.meetingUrlRedacted).not.toMatch(/pwd|p=|context/)
    await runDispatch({ sessionId: session.id, rev: 0, workspaceId: "ws_a" }, { store, provider: () => vexa, queue: fakeQueue().port, config: testBotConfig() })
    expect(fake.calls[0].body).toEqual(postBodies[name])
  })

  it("sends transcribe_enabled only when the flag is on", async () => {
    const fake = fakeFetch({ "POST /bots": () => json({ id: 1 }) })
    const vexa = createVexaClient({ baseUrl: "http://vexa-gateway:8056", apiKey: "vexa_test_key_0123456789abcdef", fetch: fake.fetch })
    const store = createMemoryBotSessionStore()
    const session = await store.create(sessionInput())

    await runDispatch(
      { sessionId: session.id, rev: 0, workspaceId: "ws_a" },
      { store, provider: () => vexa, queue: fakeQueue().port, config: testBotConfig({ MEETSUM_LIVE_TRANSCRIPT: "true" }) }
    )
    expect(fake.calls[0].body).toMatchObject({ transcribe_enabled: true })
  })
})

describe("secrets", () => {
  it("seals passcode and Teams context, never in clear text", () => {
    const link = parseMeetingLink("https://zoom.us/j/81234567890?pwd=AbC123")!
    const sealed = sealMeetingSecrets(link)!

    expect(sealed).not.toContain("AbC123")
    expect(openMeetingSecrets(sealed)).toEqual({ passcode: "AbC123" })
    expect(sealMeetingSecrets(parseMeetingLink("https://meet.google.com/abc-defg-hij")!)).toBeNull()
    expect(openMeetingSecrets(null)).toEqual({})
    expect(openMeetingSecrets("garbage")).toEqual({})
  })
})

describe("dispatchNow", () => {
  it("bumps the rev, removes the delayed job and enqueues immediately", async () => {
    vi.setSystemTime(new Date("2026-10-14T08:00:00.000Z"))

    const { store, provider, queue, deps } = setup()
    const session = await store.create(sessionInput())

    await scheduleDispatch(session, deps)

    const updated = await dispatchNow(session, deps)

    expect(updated).toMatchObject({ dispatchRev: 1, dispatchAt: "2026-10-14T08:00:00.000Z" })
    expect(queue.port.remove).toHaveBeenCalledWith(`bot.dispatch:${session.id}:0`)
    await vi.advanceTimersByTimeAsync(0)
    expect(provider.requestBot).toHaveBeenCalledTimes(1)

    // The old delayed job never fires.
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(provider.requestBot).toHaveBeenCalledTimes(1)
  })

  it("returns non-scheduled sessions unchanged and rejects other workspaces", async () => {
    const { store, deps } = setup()
    const session = await store.create(sessionInput({ status: "active" }))

    expect((await dispatchNow(session, deps)).status).toBe("active")
    expect((await dispatchNow(session.id, { ...deps, workspaceId: "ws_a" })).status).toBe("active")
    await expect(dispatchNow(session.id, { ...deps, workspaceId: "ws_b" })).rejects.toThrow("not found")
    await expect(dispatchNow(session.id, deps)).rejects.toThrow("requires the session's workspaceId")
  })
})

describe("workspace isolation (W1/W2)", () => {
  beforeEach(() => {
    vi.setSystemTime(new Date("2026-10-14T08:59:00.000Z"))
  })

  it("a W1 dispatch job can never read or update a W2 session", async () => {
    const { store, provider, queue, deps } = setup()
    const w2 = await store.create(sessionInput({ workspaceId: "ws_2", calendarEventId: "cal_w2" }))
    const before = await store.get(w2.id, { workspaceId: "ws_2" })
    // Loaded by id AND workspace: a forged payload is unrecoverable (no retries).
    await expect(runDispatch({ sessionId: w2.id, rev: 0, workspaceId: "ws_1" }, deps)).rejects.toBeInstanceOf(
      UnrecoverableError
    )
    expect(provider.requestBot).not.toHaveBeenCalled()
    expect(queue.jobs).toHaveLength(0)
    expect(await store.get(w2.id, { workspaceId: "ws_2" })).toEqual(before)
    expect(store.events.filter((event) => event.botSessionId === w2.id)).toEqual([])
    await expect(dispatchNow(w2.id, { ...deps, workspaceId: "ws_1" })).rejects.toThrow("not found")
    expect(await store.get(w2.id, { workspaceId: "ws_2" })).toEqual(before)
  })

  it("two workspaces with the same meeting link get independent sessions", async () => {
    const provider = fakeProvider({
      requestBot: vi
        .fn()
        .mockResolvedValueOnce({ vexaMeetingId: "501", raw: {} })
        .mockRejectedValueOnce(new VexaError("conflict", "Vexa POST /bots → 409", { status: 409 })),
      findActiveBot: vi.fn(async () => ({ platform: "google_meet", nativeMeetingId: "abc-defg-hij", vexaMeetingId: "501" })),
    })
    const { store, deps } = setup({ provider })
    const w1 = await store.create(sessionInput({ workspaceId: "ws_1" }))
    const w2 = await store.create(sessionInput({ workspaceId: "ws_2" }))

    expect(w1.id).not.toBe(w2.id)
    expect(await store.findByCalendarEvent("ws_1", "cal_1")).toMatchObject({ id: w1.id })
    expect(await store.findByCalendarEvent("ws_2", "cal_1")).toMatchObject({ id: w2.id })

    await runDispatch({ sessionId: w1.id, rev: 0, workspaceId: "ws_1" }, deps)

    const second = await runDispatch({ sessionId: w2.id, rev: 0, workspaceId: "ws_2" }, deps)

    // Vexa's own 409 stops W2's bot; it never adopts W1's Vexa meeting.
    expect(second.session).toMatchObject({ status: "blocked", statusReason: "already_in_meeting", vexaMeetingId: null })
    expect(await store.get(w1.id, { workspaceId: "ws_1" })).toMatchObject({ status: "requested", vexaMeetingId: "501" })
  })
})

describe("adoption never crosses workspaces (W1/W2)", () => {
  beforeEach(() => {
    vi.setSystemTime(new Date("2026-10-14T08:59:00.000Z"))
  })

  it("a 409 does not adopt a bot whose Vexa id is not yet recorded by another workspace's open session", async () => {
    const provider = fakeProvider({
      requestBot: vi.fn().mockRejectedValue(new VexaError("conflict", "Vexa POST /bots → 409", { status: 409 })),
      findActiveBot: vi.fn(async () => ({ platform: "google_meet", nativeMeetingId: "abc-defg-hij", vexaMeetingId: "900" })),
    })
    const { store, deps } = setup({ provider })
    // W2's bot was requested, but its POST response (with the Vexa id) was lost.
    const w2 = await store.create(sessionInput({ workspaceId: "ws_2", status: "requested", calendarEventId: "cal_w2" }))
    const w2Before = await store.get(w2.id, { workspaceId: "ws_2" })
    const w1 = await store.create(sessionInput({ workspaceId: "ws_1" }))

    const result = await runDispatch({ sessionId: w1.id, rev: 0, workspaceId: "ws_1" }, deps)

    expect(result.session).toMatchObject({ status: "blocked", statusReason: "already_in_meeting", vexaMeetingId: null })
    expect(await store.get(w2.id, { workspaceId: "ws_2" })).toEqual(w2Before)
  })

  it("a retry adopt never takes a bot reported for a different target", async () => {
    const provider = fakeProvider({
      findActiveBot: vi.fn(async () => ({ platform: "google_meet", nativeMeetingId: "zzz-zzzz-zzz", vexaMeetingId: "901" })),
      requestBot: vi.fn(async () => ({ vexaMeetingId: "4242", status: "requested", raw: {} })),
    })
    const { store, deps } = setup({ provider })
    const w1 = await store.create(sessionInput({ workspaceId: "ws_1", status: "requested" }))

    const result = await runDispatch({ sessionId: w1.id, rev: 0, workspaceId: "ws_1" }, deps)

    expect(result).toMatchObject({ outcome: "requested", session: { vexaMeetingId: "4242" } })
  })

  it("adopting updates only the job's own session", async () => {
    const provider = fakeProvider({
      requestBot: vi.fn().mockRejectedValue(new VexaError("conflict", "Vexa POST /bots → 409", { status: 409 })),
      findActiveBot: vi.fn(async () => ({ platform: "google_meet", nativeMeetingId: "abc-defg-hij", vexaMeetingId: "902" })),
    })
    const { store, deps } = setup({ provider })
    const w2Terminal = await store.create(sessionInput({ workspaceId: "ws_2", status: "completed", calendarEventId: "cal_w2" }))
    const before = await store.get(w2Terminal.id, { workspaceId: "ws_2" })
    const w1 = await store.create(sessionInput({ workspaceId: "ws_1" }))

    const result = await runDispatch({ sessionId: w1.id, rev: 0, workspaceId: "ws_1" }, deps)

    expect(result).toMatchObject({ outcome: "adopted", session: { id: w1.id, workspaceId: "ws_1", vexaMeetingId: "902" } })
    expect(await store.get(w2Terminal.id, { workspaceId: "ws_2" })).toEqual(before)
  })
})
