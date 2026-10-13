import { beforeEach, describe, expect, it, vi } from "vitest"

import { enqueueIntegrationEvent } from "@/lib/integrations/core/dispatch-hook"
import { runIntegrationDispatch } from "@/lib/integrations/core/dispatcher"
import { createRecordingQueue, createTestRuntime, testMeetingRecord, testRule, type RecordedJob, type TestRuntime } from "@/lib/integrations/testing/harness"

vi.mock("@/lib/audit", () => ({ recordAuditLog: vi.fn(async () => undefined) }))

/**
 * M8 A4 dispatcher: idempotent on a duplicate event and on reprocessing, a
 * W1 event never creates a W2 delivery, the 50-rule cap, privacy skip
 * (`private_meeting`), inactive owner (rule disabled), connection states,
 * email recap modes, and the hook only enqueues rule triggers.
 */

describe("runIntegrationDispatch", () => {
  let rt: TestRuntime
  let connectionId: string

  beforeEach(async () => {
    rt = createTestRuntime({
      meetings: [
        testMeetingRecord({ id: "m_a" }),
        testMeetingRecord({ id: "m_private", visibility: "private", ownerUserId: "user_owner" }),
        testMeetingRecord({ id: "m_b", workspaceId: "ws_b" }),
      ],
    })
    const created = await rt.store.createConnection({
      id: "intc_a",
      workspaceId: "ws_a",
      provider: "slack",
      status: "active",
      accountLabel: "Acme",
      externalAccountId: "T1",
      scopes: [],
      config: {},
    })

    connectionId = created.ok ? created.connection.id : ""
    await rt.store.createConnection({
      id: "intc_b",
      workspaceId: "ws_b",
      provider: "slack",
      status: "active",
      accountLabel: "Other",
      externalAccountId: "T2",
      scopes: [],
      config: {},
    })
  })

  const event = (overrides: Partial<Parameters<typeof runIntegrationDispatch>[0]> = {}) => ({
    workspaceId: "ws_a",
    eventName: "meeting.completed",
    eventId: `evt_${Math.random()}`,
    meetingId: "m_a",
    ...overrides,
  })

  it("queues one delivery per matching rule and enqueues its deliver job", async () => {
    await rt.store.createRule(testRule({ connectionId }))

    expect(await runIntegrationDispatch(event(), rt)).toEqual({ queued: 1, skipped: 0, duplicates: 0 })

    const [delivery] = await rt.store.listDeliveries("ws_a")

    expect(delivery).toMatchObject({ status: "queued", origin: "rule", provider: "slack", meetingId: "m_a" })
    expect(delivery.idempotencyKey).toMatch(/^rule:intr_t\d+:meeting\.completed:m_a$/)
    expect(rt.jobs).toEqual([{ name: "integration.deliver", payload: { workspaceId: "ws_a", deliveryId: delivery.id }, jobId: delivery.id }])
  })

  it("is idempotent on a duplicate event and on reprocessing (new event id)", async () => {
    await rt.store.createRule(testRule({ connectionId }))

    const first = event()

    await runIntegrationDispatch(first, rt)
    expect(await runIntegrationDispatch(first, rt)).toEqual({ queued: 0, skipped: 0, duplicates: 1 })
    expect(await runIntegrationDispatch(event(), rt)).toEqual({ queued: 0, skipped: 0, duplicates: 1 })
    expect(await rt.store.listDeliveries("ws_a")).toHaveLength(1)
    expect(rt.jobs).toHaveLength(1)
  })

  it("keys action-item events per action item", async () => {
    await rt.store.createRule(testRule({ connectionId, trigger: "action_item.created" }))

    await runIntegrationDispatch(event({ eventName: "action_item.created", actionItemId: "ai_1" }), rt)
    await runIntegrationDispatch(event({ eventName: "action_item.created", actionItemId: "ai_2" }), rt)

    expect((await rt.store.listDeliveries("ws_a")).map((row) => row.idempotencyKey).sort()).toEqual([
      expect.stringMatching(/:m_a:ai_1$/),
      expect.stringMatching(/:m_a:ai_2$/),
    ])
  })

  it("never creates a W2 delivery from a W1 event, nor reads a W2 meeting", async () => {
    await rt.store.createRule(testRule({ connectionId }))
    await rt.store.createRule(testRule({ workspaceId: "ws_b", connectionId: "intc_b", createdByUserId: "user_b" }))

    await runIntegrationDispatch(event(), rt)
    await runIntegrationDispatch(event({ meetingId: "m_b" }), rt)

    expect(await rt.store.listDeliveries("ws_b")).toHaveLength(0)
    expect((await rt.store.listDeliveries("ws_a")).every((row) => row.meetingId === "m_a")).toBe(true)
  })

  it("evaluates at most 50 rules per event", async () => {
    for (let index = 0; index < 50; index += 1) await rt.store.createRule(testRule({ connectionId }))

    expect((await runIntegrationDispatch(event(), rt)).queued).toBe(50)
  })

  it("skips a private meeting for an admin's rule and never enqueues it", async () => {
    await rt.store.createRule(testRule({ connectionId, includePrivate: true, createdByUserId: "user_admin" }))

    await runIntegrationDispatch(event({ meetingId: "m_private" }), rt)

    expect(await rt.store.listDeliveries("ws_a")).toEqual([expect.objectContaining({ status: "skipped", skipReason: "private_meeting" })])
    expect(rt.jobs).toHaveLength(0)
  })

  it("queues a private meeting for the owner's include_private rule or the owner's meeting pref", async () => {
    await rt.store.createRule(testRule({ connectionId, includePrivate: true, createdByUserId: "user_owner" }))
    await rt.store.createRule(testRule({ connectionId, createdByUserId: "user_admin" }))
    await rt.store.upsertPrefs("ws_a", "m_private", { allowPrivatePush: true, allowPrivateSetByUserId: "user_owner" })

    expect(await runIntegrationDispatch(event({ meetingId: "m_private" }), rt)).toMatchObject({ queued: 1, skipped: 1 })
    // The admin rule passed privacy (owner pref) but its default visibility filter excludes private.
    expect((await rt.store.listDeliveries("ws_a")).map((row) => row.skipReason ?? row.status).sort()).toEqual(["filtered", "queued"])
  })

  it("skips and disables a rule whose creator left the workspace", async () => {
    const created = await rt.store.createRule(testRule({ connectionId, createdByUserId: "user_gone" }))

    await runIntegrationDispatch(event(), rt)

    expect(await rt.store.listDeliveries("ws_a")).toEqual([expect.objectContaining({ status: "skipped", skipReason: "rule_owner_inactive" })])
    expect(await rt.store.getRule("ws_a", created.ok ? created.rule.id : "")).toMatchObject({
      enabled: false,
      disabledReason: "rule_owner_inactive",
    })
  })

  it("skips rules whose connection needs reauth", async () => {
    await rt.store.createRule(testRule({ connectionId }))
    await rt.store.updateConnection("ws_a", connectionId, { status: "needs_reauth" })

    await runIntegrationDispatch(event(), rt)

    expect(await rt.store.listDeliveries("ws_a")).toEqual([expect.objectContaining({ status: "skipped", skipReason: "needs_reauth" })])
  })

  it("applies email recap modes: off wins, opt_in needs the meeting pref", async () => {
    await rt.store.createRule(
      testRule({ provider: "email", destination: { provider: "email", audience: "members", mode: "opt_in", locale: "meeting" } })
    )

    await runIntegrationDispatch(event(), rt)
    expect((await rt.store.listDeliveries("ws_a"))[0]).toMatchObject({ status: "skipped", skipReason: "recap_not_opted_in" })

    rt.meetings.set("m_on", testMeetingRecord({ id: "m_on" }))
    await rt.store.upsertPrefs("ws_a", "m_on", { emailRecap: "on" })
    await runIntegrationDispatch(event({ meetingId: "m_on" }), rt)
    expect((await rt.store.listDeliveries("ws_a", { meetingId: "m_on" }))[0]).toMatchObject({ status: "queued" })

    await rt.store.createRule(
      testRule({ provider: "email", destination: { provider: "email", audience: "members", mode: "all_meetings", locale: "meeting" } })
    )
    rt.meetings.set("m_off", testMeetingRecord({ id: "m_off" }))
    await rt.store.upsertPrefs("ws_a", "m_off", { emailRecap: "off" })
    await runIntegrationDispatch(event({ meetingId: "m_off" }), rt)
    expect((await rt.store.listDeliveries("ws_a", { meetingId: "m_off" }))[0]).toMatchObject({ status: "skipped", skipReason: "recap_off" })
  })

  it("ignores non-trigger events", async () => {
    await rt.store.createRule(testRule({ connectionId }))
    expect(await runIntegrationDispatch(event({ eventName: "clip.created" }), rt)).toEqual({ queued: 0, skipped: 0, duplicates: 0 })
  })
})

describe("enqueueIntegrationEvent", () => {
  it("enqueues only rule triggers, with the dispatch job id, and never throws", async () => {
    const jobs: RecordedJob[] = []
    const queue = createRecordingQueue(jobs)

    await enqueueIntegrationEvent({ workspaceId: "ws_a", eventName: "meeting.completed", eventId: "evt_1", meetingId: "m_a" }, queue)
    await enqueueIntegrationEvent({ workspaceId: "ws_a", eventName: "agent.triggered", eventId: "evt_2", meetingId: "m_a" }, queue)
    await enqueueIntegrationEvent(
      { workspaceId: "ws_a", eventName: "summary.created", eventId: "evt_3", meetingId: "m_a" },
      { enqueue: async () => { throw new Error("redis down") } }
    )

    expect(jobs).toEqual([
      {
        name: "integration.dispatch",
        payload: { workspaceId: "ws_a", eventName: "meeting.completed", eventId: "evt_1", meetingId: "m_a" },
        jobId: "integration.dispatch:evt_1",
      },
    ])
  })
})
