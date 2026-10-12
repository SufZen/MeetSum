import { UnrecoverableError } from "bullmq"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { query, queueAdd, queueGetJob, guardedFetch } = vi.hoisted(() => ({
  query: vi.fn(),
  queueAdd: vi.fn(),
  queueGetJob: vi.fn(),
  guardedFetch: vi.fn(),
}))

vi.mock("@/lib/db/client", () => ({
  getDatabasePool: () => ({ query }),
}))

vi.mock("@/lib/jobs/queue", () => ({
  getMeetSumQueue: () => ({ add: queueAdd, getJob: queueGetJob }),
}))

vi.mock("@/lib/webhooks/url-guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/webhooks/url-guard")>()),
  guardedWebhookFetch: guardedFetch,
}))

import { encryptSecret } from "@/lib/auth/secret-crypto"
import { signWebhookPayload, type PlatformEvent } from "@/lib/platform/events"
import {
  deliverWebhookEvent,
  getWebhookDeliverySlotStats,
  processWebhookDeliveryJob,
  QUEUE_UNAVAILABLE_ERROR,
} from "@/lib/webhooks/delivery"
import { UnsafeWebhookUrlError, WebhookResolutionError } from "@/lib/webhooks/url-guard"

const event: PlatformEvent<Record<string, unknown>> = {
  id: "evt_1",
  name: "summary.created",
  occurredAt: "2026-10-12T10:00:00.000Z",
  data: { meetingId: "meet_1" },
}

type DeliveryRowOverrides = Partial<{
  status: string
  subscription_id: string | null
  url: string | null
  enabled: boolean | null
  secret_ciphertext: string | null
}>

function deliveryRow(overrides: DeliveryRowOverrides = {}) {
  return {
    id: "whdel_1",
    event_name: "summary.created",
    event_payload: event,
    status: "queued",
    subscription_id: "wh_1",
    url: "https://hooks.example.com/meetsum",
    enabled: true,
    secret_ciphertext: null,
    ...overrides,
  }
}

/** Routes SQL to canned results and records every call. */
function useDatabase(options: {
  subscriptions?: Array<{
    id: string
    url: string
    events: string[]
    workspace_id?: string
  }>
  delivery?: ReturnType<typeof deliveryRow>
}) {
  query.mockImplementation(async (sql: string, values?: unknown[]) => {
    if (/from webhook_subscriptions\s+where enabled = true/.test(sql)) {
      // Honour the mandatory workspace filter like Postgres would.
      const workspaceId = /workspace_id = \$1/.test(sql) ? values?.[0] : undefined
      return {
        rows: (options.subscriptions ?? []).filter(
          (subscription) =>
            workspaceId !== undefined &&
            (subscription.workspace_id ?? "ws_1") === workspaceId
        ),
      }
    }
    if (/from webhook_deliveries d\s+left join/.test(sql)) {
      return { rows: options.delivery ? [options.delivery] : [] }
    }
    return { rows: [] }
  })
}

function statusUpdates() {
  return query.mock.calls
    .filter(([sql]) => /set status = \$2/.test(sql as string))
    .map(([, values]) => values as unknown[])
}

function lastStatusUpdate() {
  const updates = statusUpdates()
  return updates[updates.length - 1]
}

beforeEach(() => {
  vi.stubEnv("MEETSUM_STORAGE", "postgres")
  vi.stubEnv("MEETSUM_SESSION_SECRET", "test-session-secret-for-encryption")
  vi.stubEnv("WEBHOOK_SIGNING_SECRET", "global-legacy-secret")
  vi.stubEnv("MEETSUM_WEBHOOK_MAX_ATTEMPTS", "")
  vi.stubEnv("MEETSUM_WEBHOOK_BACKOFF_MS", "")
  queueGetJob.mockResolvedValue(undefined)
  queueAdd.mockResolvedValue({ id: "job" })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe("deliverWebhookEvent", () => {
  it("fans out queued rows only to matching subscriptions and enqueues each", async () => {
    useDatabase({
      subscriptions: [
        { id: "wh_1", url: "https://a.example.com", events: ["summary.created"] },
        { id: "wh_2", url: "https://b.example.com", events: ["meeting.completed"] },
        { id: "wh_3", url: "https://c.example.com", events: ["summary.created"] },
      ],
    })

    const result = await deliverWebhookEvent({
      workspaceId: "ws_1",
      eventName: "summary.created",
      data: { meetingId: "meet_1" },
    })

    const inserts = query.mock.calls.filter(([sql]) =>
      /insert into webhook_deliveries/.test(sql as string)
    )
    expect(inserts).toHaveLength(2)
    expect(inserts.map(([, values]) => (values as unknown[])[1])).toEqual([
      "wh_1",
      "wh_3",
    ])
    expect(inserts[0][0]).toContain("'queued'")
    expect((inserts[0][1] as unknown[])[3]).toBe(6)

    expect(queueAdd).toHaveBeenCalledTimes(2)
    const [name, payload, options] = queueAdd.mock.calls[0]
    const deliveryId = (inserts[0][1] as unknown[])[0]
    expect(name).toBe("webhook.deliver")
    expect(payload).toEqual({ deliveryId })
    expect(options).toMatchObject({
      jobId: deliveryId,
      attempts: 6,
      backoff: { type: "exponential", delay: 30_000 },
    })
    expect(guardedFetch).not.toHaveBeenCalled()
    expect(result).toMatchObject({ queued: 2, delivered: 0, failed: 0 })
  })

  it("reads attempts and backoff from env", async () => {
    vi.stubEnv("MEETSUM_WEBHOOK_MAX_ATTEMPTS", "4")
    vi.stubEnv("MEETSUM_WEBHOOK_BACKOFF_MS", "1500")
    useDatabase({
      subscriptions: [
        { id: "wh_1", url: "https://a.example.com", events: ["summary.created"] },
      ],
    })

    await deliverWebhookEvent({ eventName: "summary.created", data: {}, workspaceId: "ws_1" })

    const insert = query.mock.calls.find(([sql]) =>
      /insert into webhook_deliveries/.test(sql as string)
    )
    expect((insert?.[1] as unknown[])[3]).toBe(4)
    expect(queueAdd.mock.calls[0][2]).toMatchObject({
      attempts: 4,
      backoff: { type: "exponential", delay: 1500 },
    })
  })

  it("makes one inline attempt when the queue is unavailable", async () => {
    queueAdd.mockRejectedValue(new Error("ECONNREFUSED redis"))
    guardedFetch.mockResolvedValue({ ok: true, status: 200, durationMs: 12 })
    useDatabase({
      subscriptions: [
        { id: "wh_1", url: "https://a.example.com", events: ["summary.created"] },
      ],
      delivery: deliveryRow(),
    })

    const result = await deliverWebhookEvent({
      workspaceId: "ws_1",
      eventName: "summary.created",
      data: {},
    })

    expect(guardedFetch).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ queued: 0, delivered: 1, failed: 0 })
  })

  it("records an inline failure without retrying", async () => {
    queueAdd.mockRejectedValue(new Error("ECONNREFUSED redis"))
    guardedFetch.mockResolvedValue({ ok: false, status: 503, durationMs: 5 })
    useDatabase({
      subscriptions: [
        { id: "wh_1", url: "https://a.example.com", events: ["summary.created"] },
      ],
      delivery: deliveryRow(),
    })

    const result = await deliverWebhookEvent({
      workspaceId: "ws_1",
      eventName: "summary.created",
      data: {},
    })

    expect(guardedFetch).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ delivered: 0, failed: 1 })
    expect(lastStatusUpdate()[1]).toBe("failed")
  })

  it("caps the fan-out per event", async () => {
    vi.stubEnv("MEETSUM_WEBHOOK_MAX_SUBSCRIPTIONS_PER_EVENT", "2")
    vi.spyOn(console, "warn").mockImplementation(() => {})
    useDatabase({
      subscriptions: Array.from({ length: 3 }, (_, index) => ({
        id: `wh_${index}`,
        url: `https://h${index}.example.com`,
        events: ["summary.created"],
      })),
    })

    const result = await deliverWebhookEvent({ eventName: "summary.created", data: {}, workspaceId: "ws_1" })

    const select = query.mock.calls.find(([sql]) =>
      /from webhook_subscriptions/.test(sql as string)
    )
    expect(select?.[0]).toMatch(/workspace_id = \$1/)
    expect(select?.[0]).toMatch(/events \? \$2/)
    expect(select?.[1]).toEqual(["ws_1", "summary.created", 3])
    expect(queueAdd).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ queued: 2, truncated: true })
  })

  it("bounds inline work when the queue is down", async () => {
    queueAdd.mockRejectedValue(new Error("ECONNREFUSED redis"))
    guardedFetch.mockResolvedValue({ ok: true, status: 200, durationMs: 1 })
    useDatabase({
      subscriptions: Array.from({ length: 5 }, (_, index) => ({
        id: `wh_${index}`,
        url: `https://h${index}.example.com`,
        events: ["summary.created"],
      })),
      delivery: deliveryRow(),
    })

    const result = await deliverWebhookEvent({ eventName: "summary.created", data: {}, workspaceId: "ws_1" })

    // enqueue is tried once, then skipped for the rest
    expect(queueAdd).toHaveBeenCalledTimes(1)
    expect(guardedFetch).toHaveBeenCalledTimes(2)
    const deferred = statusUpdates().filter(
      (values) => values[1] === "failed" && values[3] === QUEUE_UNAVAILABLE_ERROR
    )
    expect(deferred).toHaveLength(3)
    expect(result).toMatchObject({ queued: 0, delivered: 2, failed: 3 })
  })

  it("can disable the inline fallback entirely", async () => {
    vi.stubEnv("MEETSUM_WEBHOOK_INLINE_FALLBACK_MAX", "0")
    queueAdd.mockRejectedValue(new Error("ECONNREFUSED redis"))
    useDatabase({
      subscriptions: [
        { id: "wh_1", url: "https://a.example.com", events: ["summary.created"] },
      ],
    })

    const result = await deliverWebhookEvent({ eventName: "summary.created", data: {}, workspaceId: "ws_1" })

    expect(guardedFetch).not.toHaveBeenCalled()
    expect(result).toMatchObject({ delivered: 0, failed: 1 })
  })

  it("never delivers a W1 event to a W2 subscription", async () => {
    useDatabase({
      subscriptions: [
        {
          id: "wh_w1",
          url: "https://w1.example.com",
          events: ["summary.created"],
          workspace_id: "ws_1",
        },
        {
          id: "wh_w2",
          url: "https://w2.example.com",
          events: ["summary.created"],
          workspace_id: "ws_2",
        },
      ],
    })

    await deliverWebhookEvent({
      eventName: "summary.created",
      data: { meetingId: "meet_1" },
      workspaceId: "ws_1",
    })

    const inserts = query.mock.calls.filter(([sql]) =>
      /insert into webhook_deliveries/.test(sql as string)
    )
    expect(inserts.map(([, values]) => (values as unknown[])[1])).toEqual(["wh_w1"])
    const envelope = JSON.parse((inserts[0][1] as unknown[])[4] as string)
    expect(envelope).toMatchObject({
      name: "summary.created",
      workspace_id: "ws_1",
      data: { meetingId: "meet_1" },
    })
  })

  it("fails closed without a workspace: no subscription is even queried", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    useDatabase({
      subscriptions: [
        { id: "wh_1", url: "https://a.example.com", events: ["summary.created"] },
      ],
    })

    const result = await deliverWebhookEvent({
      eventName: "summary.created",
      data: {},
    })

    expect(result).toMatchObject({ queued: 0, delivered: 0, skipped: true })
    expect(query).not.toHaveBeenCalled()
    expect(queueAdd).not.toHaveBeenCalled()
  })

  it("skips when storage is not postgres", async () => {
    vi.stubEnv("MEETSUM_STORAGE", "memory")

    await expect(
      deliverWebhookEvent({ eventName: "summary.created", data: {}, workspaceId: "ws_1" })
    ).resolves.toMatchObject({ skipped: true })
    expect(query).not.toHaveBeenCalled()
  })
})

describe("processWebhookDeliveryJob", () => {
  const job = { deliveryId: "whdel_1", attempt: 1, maxAttempts: 3 }

  it("signs with the subscription secret and sends the MeetSum headers", async () => {
    const secret = "whsec_subscription_secret_value"
    useDatabase({
      delivery: deliveryRow({ secret_ciphertext: encryptSecret(secret) }),
    })
    guardedFetch.mockResolvedValue({ ok: true, status: 204, durationMs: 42 })

    await expect(processWebhookDeliveryJob(job)).resolves.toEqual({
      deliveryId: "whdel_1",
      status: "sent",
      responseStatus: 204,
    })

    const [url, init] = guardedFetch.mock.calls[0]
    expect(url).toBe("https://hooks.example.com/meetsum")
    expect(init.headers).toEqual({
      "content-type": "application/json",
      "x-meetsum-signature": signWebhookPayload(event, secret),
      "x-meetsum-event": "summary.created",
      "x-meetsum-delivery": "whdel_1",
    })
    expect(init.headers["x-meetsum-signature"]).not.toBe(
      signWebhookPayload(event, "global-legacy-secret")
    )
    expect(JSON.parse(init.body)).toEqual(event)
    // status, responseStatus, lastError, durationMs, delivered
    expect(lastStatusUpdate()).toEqual(["whdel_1", "sent", 204, null, 42, true])
    expect(
      query.mock.calls.some(([sql]) => /attempts = attempts \+ 1/.test(sql as string))
    ).toBe(true)
  })

  it("falls back to the global secret for legacy subscriptions", async () => {
    useDatabase({ delivery: deliveryRow({ secret_ciphertext: null }) })
    guardedFetch.mockResolvedValue({ ok: true, status: 200, durationMs: 1 })

    await processWebhookDeliveryJob(job)

    expect(guardedFetch.mock.calls[0][1].headers["x-meetsum-signature"]).toBe(
      signWebhookPayload(event, "global-legacy-secret")
    )
  })

  it("marks retrying and rethrows a retryable error before the last attempt", async () => {
    useDatabase({ delivery: deliveryRow() })
    guardedFetch.mockResolvedValue({ ok: false, status: 500, durationMs: 3 })

    const error = await processWebhookDeliveryJob(job).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(UnrecoverableError)
    expect(lastStatusUpdate()).toEqual([
      "whdel_1",
      "retrying",
      500,
      "Webhook receiver responded with HTTP 500",
      3,
      false,
    ])
  })

  it.each([408, 429, 302])("treats HTTP %i as retryable", async (status) => {
    useDatabase({ delivery: deliveryRow() })
    guardedFetch.mockResolvedValue({ ok: false, status, durationMs: 3 })

    const error = await processWebhookDeliveryJob(job).catch((e: unknown) => e)

    expect(error).not.toBeInstanceOf(UnrecoverableError)
    expect(lastStatusUpdate()[1]).toBe("retrying")
  })

  it("retries a transient DNS resolution failure instead of failing permanently", async () => {
    useDatabase({ delivery: deliveryRow() })
    guardedFetch.mockRejectedValue(
      new WebhookResolutionError("hooks.example.com", Object.assign(new Error("EAI_AGAIN"), { code: "EAI_AGAIN" }))
    )

    const error = await processWebhookDeliveryJob(job).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(UnrecoverableError)
    expect(lastStatusUpdate()[1]).toBe("retrying")
  })

  it("marks failed on the final attempt", async () => {
    useDatabase({ delivery: deliveryRow() })
    guardedFetch.mockResolvedValue({ ok: false, status: 502, durationMs: 3 })

    await expect(
      processWebhookDeliveryJob({ ...job, attempt: 3 })
    ).rejects.toThrow(/HTTP 502/)
    expect(lastStatusUpdate()[1]).toBe("failed")
  })

  it("retries network errors", async () => {
    useDatabase({ delivery: deliveryRow() })
    guardedFetch.mockRejectedValue(new Error("fetch failed"))

    const error = await processWebhookDeliveryJob(job).catch((e: unknown) => e)

    expect(error).not.toBeInstanceOf(UnrecoverableError)
    expect(lastStatusUpdate()[1]).toBe("retrying")
    expect(lastStatusUpdate()[3]).toBe("fetch failed")
  })

  it.each([400, 401, 404, 410, 422])(
    "fails permanently on HTTP %i",
    async (status) => {
      useDatabase({ delivery: deliveryRow() })
      guardedFetch.mockResolvedValue({ ok: false, status, durationMs: 3 })

      await expect(processWebhookDeliveryJob(job)).rejects.toBeInstanceOf(
        UnrecoverableError
      )
      expect(lastStatusUpdate()[1]).toBe("failed")
      expect(lastStatusUpdate()[2]).toBe(status)
    }
  )

  it("fails permanently when the URL is unsafe", async () => {
    useDatabase({ delivery: deliveryRow({ url: "https://169.254.169.254/" }) })
    guardedFetch.mockRejectedValue(
      new UnsafeWebhookUrlError("Webhook URL must not target a private or reserved address")
    )

    await expect(processWebhookDeliveryJob(job)).rejects.toBeInstanceOf(
      UnrecoverableError
    )
    expect(lastStatusUpdate()[1]).toBe("failed")
    expect(lastStatusUpdate()[3]).toMatch(/private or reserved/)
  })

  it("cancels deliveries for disabled subscriptions without sending", async () => {
    useDatabase({ delivery: deliveryRow({ enabled: false }) })

    await expect(processWebhookDeliveryJob(job)).resolves.toEqual({
      deliveryId: "whdel_1",
      status: "cancelled",
    })
    expect(guardedFetch).not.toHaveBeenCalled()
    expect(lastStatusUpdate()[1]).toBe("cancelled")
  })

  it("cancels deliveries whose subscription was deleted", async () => {
    useDatabase({
      delivery: deliveryRow({ subscription_id: null, url: null, enabled: null }),
    })

    await expect(processWebhookDeliveryJob(job)).resolves.toMatchObject({
      status: "cancelled",
    })
    expect(guardedFetch).not.toHaveBeenCalled()
  })

  it("cancels a delivery whose event belongs to another workspace than its subscription", async () => {
    useDatabase({
      delivery: {
        ...deliveryRow(),
        event_payload: { ...event, workspace_id: "ws_1" },
        subscription_workspace_id: "ws_2",
      } as ReturnType<typeof deliveryRow>,
    })

    await expect(processWebhookDeliveryJob(job)).resolves.toEqual({
      deliveryId: "whdel_1",
      status: "cancelled",
    })
    expect(guardedFetch).not.toHaveBeenCalled()
    expect(lastStatusUpdate()[1]).toBe("cancelled")
  })

  it("returns cancelled for an unknown delivery id", async () => {
    useDatabase({})

    await expect(processWebhookDeliveryJob(job)).resolves.toEqual({
      deliveryId: "whdel_1",
      status: "cancelled",
    })
    expect(guardedFetch).not.toHaveBeenCalled()
  })

  it("refuses to send once the lifetime attempt budget is spent", async () => {
    vi.stubEnv("MEETSUM_WEBHOOK_MAX_TOTAL_ATTEMPTS", "8")
    useDatabase({ delivery: { ...deliveryRow(), attempts: 8 } as ReturnType<typeof deliveryRow> })

    await expect(processWebhookDeliveryJob(job)).rejects.toBeInstanceOf(
      UnrecoverableError
    )
    expect(guardedFetch).not.toHaveBeenCalled()
    expect(lastStatusUpdate()[1]).toBe("failed")
  })

  it("limits concurrent requests per target host and overall", async () => {
    vi.stubEnv("MEETSUM_WEBHOOK_PER_HOST_CONCURRENCY", "2")
    vi.stubEnv("MEETSUM_WEBHOOK_CONCURRENCY", "3")
    const hostOf = (index: number) => (index < 4 ? "same.example.com" : `h${index}.example.com`)
    query.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (/from webhook_deliveries d\s+left join/.test(sql)) {
        const index = Number(String(values?.[0]).split("_")[1])
        return { rows: [deliveryRow({ url: `https://${hostOf(index)}/hook` })] }
      }
      return { rows: [] }
    })

    const inFlight = new Map<string, number>()
    let maxSameHost = 0
    let maxTotal = 0
    let total = 0
    const releases: Array<() => void> = []
    guardedFetch.mockImplementation(async (url: string) => {
      const host = new URL(url).host
      inFlight.set(host, (inFlight.get(host) ?? 0) + 1)
      total += 1
      maxSameHost = Math.max(maxSameHost, inFlight.get("same.example.com") ?? 0)
      maxTotal = Math.max(maxTotal, total)
      await new Promise<void>((resolve) => releases.push(resolve))
      inFlight.set(host, (inFlight.get(host) ?? 1) - 1)
      total -= 1
      return { ok: true, status: 200, durationMs: 1 }
    })

    const jobs = Array.from({ length: 6 }, (_, index) =>
      processWebhookDeliveryJob({ deliveryId: `whdel_${index}`, attempt: 1, maxAttempts: 3 })
    )

    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
    await flush()
    expect(getWebhookDeliverySlotStats().active).toBe(3)
    expect(getWebhookDeliverySlotStats().waiting).toBe(3)

    while (releases.length || getWebhookDeliverySlotStats().active) {
      releases.splice(0).forEach((release) => release())
      await flush()
    }
    await Promise.all(jobs)

    expect(maxSameHost).toBeLessThanOrEqual(2)
    expect(maxTotal).toBeLessThanOrEqual(3)
    expect(guardedFetch).toHaveBeenCalledTimes(6)
    expect(getWebhookDeliverySlotStats()).toEqual({ active: 0, waiting: 0 })
  })

  it("does not resend an already-sent delivery", async () => {
    useDatabase({ delivery: deliveryRow({ status: "sent" }) })

    await expect(processWebhookDeliveryJob(job)).resolves.toMatchObject({
      status: "sent",
    })
    expect(guardedFetch).not.toHaveBeenCalled()
  })
})
