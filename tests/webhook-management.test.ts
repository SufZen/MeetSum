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

vi.mock("@/lib/auth/authz", async (importOriginal) => mockAuthzModule(importOriginal))

vi.mock("@/lib/audit", () => ({ recordAuditLog: async () => undefined }))

import { mockAuthzModule, testAuthContext, testAuthState } from "./helpers/auth-context"
import { DELETE, PATCH } from "@/app/api/webhooks/subscriptions/[id]/route"
import {
  GET as getSubscriptions,
  POST as postSubscription,
} from "@/app/api/webhooks/subscriptions/route"
import { decryptSecret, encryptSecret } from "@/lib/auth/secret-crypto"
import { signWebhookPayload } from "@/lib/platform/events"
import {
  createWebhookSubscription,
  deleteWebhookSubscription,
  listWebhookDeliveries,
  listWebhookSubscriptions,
  retryWebhookDelivery,
  sendWebhookTest,
  updateWebhookSubscription,
  WebhookNotFoundError,
} from "@/lib/webhooks/management"
import { UnsafeWebhookUrlError } from "@/lib/webhooks/url-guard"

const PUBLIC_URL = "https://93.184.216.34/hooks/meetsum"
const noParams = { params: Promise.resolve({}) }
const GET = (request: Request) => getSubscriptions(request, noParams)
const POST = (request: Request) => postSubscription(request, noParams)

function subscriptionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "wh_1",
    url: PUBLIC_URL,
    events: ["summary.created"],
    enabled: true,
    secret_ref: "generated",
    created_at: "2026-10-12T10:00:00.000Z",
    updated_at: "2026-10-12T10:00:00.000Z",
    ...overrides,
  }
}

function callsMatching(pattern: RegExp) {
  return query.mock.calls.filter(([sql]) => pattern.test(sql as string))
}

beforeEach(() => {
  vi.stubEnv("MEETSUM_SESSION_SECRET", "test-session-secret-for-encryption")
  vi.stubEnv("WEBHOOK_SIGNING_SECRET", "global-legacy-secret")
  vi.stubEnv("MEETSUM_RATE_LIMIT", "false")
  queueGetJob.mockResolvedValue(undefined)
  queueAdd.mockResolvedValue({ id: "job" })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe("webhook subscription management (postgres)", () => {
  beforeEach(() => {
    vi.stubEnv("MEETSUM_STORAGE", "postgres")
  })

  it("generates a whsec_ secret, stores it encrypted, and returns it once", async () => {
    query.mockImplementation(async (sql: string) =>
      /insert into webhook_subscriptions/.test(sql)
        ? { rows: [subscriptionRow()] }
        : { rows: [] }
    )

    const result = await createWebhookSubscription("ws_1", {
      url: PUBLIC_URL,
      events: ["summary.created"],
    })

    expect(result.secret).toMatch(/^whsec_[A-Za-z0-9_-]{32}$/)
    expect(result.subscription).not.toHaveProperty("secret")
    const [, values] = callsMatching(/insert into webhook_subscriptions/)[0]
    const [, workspaceId, url, , secretRef, secretHash, ciphertext] =
      values as string[]
    expect(workspaceId).toBe("ws_1")
    expect(url).toBe(PUBLIC_URL)
    expect(secretRef).toBe("generated")
    expect(secretHash).not.toContain(result.secret)
    expect(ciphertext).not.toContain(result.secret)
    expect(decryptSecret(ciphertext)).toBe(result.secret)
  })

  it("accepts a provided secret of at least 16 characters", async () => {
    query.mockResolvedValue({ rows: [subscriptionRow({ secret_ref: "provided" })] })

    const result = await createWebhookSubscription("ws_1", {
      url: PUBLIC_URL,
      secret: "operator-chosen-secret",
    })

    expect(result.secret).toBe("operator-chosen-secret")
    const [, values] = callsMatching(/insert into webhook_subscriptions/)[0]
    expect((values as string[])[4]).toBe("provided")
    expect(decryptSecret((values as string[])[6])).toBe("operator-chosen-secret")
  })

  it("rejects a provided secret shorter than 16 characters", async () => {
    await expect(
      createWebhookSubscription("ws_1", { url: PUBLIC_URL, secret: "too-short" })
    ).rejects.toThrow(/at least 16 characters/)
    expect(query).not.toHaveBeenCalled()
  })

  it.each([
    "https://169.254.169.254/latest/meta-data",
    "https://10.0.0.5/hook",
    "https://127.0.0.1/hook",
    "https://[::1]/hook",
    "https://localhost/hook",
    "https://user:pw@93.184.216.34/hook",
  ])("rejects unsafe URL %s before writing", async (url) => {
    await expect(createWebhookSubscription("ws_1", { url })).rejects.toBeInstanceOf(
      UnsafeWebhookUrlError
    )
    expect(query).not.toHaveBeenCalled()
  })

  it("rotates the secret and returns the new one", async () => {
    query.mockResolvedValue({ rows: [subscriptionRow()] })

    const result = await updateWebhookSubscription("ws_1", "wh_1", { rotateSecret: true })

    expect(result.secret).toMatch(/^whsec_/)
    const [sql, values] = callsMatching(/update webhook_subscriptions/)[0]
    expect(sql).toContain("secret_ciphertext = $1")
    expect(sql).toContain("secret_ref = 'generated'")
    expect(decryptSecret((values as string[])[0])).toBe(result.secret)
  })

  it("updates url, enabled and events without exposing the secret", async () => {
    query.mockResolvedValue({ rows: [subscriptionRow({ enabled: false })] })

    const result = await updateWebhookSubscription("ws_1", "wh_1", {
      url: "https://93.184.216.35/new",
      enabled: false,
      events: ["meeting.completed"],
    })

    expect(result.secret).toBeUndefined()
    const [sql, values] = callsMatching(/update webhook_subscriptions/)[0]
    expect(sql).toContain("url = $1")
    expect(sql).toContain("enabled = $2")
    expect(sql).toContain("events = $3::jsonb")
    expect(sql).not.toContain("secret_ciphertext")
    expect(values).toEqual([
      "https://93.184.216.35/new",
      false,
      JSON.stringify(["meeting.completed"]),
      "wh_1",
      "ws_1",
    ])
    expect(sql).toContain("where id = $4 and workspace_id = $5")
  })

  it("rejects an update to a private URL", async () => {
    await expect(
      updateWebhookSubscription("ws_1", "wh_1", { url: "https://192.168.1.10/x" })
    ).rejects.toBeInstanceOf(UnsafeWebhookUrlError)
    expect(query).not.toHaveBeenCalled()
  })

  it("reports unknown subscriptions as not found on update", async () => {
    query.mockResolvedValue({ rows: [] })

    await expect(
      updateWebhookSubscription("ws_1", "wh_missing", { enabled: true })
    ).rejects.toBeInstanceOf(WebhookNotFoundError)
  })

  it("deletes a subscription together with its deliveries", async () => {
    query.mockResolvedValue({ rows: [{ id: "wh_1" }] })

    await expect(deleteWebhookSubscription("ws_1", "wh_1")).resolves.toEqual({
      id: "wh_1",
      deleted: true,
    })
    const [sql, values] = query.mock.calls[0]
    expect(sql).toMatch(/where id = \$1 and workspace_id = \$2/)
    expect(sql).toMatch(/delete from webhook_deliveries/)
    expect(sql).toMatch(/delete from webhook_subscriptions/)
    expect(values).toEqual(["wh_1", "ws_1"])
  })

  it("reports a missing subscription on delete", async () => {
    query.mockResolvedValue({ rows: [] })

    await expect(deleteWebhookSubscription("ws_1", "wh_missing")).rejects.toBeInstanceOf(
      WebhookNotFoundError
    )
  })

  it("resets a failed delivery to queued and enqueues it", async () => {
    query.mockImplementation(async (sql: string) => {
      if (/select d.id, d.status, d.attempts, s.enabled/.test(sql)) {
        return { rows: [{ id: "whdel_1", status: "failed", attempts: 6, enabled: true }] }
      }
      if (/select d.id, d.webhook_subscription_id/.test(sql)) {
        return {
          rows: [
            {
              id: "whdel_1",
              webhook_subscription_id: "wh_1",
              subscription_url: PUBLIC_URL,
              event_name: "summary.created",
              status: "queued",
              attempts: 6,
              max_attempts: 6,
              response_status: 500,
              last_error: null,
              created_at: "2026-10-12T10:00:00.000Z",
            },
          ],
        }
      }
      return { rows: [] }
    })

    const delivery = await retryWebhookDelivery("ws_1", "whdel_1")

    expect(delivery).toMatchObject({ id: "whdel_1", status: "queued", maxAttempts: 6 })
    const [sql] = callsMatching(/set status = 'queued'/)[0]
    expect(sql).toContain("last_error = null")
    expect(queueAdd).toHaveBeenCalledWith(
      "webhook.deliver",
      { deliveryId: "whdel_1" },
      expect.objectContaining({ jobId: "whdel_1", attempts: 6 })
    )
    expect(guardedFetch).not.toHaveBeenCalled()
  })

  it("refuses to retry an already-sent delivery", async () => {
    query.mockResolvedValue({
      rows: [{ id: "whdel_1", status: "sent", attempts: 1, enabled: true }],
    })

    await expect(retryWebhookDelivery("ws_1", "whdel_1")).rejects.toThrow(/already sent/)
    expect(queueAdd).not.toHaveBeenCalled()
  })

  it("refuses to retry a delivery that is still in progress", async () => {
    query.mockResolvedValue({
      rows: [{ id: "whdel_1", status: "retrying", attempts: 2, enabled: true }],
    })

    await expect(retryWebhookDelivery("ws_1", "whdel_1")).rejects.toThrow(/in progress/)
    expect(queueAdd).not.toHaveBeenCalled()
  })

  it("only grants the remaining lifetime attempt budget on retry", async () => {
    query.mockImplementation(async (sql: string) => {
      if (/select d.id, d.status, d.attempts, s.enabled/.test(sql)) {
        return { rows: [{ id: "whdel_1", status: "failed", attempts: 17, enabled: true }] }
      }
      if (/select d.id, d.webhook_subscription_id/.test(sql)) {
        return { rows: [{ id: "whdel_1", webhook_subscription_id: "wh_1", subscription_url: PUBLIC_URL, event_name: "summary.created", status: "queued", attempts: 17, response_status: null, last_error: null, created_at: "2026-10-12T10:00:00.000Z" }] }
      }
      return { rows: [] }
    })

    await retryWebhookDelivery("ws_1", "whdel_1")

    const [, values] = callsMatching(/set status = 'queued'/)[0]
    expect(values).toEqual(["whdel_1", 3])
    expect(queueAdd.mock.calls[0][2]).toMatchObject({ attempts: 3 })
  })

  it("refuses to retry once the lifetime attempt budget is spent", async () => {
    vi.stubEnv("MEETSUM_WEBHOOK_MAX_TOTAL_ATTEMPTS", "10")
    query.mockResolvedValue({
      rows: [{ id: "whdel_1", status: "failed", attempts: 10, enabled: true }],
    })

    await expect(retryWebhookDelivery("ws_1", "whdel_1")).rejects.toThrow(/exhausted/)
    expect(queueAdd).not.toHaveBeenCalled()
  })

  it("signs subscription test sends with the subscription secret via the guard", async () => {
    const secret = "whsec_subscription_specific_secret"
    query.mockResolvedValue({
      rows: [{ url: PUBLIC_URL, enabled: true, secret_ciphertext: encryptSecret(secret) }],
    })
    guardedFetch.mockResolvedValue({ ok: true, status: 200, durationMs: 4 })

    const result = await sendWebhookTest("ws_1", { subscriptionId: "wh_1" })

    expect(result).toMatchObject({ url: PUBLIC_URL, status: "sent", responseStatus: 200 })
    const [url, init] = guardedFetch.mock.calls[0]
    expect(url).toBe(PUBLIC_URL)
    expect(init.headers["x-meetsum-signature"]).toBe(
      signWebhookPayload(result.event, secret)
    )
    expect(init.headers["x-meetsum-event"]).toBe("meeting.completed")
  })

  it("scopes every lookup to the caller's workspace", async () => {
    query.mockResolvedValue({ rows: [] })

    await expect(
      updateWebhookSubscription("ws_2", "wh_1", { enabled: false })
    ).rejects.toBeInstanceOf(WebhookNotFoundError)
    await expect(deleteWebhookSubscription("ws_2", "wh_1")).rejects.toBeInstanceOf(
      WebhookNotFoundError
    )
    await expect(retryWebhookDelivery("ws_2", "whdel_1")).rejects.toBeInstanceOf(
      WebhookNotFoundError
    )
    await expect(
      sendWebhookTest("ws_2", { subscriptionId: "wh_1" })
    ).rejects.toBeInstanceOf(WebhookNotFoundError)
    await listWebhookSubscriptions("ws_2")
    await listWebhookDeliveries("ws_2", { subscriptionId: "wh_1" })

    for (const [sql, values] of query.mock.calls) {
      expect(sql).toMatch(/workspace_id = \$\d/)
      expect(values).toContain("ws_2")
    }
    expect(guardedFetch).not.toHaveBeenCalled()
  })

  it("rejects test sends to private URLs", async () => {
    await expect(
      sendWebhookTest("ws_1", { url: "https://169.254.169.254/latest" })
    ).rejects.toBeInstanceOf(UnsafeWebhookUrlError)
    expect(guardedFetch).not.toHaveBeenCalled()
  })
})

describe("webhook subscription routes (memory storage)", () => {
  beforeEach(() => {
    vi.stubEnv("MEETSUM_STORAGE", "memory")
  })

  beforeEach(() => {
    testAuthState.ctx = testAuthContext({ workspaceId: "ws_1", role: "admin" })
  })

  function jsonRequest(url: string, method: string, body?: unknown) {
    return new Request(url, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  it("returns the secret only in the create response", async () => {
    const created = await POST(
      jsonRequest("http://localhost/api/webhooks/subscriptions", "POST", {
        url: PUBLIC_URL,
        events: ["summary.created"],
      })
    )
    const createdBody = await created.json()

    expect(created.status).toBe(201)
    expect(createdBody.secret).toMatch(/^whsec_/)
    expect(createdBody.signature).toBe(
      signWebhookPayload(createdBody.testEvent, createdBody.secret)
    )

    const listed = await GET(new Request("http://localhost/api/webhooks/subscriptions"))
    const listedText = await listed.text()

    expect(listedText).toContain(createdBody.subscription.id)
    expect(listedText).not.toContain(createdBody.secret)

    const params = { params: Promise.resolve({ id: createdBody.subscription.id }) }
    const rotated = await PATCH(
      jsonRequest("http://localhost/x", "PATCH", { rotateSecret: true }),
      params
    )
    const rotatedBody = await rotated.json()

    expect(rotated.status).toBe(200)
    expect(rotatedBody.secret).toMatch(/^whsec_/)
    expect(rotatedBody.secret).not.toBe(createdBody.secret)

    const paused = await PATCH(
      jsonRequest("http://localhost/x", "PATCH", { enabled: false }),
      params
    )
    const pausedBody = await paused.json()
    expect(pausedBody.subscription.enabled).toBe(false)
    expect(pausedBody).not.toHaveProperty("secret")

    const deleted = await DELETE(new Request("http://localhost/x", { method: "DELETE" }), params)
    expect(deleted.status).toBe(200)

    const deletedAgain = await DELETE(
      new Request("http://localhost/x", { method: "DELETE" }),
      params
    )
    expect(deletedAgain.status).toBe(404)
  })

  it("hides another workspace's subscriptions (list, patch and delete → 404)", async () => {
    const created = await POST(
      jsonRequest("http://localhost/api/webhooks/subscriptions", "POST", {
        url: PUBLIC_URL,
      })
    )
    const { subscription } = await created.json()

    testAuthState.ctx = testAuthContext({ workspaceId: "ws_2", role: "owner" })
    const listed = await (
      await GET(new Request("http://localhost/api/webhooks/subscriptions"))
    ).json()
    expect(listed.subscriptions.map((item: { id: string }) => item.id)).not.toContain(
      subscription.id
    )

    const params = { params: Promise.resolve({ id: subscription.id }) }
    const patched = await PATCH(
      jsonRequest("http://localhost/x", "PATCH", { enabled: false }),
      params
    )
    expect(patched.status).toBe(404)
    const deleted = await DELETE(
      new Request("http://localhost/x", { method: "DELETE" }),
      params
    )
    expect(deleted.status).toBe(404)

    testAuthState.ctx = testAuthContext({ workspaceId: "ws_1", role: "admin" })
    const stillThere = await (
      await GET(new Request("http://localhost/api/webhooks/subscriptions"))
    ).json()
    expect(
      stillThere.subscriptions.find((item: { id: string }) => item.id === subscription.id)
        ?.enabled
    ).toBe(true)
  })

  it("requires webhooks:manage (members get 403)", async () => {
    testAuthState.ctx = testAuthContext({ workspaceId: "ws_1", role: "member" })

    const response = await GET(new Request("http://localhost/api/webhooks/subscriptions"))

    expect(response.status).toBe(403)
    expect(testAuthState.permissions).toContain("webhooks:manage")
  })

  it("answers 400 for a private webhook URL", async () => {
    const response = await POST(
      jsonRequest("http://localhost/api/webhooks/subscriptions", "POST", {
        url: "https://169.254.169.254/latest/meta-data",
      })
    )

    expect(response.status).toBe(400)
    expect((await response.json()).error).toMatch(/private or reserved/)
  })
})
