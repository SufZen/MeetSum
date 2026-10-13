import { afterEach, describe, expect, it, vi } from "vitest"

import { createVexaClient, getBotProvider, setBotProviderForTesting } from "@/lib/bot/vexa/client"
import { VexaError, type VexaBotRequest } from "@/lib/bot/vexa/types"

import { fakeFetch, json, loadVexaFixture } from "./fixtures/vexa/api/fakes"

const BASE = "http://vexa-gateway:8056"
const API_KEY = "vexa_test_key_0123456789abcdef"
const responses = loadVexaFixture<Record<string, Record<string, unknown>>>("responses.json")
const postBodies = loadVexaFixture<Record<string, Record<string, unknown>>>("post-bots.json")
const THREAD = "19:meeting_NjY4YzEzMzQtZjBkZS00OTk1LWE4ZjAtMTIzNDU2Nzg5MDEy@thread.v2"

function client(routes: Parameters<typeof fakeFetch>[0], overrides: { retries?: number } = {}) {
  const fake = fakeFetch(routes)
  const sleep = vi.fn(async (ms: number) => void ms)
  const vexa = createVexaClient({ baseUrl: BASE, apiKey: API_KEY, fetch: fake.fetch, sleep, ...overrides })

  return { vexa, sleep, ...fake }
}

async function caught(promise: Promise<unknown>): Promise<VexaError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof VexaError) return error
    throw error
  }
  throw new Error("expected a VexaError")
}

const common = {
  botName: "MeetSum Notetaker",
  transcribeEnabled: false,
  recordingEnabled: true,
  authenticated: true,
  automaticLeave: { maxTimeLeftAloneMs: 600_000 },
} satisfies Partial<VexaBotRequest>

describe("requestBot", () => {
  it.each([
    ["meet", { ...common, platform: "google_meet", nativeMeetingId: "abc-defg-hij", language: "he" }],
    [
      "teamsNumeric",
      {
        ...common,
        platform: "teams",
        nativeMeetingId: "9384756123456",
        passcode: "Qw12",
        meetingUrl: "https://teams.live.com/meet/9384756123456?p=Qw12",
        teamsBaseHost: "teams.live.com",
      },
    ],
    [
      "teamsThread",
      {
        ...common,
        platform: "teams",
        nativeMeetingId: THREAD,
        meetingUrl: postBodies.teamsThread.meeting_url as string,
      },
    ],
    [
      "zoom",
      {
        ...common,
        platform: "zoom",
        nativeMeetingId: "81234567890",
        language: "en",
        passcode: "AbC123",
        meetingUrl: "https://zoom.us/j/81234567890?pwd=AbC123",
      },
    ],
  ] as const)("sends the exact %s body", async (name, request) => {
    const { vexa, calls } = client({ "POST /bots": () => json(responses.botCreated, { status: 201 }) })
    const result = await vexa.requestBot(request as VexaBotRequest)

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${BASE}/bots`)
    expect(calls[0].body).toEqual(postBodies[name])
    expect(result).toMatchObject({ vexaMeetingId: "4242", status: "requested" })
  })

  it("sends X-API-Key and redirect:error on every request", async () => {
    const { vexa, calls } = client({
      "POST /bots": () => json(responses.botCreated),
      "GET /bots/status": () => json(responses.botsStatusV010),
    })

    await vexa.requestBot({ ...common, platform: "google_meet", nativeMeetingId: "abc-defg-hij" })
    await vexa.findActiveBot("zoom", "81234567890")

    for (const call of calls) {
      expect((call.init.headers as Record<string, string>)["X-API-Key"]).toBe(API_KEY)
      expect(call.init.redirect).toBe("error")
      expect(call.init.signal).toBeInstanceOf(AbortSignal)
    }
  })

  it("reads the meeting id from id | meeting_id | meeting.id", async () => {
    const { vexa } = client({
      "POST /bots": [
        () => json(responses.botCreatedNested),
        () => json({ meeting_id: 77, status: "joining" }),
        () => json({}),
      ],
    })
    const request = { ...common, platform: "google_meet", nativeMeetingId: "abc-defg-hij" } as const

    expect((await vexa.requestBot(request)).vexaMeetingId).toBe("4343")
    expect((await vexa.requestBot(request)).vexaMeetingId).toBe("77")
    expect((await vexa.requestBot(request)).vexaMeetingId).toBeUndefined()
  })

  it.each([
    [403, responses.errorConcurrency, "capacity", true],
    [429, { detail: "slow down" }, "capacity", true],
    [403, { detail: "Forbidden" }, "auth", false],
    [401, { detail: "Invalid API key" }, "auth", false],
    [409, responses.errorAlreadyInMeeting, "conflict", false],
    [422, responses.errorValidation, "invalid", false],
    [503, responses.errorNoStt, "config", false],
    [503, { detail: "upstream down" }, "unavailable", true],
  ] as const)("maps %i to %s", async (status, body, kind, retryable) => {
    const { vexa, calls } = client({ "POST /bots": () => json(body, { status }) })
    const error = await caught(vexa.requestBot({ ...common, platform: "google_meet", nativeMeetingId: "abc-defg-hij" }))

    expect(error).toMatchObject({ kind, status, retryable })
    // POST /bots is never auto-retried.
    expect(calls).toHaveLength(1)
  })

  it("flags auth_session_missing", async () => {
    const { vexa } = client({ "POST /bots": () => json(responses.errorAuthSession, { status: 403 }) })
    const error = await caught(vexa.requestBot({ ...common, platform: "google_meet", nativeMeetingId: "abc-defg-hij" }))

    expect(error.code).toBe("auth_session_missing")
  })

  it("rejects invalid platforms and native ids before any request", async () => {
    const { vexa, calls } = client({})

    expect(
      (await caught(vexa.requestBot({ ...common, platform: "webex" as never, nativeMeetingId: "abc-defg-hij" }))).kind
    ).toBe("invalid")
    expect((await caught(vexa.stopBot("zoom", "../../admin"))).kind).toBe("invalid")
    expect((await caught(vexa.getMeeting("1/../../x"))).kind).toBe("invalid")
    expect(calls).toHaveLength(0)
  })
})

describe("retries", () => {
  it("retries GET on 502 and 429 honouring Retry-After", async () => {
    const { vexa, sleep, calls } = client({
      "GET /meetings/4242": [
        () => new Response("bad gateway", { status: 502 }),
        () => json({ detail: "rate" }, { status: 429, headers: { "retry-after": "3" } }),
        () => json(responses.meetingCompleted),
      ],
    })

    const meeting = await vexa.getMeeting("4242")

    expect(meeting.status).toBe("completed")
    expect(calls).toHaveLength(3)
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(sleep.mock.calls[1]).toEqual([3000])
    expect(sleep.mock.calls[0][0]).toBeGreaterThanOrEqual(500)
  })

  it("gives up after the configured retries", async () => {
    const { vexa, calls } = client({ "DELETE /bots/zoom/81234567890": () => new Response("", { status: 500 }) })

    expect((await caught(vexa.stopBot("zoom", "81234567890"))).kind).toBe("unavailable")
    expect(calls).toHaveLength(3)
  })

  it("retries network errors on GET", async () => {
    const fail = () => {
      throw new TypeError("fetch failed")
    }
    const { vexa, calls } = client({ "GET /bots/status": [fail, () => json(responses.botsStatusV012)] })

    expect(await vexa.findActiveBot("teams", "9384756123456")).toMatchObject({ vexaMeetingId: "5151" })
    expect(calls).toHaveLength(2)
  })

  it("maps a timeout to `timeout`", async () => {
    const { vexa } = client({
      "GET /meetings/4242": () => {
        throw new DOMException("The operation timed out.", "TimeoutError")
      },
    })

    expect(await caught(vexa.getMeeting("4242"))).toMatchObject({ kind: "timeout", retryable: true })
  })
})

describe("parsing", () => {
  it("parses a completed meeting with recordings and provenance", async () => {
    const { vexa } = client({ "GET /meetings/4242": () => json(responses.meetingCompleted) })
    const meeting = await vexa.getMeeting("4242")

    expect(meeting).toMatchObject({
      id: "4242",
      platform: "google_meet",
      nativeMeetingId: "abc-defg-hij",
      status: "completed",
      reason: "left_alone",
      recordings: [
        { id: "rec_77", media: [{ id: "media_91", type: "audio", contentType: "audio/webm", sizeBytes: 1843200 }] },
      ],
      serviceProvenance: { botOutcome: "served", lifecycleContractVersion: "2" },
    })
  })

  it("parses running_bots (0.10) and running (0.12)", async () => {
    const { vexa } = client({
      "GET /bots/status": [() => json(responses.botsStatusV010), () => json(responses.botsStatusV012)],
    })

    expect(await vexa.findActiveBot("google_meet", "abc-defg-hij")).toEqual({
      platform: "google_meet",
      nativeMeetingId: "abc-defg-hij",
      vexaMeetingId: "4242",
      status: "awaiting_admission",
    })
    expect(await vexa.findActiveBot("google_meet", "abc-defg-hij")).toBeUndefined()
  })

  it("ignores an off-origin raw_url", async () => {
    const { vexa } = client({
      "GET /recordings/rec_77/master": [
        () => json(responses.recordingMasterOffOrigin),
        () => json(responses.recordingMasterSameOrigin),
      ],
    })

    const off = await vexa.getRecordingMaster("rec_77", "audio")
    const same = await vexa.getRecordingMaster("rec_77", "audio")

    expect(off.rawUrl).toBeUndefined()
    expect(off.mediaId).toBe("media_91")
    expect(same.rawUrl).toBe("http://vexa-gateway:8056/recordings/rec_77/media/media_91/raw")
  })

  it("streams recording media from the built path", async () => {
    const { vexa, calls } = client({
      "GET /recordings/rec_77/media/media_91/raw": () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "audio/webm", "content-length": "3" },
        }),
    })
    const stream = await vexa.streamRecordingMedia("rec_77", "media_91")

    expect(stream).toMatchObject({ contentType: "audio/webm", contentLength: 3 })
    expect(new Uint8Array(await new Response(stream.body).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    expect(calls[0].url).toBe(`${BASE}/recordings/rec_77/media/media_91/raw`)
  })

  it("parses transcripts tolerantly", async () => {
    const { vexa } = client({ "GET /transcripts/by-id/4242": () => json(responses.transcript) })
    const transcript = await vexa.getTranscript("4242")

    expect(transcript.segments).toHaveLength(2)
    expect(transcript.segments[0]).toMatchObject({ segmentId: "seg-1", speaker: "Dana Levi", start: 1.2, end: 3.4, completed: true })
    expect(transcript.segments[1]).toMatchObject({ segmentId: "1", text: "hi", completed: false })
  })

  it("rejects malformed bodies as bad_response", async () => {
    const { vexa } = client({ "GET /meetings/4242": () => new Response("<html>", { status: 200 }) })

    expect((await caught(vexa.getMeeting("4242"))).kind).toBe("bad_response")
  })
})

describe("chat, webhook, deletion", () => {
  it("sendChat tries /chat then /acts, else unsupported", async () => {
    const sent = client({ "POST /bots/zoom/81234567890/chat": () => json({ ok: true }) })

    expect(await sent.vexa.sendChat("zoom", "81234567890", "שלום")).toBe("sent")

    const acts = client({ "POST /bots/zoom/81234567890/acts": () => json({ ok: true }) })

    expect(await acts.vexa.sendChat("zoom", "81234567890", "hi")).toBe("sent")
    expect(acts.calls.map((call) => call.url)).toEqual([
      `${BASE}/bots/zoom/81234567890/chat`,
      `${BASE}/bots/zoom/81234567890/acts`,
    ])
    expect(acts.calls[1].body).toEqual({ type: "chat", text: "hi" })

    const none = client({ "POST /bots/zoom/81234567890/acts": () => new Response("", { status: 405 }) })

    expect(await none.vexa.sendChat("zoom", "81234567890", "hi")).toBe("unsupported")
  })

  it("configures the webhook and never returns or leaks the secret", async () => {
    const secret = "whsec_0123456789abcdef0123456789abcdef"
    const { vexa, calls } = client({
      "PUT /user/webhook": [() => json({ detail: `bad secret ${secret}` }, { status: 422 }), () => json({})],
      "GET /user/webhook": () => json(responses.webhook),
    })
    const config = {
      url: "https://meetsum.example/api/integrations/vexa/webhook",
      secret,
      events: { "meeting.completed": true },
    }

    const error = await caught(vexa.configureWebhook(config))

    expect(error.message).not.toContain(secret)
    await vexa.configureWebhook(config)
    expect(calls[1].body).toEqual({
      webhook_url: config.url,
      webhook_secret: secret,
      webhook_events: { "meeting.completed": true },
    })

    const info = await vexa.getWebhook()

    expect(info.url).toBe("https://meetsum.example/api/integrations/vexa/webhook")
    expect(info.secretConfigured).toBe(true)
    expect(JSON.stringify(info)).not.toContain("whsec_should_never_leak")
  })

  it("deleteMeeting resolves on 404 and throws conflict on 409", async () => {
    const { vexa } = client({
      "DELETE /meetings/1": () => new Response(null, { status: 204 }),
      "DELETE /meetings/2": () => json({ detail: "gone" }, { status: 404 }),
      "DELETE /meetings/3": () => json({ detail: "bot still in meeting" }, { status: 409 }),
    })

    await expect(vexa.deleteMeeting("1")).resolves.toBeUndefined()
    await expect(vexa.deleteMeeting("2")).resolves.toBeUndefined()
    expect((await caught(vexa.deleteMeeting("3"))).kind).toBe("conflict")
  })

  it("health reports ok/false", async () => {
    expect(await client({ "GET /bots/status": () => json({ running: [], count: 0 }) }).vexa.health()).toMatchObject({ ok: true })
    expect(await client({ "GET /bots/status": () => json({}, { status: 401 }) }).vexa.health()).toEqual({ ok: false })
  })
})

describe("redaction", () => {
  it("never puts the API key, passcodes or Authorization in error messages", async () => {
    const echoed = {
      detail: `invalid request X-API-Key: ${API_KEY} Authorization: Bearer abc.def passcode=998877`,
      request: { meeting_url: "https://zoom.us/j/81234567890?pwd=AbC123", passcode: "AbC123", api_key: API_KEY },
    }
    const { vexa } = client({ "POST /bots": () => json(echoed, { status: 422 }) })
    const error = await caught(
      vexa.requestBot({
        ...common,
        platform: "zoom",
        nativeMeetingId: "81234567890",
        passcode: "AbC123",
        meetingUrl: "https://zoom.us/j/81234567890?pwd=AbC123",
      })
    )

    expect(error.kind).toBe("invalid")
    for (const secret of [API_KEY, "AbC123", "998877", "abc.def", "pwd=AbC"]) {
      expect(error.message).not.toContain(secret)
    }
    expect(error.message.length).toBeLessThanOrEqual(300)
  })

  it("never logs the API key header", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { vexa } = client({ "GET /meetings/4242": () => json({}, { status: 500 }) }, { retries: 0 })

    await caught(vexa.getMeeting("4242"))

    const logged = JSON.stringify([...log.mock.calls, ...errorLog.mock.calls])

    expect(logged).not.toContain(API_KEY)
    log.mockRestore()
    errorLog.mockRestore()
  })
})

describe("configuration", () => {
  afterEach(() => {
    setBotProviderForTesting(undefined)
    vi.unstubAllEnvs()
  })

  it("rejects bad base URLs and short keys", () => {
    expect(() => createVexaClient({ baseUrl: "ftp://x", apiKey: API_KEY })).toThrow(VexaError)
    expect(() => createVexaClient({ baseUrl: "http://u:p@x", apiKey: API_KEY })).toThrow(VexaError)
    expect(() => createVexaClient({ baseUrl: "http://x?a=1", apiKey: API_KEY })).toThrow(VexaError)
    expect(() => createVexaClient({ baseUrl: BASE, apiKey: "short" })).toThrow(VexaError)
  })

  it("getBotProvider builds only from env", () => {
    vi.stubEnv("VEXA_API_URL", "")
    expect(() => getBotProvider()).toThrow(VexaError)

    vi.stubEnv("VEXA_API_URL", BASE)
    vi.stubEnv("VEXA_API_KEY", API_KEY)
    expect(getBotProvider()).toBe(getBotProvider())
  })
})
