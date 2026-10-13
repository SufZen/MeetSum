import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createIntegrationWorld, hebrewMeeting, NOTION_DB, SLACK_CHANNEL, standardRules, type World } from "./helpers/integration-world"
import { createTestCtx, jsonRequest, routeParams, setRouteCtx } from "./helpers/route-ctx"

vi.mock("@/lib/auth/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/authz")>()
  const { mockAuthzModule } = await import("./helpers/route-ctx")

  return mockAuthzModule(actual)
})

vi.mock("@/lib/audit", () => ({ recordAuditLog: vi.fn(async () => undefined) }))

import { POST as retryDeliveryRoute } from "@/app/api/integrations/deliveries/[id]/retry/route"
import { POST as exportGoogleDocs } from "@/app/api/meetings/[id]/export/google-docs/route"
import { POST as exportNotion } from "@/app/api/meetings/[id]/export/notion/route"
import { PUT as putPrefs } from "@/app/api/meetings/[id]/integration-prefs/route"
import { POST as sendRoute } from "@/app/api/meetings/[id]/integrations/send/route"
import { createManualDelivery } from "@/lib/integrations/core/deliveries"
import { runIntegrationDispatch } from "@/lib/integrations/core/dispatcher"
import { getIntegrationQueuePort } from "@/lib/integrations/core/queue"
import { sealTokenSet } from "@/lib/integrations/core/tokens"
import { DEFAULT_RULE_CONTENT } from "@/lib/integrations/recap"
import { createInMemoryMeetingDatabase, type MeetingRecord } from "@/lib/meetings/repository"
import { resolveWebhookPayloadV2 } from "@/lib/platform/event-payloads"
import { resetRateLimitsForTesting } from "@/lib/rate-limit"
import type { WorkspaceRole } from "@/lib/workspaces/types"

/**
 * M8 Integration step: a private meeting never reaches any provider, the
 * email recap or a v2 webhook without its owner's opt-in, on every path:
 * rules (an admin's rule, even with includePrivate), manual sends, the
 * Notion and Google Docs exports, the delivery-log retry, and a meeting
 * that becomes private after its delivery was enqueued. The provider HTTP
 * (the fake server's log) and the email sender record nothing. The owner's
 * per-meeting opt-in lets it through; the same pref set by anyone else
 * does not.
 */

const PRIVATE = (id: string, overrides: Partial<MeetingRecord> = {}) =>
  hebrewMeeting({ id, visibility: "private", ownerUserId: "user_owner", ...overrides })

describe("private meetings never leave without the owner's opt-in", () => {
  let world: World
  const meetings = [PRIVATE("m_priv"), PRIVATE("m_priv_ok"), hebrewMeeting({ id: "m_flip" }), hebrewMeeting({ id: "m_flip_manual" })]

  async function as(role: WorkspaceRole, userId: string) {
    setRouteCtx(await createTestCtx({ role, userId, database: createInMemoryMeetingDatabase(world.rt.meetings.size ? [...world.rt.meetings.values()] : meetings) }))
  }

  const noProviderTraffic = () => {
    expect(world.server.requests().filter((request) => request.provider !== undefined)).toEqual([])
    expect(world.emails).toEqual([])
  }

  beforeEach(async () => {
    resetRateLimitsForTesting()
    world = await createIntegrationWorld(meetings)
    // The owner's personal Google Drive connection (Docs export).
    await world.store.createConnection({
      id: "intc_drive",
      workspaceId: "ws_a",
      provider: "google_drive",
      userId: "user_owner",
      status: "active",
      accountLabel: "owner drive",
      externalAccountId: "g_owner",
      scopes: [],
      ...sealTokenSet("ws_a", "intc_drive", { accessToken: "fake_google_access_token", scopes: [] }),
      config: {},
      createdByUserId: "user_owner",
    })
  })

  afterEach(async () => {
    setRouteCtx(undefined)
    await world.close()
  })

  it("skips every rule provider, email included, for an admin's rule (even with includePrivate)", async () => {
    await standardRules(world, { createdByUserId: "user_admin", includePrivate: true, filters: { visibility: ["private", "workspace", "link"] } })
    await world.dispatch("m_priv")

    const rows = await world.store.listDeliveries("ws_a")

    expect(rows).toHaveLength(4)
    expect(rows.every((row) => row.status === "skipped" && row.skipReason === "private_meeting")).toBe(true)
    noProviderTraffic()
  })

  it("delivers after the owner's per-meeting opt-in; the same pref set by a non-owner is ignored", async () => {
    // Rules that also match private meetings (the default filter is workspace + link).
    await standardRules(world, { createdByUserId: "user_admin", filters: { visibility: ["private", "workspace", "link"] } })

    // A non-owner (an admin, who cannot even see the private meeting) cannot set it through the API…
    await as("admin", "user_admin")
    expect((await putPrefs(jsonRequest("http://localhost/x", "PUT", { allowPrivatePush: true }), routeParams({ id: "m_priv" }))).status).toBe(404)

    // …and a pref recorded with another setter grants nothing.
    await world.store.upsertPrefs("ws_a", "m_priv", { allowPrivatePush: true, allowPrivateSetByUserId: "user_admin" })
    await world.dispatch("m_priv")
    expect((await world.store.listDeliveries("ws_a")).every((row) => row.skipReason === "private_meeting")).toBe(true)
    noProviderTraffic()

    // The owner opts in.
    await as("member", "user_owner")
    expect((await putPrefs(jsonRequest("http://localhost/x", "PUT", { allowPrivatePush: true }), routeParams({ id: "m_priv_ok" }))).status).toBe(200)
    await world.dispatch("m_priv_ok")

    const delivered = (await world.store.listDeliveries("ws_a")).filter((row) => row.meetingId === "m_priv_ok")

    expect(Object.fromEntries(delivered.map((row) => [row.provider, row.status]))).toMatchObject({ slack: "sent", notion: "sent", hubspot: "sent" })
    expect(world.providerRequests("slack", "chat.postMessage")).toHaveLength(1)
  })

  it("refuses manual sends and both exports of a private meeting without the opt-in, then allows them with it", async () => {
    await as("member", "user_owner")

    const send = () =>
      sendRoute(
        jsonRequest("http://localhost/x", "POST", {
          connectionId: world.connections.slack,
          destination: { provider: "slack", channelId: SLACK_CHANNEL, channelName: "general" },
        }),
        routeParams({ id: "m_priv" })
      )
    const notion = () => exportNotion(jsonRequest("http://localhost/x", "POST", { databaseId: NOTION_DB }), routeParams({ id: "m_priv" }))
    const docs = () => exportGoogleDocs(jsonRequest("http://localhost/x", "POST", {}), routeParams({ id: "m_priv" }))

    for (const call of [send, notion, docs]) {
      const response = await call()

      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: "private_meeting_not_opted_in" })
    }
    await world.drain()
    expect(await world.store.listDeliveries("ws_a")).toEqual([])
    noProviderTraffic()

    await world.store.upsertPrefs("ws_a", "m_priv", { allowPrivatePush: true, allowPrivateSetByUserId: "user_owner" })
    expect((await send()).status).toBe(202)
    expect((await notion()).status).toBe(200)
    expect((await docs()).status).toBe(200)
    await world.drain()
    expect(world.providerRequests("slack", "chat.postMessage")).toHaveLength(1)
  })

  it("skips rule and manual deliveries of a meeting made private after enqueue, and a retry of one", async () => {
    await standardRules(world, { createdByUserId: "user_admin" })
    await runIntegrationDispatch({ workspaceId: "ws_a", eventName: "meeting.completed", eventId: "evt_flip", meetingId: "m_flip" }, world.rt)
    await createManualDelivery(world.store, getIntegrationQueuePort(), {
      workspaceId: "ws_a",
      connectionId: world.connections.slack,
      provider: "slack",
      meetingId: "m_flip_manual",
      requestedByUserId: "user_admin",
      request: { destination: { provider: "slack", channelId: SLACK_CHANNEL, channelName: "general" }, content: DEFAULT_RULE_CONTENT },
    })

    world.rt.meetings.set("m_flip", PRIVATE("m_flip"))
    world.rt.meetings.set("m_flip_manual", PRIVATE("m_flip_manual"))
    await world.drain()

    const rows = await world.store.listDeliveries("ws_a")

    expect(rows).toHaveLength(5)
    expect(rows.every((row) => row.status === "skipped" && row.skipReason === "private_meeting")).toBe(true)
    noProviderTraffic()

    // A private skip is not retryable from the delivery log…
    await as("admin", "user_admin")
    expect((await retryDeliveryRoute(new Request("http://localhost/x", { method: "POST" }), routeParams({ id: rows[0]!.id }))).status).toBe(409)

    // …and a failed delivery retried after the meeting went private is skipped again.
    const failed = rows.find((row) => row.provider === "slack" && row.origin === "rule")!

    await world.store.updateDelivery("ws_a", failed.id, { status: "failed", skipReason: null })
    expect((await retryDeliveryRoute(new Request("http://localhost/x", { method: "POST" }), routeParams({ id: failed.id }))).status).toBe(202)
    await world.drain()
    expect(await world.store.getDelivery("ws_a", failed.id)).toMatchObject({ status: "skipped", skipReason: "private_meeting" })
    noProviderTraffic()
  })

  it("gives a v2 webhook only the minimal payload for a private meeting", async () => {
    const payload = await resolveWebhookPayloadV2(
      "summary.created",
      { meetingId: "m_priv", title: "פגישת סטטוס עם לקוח", overview: "סיכמנו" },
      { workspaceId: "ws_a" },
      { loadMeeting: async () => PRIVATE("m_priv") }
    )

    expect(payload).toEqual({ meetingId: "m_priv", workspace_id: "ws_a", visibility: "private" })
  })
})
