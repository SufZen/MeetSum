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

    const after = await store.get(session.id)

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

    await store.update(session.id, { dispatchRev: 1 })
    expect((await runDispatch({ sessionId: session.id, rev: 0 }, deps)).outcome).toBe("skipped")
    expect(provider.requestBot).not.toHaveBeenCalled()
  })

  it("skips another workspace's session", async () => {
    const { store, provider, deps } = setup()
    const session = await store.create(sessionInput())

    expect((await runDispatch({ sessionId: session.id, rev: 0, workspaceId: "ws_b" }, deps)).outcome).toBe("skipped")
    expect(provider.requestBot).not.toHaveBeenCalled()
  })

  it("a missed window cancels", async () => {
    vi.setSystemTime(new Date("2026-10-14T09:31:00.000Z"))

    const { store, provider, deps } = setup()
    const session = await store.create(sessionInput())
    const result = await runDispatch({ sessionId: session.id, rev: 0 }, deps)

    expect(result.session).toMatchObject({ status: "cancelled", statusReason: "missed_window" })
    expect(provider.requestBot).not.toHaveBeenCalled()
  })

  it("re-delays 60 s when capacity is reached", async () => {
    const { store, provider, queue, deps } = setup({ env: { MEETSUM_BOT_MAX_CONCURRENT: "1" } })

    await store.create(sessionInput({ calendarEventId: "cal_other", nativeMeetingId: "zzz-zzzz-zzz", status: "active" }))

    const session = await store.create(sessionInput())
    const result = await runDispatch({ sessionId: session.id, rev: 0 }, deps)

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
    expect(await runDispatch({ sessionId: session.id, rev: 0 }, deps)).toMatchObject({
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
    const result = await runDispatch({ sessionId: session.id, rev: 0 }, deps)

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
    const result = await runDispatch({ sessionId: session.id, rev: 0 }, deps)

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

    await store.update(other.id, { vexaMeetingId: "888" })

    const session = await store.create(sessionInput())
    const result = await runDispatch({ sessionId: session.id, rev: 0 }, deps)

    expect(result.session).toMatchObject({ status: "blocked", statusReason: "already_in_meeting", error: null })
  })

  it("a live session for the same target in another workspace blocks before any POST", async () => {
    const { store, provider, deps } = setup()

    await store.create(sessionInput({ workspaceId: "ws_b", calendarEventId: "cal_b", status: "active" }))

    const session = await store.create(sessionInput())
    const result = await runDispatch({ sessionId: session.id, rev: 0 }, deps)

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

    await expect(runDispatch({ sessionId: session.id, rev: 0 }, deps)).rejects.toBeInstanceOf(UnrecoverableError)
    expect(await store.get(session.id)).toMatchObject({ status: "failed", statusReason: "invalid_meeting_link" })
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

    expect((await runDispatch({ sessionId: first.id, rev: 0 }, deps)).session).toMatchObject({
      status: "failed",
      statusReason: "vexa_misconfigured",
    })
    expect((await runDispatch({ sessionId: second.id, rev: 0 }, deps)).session).toMatchObject({
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

    await expect(runDispatch({ sessionId: session.id, rev: 0 }, deps)).rejects.toMatchObject({ kind: "timeout" })
    expect(await store.get(session.id)).toMatchObject({ status: "requested", vexaMeetingId: null })

    // BullMQ retry of the same job.
    const retry = await runDispatch({ sessionId: session.id, rev: 0 }, deps)

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

    await expect(runDispatch({ sessionId: session.id, rev: 0 }, deps)).rejects.toBeInstanceOf(VexaError)
    expect((await runDispatch({ sessionId: session.id, rev: 0 }, deps)).session).toMatchObject({ vexaMeetingId: "99" })
    expect(provider.findActiveBot).toHaveBeenCalledTimes(1)
  })

  it("two concurrent runs post once", async () => {
    const { store, provider, deps } = setup()
    const session = await store.create(sessionInput())

    await Promise.all([
      runDispatch({ sessionId: session.id, rev: 0 }, deps),
      runDispatch({ sessionId: session.id, rev: 0 }, deps),
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
    await runDispatch({ sessionId: session.id, rev: 0 }, { store, provider: () => vexa, queue: fakeQueue().port, config: testBotConfig() })
    expect(fake.calls[0].body).toEqual(postBodies[name])
  })

  it("sends transcribe_enabled only when the flag is on", async () => {
    const fake = fakeFetch({ "POST /bots": () => json({ id: 1 }) })
    const vexa = createVexaClient({ baseUrl: "http://vexa-gateway:8056", apiKey: "vexa_test_key_0123456789abcdef", fetch: fake.fetch })
    const store = createMemoryBotSessionStore()
    const session = await store.create(sessionInput())

    await runDispatch(
      { sessionId: session.id, rev: 0 },
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

    const updated = await dispatchNow(session.id, deps)

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

    expect((await dispatchNow(session.id, deps)).status).toBe("active")
    await expect(dispatchNow(session.id, { ...deps, workspaceId: "ws_b" })).rejects.toThrow("not found")
  })
})
