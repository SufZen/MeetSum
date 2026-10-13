import { beforeEach, describe, expect, it, vi } from "vitest"

import { upsertConnectionFromOAuth, disconnectConnection } from "@/lib/integrations/core/connections"
import { RetryableDeliveryError, runIntegrationDelivery } from "@/lib/integrations/core/deliver"
import { runIntegrationDispatch } from "@/lib/integrations/core/dispatcher"
import { providerErrorForResponse } from "@/lib/integrations/core/errors"
import { integrationBackoffStrategy, processIntegrationJob } from "@/lib/integrations/core/worker"
import { ProviderError, type DeliverInput, type DeliverResult, type IntegrationProvider } from "@/lib/integrations/core/types"
import { createTestRuntime, testMeetingRecord, testRule, type TestRuntime } from "@/lib/integrations/testing/harness"

vi.mock("@/lib/audit", () => ({ recordAuditLog: vi.fn(async () => undefined) }))

/**
 * M8 A5 deliver: `Retry-After`, auth → unrecoverable + needs_reauth,
 * partial resume, `integration.delivery.failed` emitted without content,
 * the deliver-time privacy re-check (visibility flips), the inactive owner,
 * and a delivery after disconnect never calls the provider.
 */

process.env.MEETSUM_SESSION_SECRET ??= "test-session-secret-for-integrations"

describe("runIntegrationDelivery", () => {
  let rt: TestRuntime
  let connectionId: string
  let deliver: ReturnType<typeof vi.fn<(input: DeliverInput) => Promise<DeliverResult>>>
  let seen: DeliverInput[]

  beforeEach(async () => {
    rt = createTestRuntime({ meetings: [testMeetingRecord({ id: "m_a", title: "פגישת מכירות" })] })
    seen = []
    deliver = vi.fn(async (input: DeliverInput) => {
      seen.push(input)
      return { status: "sent", externalRef: { channel: "C1", ts: "1.0" } }
    })
    const provider: IntegrationProvider = { id: "slack", scope: "workspace", configured: () => true, deliver }

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

  it("delivers the recap with a working token and records the external ref", async () => {
    const delivery = await queued()

    expect(await runIntegrationDelivery({ workspaceId: "ws_a", deliveryId: delivery.id, finalAttempt: false }, rt)).toEqual({ status: "sent" })
    expect(await seen[0].getAccessToken()).toBe("xoxb-fixture")
    expect(seen[0].recap).toMatchObject({ meetingId: "m_a", dir: "rtl", decisions: ["להשיק בנובמבר"] })
    expect(seen[0].recap.links.meeting).toMatch(/\/he\?meeting=m_a$/)
    expect(JSON.stringify(seen[0].connection)).not.toContain("xoxb")
    expect(await rt.store.getDelivery("ws_a", delivery.id)).toMatchObject({
      status: "sent",
      attempts: 1,
      externalRef: { channel: "C1", ts: "1.0" },
    })
    // Terminal rows are a no-op.
    expect(await runIntegrationDelivery({ workspaceId: "ws_a", deliveryId: delivery.id, finalAttempt: false }, rt)).toEqual({ status: "noop" })
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it("honours Retry-After on rate limits and backs off exponentially otherwise", async () => {
    const delivery = await queued()

    deliver.mockRejectedValueOnce(
      providerErrorForResponse("slack", new Response(null, { status: 429, headers: { "retry-after": "42" } }), "ratelimited")
    )

    expect(await runIntegrationDelivery({ workspaceId: "ws_a", deliveryId: delivery.id, finalAttempt: false }, rt)).toEqual({
      status: "retrying",
      delayMs: 42_000,
    })
    expect(await rt.store.getDelivery("ws_a", delivery.id)).toMatchObject({
      status: "retrying",
      lastError: "code=unknown kind=rate_limited provider=slack status=429 provider_code=ratelimited",
    })

    deliver.mockRejectedValueOnce(new ProviderError("retryable", "503"))
    expect(await runIntegrationDelivery({ workspaceId: "ws_a", deliveryId: delivery.id, finalAttempt: false }, rt)).toEqual({
      status: "retrying",
      delayMs: 60_000,
    })
    expect(integrationBackoffStrategy(3)).toBe(120_000)
    expect(integrationBackoffStrategy(20)).toBe(3_600_000)
  })

  it("fails an auth error immediately, flags the connection and emits delivery.failed without content", async () => {
    const delivery = await queued()

    deliver.mockRejectedValueOnce(new ProviderError("auth", "token_revoked", { providerCode: "token_revoked" }))

    expect(await runIntegrationDelivery({ workspaceId: "ws_a", deliveryId: delivery.id, finalAttempt: false }, rt)).toEqual({ status: "failed" })
    expect((await rt.store.getConnection("ws_a", connectionId))?.status).toBe("needs_reauth")
    expect(rt.failures).toEqual([
      { workspaceId: "ws_a", data: { deliveryId: delivery.id, provider: "slack", meetingId: "m_a", reason: "auth" } },
    ])
    expect(JSON.stringify(rt.failures)).not.toContain("פגישת")
  })

  it("resumes from saved progress and ends partial when the last attempt still fails", async () => {
    const delivery = await queued()

    deliver.mockImplementationOnce(async (input) => {
      await input.saveProgress({ appendedBatches: 1, pageId: "p1" })
      throw new ProviderError("retryable", "batch 2 failed")
    })
    expect((await runIntegrationDelivery({ workspaceId: "ws_a", deliveryId: delivery.id, finalAttempt: false }, rt)).status).toBe("retrying")

    deliver.mockImplementationOnce(async (input) => {
      expect(input.progress).toMatchObject({ appendedBatches: 1, pageId: "p1" })
      throw new ProviderError("retryable", "still failing")
    })
    expect(await runIntegrationDelivery({ workspaceId: "ws_a", deliveryId: delivery.id, finalAttempt: true }, rt)).toEqual({ status: "partial" })
    expect(rt.failures).toEqual([])
  })

  it("re-checks privacy at deliver time: a meeting made private since dispatch is skipped", async () => {
    const delivery = await queued()

    rt.meetings.set("m_a", testMeetingRecord({ id: "m_a", visibility: "private" }))

    expect(await runIntegrationDelivery({ workspaceId: "ws_a", deliveryId: delivery.id, finalAttempt: false }, rt)).toEqual({ status: "skipped" })
    expect(await rt.store.getDelivery("ws_a", delivery.id)).toMatchObject({ skipReason: "private_meeting" })
    expect(deliver).not.toHaveBeenCalled()
  })

  it("skips when the rule owner left after dispatch", async () => {
    const delivery = await queued()

    rt.members.set("ws_a", (rt.members.get("ws_a") ?? []).filter((member) => member.userId !== "user_admin"))

    await runIntegrationDelivery({ workspaceId: "ws_a", deliveryId: delivery.id, finalAttempt: false }, rt)
    expect(await rt.store.getDelivery("ws_a", delivery.id)).toMatchObject({ status: "skipped", skipReason: "rule_owner_inactive" })
  })

  it("never calls the provider after a disconnect (queued job cancelled, running job skipped)", async () => {
    const delivery = await queued()
    const row = await rt.store.getConnection("ws_a", connectionId)

    await disconnectConnection(row!, { workspaceId: "ws_a" }, rt.store)

    expect((await rt.store.getDelivery("ws_a", delivery.id))?.status).toBe("cancelled")
    expect(await runIntegrationDelivery({ workspaceId: "ws_a", deliveryId: delivery.id, finalAttempt: false }, rt)).toEqual({ status: "noop" })

    // A job already claimed (running) when the disconnect lands is skipped too.
    const manual = await rt.store.insertDelivery({
      id: "intd_running",
      workspaceId: "ws_a",
      connectionId,
      provider: "slack",
      origin: "manual",
      meetingId: "m_a",
      idempotencyKey: "manual:x",
      status: "running",
      maxAttempts: 5,
      requestedByUserId: "user_admin",
      progress: { request: { destination: { provider: "slack", channelId: "C1", channelName: "" }, content: testRule().content } },
    })

    expect(await runIntegrationDelivery({ workspaceId: "ws_a", deliveryId: manual.delivery.id, finalAttempt: false }, rt)).toEqual({
      status: "skipped",
    })
    expect(await rt.store.getDelivery("ws_a", manual.delivery.id)).toMatchObject({ skipReason: "connection_inactive" })
    expect(deliver).not.toHaveBeenCalled()
  })

  it("never resolves another workspace's delivery id", async () => {
    const delivery = await queued()

    expect(await runIntegrationDelivery({ workspaceId: "ws_b", deliveryId: delivery.id, finalAttempt: false }, rt)).toEqual({ status: "noop" })
    expect((await rt.store.getDelivery("ws_a", delivery.id))?.status).toBe("queued")
  })

  it("throws a retryable error from the worker so BullMQ backs off", async () => {
    const delivery = await queued()

    deliver.mockRejectedValueOnce(new ProviderError("retryable", "x", { retryAfterMs: 5000 }))

    const error = await processIntegrationJob(
      { name: "integration.deliver", data: { workspaceId: "ws_a", deliveryId: delivery.id }, attemptsMade: 0, opts: { attempts: 5 } },
      { runtime: rt }
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(RetryableDeliveryError)
    expect((error as RetryableDeliveryError).delayMs).toBe(5000)
    expect(integrationBackoffStrategy(1, "integration", error as Error)).toBe(5000)

    // The final attempt stores `failed` instead of throwing.
    deliver.mockRejectedValueOnce(new ProviderError("retryable", "x"))
    expect(
      await processIntegrationJob(
        { name: "integration.deliver", data: { workspaceId: "ws_a", deliveryId: delivery.id }, attemptsMade: 4, opts: { attempts: 5 } },
        { runtime: rt }
      )
    ).toEqual({ status: "failed" })
  })
})
