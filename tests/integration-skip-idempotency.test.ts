import { describe, expect, it, vi } from "vitest"

import { upsertConnectionFromOAuth } from "@/lib/integrations/core/connections"
import { runIntegrationDelivery } from "@/lib/integrations/core/deliver"
import { runIntegrationDispatch } from "@/lib/integrations/core/dispatcher"
import type { DeliverResult, IntegrationProvider } from "@/lib/integrations/core/types"
import { createTestRuntime, testMeetingRecord, testRule } from "@/lib/integrations/testing/harness"

vi.mock("@/lib/audit", () => ({ recordAuditLog: vi.fn(async () => undefined) }))

/**
 * M8 e2e fix #12: a recap skipped for a missing opt-in or missing
 * recipients does not use up the rule's idempotency key, so opting in (or
 * adding recipients) and completing the meeting again sends it. A sent
 * delivery still uses the key (no duplicate post).
 */

process.env.MEETSUM_SESSION_SECRET ??= "test-session-secret-for-integrations"

describe("skipped outcomes keep the idempotency key free", () => {
  it("opting in after a skipped recap lets the next completion send it", async () => {
    const rt = createTestRuntime({ meetings: [testMeetingRecord({ id: "m_a" })] })

    await rt.store.createRule(
      testRule({ provider: "email", connectionId: null, destination: { provider: "email", audience: "members", mode: "opt_in", locale: "meeting" } })
    )

    const first = await runIntegrationDispatch({ workspaceId: "ws_a", eventName: "meeting.completed", eventId: "evt_1", meetingId: "m_a" }, rt)

    expect(first).toMatchObject({ queued: 0, skipped: 1 })

    await rt.store.upsertPrefs("ws_a", "m_a", { emailRecap: "on" })
    const again = await runIntegrationDispatch({ workspaceId: "ws_a", eventName: "meeting.completed", eventId: "evt_2", meetingId: "m_a" }, rt)

    expect(again).toMatchObject({ queued: 1, duplicates: 0 })

    // Once queued (and sent), a further completion is a duplicate.
    const third = await runIntegrationDispatch({ workspaceId: "ws_a", eventName: "meeting.completed", eventId: "evt_3", meetingId: "m_a" }, rt)

    expect(third).toMatchObject({ queued: 0, duplicates: 1 })
  })

  it("a deliver-time no_recipients skip frees the key too", async () => {
    const rt = createTestRuntime({ meetings: [testMeetingRecord({ id: "m_a" })] })
    let result: DeliverResult = { status: "skipped", skipReason: "no_recipients", externalRef: {} }
    const provider: IntegrationProvider = { id: "slack", scope: "workspace", configured: () => true, deliver: async () => result }

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
    await rt.store.createRule(testRule({ connectionId: created.connection.id }))

    await runIntegrationDispatch({ workspaceId: "ws_a", eventName: "meeting.completed", eventId: "evt_1", meetingId: "m_a" }, rt)
    const [skipped] = await rt.store.listDeliveries("ws_a")

    await runIntegrationDelivery({ workspaceId: "ws_a", deliveryId: skipped.id, finalAttempt: false }, rt)
    expect(await rt.store.getDelivery("ws_a", skipped.id)).toMatchObject({ status: "skipped", skipReason: "no_recipients" })

    result = { status: "sent", externalRef: {} }
    const again = await runIntegrationDispatch({ workspaceId: "ws_a", eventName: "meeting.completed", eventId: "evt_2", meetingId: "m_a" }, rt)

    expect(again).toMatchObject({ queued: 1, duplicates: 0 })
  })
})
