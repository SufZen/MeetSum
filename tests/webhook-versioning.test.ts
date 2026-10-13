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
import type { MeetingRecord } from "@/lib/meetings/repository"
import { emitPlatformEvent, setPlatformEventDeliveryForTesting } from "@/lib/platform/emit"
import { webhookEnvelopeSchema } from "@/lib/platform/event-schemas"
import { verifyWebhookSignatureV2 } from "@/lib/platform/events"
import { deliverWebhookEvent, processWebhookDeliveryJob } from "@/lib/webhooks/delivery"
import {
  createWebhookSubscription,
  updateWebhookSubscription,
  WebhookValidationError,
} from "@/lib/webhooks/management"

/**
 * M8 C4 versioning: v1 subscriptions keep today's payloads and never get a
 * v2-only event; v2 subscriptions get the catalog envelope; subscribing to
 * an event outside the subscription's version is refused.
 */

type Sub = { id: string; url: string; events: string[]; workspace_id?: string; payload_version?: number }

function useSubscriptions(subscriptions: Sub[]) {
  query.mockImplementation(async (sql: string, values?: unknown[]) => {
    if (/from webhook_subscriptions\s+where enabled = true/.test(sql)) {
      return {
        rows: subscriptions.filter((subscription) => (subscription.workspace_id ?? "ws_1") === values?.[0]),
      }
    }
    return { rows: [] }
  })
}

function inserted() {
  return query.mock.calls
    .filter(([sql]) => /insert into webhook_deliveries/.test(sql as string))
    .map(([, values]) => {
      const row = values as unknown[]

      return { subscriptionId: row[1], payload: JSON.parse(row[4] as string), version: row[5] }
    })
}

const PUBLIC_URL = "https://93.184.216.34/hooks"

beforeEach(() => {
  vi.stubEnv("MEETSUM_STORAGE", "postgres")
  vi.stubEnv("MEETSUM_SESSION_SECRET", "test-session-secret-for-encryption")
  vi.stubEnv("WEBHOOK_SIGNING_SECRET", "global-legacy-secret")
  queueGetJob.mockResolvedValue(undefined)
  queueAdd.mockResolvedValue({ id: "job" })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  setPlatformEventDeliveryForTesting(undefined)
})

describe("deliverWebhookEvent versioning", () => {
  const v1Data = { meetingId: "meet_1", title: "Weekly", mode: "full" }
  const v2Data = {
    meetingId: "meet_1",
    title: "Weekly",
    mode: "full",
    startedAt: "2026-10-12T07:30:00.000Z",
    language: "en",
    participantCount: 2,
    actionItemCount: 0,
    url: "https://meetsum.example.com/en?meeting=meet_1",
    visibility: "workspace",
  }

  it("sends v1 subscribers the legacy envelope and v2 subscribers the catalog envelope", async () => {
    useSubscriptions([
      { id: "wh_v1", url: PUBLIC_URL, events: ["meeting.completed"] },
      { id: "wh_v2", url: PUBLIC_URL, events: ["meeting.completed"], payload_version: 2 },
    ])

    await deliverWebhookEvent({ eventName: "meeting.completed", data: v1Data, dataV2: v2Data, workspaceId: "ws_1" })

    const [v1, v2] = inserted()

    expect(v1).toMatchObject({ subscriptionId: "wh_v1", version: 1 })
    expect(Object.keys(v1.payload).sort()).toEqual(["data", "id", "name", "occurredAt", "workspace_id"])
    expect(v1.payload.data).toEqual(v1Data)

    expect(v2).toMatchObject({ subscriptionId: "wh_v2", version: 2 })
    expect(v2.payload).toMatchObject({ id: v1.payload.id, name: "meeting.completed", version: 2, workspace_id: "ws_1", data: v2Data })
    expect(webhookEnvelopeSchema("meeting.completed", 2)!.safeParse(v2.payload).success).toBe(true)
  })

  it("never sends a v2-only event to a v1 subscription", async () => {
    useSubscriptions([
      // A v1 row that somehow lists a v2 event is still skipped.
      { id: "wh_v1", url: PUBLIC_URL, events: ["clip.created"] },
      { id: "wh_v2", url: PUBLIC_URL, events: ["clip.created"], payload_version: 2 },
    ])

    await deliverWebhookEvent({
      eventName: "clip.created",
      data: { meetingId: "meet_1", clipId: "clip_1" },
      dataV2: { meetingId: "meet_1", clipId: "clip_1", workspace_id: "ws_1", visibility: "private" },
      workspaceId: "ws_1",
    })

    expect(inserted().map((row) => row.subscriptionId)).toEqual(["wh_v2"])
  })

  it("falls back to the minimal private payload when the v2 data cannot be built", async () => {
    useSubscriptions([{ id: "wh_v2", url: PUBLIC_URL, events: ["summary.created"], payload_version: 2 }])

    // No dataV2: the meeting is re-read through the (unavailable) system repository.
    await deliverWebhookEvent({
      eventName: "summary.created",
      data: { meetingId: "meet_1", title: "Secret plan", tags: ["x"] },
      workspaceId: "ws_1",
    })

    expect(inserted()[0].payload.data).toEqual({ meetingId: "meet_1", workspace_id: "ws_1", visibility: "private" })
  })
})

describe("processWebhookDeliveryJob headers", () => {
  it("sends x-meetsum-event-version 2 and a valid v2 signature for a v2 row", async () => {
    const secret = "whsec_subscription_secret_value"
    const event = {
      id: "evt_1",
      name: "clip.created",
      version: 2,
      occurredAt: "2026-10-12T10:00:00.000Z",
      workspace_id: "ws_1",
      data: { meetingId: "meet_1", clipId: "clip_1", workspace_id: "ws_1", visibility: "private" },
    }
    query.mockImplementation(async (sql: string) =>
      /from webhook_deliveries d\s+left join/.test(sql)
        ? {
            rows: [
              {
                id: "whdel_1",
                event_name: "clip.created",
                event_payload: event,
                payload_version: 2,
                status: "queued",
                subscription_id: "wh_v2",
                url: PUBLIC_URL,
                enabled: true,
                secret_ciphertext: encryptSecret(secret),
                subscription_workspace_id: "ws_1",
              },
            ],
          }
        : { rows: [] }
    )
    guardedFetch.mockResolvedValue({ ok: true, status: 200, durationMs: 1 })

    await processWebhookDeliveryJob({ deliveryId: "whdel_1", attempt: 1, maxAttempts: 3 })

    const [, init] = guardedFetch.mock.calls[0]

    expect(init.headers["x-meetsum-event-version"]).toBe("2")
    expect(init.headers["x-meetsum-signature"]).toMatch(/^[0-9a-f]{64}$/)
    expect(verifyWebhookSignatureV2(init.headers["x-meetsum-signature-v2"], init.body, secret)).toMatchObject({ ok: true })
    expect(JSON.parse(init.body)).toEqual(event)
  })
})

describe("subscription versions", () => {
  it("creates v2 subscriptions by default with every v2 event", async () => {
    query.mockImplementation(async (sql: string, values?: unknown[]) =>
      /insert into webhook_subscriptions/.test(sql)
        ? {
            rows: [
              {
                id: "wh_1",
                url: PUBLIC_URL,
                events: JSON.parse(values?.[3] as string),
                enabled: true,
                payload_version: values?.[7],
                secret_ref: "generated",
                created_at: "2026-10-12T10:00:00.000Z",
              },
            ],
          }
        : { rows: [] }
    )

    const { subscription } = await createWebhookSubscription("ws_1", { url: PUBLIC_URL })

    expect(subscription.payloadVersion).toBe(2)
    expect(subscription.events).toContain("clip.created")
    expect(subscription.events).toContain("bot.status_changed")
  })

  it("refuses a v2-only event on a v1 subscription and unknown events (400)", async () => {
    await expect(
      createWebhookSubscription("ws_1", { url: PUBLIC_URL, payloadVersion: 1, events: ["clip.created"] })
    ).rejects.toBeInstanceOf(WebhookValidationError)
    await expect(
      createWebhookSubscription("ws_1", { url: PUBLIC_URL, events: ["meeting.deleted"] })
    ).rejects.toMatchObject({ code: "event_not_in_version" })

    query.mockResolvedValue({ rows: [{ payload_version: 1 }] })
    await expect(
      updateWebhookSubscription("ws_1", "wh_1", { events: ["action_item.updated"] })
    ).rejects.toMatchObject({ code: "event_not_in_version" })
  })

  it("upgrades v1 → v2 (one-way) and refuses a downgrade", async () => {
    query.mockImplementation(async (sql: string) =>
      /select payload_version/.test(sql)
        ? { rows: [{ payload_version: 1 }] }
        : {
            rows: [
              {
                id: "wh_1",
                url: PUBLIC_URL,
                events: ["meeting.completed", "clip.created"],
                enabled: true,
                payload_version: 2,
                secret_ref: "generated",
                created_at: "2026-10-12T10:00:00.000Z",
              },
            ],
          }
    )

    const { subscription } = await updateWebhookSubscription("ws_1", "wh_1", {
      payloadVersion: 2,
      events: ["meeting.completed", "clip.created"],
    })
    const update = query.mock.calls.find(([sql]) => /update webhook_subscriptions/.test(sql as string))

    expect(update?.[0]).toContain("payload_version = $2")
    expect(subscription.payloadVersion).toBe(2)

    query.mockResolvedValue({ rows: [{ payload_version: 2 }] })
    await expect(updateWebhookSubscription("ws_1", "wh_1", { payloadVersion: 1 })).rejects.toMatchObject({
      code: "payload_version_downgrade",
    })
  })
})

describe("emitPlatformEvent", () => {
  const meeting = (visibility: MeetingRecord["visibility"]): MeetingRecord => ({
    id: "meet_1",
    workspaceId: "ws_1",
    title: "Secret plan",
    source: "upload",
    language: "en",
    status: "completed",
    retention: "audio",
    startedAt: "2026-10-12T07:30:00.000Z",
    participants: [],
    visibility,
    summary: {
      overview: "",
      decisions: [],
      actionItems: [{ id: "act_1", title: "Hidden task", status: "done" }],
    },
  })

  it("re-reads the meeting through the scoped repo and keeps private payloads minimal", async () => {
    const deliver = vi.fn().mockResolvedValue({})
    setPlatformEventDeliveryForTesting(deliver)

    await emitPlatformEvent(
      { workspaceId: "ws_1", repo: { getMeeting: async () => meeting("private") } as never },
      "action_item.updated",
      { meetingId: "meet_1", actionItemId: "act_1", changed: ["status"] }
    )

    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "action_item.updated",
        workspaceId: "ws_1",
        dataV2: { meetingId: "meet_1", actionItemId: "act_1", workspace_id: "ws_1", visibility: "private" },
      })
    )

    deliver.mockClear()
    await emitPlatformEvent(
      { workspaceId: "ws_1", repo: { getMeeting: async () => meeting("workspace") } as never },
      "action_item.updated",
      { meetingId: "meet_1", actionItemId: "act_1", changed: ["status"] }
    )

    expect(deliver.mock.calls[0][0].dataV2).toMatchObject({ title: "Hidden task", status: "done", changed: ["status"] })
  })

  it("never throws and ignores events outside the catalog", async () => {
    const deliver = vi.fn().mockRejectedValue(new Error("db down"))
    setPlatformEventDeliveryForTesting(deliver)

    await expect(
      emitPlatformEvent({ workspaceId: "ws_1" }, "bot.status_changed", { sessionId: "bot_1", status: "failed" })
    ).resolves.toBeUndefined()
    await emitPlatformEvent({ workspaceId: "ws_1" }, "agent.triggered", {})
    expect(deliver).toHaveBeenCalledTimes(1)
  })
})
