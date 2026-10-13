import { beforeEach, describe, expect, it, vi } from "vitest"

import type { EmailMessage, EmailSender } from "@/lib/email/types"
import { runIntegrationDelivery } from "@/lib/integrations/core/deliver"
import { runIntegrationDispatch } from "@/lib/integrations/core/dispatcher"
import { createEmailRecapProvider } from "@/lib/integrations/email-recap/provider"
import { verifyUnsubscribeToken } from "@/lib/integrations/email-recap/unsubscribe-token"
import { createTestRuntime, testMeetingRecord, testRule, type TestRuntime } from "@/lib/integrations/testing/harness"
import type { MeetingRecord } from "@/lib/meetings/repository"

vi.mock("@/lib/audit", () => ({ recordAuditLog: vi.fn(async () => undefined) }))

/**
 * M8 A10 email recap end to end through dispatch + deliver: per-recipient
 * idempotency on retry, `partial`, the hourly cap, opt-in modes with the
 * per-meeting override, one email per recipient, signed unsubscribe links.
 */

process.env.MEETSUM_SESSION_SECRET ??= "test-session-secret-for-integrations"

function participants(emails: string[]): MeetingRecord["participantDetails"] {
  return emails.map((email, index) => ({
    id: `p${index}`,
    meetingId: "m_a",
    name: email,
    email,
    role: "attendee",
    source: "calendar",
    attendanceStatus: "accepted",
    createdAt: "",
    updatedAt: "",
  }))
}

describe("email recap provider", () => {
  let rt: TestRuntime
  let sent: EmailMessage[]
  let failFor: Set<string>
  const env = {
    NODE_ENV: "test",
    NEXT_PUBLIC_APP_URL: "https://app.test",
    MEETSUM_SESSION_SECRET: process.env.MEETSUM_SESSION_SECRET,
    MEETSUM_EMAIL_RECAP_MAX_PER_HOUR: "200",
  } as NodeJS.ProcessEnv

  function install(overrides: Record<string, string> = {}) {
    const sender: EmailSender = {
      provider: "log",
      isConfigured: () => true,
      send: async (message) => {
        if (failFor.has(message.to)) throw new Error(`smtp 550 for ${message.to}`)
        sent.push(message)
        return { provider: "log" }
      },
    }

    rt.providers.set(
      "email",
      createEmailRecapProvider({
        store: async () => rt.store,
        sender: () => sender,
        listMembers: async (workspaceId) => (rt.members.get(workspaceId) ?? []).map(({ userId, email }) => ({ userId, email })),
        workspaceName: async () => "Acme",
        sleep: async () => undefined,
        env: { ...env, ...overrides } as NodeJS.ProcessEnv,
      })
    )
  }

  beforeEach(() => {
    sent = []
    failFor = new Set()
    rt = createTestRuntime({
      meetings: [
        testMeetingRecord({
          id: "m_a",
          participantDetails: participants(["owner@acme.test", "member@acme.test", "client@customer.com"]),
        }),
      ],
    })
    install()
  })

  async function dispatchAndDeliver(meetingId = "m_a", finalAttempt = false) {
    await runIntegrationDispatch({ workspaceId: "ws_a", eventName: "meeting.completed", eventId: `evt_${Math.random()}`, meetingId }, rt)
    const delivery = (await rt.store.listDeliveries("ws_a", { meetingId }))[0]

    return { delivery, outcome: await runIntegrationDelivery({ workspaceId: "ws_a", deliveryId: delivery.id, finalAttempt }, rt) }
  }

  it("sends nothing without the workspace rule (off by default)", async () => {
    await runIntegrationDispatch({ workspaceId: "ws_a", eventName: "meeting.completed", eventId: "e", meetingId: "m_a" }, rt)

    expect(await rt.store.listDeliveries("ws_a")).toEqual([])
    expect(sent).toEqual([])
  })

  it("sends one email per member, with a signed unsubscribe link and the headers", async () => {
    await rt.store.createRule(
      testRule({ provider: "email", destination: { provider: "email", audience: "members", mode: "all_meetings", locale: "meeting" } })
    )

    const { delivery, outcome } = await dispatchAndDeliver()

    expect(outcome).toEqual({ status: "sent" })
    expect(sent.map((message) => message.to).sort()).toEqual(["member@acme.test", "owner@acme.test"])
    for (const message of sent) {
      expect(message.subject.startsWith("סיכום פגישה:")).toBe(true)
      expect(message.html).toContain('dir="rtl"')
      expect(message.html).toContain("https://app.test/he?meeting=m_a")
      const token = new URL(/<(.+)>/.exec(message.headers?.["List-Unsubscribe"] ?? "")![1]).searchParams.get("t")

      expect(verifyUnsubscribeToken(token, env)).toMatchObject({ ws: "ws_a", e: message.to })
      // Never another recipient's address.
      expect(`${message.html}${message.text}`).not.toContain(sent.find((other) => other.to !== message.to)!.to)
    }

    const row = await rt.store.getDelivery("ws_a", delivery.id)

    expect(row?.externalRef).toEqual({ recipients: 2 })
    expect((row?.progress.sent as string[]).every((hash) => /^[0-9a-f]{64}$/.test(hash))).toBe(true)
    expect(JSON.stringify(row)).not.toMatch(/@acme\.test|@customer\.com/)
  })

  it("is idempotent per recipient on retry and ends partial when the last attempt still fails", async () => {
    await rt.store.createRule(
      testRule({ provider: "email", destination: { provider: "email", audience: "attendees", mode: "all_meetings", locale: "en" } })
    )
    failFor.add("client@customer.com")

    const { delivery, outcome } = await dispatchAndDeliver()

    expect(outcome.status).toBe("retrying")
    expect(sent).toHaveLength(2)

    failFor.clear()
    expect(await runIntegrationDelivery({ workspaceId: "ws_a", deliveryId: delivery.id, finalAttempt: false }, rt)).toEqual({ status: "sent" })
    expect(sent.map((message) => message.to)).toEqual(["owner@acme.test", "member@acme.test", "client@customer.com"])
    // Non-members get no app link.
    expect(sent[2].html).not.toContain("?meeting=m_a")

    rt.meetings.set("m_b", testMeetingRecord({ id: "m_b", participantDetails: participants(["owner@acme.test", "client@customer.com"]) }))
    failFor.add("client@customer.com")
    const second = await dispatchAndDeliver("m_b", true)

    expect(second.outcome).toEqual({ status: "partial" })
  })

  it("applies the hourly cap (partial, hourly_cap) and resumes later", async () => {
    install({ MEETSUM_EMAIL_RECAP_MAX_PER_HOUR: "1" })
    await rt.store.createRule(
      testRule({ provider: "email", destination: { provider: "email", audience: "members", mode: "all_meetings", locale: "meeting" } })
    )

    const { delivery, outcome } = await dispatchAndDeliver()

    expect(outcome).toMatchObject({ status: "retrying" })
    expect((outcome as { delayMs: number }).delayMs).toBeGreaterThanOrEqual(60_000)
    expect(sent).toHaveLength(1)
    expect(await runIntegrationDelivery({ workspaceId: "ws_a", deliveryId: delivery.id, finalAttempt: true }, rt)).toEqual({ status: "partial" })
    expect(await rt.store.getDelivery("ws_a", delivery.id)).toMatchObject({ skipReason: "hourly_cap" })
    expect(sent).toHaveLength(1)
  })

  it("honours opt_in with the per-meeting override, and off always wins", async () => {
    await rt.store.createRule(
      testRule({ provider: "email", destination: { provider: "email", audience: "members", mode: "opt_in", locale: "meeting" } })
    )

    expect((await dispatchAndDeliver()).delivery).toMatchObject({ status: "skipped", skipReason: "recap_not_opted_in" })

    rt.meetings.set("m_on", testMeetingRecord({ id: "m_on", participantDetails: participants(["owner@acme.test"]) }))
    await rt.store.upsertPrefs("ws_a", "m_on", { emailRecap: "on" })
    expect((await dispatchAndDeliver("m_on")).outcome).toEqual({ status: "sent" })

    // The pref flips to off before delivery: re-checked at deliver time.
    rt.meetings.set("m_flip", testMeetingRecord({ id: "m_flip", participantDetails: participants(["owner@acme.test"]) }))
    await rt.store.upsertPrefs("ws_a", "m_flip", { emailRecap: "on" })
    await runIntegrationDispatch({ workspaceId: "ws_a", eventName: "meeting.completed", eventId: "e_flip", meetingId: "m_flip" }, rt)
    await rt.store.upsertPrefs("ws_a", "m_flip", { emailRecap: "off" })
    const flip = (await rt.store.listDeliveries("ws_a", { meetingId: "m_flip" }))[0]

    expect(await runIntegrationDelivery({ workspaceId: "ws_a", deliveryId: flip.id, finalAttempt: false }, rt)).toEqual({ status: "skipped" })
    expect(sent).toHaveLength(1)
  })

  it("never emails a private meeting to non-members, even with attendees", async () => {
    rt.meetings.set(
      "m_private",
      testMeetingRecord({
        id: "m_private",
        visibility: "private",
        ownerUserId: "user_owner",
        participantDetails: participants(["owner@acme.test", "client@customer.com"]),
      })
    )
    await rt.store.createRule(
      testRule({
        provider: "email",
        createdByUserId: "user_owner",
        includePrivate: true,
        destination: { provider: "email", audience: "attendees", mode: "all_meetings", locale: "meeting" },
      })
    )

    await dispatchAndDeliver("m_private")

    expect(sent.map((message) => message.to)).toEqual(["owner@acme.test"])
  })

  it("skips unsubscribed addresses and reports no_recipients", async () => {
    await rt.store.createRule(
      testRule({ provider: "email", destination: { provider: "email", audience: "members", mode: "all_meetings", locale: "meeting" } })
    )
    await rt.store.addUnsubscribe("ws_a", "owner@acme.test", "link")
    await rt.store.addUnsubscribe("ws_a", "member@acme.test", "one_click")

    const { delivery } = await dispatchAndDeliver()

    expect(await rt.store.getDelivery("ws_a", delivery.id)).toMatchObject({ status: "skipped", skipReason: "no_recipients" })
    expect(sent).toEqual([])
  })
})
