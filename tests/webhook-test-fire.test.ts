import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { guardedFetch } = vi.hoisted(() => ({ guardedFetch: vi.fn() }))

vi.mock("@/lib/webhooks/url-guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/webhooks/url-guard")>()),
  guardedWebhookFetch: guardedFetch,
}))

vi.mock("@/lib/auth/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/authz")>()
  const { mockAuthzModule } = await import("./helpers/route-ctx")

  return mockAuthzModule(actual)
})

vi.mock("@/lib/audit", () => ({ recordAuditLog: vi.fn() }))

import { GET as getCatalog } from "@/app/api/webhooks/catalog/route"
import { POST as postTest } from "@/app/api/webhooks/test/route"
import { WEBHOOK_EVENTS_V1, WEBHOOK_EVENTS_V2 } from "@/lib/platform/event-catalog"
import { webhookEnvelopeSchema } from "@/lib/platform/event-schemas"
import { signWebhookPayload, verifyWebhookSignatureV2 } from "@/lib/platform/events"
import { buildWebhookTestEvent, sendWebhookTest } from "@/lib/webhooks/management"

import { createTestCtx, jsonRequest, setRouteCtx } from "./helpers/route-ctx"

/**
 * M8 C4 test-fire: `POST /api/webhooks/test` sends the catalog example
 * payload of the chosen event for the subscription's version, flagged
 * `test: true`, with both signatures. The catalog endpoint lists every event.
 */
const PUBLIC_URL = "https://93.184.216.34/hooks/meetsum"
const noParams = { params: Promise.resolve({}) }

beforeEach(() => {
  vi.stubEnv("MEETSUM_STORAGE", "memory")
  vi.stubEnv("MEETSUM_RATE_LIMIT", "false")
  guardedFetch.mockResolvedValue({ ok: true, status: 200, durationMs: 2 })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  setRouteCtx(undefined)
})

describe("test-fire example payloads", () => {
  it("every event's example validates in each of its versions", () => {
    for (const name of WEBHOOK_EVENTS_V2) {
      const versions = (WEBHOOK_EVENTS_V1 as readonly string[]).includes(name) ? ([1, 2] as const) : ([2] as const)

      for (const version of versions) {
        const event = buildWebhookTestEvent(name, version, "ws_1")

        expect(event.test).toBe(true)
        expect(webhookEnvelopeSchema(name, version)!.safeParse(event).success, `${name} v${version}`).toBe(true)
      }
    }
  })

  it("refuses a v2-only event for a v1 test", () => {
    expect(() => buildWebhookTestEvent("clip.created", 1, "ws_1")).toThrow(/not available/)
  })

  it("signs an ad-hoc test with both schemes and a throwaway secret", async () => {
    const result = await sendWebhookTest("ws_1", { url: PUBLIC_URL, eventName: "clip.created" })
    const [, init] = guardedFetch.mock.calls[0]

    expect(result.payloadVersion).toBe(2)
    expect(JSON.parse(init.body)).toEqual(result.event)
    expect(init.headers["x-meetsum-event"]).toBe("clip.created")
    expect(init.headers["x-meetsum-event-version"]).toBe("2")
    expect(init.headers["x-meetsum-signature"]).toBe(signWebhookPayload(result.event as never, result.secret!))
    expect(verifyWebhookSignatureV2(init.headers["x-meetsum-signature-v2"], init.body, result.secret!)).toMatchObject({
      ok: true,
    })
  })
})

describe("routes", () => {
  it("POST /api/webhooks/test sends the example for the requested event and refuses unknown events", async () => {
    setRouteCtx(await createTestCtx({ role: "admin" }))

    const ok = await postTest(
      jsonRequest("http://localhost/api/webhooks/test", "POST", { url: PUBLIC_URL, eventName: "bot.status_changed" }),
      noParams
    )
    const body = await ok.json()

    expect(ok.status).toBe(200)
    expect(body.event).toMatchObject({ name: "bot.status_changed", version: 2, test: true })

    const bad = await postTest(
      jsonRequest("http://localhost/api/webhooks/test", "POST", { url: PUBLIC_URL, eventName: "meeting.deleted" }),
      noParams
    )

    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ error: "unknown_event" })

    const v1Only = await postTest(
      jsonRequest("http://localhost/api/webhooks/test", "POST", {
        url: PUBLIC_URL,
        eventName: "clip.created",
        payloadVersion: 1,
      }),
      noParams
    )

    expect(v1Only.status).toBe(400)
  })

  it("GET /api/webhooks/catalog lists every event with versions, example and schema (webhooks:manage)", async () => {
    setRouteCtx(await createTestCtx({ role: "member" }))
    expect((await getCatalog(new Request("http://localhost/api/webhooks/catalog"), noParams)).status).toBe(403)

    setRouteCtx(await createTestCtx({ role: "admin" }))
    const response = await getCatalog(new Request("http://localhost/api/webhooks/catalog"), noParams)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.version).toBe(2)
    expect(body.events.map((event: { name: string }) => event.name)).toEqual([...WEBHOOK_EVENTS_V2])
    expect(body.events.find((event: { name: string }) => event.name === "clip.created")).toMatchObject({
      versions: [2],
      schemaUrl: "docs/webhooks/schemas/v2/clip.created.schema.json",
      example: expect.objectContaining({ clipId: "clip_1" }),
    })
    expect(body.events.find((event: { name: string }) => event.name === "meeting.completed").versions).toEqual([1, 2])
  })
})
