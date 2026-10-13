import { afterEach, describe, expect, it, vi } from "vitest"

import { upsertConnectionFromOAuth } from "@/lib/integrations/core/connections"
import { runIntegrationDelivery } from "@/lib/integrations/core/deliver"
import { retryDelivery } from "@/lib/integrations/core/deliveries"
import { runIntegrationDispatch } from "@/lib/integrations/core/dispatcher"
import { setIntegrationStoreForTesting } from "@/lib/integrations/core/store"
import type { DeliverResult, IntegrationProvider } from "@/lib/integrations/core/types"
import { processIntegrationJob, runIntegrationTick } from "@/lib/integrations/core/worker"
import { createRecordingQueue, createTestRuntime, testMeetingRecord, testRule, type RecordedJob } from "@/lib/integrations/testing/harness"
import { getManualExportRuntime } from "@/lib/integrations/notion/manual-export-runtime"

vi.mock("@/lib/audit", () => ({ recordAuditLog: vi.fn(async () => undefined) }))

/**
 * M8 review: every path that can reach a provider's `deliver` goes through
 * the one atomic claim in deliver.ts (BullMQ worker job, inline/memory mode
 * and the retry/sweeper re-enqueues all run `runIntegrationDelivery`; the
 * manual Notion export uses the same `claimDelivery`). Driving them all
 * concurrently against one delivery id makes exactly one provider call.
 */

process.env.MEETSUM_SESSION_SECRET ??= "test-session-secret-for-integrations"

afterEach(() => {
  setIntegrationStoreForTesting(undefined)
})

describe("one claim for every delivery path", () => {
  it("worker job, inline run, retry, sweeper and manual-export claim race: exactly one provider call", async () => {
    const rt = createTestRuntime({ meetings: [testMeetingRecord({ id: "m_a" })] })
    let calls = 0
    const provider: IntegrationProvider = {
      id: "slack",
      scope: "workspace",
      configured: () => true,
      deliver: async (): Promise<DeliverResult> => {
        calls += 1
        await new Promise((resolve) => setTimeout(resolve, 15))
        return { status: "sent", externalRef: {} }
      },
    }

    rt.providers.set("slack", provider)
    setIntegrationStoreForTesting(rt.store)

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
    await rt.store.createRule(testRule({ connectionId: created.connection.id }))
    await runIntegrationDispatch({ workspaceId: "ws_a", eventName: "meeting.completed", eventId: "evt_1", meetingId: "m_a" }, rt)

    const [delivery] = await rt.store.listDeliveries("ws_a")
    const input = { workspaceId: "ws_a", deliveryId: delivery.id }
    const sweeperJobs: RecordedJob[] = []

    const results = await Promise.all([
      // BullMQ worker job.
      processIntegrationJob({ name: "integration.deliver", data: input } as never, { runtime: rt, store: rt.store }),
      // Inline/memory mode (the inline port calls runIntegrationDelivery with finalAttempt).
      runIntegrationDelivery({ ...input, finalAttempt: true }, rt),
      // A re-enqueued retry or sweeper job lands here too.
      runIntegrationDelivery({ ...input, finalAttempt: false }, rt),
      // Manual retry: only re-queues, and never a queued/running row.
      retryDelivery(rt.store, createRecordingQueue([]), delivery, { workspaceId: "ws_a" }),
      // The sweeper leaves a live lease alone.
      runIntegrationTick({ store: rt.store, queue: createRecordingQueue(sweeperJobs), providers: () => [] }),
      // The manual export's claim (same store, same lease).
      getManualExportRuntime()!.claimManualDelivery("ws_a", delivery.id),
    ])

    expect(calls).toBe(1)
    expect(results[3]).toBeUndefined()
    expect(sweeperJobs).toEqual([])
    expect((await rt.store.getDelivery("ws_a", delivery.id))?.status).toBe("sent")
  })
})
