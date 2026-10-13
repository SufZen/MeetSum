import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createTestCtx, routeParams, setRouteCtx, testMeeting } from "./helpers/route-ctx"

vi.mock("@/lib/auth/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/authz")>()
  const { mockAuthzModule } = await import("./helpers/route-ctx")

  return mockAuthzModule(actual)
})

import { GET as live } from "@/app/api/meetings/[id]/bot/live/route"
import { LiveTranscriptHub } from "@/lib/bot/live/hub"
import { setLiveTranscriptHub } from "@/lib/bot/live/stream"
import { formatSseComment, formatSseEvent } from "@/lib/bot/sse"
import { setMemoryBotSessionStore } from "@/lib/bot/store"
import { createMemoryBotSessionStore, type MemoryBotSessionStore } from "@/lib/bot/store-memory"
import type { BotProvider, VexaTranscriptSegment } from "@/lib/bot/vexa/types"
import { createInMemoryMeetingDatabase } from "@/lib/meetings/repository"

/** M7 B8: SSE framing, segment upserts by id, end, abort stops the poller, flag gates. */

const WS = "ws_a"
let store: MemoryBotSessionStore
let segments: VexaTranscriptSegment[]
let ticks: Array<() => void>
let cleared: unknown[]
let hub: LiveTranscriptHub

const provider = {
  getTranscript: vi.fn(async () => ({ vexaMeetingId: "4242", segments: structuredClone(segments), raw: {} })),
} as unknown as BotProvider

async function flush() {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

function makeHub(maxStreams = 5) {
  hub = new LiveTranscriptHub({
    provider: () => provider,
    store: () => store,
    pollMs: 2000,
    maxStreams,
    setInterval: (fn) => {
      ticks.push(fn)
      return ticks.length
    },
    clearInterval: (handle) => cleared.push(handle),
  })
  setLiveTranscriptHub(hub)
}

async function seedLiveSession(overrides: { transcribeEnabled?: boolean } = {}) {
  const session = await store.create({
    workspaceId: WS,
    meetingId: "m_live",
    origin: "manual",
    platform: "google_meet",
    nativeMeetingId: "abc-defg-hij",
    botName: "MeetSum Notetaker",
    status: "active",
    transcribeEnabled: overrides.transcribeEnabled ?? true,
  })

  await store.update(session.id, { vexaMeetingId: "4242" }, { workspaceId: WS })
  return session
}

async function open(controller = new AbortController()) {
  const response = await live(
    new Request("http://localhost/api/meetings/m_live/bot/live", { signal: controller.signal }),
    routeParams({ id: "m_live" })
  )

  return { response, controller }
}

async function readAll(response: Response, until: (text: string) => boolean) {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let text = ""

  while (!until(text)) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), 200)
      ),
    ])

    if (chunk.done) break
    text += decoder.decode(chunk.value)
  }

  reader.releaseLock()
  return text
}

beforeEach(async () => {
  vi.stubEnv("MEETSUM_STORAGE", "memory")
  vi.stubEnv("MEETSUM_BOT_ENABLED", "true")
  vi.stubEnv("MEETSUM_LIVE_TRANSCRIPT", "true")
  store = createMemoryBotSessionStore()
  setMemoryBotSessionStore(store)
  segments = [{ segmentId: "s1", speaker: "דנה", text: "שלום", start: 1, end: 2, language: "he", completed: false }]
  ticks = []
  cleared = []
  makeHub()
  setRouteCtx(
    await createTestCtx({
      role: "viewer",
      workspaceId: WS,
      database: createInMemoryMeetingDatabase([testMeeting({ id: "m_live", workspaceId: WS })]),
    })
  )
})

afterEach(() => {
  setMemoryBotSessionStore(undefined)
  setLiveTranscriptHub(undefined)
  setRouteCtx(undefined)
  vi.unstubAllEnvs()
})

describe("formatSseEvent", () => {
  it("frames id, event and data lines", () => {
    expect(formatSseEvent("segment", { a: 1 }, "s1")).toBe('id: s1\nevent: segment\ndata: {"a":1}\n\n')
    expect(formatSseEvent("x", "two\nlines")).toBe("event: x\ndata: two\ndata: lines\n\n")
    expect(formatSseComment()).toBe(": keep-alive\n\n")
  })
})

describe("GET /api/meetings/[id]/bot/live", () => {
  it("streams status and segment upserts keyed by segment id", async () => {
    await seedLiveSession()

    const { response, controller } = await open()

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform")
    expect(response.headers.get("x-accel-buffering")).toBe("no")

    const first = await readAll(response, (text) => text.includes("event: segment"))

    expect(first).toContain(": connected")
    expect(first).toContain('event: status\ndata: {"status":"active","statusReason":null}')
    expect(first).toContain("id: s1\nevent: segment\n")
    expect(first).toContain('"final":false')

    // Same segment id, finalized text: re-emitted as an upsert; unchanged ones are not.
    segments = [
      { ...segments[0], text: "שלום לכולם", completed: true },
      { segmentId: "s2", speaker: "Avi", text: "hi", start: 3, end: 4, language: "en", completed: true },
    ]
    ticks[0]()
    await flush()

    const second = await readAll(response, (text) => text.includes("id: s2"))

    expect(second.match(/id: s1/g)).toHaveLength(1)
    expect(second).toContain('"text":"שלום לכולם"')
    expect(second).toContain('"final":true')
    expect(second).not.toContain("event: status")

    controller.abort()
  })

  it("sends end and closes when the session turns terminal", async () => {
    const session = await seedLiveSession()
    const { response } = await open()

    await readAll(response, (text) => text.includes("event: segment"))
    await store.transition(session.id, { status: "completed", at: new Date(), source: "webhook", workspaceId: WS })
    ticks[0]()
    await flush()

    const rest = await readAll(response, (text) => text.includes("event: end"))

    expect(rest).toContain('event: end\ndata: {"status":"completed","statusReason":null}')
    expect(hub.pollerCount).toBe(0)
    expect(cleared).toHaveLength(1)
  })

  it("stops the shared poller when the last client aborts", async () => {
    await seedLiveSession()

    const a = await open()
    const b = await open()

    expect(hub.pollerCount).toBe(1)
    expect(hub.streamCount).toBe(2)
    a.controller.abort()
    expect(hub.pollerCount).toBe(1)
    b.controller.abort()
    expect(hub.pollerCount).toBe(0)
    expect(cleared).toEqual([1])
  })

  it("caps concurrent streams per process (429)", async () => {
    makeHub(1)
    await seedLiveSession()

    const first = await open()
    const second = await open()

    expect(second.response.status).toBe(429)
    expect(await second.response.json()).toEqual({ error: "live_unavailable" })
    first.controller.abort()
  })

  it("is 404 live_unavailable when the flag is off or transcription is disabled", async () => {
    await seedLiveSession({ transcribeEnabled: false })

    let { response } = await open()

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: "live_unavailable" })

    vi.stubEnv("MEETSUM_LIVE_TRANSCRIPT", "false")
    ;({ response } = await open())
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: "live_unavailable" })
  })
})
