import { beforeEach, describe, expect, it, vi } from "vitest"

import { recordAuditLog } from "@/lib/audit"
import { upsertConnectionFromOAuth } from "@/lib/integrations/core/connections"
import { runIntegrationDelivery } from "@/lib/integrations/core/deliver"
import { createManualDelivery, IntegrationQueueUnavailableError, retryDelivery } from "@/lib/integrations/core/deliveries"
import { runIntegrationDispatch } from "@/lib/integrations/core/dispatcher"
import { runIntegrationTick } from "@/lib/integrations/core/worker"
import type { DeliverResult, IntegrationProvider } from "@/lib/integrations/core/types"
import { createRecordingQueue, createTestRuntime, testMeetingRecord, testRule, type RecordedJob, type TestRuntime } from "@/lib/integrations/testing/harness"

vi.mock("@/lib/audit", () => ({ recordAuditLog: vi.fn(async () => undefined) }))

/**
 * M8 review: a delivery is claimed atomically with an expiring lease before
 * any external call. Two workers (or a retry and the sweeper) never deliver
 * it concurrently; a crashed worker's delivery is re-queued by the sweeper
 * after the lease expires (with a max-attempts cap); a failed claim means no
 * external call; manual sends and retries are always audited, including on
 * a queue timeout and an Idempotency-Key replay.
 */

process.env.MEETSUM_SESSION_SECRET ??= "test-session-secret-for-integrations"

describe("delivery lease", () => {
  let rt: TestRuntime
  let calls: number
  let release: (() => void) | undefined
  let connectionId: string

  beforeEach(async () => {
    vi.mocked(recordAuditLog).mockClear()
    rt = createTestRuntime({ meetings: [testMeetingRecord({ id: "m_a" })] })
    calls = 0
    release = undefined
    const provider: IntegrationProvider = {
      id: "slack",
      scope: "workspace",
      configured: () => true,
      deliver: async (): Promise<DeliverResult> => {
        calls += 1
        if (release === undefined) await new Promise<void>((resolve) => setTimeout(resolve, 20))
        return { status: "sent", externalRef: {} }
      },
    }

    rt.providers.set("slack", provider)

    const created = await upsertConnectionFromOAuth(
      {
        workspaceId: "ws_a",
        provider: "slack",
        actorUserId: "user_admin",
        exchange: { accessToken: "xoxb-fixture", scopes: [], account: { externalId: "T1", label: "Acme" } },
      },
      rt.store
    )

    if (!created.ok) throw new Error("setup")
    connectionId = created.connection.id
    await rt.store.createRule(testRule({ connectionId }))
  })

  async function queued() {
    await runIntegrationDispatch({ workspaceId: "ws_a", eventName: "meeting.completed", eventId: "evt_1", meetingId: "m_a" }, rt)
    const [delivery] = await rt.store.listDeliveries("ws_a")

    return delivery
  }

  it("two concurrent workers on the same delivery make exactly one external call", async () => {
    const delivery = await queued()
    const run = () => runIntegrationDelivery({ workspaceId: "ws_a", deliveryId: delivery.id, finalAttempt: false }, rt)

    const outcomes = await Promise.all([run(), run()])

    expect(calls).toBe(1)
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["noop", "sent"])
  })

  it("a delivery under an active lease is never claimed again (retry or sweeper)", async () => {
    const delivery = await queued()
    const claimed = await rt.store.claimDelivery("ws_a", delivery.id, new Date())

    expect(claimed?.leaseUntil).toBeDefined()
    expect(await runIntegrationDelivery({ workspaceId: "ws_a", deliveryId: delivery.id, finalAttempt: false }, rt)).toEqual({ status: "noop" })
    expect(calls).toBe(0)

    // The sweeper leaves a live lease alone.
    const jobs: RecordedJob[] = []

    await runIntegrationTick({ store: rt.store, queue: createRecordingQueue(jobs), providers: () => [] })
    expect(jobs).toEqual([])
  })

  it("a failed claim (lease write) means no external call", async () => {
    const delivery = await queued()

    vi.spyOn(rt.store, "claimDelivery").mockRejectedValueOnce(new Error("database unavailable"))

    await expect(runIntegrationDelivery({ workspaceId: "ws_a", deliveryId: delivery.id, finalAttempt: false }, rt)).rejects.toThrow()
    expect(calls).toBe(0)
  })

  it("a crashed worker's delivery is re-queued by the sweeper after the lease expires, then failed at the cap", async () => {
    const delivery = await queued()
    const start = Date.now()

    // A worker claims and crashes (never finishes).
    await rt.store.claimDelivery("ws_a", delivery.id, new Date(start))

    const jobs: RecordedJob[] = []
    const later = () => new Date(start + 60 * 60_000)

    await runIntegrationTick({ store: rt.store, queue: createRecordingQueue(jobs), providers: () => [], now: later })
    expect(jobs.map((job) => job.name)).toEqual(["integration.deliver"])
    expect(await rt.store.getDelivery("ws_a", delivery.id)).toMatchObject({ status: "retrying" })

    // At the attempts cap, an expired lease fails the delivery with a typed reason.
    await rt.store.updateDelivery("ws_a", delivery.id, { status: "queued", attempts: delivery.maxAttempts - 1 })
    await rt.store.claimDelivery("ws_a", delivery.id, new Date(start))
    await runIntegrationTick({ store: rt.store, queue: createRecordingQueue([]), providers: () => [], now: later })

    expect(await rt.store.getDelivery("ws_a", delivery.id)).toMatchObject({
      status: "failed",
      lastError: expect.stringMatching(/provider_code=lease_expired/),
    })
  })

  it("audits manual sends on success, on a queue timeout and on an Idempotency-Key replay; retries are audited too", async () => {
    vi.stubEnv("MEETSUM_QUEUE_ENQUEUE_TIMEOUT_MS", "30")
    const input = {
      workspaceId: "ws_a",
      connectionId,
      provider: "slack" as const,
      meetingId: "m_a",
      requestedByUserId: "user_me",
      clientKey: "key-1",
      request: { destination: { provider: "slack" as const, channelId: "C1", channelName: "general" }, content: testRule().content },
      actor: { workspaceId: "ws_a", actorUserId: "user_me" },
    }
    const audited = () =>
      vi.mocked(recordAuditLog).mock.calls.filter(([entry]) => (entry as { action?: string }).action === "integration.manual_send")

    await createManualDelivery(rt.store, createRecordingQueue([]), input)
    expect(audited()).toHaveLength(1)

    await createManualDelivery(rt.store, createRecordingQueue([]), input)
    expect(audited()).toHaveLength(2)

    await expect(
      createManualDelivery(rt.store, { enqueue: () => new Promise<void>(() => undefined) }, { ...input, clientKey: "key-2" })
    ).rejects.toBeInstanceOf(IntegrationQueueUnavailableError)
    expect(audited()).toHaveLength(3)

    const [failed] = await rt.store.listDeliveries("ws_a", { status: "queued" })

    await rt.store.updateDelivery("ws_a", failed.id, { status: "failed" })
    const row = (await rt.store.getDelivery("ws_a", failed.id))!

    await expect(retryDelivery(rt.store, { enqueue: () => new Promise<void>(() => undefined) }, row, input.actor)).rejects.toBeInstanceOf(
      IntegrationQueueUnavailableError
    )
    expect(vi.mocked(recordAuditLog).mock.calls.some(([entry]) => (entry as { action?: string }).action === "integration.delivery.retried")).toBe(true)
    vi.unstubAllEnvs()
  })
})
