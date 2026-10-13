import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createTestCtx, jsonRequest, routeParams, setRouteCtx, testMeeting } from "./helpers/route-ctx"

vi.mock("@/lib/auth/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/authz")>()
  const { mockAuthzModule } = await import("./helpers/route-ctx")

  return mockAuthzModule(actual)
})

const recordAuditLog = vi.hoisted(() => vi.fn(async (input: unknown) => void input))

vi.mock("@/lib/audit", () => ({ recordAuditLog }))

import { GET as listConnections } from "@/app/api/integrations/connections/route"
import { DELETE as deleteConnection, PATCH as patchConnection } from "@/app/api/integrations/connections/[id]/route"
import { GET as pickerOptions } from "@/app/api/integrations/connections/[id]/options/[picker]/route"
import { GET as listDeliveries } from "@/app/api/integrations/deliveries/route"
import { GET as getDelivery } from "@/app/api/integrations/deliveries/[id]/route"
import { POST as retryDelivery } from "@/app/api/integrations/deliveries/[id]/retry/route"
import { GET as listProviders } from "@/app/api/integrations/providers/route"
import { GET as listRules, POST as createRule } from "@/app/api/integrations/rules/route"
import { DELETE as deleteRule, PATCH as patchRule } from "@/app/api/integrations/rules/[id]/route"
import { GET as getPrefs, PUT as putPrefs } from "@/app/api/meetings/[id]/integration-prefs/route"
import { POST as sendToIntegration } from "@/app/api/meetings/[id]/integrations/send/route"
import { setProviderTransportForTesting } from "@/lib/integrations/core/http"
import { setIntegrationQueuePortForTesting } from "@/lib/integrations/core/queue"
import { setIntegrationStoreForTesting, type IntegrationStore } from "@/lib/integrations/core/store"
import { createMemoryIntegrationStore } from "@/lib/integrations/core/store-memory"
import { sealTokenSet } from "@/lib/integrations/core/tokens"
import { createRecordingQueue, testRule, type RecordedJob } from "@/lib/integrations/testing/harness"
import { createInMemoryMeetingDatabase, type InMemoryMeetingDatabase } from "@/lib/meetings/repository"
import { resetRateLimitsForTesting } from "@/lib/rate-limit"
import type { WorkspaceRole } from "@/lib/workspaces/types"

/**
 * M8 integration routes: permission matrix, cross-workspace ids → 404, caps
 * → 409, manual send on private meetings (403/404), Idempotency-Key replay,
 * owner-only meeting prefs, tokens never in a response, and stored errors
 * never leak provider text.
 */

process.env.MEETSUM_SESSION_SECRET ??= "test-session-secret-for-integrations"

const BASE = "http://localhost/api"
const TOKEN = "xoxb-route-fixture-token"

describe("integration routes", () => {
  let store: IntegrationStore
  let jobs: RecordedJob[]
  let database: InMemoryMeetingDatabase

  async function as(role: WorkspaceRole, userId = "user_me", workspaceId = "ws_a") {
    setRouteCtx(await createTestCtx({ role, userId, workspaceId, database }))
  }

  async function connection(overrides: { id: string; workspaceId?: string; provider?: "slack" | "microsoft"; userId?: string; config?: Record<string, unknown> }) {
    const workspaceId = overrides.workspaceId ?? "ws_a"
    const result = await store.createConnection({
      id: overrides.id,
      workspaceId,
      provider: overrides.provider ?? "slack",
      ...(overrides.userId ? { userId: overrides.userId } : {}),
      status: "active",
      accountLabel: "Acme",
      externalAccountId: `${overrides.id}_ext`,
      scopes: ["chat:write", "chat:write.public"],
      ...sealTokenSet(workspaceId, overrides.id, { accessToken: TOKEN, refreshToken: "xoxe-refresh", scopes: [] }),
      config: overrides.config ?? {},
      createdByUserId: "user_admin",
    })

    if (!result.ok) throw new Error("setup")
    return result.connection
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    resetRateLimitsForTesting()
    store = createMemoryIntegrationStore()
    jobs = []
    setIntegrationStoreForTesting(store)
    setIntegrationQueuePortForTesting(createRecordingQueue(jobs))
    setProviderTransportForTesting(async (url, init) => {
      if (url.endsWith("/conversations.info")) {
        return String(init?.body ?? "").includes("CFORGED")
          ? Response.json({ ok: false, error: "channel_not_found" })
          : Response.json({ ok: true, channel: { is_member: true } })
      }
      if (url.endsWith("/conversations.list")) return Response.json({ ok: true, channels: [{ id: "C1", name: "general" }], response_metadata: { next_cursor: "" } })
      if (url.endsWith("/auth.revoke")) return Response.json({ ok: true })
      return Response.json({ ok: false, error: "unknown" })
    })
    database = createInMemoryMeetingDatabase([
      testMeeting({ id: "m_a", title: "פגישה גלויה" }),
      testMeeting({ id: "m_mine_private", visibility: "private", ownerUserId: "user_me" }),
      testMeeting({ id: "m_other_private", visibility: "private", ownerUserId: "user_owner" }),
      testMeeting({
        id: "m_shared_private",
        visibility: "private",
        ownerUserId: "user_owner",
        // The in-memory repository derives participants (and their emails) from this list.
        participants: ["me@example.com"],
      }),
      testMeeting({ id: "m_b", workspaceId: "ws_b" }),
    ])
    await connection({ id: "intc_a" })
    await connection({ id: "intc_b", workspaceId: "ws_b" })
  })

  afterEach(() => {
    setRouteCtx(undefined)
    setIntegrationStoreForTesting(undefined)
    setIntegrationQueuePortForTesting(undefined)
    setProviderTransportForTesting(undefined)
  })

  const slackRule = (overrides: Record<string, unknown> = {}) => ({
    provider: "slack",
    connectionId: "intc_a",
    name: "Sales to #general",
    trigger: "meeting.completed",
    destination: { provider: "slack", channelId: "C1", channelName: "general" },
    ...overrides,
  })

  describe("permissions", () => {
    it("lets viewers list providers but not connections; members list connections without tokens", async () => {
      await as("viewer")
      expect((await listProviders(new Request(`${BASE}/integrations/providers`), routeParams({}))).status).toBe(200)
      expect((await listConnections(new Request(`${BASE}/integrations/connections`), routeParams({}))).status).toBe(403)

      await as("member")
      const response = await listConnections(new Request(`${BASE}/integrations/connections`), routeParams({}))
      const text = await response.text()

      expect(response.status).toBe(200)
      expect(JSON.parse(text).connections.map((row: { id: string }) => row.id)).toEqual(["intc_a"])
      expect(text).not.toMatch(/xox|v2:|_enc|Token/)
    })

    it("restricts rules and the delivery log to admins", async () => {
      await as("member")
      expect((await listRules(new Request(`${BASE}/integrations/rules`), routeParams({}))).status).toBe(403)
      expect((await createRule(jsonRequest(`${BASE}/integrations/rules`, "POST", slackRule()), routeParams({}))).status).toBe(403)
      expect((await listDeliveries(new Request(`${BASE}/integrations/deliveries`), routeParams({}))).status).toBe(403)

      await as("admin")
      expect((await listRules(new Request(`${BASE}/integrations/rules`), routeParams({}))).status).toBe(200)
    })

    it("lets only admins configure or disconnect a workspace connection", async () => {
      await as("member")
      expect((await patchConnection(jsonRequest(`${BASE}/x`, "PATCH", { config: { allowManualSend: false } }), routeParams({ id: "intc_a" }))).status).toBe(403)
      expect((await deleteConnection(new Request(`${BASE}/x`, { method: "DELETE" }), routeParams({ id: "intc_a" }))).status).toBe(403)

      await as("admin")
      const patched = await patchConnection(jsonRequest(`${BASE}/x`, "PATCH", { config: { allowManualSend: false, defaultChannelId: "C1" } }), routeParams({ id: "intc_a" }))

      expect(patched.status).toBe(200)
      expect((await patched.json()).connection.config).toEqual({ allowManualSend: false, defaultChannelId: "C1" })
      expect((await patchConnection(jsonRequest(`${BASE}/x`, "PATCH", { config: { secret: "x" } }), routeParams({ id: "intc_a" }))).status).toBe(400)
    })

    it("keeps personal connections owner-only; admins see label/status and may revoke", async () => {
      await connection({ id: "intc_ms", provider: "microsoft", userId: "user_owner" })

      await as("member", "user_me")
      expect(
        (await (await listConnections(new Request(`${BASE}/x`), routeParams({}))).json()).connections.map((row: { id: string }) => row.id)
      ).toEqual(["intc_a"])
      expect((await patchConnection(jsonRequest(`${BASE}/x`, "PATCH", { config: { calendarSyncEnabled: true } }), routeParams({ id: "intc_ms" }))).status).toBe(404)

      await as("member", "user_owner")
      expect((await patchConnection(jsonRequest(`${BASE}/x`, "PATCH", { config: { calendarSyncEnabled: true } }), routeParams({ id: "intc_ms" }))).status).toBe(200)

      await as("admin", "user_admin")
      const listed = (await (await listConnections(new Request(`${BASE}/x`), routeParams({}))).json()).connections
      const personal = listed.find((row: { id: string }) => row.id === "intc_ms")

      expect(personal).toMatchObject({ accountLabel: "Acme", status: "active", config: {}, scopes: [] })
      expect((await patchConnection(jsonRequest(`${BASE}/x`, "PATCH", { config: { calendarSyncEnabled: false } }), routeParams({ id: "intc_ms" }))).status).toBe(403)
      expect((await deleteConnection(new Request(`${BASE}/x`, { method: "DELETE" }), routeParams({ id: "intc_ms" }))).status).toBe(200)
    })
  })

  describe("workspace isolation", () => {
    it("answers 404 for another workspace's connection, rule and delivery ids", async () => {
      await as("admin")
      expect((await patchConnection(jsonRequest(`${BASE}/x`, "PATCH", { config: {} }), routeParams({ id: "intc_b" }))).status).toBe(404)
      expect((await deleteConnection(new Request(`${BASE}/x`, { method: "DELETE" }), routeParams({ id: "intc_b" }))).status).toBe(404)
      expect((await pickerOptions(new Request(`${BASE}/x?purpose=rule`), routeParams({ id: "intc_b", picker: "channels" }))).status).toBe(404)
      expect((await createRule(jsonRequest(`${BASE}/x`, "POST", slackRule({ connectionId: "intc_b" })), routeParams({}))).status).toBe(404)
      expect(
        (await sendToIntegration(jsonRequest(`${BASE}/x`, "POST", { connectionId: "intc_b", destination: { provider: "slack", channelId: "C1", channelName: "" } }), routeParams({ id: "m_a" })))
          .status
      ).toBe(404)

      const ruleB = await store.createRule({
        id: "intr_b",
        workspaceId: "ws_b",
        provider: "slack",
        connectionId: "intc_b",
        name: "B",
        enabled: true,
        trigger: "meeting.completed",
        filters: {},
        destination: { provider: "slack", channelId: "C1", channelName: "" },
        content: { overview: true, actionItems: true, decisions: true, openQuestions: false, transcript: false, link: "app" },
        includePrivate: false,
      })

      expect(ruleB.ok).toBe(true)
      expect((await patchRule(jsonRequest(`${BASE}/x`, "PATCH", { name: "x" }), routeParams({ id: "intr_b" }))).status).toBe(404)
      expect((await deleteRule(new Request(`${BASE}/x`, { method: "DELETE" }), routeParams({ id: "intr_b" }))).status).toBe(404)

      const deliveryB = await store.insertDelivery({
        id: "intd_b",
        workspaceId: "ws_b",
        provider: "slack",
        origin: "rule",
        idempotencyKey: "k",
        status: "failed",
        maxAttempts: 5,
      })

      expect((await getDelivery(new Request(`${BASE}/x`), routeParams({ id: deliveryB.delivery.id }))).status).toBe(404)
      expect((await retryDelivery(new Request(`${BASE}/x`, { method: "POST" }), routeParams({ id: deliveryB.delivery.id }))).status).toBe(404)
      expect((await (await listDeliveries(new Request(`${BASE}/x`), routeParams({}))).json()).deliveries).toEqual([])
    })
  })

  describe("rules", () => {
    it("creates a rule owned by the admin and validates provider/destination", async () => {
      await as("admin", "user_admin")

      const created = await createRule(jsonRequest(`${BASE}/x`, "POST", slackRule({ includePrivate: true })), routeParams({}))
      const body = await created.json()

      expect(created.status).toBe(201)
      expect(body.rule).toMatchObject({ provider: "slack", createdByUserId: "user_admin", includePrivate: true, enabled: true })
      expect(body.rule.content).toMatchObject({ overview: true, transcript: false, link: "app" })
      expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "integration.rule.created", workspaceId: "ws_a" }))

      expect(
        (await createRule(jsonRequest(`${BASE}/x`, "POST", slackRule({ destination: { provider: "notion", databaseId: "abcdefgh12", databaseTitle: "x" } })), routeParams({}))).status
      ).toBe(400)
      expect((await createRule(jsonRequest(`${BASE}/x`, "POST", { ...slackRule(), extra: 1 }), routeParams({}))).status).toBe(400)
      expect((await createRule(jsonRequest(`${BASE}/x`, "POST", slackRule({ trigger: "clip.created" })), routeParams({}))).status).toBe(400)
    })

    it("resets include_private when another admin edits the rule", async () => {
      await as("admin", "user_admin")
      const { rule } = await (await createRule(jsonRequest(`${BASE}/x`, "POST", slackRule({ includePrivate: true })), routeParams({}))).json()

      await as("admin", "user_other_admin")
      const edited = await (await patchRule(jsonRequest(`${BASE}/x`, "PATCH", { name: "Renamed" }), routeParams({ id: rule.id }))).json()

      expect(edited.rule).toMatchObject({ name: "Renamed", includePrivate: false, createdByUserId: "user_other_admin" })

      // Another user can never set it on someone else's rule either.
      await as("admin", "user_third_admin")
      const forced = await (await patchRule(jsonRequest(`${BASE}/x`, "PATCH", { includePrivate: true }), routeParams({ id: rule.id }))).json()

      expect(forced.rule).toMatchObject({ includePrivate: false, createdByUserId: "user_third_admin" })

      // The (new) owner can opt their own private meetings in with their own edit.
      const own = await (await patchRule(jsonRequest(`${BASE}/x`, "PATCH", { includePrivate: true }), routeParams({ id: rule.id }))).json()

      expect(own.rule.includePrivate).toBe(true)
    })

    it("answers 409 when the rule cap is reached", async () => {
      await as("admin", "user_admin")
      for (let index = 0; index < 50; index += 1) {
        expect((await createRule(jsonRequest(`${BASE}/x`, "POST", slackRule()), routeParams({}))).status).toBe(201)
        resetRateLimitsForTesting()
      }
      expect((await createRule(jsonRequest(`${BASE}/x`, "POST", slackRule()), routeParams({}))).status).toBe(409)
    })

    it("upserts the singleton email rule", async () => {
      await as("admin", "user_admin")
      const email = (mode: string) => ({
        provider: "email",
        name: "Recap",
        trigger: "meeting.completed",
        destination: { provider: "email", audience: "members", mode, locale: "meeting" },
      })
      const first = await (await createRule(jsonRequest(`${BASE}/x`, "POST", email("all_meetings")), routeParams({}))).json()
      const second = await (await createRule(jsonRequest(`${BASE}/x`, "POST", email("opt_in")), routeParams({}))).json()

      expect(second.rule.id).toBe(first.rule.id)
      expect(second.rule.destination.mode).toBe("opt_in")
      expect((await createRule(jsonRequest(`${BASE}/x`, "POST", { ...email("opt_in"), trigger: "summary.created" }), routeParams({}))).status).toBe(400)
    })
  })

  describe("manual send", () => {
    const send = (meetingId: string, key?: string, body: Record<string, unknown> = { connectionId: "intc_a", destination: { provider: "slack", channelId: "C1", channelName: "general" } }) =>
      sendToIntegration(
        new Request(`${BASE}/meetings/${meetingId}/integrations/send`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
          body: JSON.stringify(body),
        }),
        routeParams({ id: meetingId })
      )

    it("queues a manual delivery (202) and replays the same Idempotency-Key", async () => {
      await as("member", "user_me")
      const key = "3f1c2b8e-1d2a-4c3b-9e8f-0a1b2c3d4e5f"
      const first = await send("m_a", key)
      const firstBody = await first.json()
      const replay = await (await send("m_a", key)).json()

      expect(first.status).toBe(202)
      expect(replay).toEqual({ deliveryId: firstBody.deliveryId, replayed: true })
      expect(jobs).toEqual([{ name: "integration.deliver", payload: { workspaceId: "ws_a", deliveryId: firstBody.deliveryId }, jobId: firstBody.deliveryId }])

      const polled = await getDelivery(new Request(`${BASE}/x`), routeParams({ id: firstBody.deliveryId }))

      expect(polled.status).toBe(200)
      expect((await polled.json()).delivery).toMatchObject({ origin: "manual", status: "queued", requestedByUserId: "user_me", meetingTitle: "פגישה גלויה" })

      await as("member", "user_someone_else")
      expect((await getDelivery(new Request(`${BASE}/x`), routeParams({ id: firstBody.deliveryId }))).status).toBe(404)
    })

    it("rejects an Idempotency-Key reused for another meeting, destination or content (422) without replaying", async () => {
      await as("member", "user_me")
      const key = "9a8b7c6d-1d2a-4c3b-9e8f-0a1b2c3d4e5f"
      const first = await (await send("m_a", key)).json()
      const other = { connectionId: "intc_a", destination: { provider: "slack", channelId: "C1", channelName: "general" } }

      await store.upsertPrefs("ws_a", "m_mine_private", { allowPrivatePush: true, allowPrivateSetByUserId: "user_me" })

      const otherMeeting = await send("m_mine_private", key, other)

      expect(otherMeeting.status).toBe(422)
      expect(await otherMeeting.json()).toEqual({ error: "idempotency_key_reuse" })

      const otherContent = await send("m_a", key, { ...other, content: { transcript: true } })

      expect(otherContent.status).toBe(422)
      // The original request still replays.
      expect(await (await send("m_a", key, other)).json()).toEqual({ deliveryId: first.deliveryId, replayed: true })
      expect(jobs).toHaveLength(1)
    })

    it("hides invisible meetings (404) and needs manage rights on visible private ones (403)", async () => {
      await as("member", "user_me")
      expect((await send("m_other_private")).status).toBe(404)
      expect((await send("m_b")).status).toBe(404)
      // Own private meeting: still needs the per-meeting opt-in.
      expect((await send("m_mine_private")).status).toBe(403)
      await store.upsertPrefs("ws_a", "m_mine_private", { allowPrivatePush: true, allowPrivateSetByUserId: "user_me" })
      expect((await send("m_mine_private")).status).toBe(202)
    })

    it("applies the private matrix: viewer, participant member, non-owner admin, opt-in missing vs present", async () => {
      await as("viewer", "user_me")
      expect((await send("m_shared_private")).status).toBe(403)

      // A participant member can see it but cannot manage it.
      await as("member", "user_me")
      expect((await send("m_shared_private")).status).toBe(403)

      // A non-owner admin participant can manage it, but the owner has not opted in.
      await as("admin", "user_me")
      expect((await send("m_shared_private")).status).toBe(403)

      // An opt-in recorded by someone other than the owner does not count.
      await store.upsertPrefs("ws_a", "m_shared_private", { allowPrivatePush: true, allowPrivateSetByUserId: "user_me" })
      expect((await send("m_shared_private")).status).toBe(403)

      await store.upsertPrefs("ws_a", "m_shared_private", { allowPrivatePush: true, allowPrivateSetByUserId: "user_owner" })
      expect((await send("m_shared_private")).status).toBe(202)
      expect(jobs).toHaveLength(1)
    })

    it("refuses a forged destination the provider does not confirm", async () => {
      await as("member", "user_me")

      const forged = await send("m_a", undefined, { connectionId: "intc_a", destination: { provider: "slack", channelId: "CFORGED", channelName: "x" } })

      expect(forged.status).toBe(400)
      expect(await forged.json()).toEqual({ error: "invalid_destination", providerCode: "channel_not_found" })
      expect(
        (await send("m_a", undefined, { connectionId: "intc_a", destination: { provider: "notion", databaseId: "abcdefgh12", databaseTitle: "" } })).status
      ).toBe(400)
      expect(jobs).toHaveLength(0)
    })

    it("honours allowManualSend, needs_reauth and requires a destination", async () => {
      await as("member", "user_me")
      await store.updateConnection("ws_a", "intc_a", { config: { allowManualSend: false } })
      expect((await send("m_a")).status).toBe(403)

      await store.updateConnection("ws_a", "intc_a", { config: {}, status: "needs_reauth" })
      expect((await send("m_a")).status).toBe(409)

      await store.updateConnection("ws_a", "intc_a", { status: "active" })
      expect((await send("m_a", undefined, { connectionId: "intc_a" })).status).toBe(400)
      await store.updateConnection("ws_a", "intc_a", { config: { defaultChannelId: "C1" } })
      expect((await send("m_a", undefined, { connectionId: "intc_a" })).status).toBe(202)
    })

    it("rate-limits manual sends", async () => {
      await as("member", "user_me")
      for (let index = 0; index < 10; index += 1) expect((await send("m_a")).status).toBe(202)
      expect((await send("m_a")).status).toBe(429)
    })
  })

  describe("delivery log", () => {
    it("shows Private meeting (null title) for meetings the viewer cannot see, never stored provider text", async () => {
      await store.insertDelivery({
        id: "intd_private",
        workspaceId: "ws_a",
        provider: "slack",
        origin: "rule",
        meetingId: "m_other_private",
        idempotencyKey: "k1",
        status: "skipped",
        skipReason: "private_meeting",
        maxAttempts: 5,
      })
      await store.insertDelivery({
        id: "intd_failed",
        workspaceId: "ws_a",
        provider: "slack",
        origin: "rule",
        meetingId: "m_a",
        idempotencyKey: "k2",
        status: "failed",
        lastError: `legacy text with ${TOKEN} and dana@acme.test`,
        maxAttempts: 5,
      })

      await as("admin", "user_admin")
      const text = await (await listDeliveries(new Request(`${BASE}/x`), routeParams({}))).text()
      const deliveries = JSON.parse(text).deliveries as { id: string; meetingTitle: string | null; lastError?: string }[]

      expect(deliveries.find((row) => row.id === "intd_private")?.meetingTitle).toBeNull()
      expect(deliveries.find((row) => row.id === "intd_failed")?.meetingTitle).toBe("פגישה גלויה")
      expect(text).not.toContain(TOKEN)
      expect(text).not.toContain("dana@acme.test")

      const retried = await retryDelivery(new Request(`${BASE}/x`, { method: "POST" }), routeParams({ id: "intd_failed" }))

      expect(retried.status).toBe(202)
      expect((await retried.json()).delivery).toMatchObject({ status: "queued", attempts: 0 })
      expect((await retryDelivery(new Request(`${BASE}/x`, { method: "POST" }), routeParams({ id: "intd_private" }))).status).toBe(409)
    })

    it("paginates with a cursor and filters by status", async () => {
      for (let index = 0; index < 3; index += 1) {
        await store.insertDelivery({ id: `intd_${index}`, workspaceId: "ws_a", provider: "slack", origin: "rule", idempotencyKey: `p${index}`, status: "sent", maxAttempts: 5 })
      }

      await as("admin", "user_admin")
      const first = await (await listDeliveries(new Request(`${BASE}/x?limit=2&status=sent`), routeParams({}))).json()
      const next = await (await listDeliveries(new Request(`${BASE}/x?limit=2&status=sent&before=${encodeURIComponent(first.nextCursor)}`), routeParams({}))).json()

      expect(first.deliveries).toHaveLength(2)
      expect(next.deliveries).toHaveLength(1)
      expect((await listDeliveries(new Request(`${BASE}/x?status=bogus`), routeParams({}))).status).toBe(400)
    })
  })

  describe("meeting integration prefs", () => {
    it("lets only the owner allow private pushes", async () => {
      await as("admin", "user_admin")
      expect((await putPrefs(jsonRequest(`${BASE}/x`, "PUT", { allowPrivatePush: true }), routeParams({ id: "m_a" }))).status).toBe(403)

      await as("member", "user_me")
      const response = await putPrefs(jsonRequest(`${BASE}/x`, "PUT", { allowPrivatePush: true }), routeParams({ id: "m_mine_private" }))

      expect(response.status).toBe(200)
      expect((await response.json()).prefs).toEqual({ meetingId: "m_mine_private", allowPrivatePush: true, emailRecap: "inherit" })
      expect(await store.getPrefs("ws_a", "m_mine_private")).toMatchObject({ allowPrivateSetByUserId: "user_me" })
      expect(recordAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: "integration.meeting_prefs.updated", metadata: { fields: ["allowPrivatePush"] } })
      )
    })

    it("hides invisible meetings, validates values and needs manage rights for private email recap", async () => {
      await as("member", "user_me")
      expect((await getPrefs(new Request(`${BASE}/x`), routeParams({ id: "m_other_private" }))).status).toBe(404)
      expect((await putPrefs(jsonRequest(`${BASE}/x`, "PUT", { emailRecap: "maybe" }), routeParams({ id: "m_a" }))).status).toBe(400)
      expect((await putPrefs(jsonRequest(`${BASE}/x`, "PUT", { emailRecap: "off" }), routeParams({ id: "m_a" }))).status).toBe(200)
      expect((await (await getPrefs(new Request(`${BASE}/x`), routeParams({ id: "m_a" }))).json()).prefs.emailRecap).toBe("off")

      // emailRecapAvailable: only with an enabled opt-in email rule (log email counts outside production).
      const available = async () => (await (await getPrefs(new Request(`${BASE}/x`), routeParams({ id: "m_a" }))).json()).emailRecapAvailable

      expect(await available()).toBe(false)
      const emailRule = await store.createRule(
        testRule({ id: "intr_email_optin", provider: "email", destination: { provider: "email", audience: "members", mode: "opt_in", locale: "meeting" } })
      )

      expect(await available()).toBe(true)
      if (emailRule.ok) await store.updateRule("ws_a", emailRule.rule.id, { destination: { provider: "email", audience: "members", mode: "all_meetings", locale: "meeting" } })
      expect(await available()).toBe(false)

      await as("viewer", "user_me")
      expect((await putPrefs(jsonRequest(`${BASE}/x`, "PUT", { emailRecap: "on" }), routeParams({ id: "m_a" }))).status).toBe(403)
    })
  })

  it("never puts a token in any audit record", async () => {
    await as("admin", "user_admin")
    await deleteConnection(new Request(`${BASE}/x`, { method: "DELETE" }), routeParams({ id: "intc_a" }))

    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "integration.connection.revoked" }))
    expect(JSON.stringify(recordAuditLog.mock.calls)).not.toMatch(/xox|v2:/)
  })
})
