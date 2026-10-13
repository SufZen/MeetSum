import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { createTestCtx, jsonRequest, routeParams, setRouteCtx, testMeeting } from "./helpers/route-ctx"

vi.mock("@/lib/auth/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/authz")>()
  const { mockAuthzModule } = await import("./helpers/route-ctx")

  return mockAuthzModule(actual)
})

vi.mock("@/lib/audit", () => ({ recordAuditLog: vi.fn(async () => undefined) }))

import { GET as pickerOptions } from "@/app/api/integrations/connections/[id]/options/[picker]/route"
import { DELETE as deleteConnection, PATCH as patchConnection } from "@/app/api/integrations/connections/[id]/route"
import { POST as testConnection } from "@/app/api/integrations/connections/[id]/test/route"
import { GET as listConnections } from "@/app/api/integrations/connections/route"
import { POST as retryDelivery } from "@/app/api/integrations/deliveries/[id]/retry/route"
import { GET as getDelivery } from "@/app/api/integrations/deliveries/[id]/route"
import { GET as listDeliveries } from "@/app/api/integrations/deliveries/route"
import { DELETE as deleteRule, PATCH as patchRule } from "@/app/api/integrations/rules/[id]/route"
import { GET as listRules, POST as createRuleRoute } from "@/app/api/integrations/rules/route"
import { POST as exportGoogleDocs } from "@/app/api/meetings/[id]/export/google-docs/route"
import { POST as exportNotion } from "@/app/api/meetings/[id]/export/notion/route"
import { GET as getPrefs, PUT as putPrefs } from "@/app/api/meetings/[id]/integration-prefs/route"
import { POST as sendRoute } from "@/app/api/meetings/[id]/integrations/send/route"
import { runIntegrationDispatch } from "@/lib/integrations/core/dispatcher"
import { setProviderTransportForTesting } from "@/lib/integrations/core/http"
import { completeOAuth, startOAuth } from "@/lib/integrations/core/oauth"
import { setIntegrationQueuePortForTesting } from "@/lib/integrations/core/queue"
import { setIntegrationStoreForTesting, type IntegrationStore } from "@/lib/integrations/core/store"
import { createMemoryIntegrationStore } from "@/lib/integrations/core/store-memory"
import { createPostgresIntegrationStore } from "@/lib/integrations/core/store-postgres"
import { sealTokenSet } from "@/lib/integrations/core/tokens"
import type { IntegrationProvider } from "@/lib/integrations/core/types"
import { findCanonicalMeetingId } from "@/lib/integrations/microsoft/calendar-dedupe"
import { createRecordingQueue, createTestRuntime, testMeetingRecord, testRule } from "@/lib/integrations/testing/harness"
import { createMigratedPglite, seedIntegrationFixtures, type TestPg } from "@/lib/integrations/testing/pglite"
import type { SessionContext } from "@/lib/auth/authz"
import { createInMemoryMeetingDatabase } from "@/lib/meetings/repository"
import { resetRateLimitsForTesting } from "@/lib/rate-limit"

/**
 * M8 Integration step: W1/W2 isolation across connections, rules,
 * deliveries, links, prefs, OAuth state and every integrations route, on
 * the memory store and on Postgres (PGlite, skipped if it cannot load).
 *  - a W1 event with W1 and W2 rules creates W1 deliveries only;
 *  - a W2 connection id in a W1 rule, manual send or picker → 404;
 *  - W1 never reads, lists or changes W2 rows (deliveries, links, prefs);
 *  - an OAuth state for W2 is refused for a W1-only session;
 *  - an Outlook event in W1 never dedupes against a W2 Google row with the
 *    same iCalUID.
 */

process.env.MEETSUM_SESSION_SECRET ??= "test-session-secret-for-integrations"

let pg: TestPg | undefined
let pgError: unknown

beforeAll(async () => {
  const created = await createMigratedPglite()

  pg = created.db
  pgError = created.error
  if (pg) {
    await seedIntegrationFixtures(pg)
    await pg.exec(`insert into users (id, email) values ('user_b', 'b@other.test') on conflict (id) do nothing;`)
  }
}, 120_000)

afterAll(async () => {
  await pg?.close()
})

async function seedStore(store: IntegrationStore) {
  for (const [id, workspaceId] of [
    ["intc_a", "ws_a"],
    ["intc_b", "ws_b"],
  ] as const) {
    const created = await store.createConnection({
      id,
      workspaceId,
      provider: "slack",
      status: "active",
      accountLabel: workspaceId,
      externalAccountId: `${id}_ext`,
      scopes: [],
      ...sealTokenSet(workspaceId, id, { accessToken: `xoxb-${id}`, scopes: [] }),
      config: {},
      createdByUserId: "user_admin",
    })

    if (!created.ok) throw new Error("seed")
  }
  await store.createRule(testRule({ id: "intr_iso_a", connectionId: "intc_a", createdByUserId: "user_admin" }))
  await store.createRule(testRule({ id: "intr_iso_b", workspaceId: "ws_b", connectionId: "intc_b", createdByUserId: "user_b" }))
}

describe.each(["memory", "postgres"] as const)("store isolation (%s)", (kind) => {
  let store: IntegrationStore

  beforeEach(async (context) => {
    if (kind === "postgres") {
      if (!pg) {
        context.skip(`PGlite did not load: ${String(pgError)}`)
        return
      }
      await pg.exec(`
        delete from integration_links; delete from integration_deliveries; delete from integration_rules;
        delete from meeting_integration_prefs; delete from integration_connections;
      `)
      store = createPostgresIntegrationStore(pg)
    } else {
      store = createMemoryIntegrationStore()
    }
    await seedStore(store)
  })

  it("creates deliveries only in the event's workspace", async () => {
    const rt = createTestRuntime({
      store,
      meetings: [testMeetingRecord({ id: "m_a" }), testMeetingRecord({ id: "m_b", workspaceId: "ws_b" })],
    })

    await runIntegrationDispatch({ workspaceId: "ws_a", eventName: "meeting.completed", eventId: "evt_iso", meetingId: "m_a" }, rt)
    // A W2 event naming a W1 meeting finds nothing.
    await runIntegrationDispatch({ workspaceId: "ws_b", eventName: "meeting.completed", eventId: "evt_iso_b", meetingId: "m_a" }, rt)

    expect((await store.listDeliveries("ws_a")).map((row) => row.ruleId)).toEqual(["intr_iso_a"])
    expect(await store.listDeliveries("ws_b")).toEqual([])
  })

  it("refuses a W2 connection in a W1 rule and never reads or changes W2 rows from W1", async () => {
    expect(await store.createRule(testRule({ id: "intr_cross", connectionId: "intc_b" }))).toEqual({ ok: false, reason: "connection_not_found" })
    expect(await store.getConnection("ws_a", "intc_b")).toBeUndefined()
    expect(await store.updateConnection("ws_a", "intc_b", { status: "revoked" })).toBeUndefined()
    expect(await store.updateConnectionIfCurrent("ws_a", "intc_b", 0, { accessTokenEnc: "v2:x" })).toBeUndefined()
    expect(await store.withConnectionLock("ws_a", "intc_b", async (row) => row)).toBeUndefined()
    expect(await store.getRule("ws_a", "intr_iso_b")).toBeUndefined()
    expect(await store.updateRule("ws_a", "intr_iso_b", { name: "x" })).toBeUndefined()
    expect(await store.deleteRule("ws_a", "intr_iso_b")).toBe(false)
    expect(await store.disableRulesForConnection("ws_a", "intc_b", "connection_revoked")).toEqual([])

    const { delivery } = await store.insertDelivery({
      id: "intd_iso_b",
      workspaceId: "ws_b",
      ruleId: "intr_iso_b",
      connectionId: "intc_b",
      provider: "slack",
      origin: "rule",
      meetingId: "m_b",
      idempotencyKey: "rule:intr_iso_b:meeting.completed:m_b",
      status: "queued",
      maxAttempts: 5,
    })

    expect(await store.getDelivery("ws_a", delivery.id)).toBeUndefined()
    expect(await store.claimDelivery("ws_a", delivery.id)).toBeUndefined()
    expect(await store.updateDelivery("ws_a", delivery.id, { status: "cancelled" })).toBeUndefined()
    expect(await store.cancelQueuedDeliveriesForConnection("ws_a", "intc_b")).toEqual([])
    expect(await store.listDeliveries("ws_a")).toEqual([])

    // Links: a W2 link is invisible through any W1 scope.
    await store.upsertLink({ workspaceId: "ws_b", connectionId: "intc_b", meetingId: "m_b", provider: "slack" }, {
      objectKind: "slack_message",
      destinationKey: "C1",
      externalId: "1.0",
    })
    expect(await store.listLinks({ workspaceId: "ws_a", connectionId: "intc_b", meetingId: "m_b" }, "slack_message")).toEqual([])
    expect(await store.getLink({ workspaceId: "ws_a", connectionId: "intc_b", meetingId: "m_b" }, { objectKind: "slack_message", destinationKey: "C1" })).toBeUndefined()

    // Prefs: W1 never reads (or overwrites) a W2 meeting's prefs.
    await store.upsertPrefs("ws_b", "m_b", { emailRecap: "off", updatedByUserId: "user_b" })
    expect(await store.getPrefs("ws_a", "m_b")).toBeUndefined()
    await store.upsertPrefs("ws_a", "m_b", { allowPrivatePush: true, allowPrivateSetByUserId: "user_owner" }).catch(() => undefined)
    expect(await store.getPrefs("ws_b", "m_b")).toMatchObject({ emailRecap: "off", allowPrivatePush: false })

    // W2 rows are untouched.
    expect((await store.getRule("ws_b", "intr_iso_b"))?.enabled).toBe(true)
    expect((await store.getConnection("ws_b", "intc_b"))?.status).toBe("active")
    expect((await store.getDelivery("ws_b", delivery.id))?.status).toBe("queued")
  })
})

describe("OAuth state is bound to its workspace", () => {
  it("refuses a W2 state for a session that is only a W1 member", async () => {
    const store = createMemoryIntegrationStore()
    const exchangeCode = vi.fn(async () => ({ accessToken: "xoxb-oauth-iso", scopes: [], account: { externalId: "T9", label: "W2 Slack" } }))
    const provider: IntegrationProvider = {
      id: "slack",
      scope: "workspace",
      configured: () => true,
      oauth: { pkce: false, scopes: [], authorizeUrl: ({ state }) => `https://slack.com/oauth/v2/authorize?state=${encodeURIComponent(state)}`, exchangeCode },
    }
    const env = { NODE_ENV: "test", MEETSUM_SESSION_SECRET: "iso-secret", MEETSUM_OAUTH_REDIRECT_BASE: "https://meetsum.example.com" } as NodeJS.ProcessEnv
    const deps = { store, env, getProvider: () => provider }
    const started = await startOAuth({ provider: "slack", workspaceId: "ws_b", userId: "user_x", role: "admin", returnTo: "/he" }, deps)

    if (!started.ok) throw new Error("start")

    const state = new URL(started.location).searchParams.get("state") ?? ""
    const w1Only = {
      user: { id: "user_x", email: "x@acme.test" },
      memberships: [{ workspaceId: "ws_a", userId: "user_x", role: "admin", createdAt: "" }],
    } as unknown as SessionContext
    const result = await completeOAuth({ provider: "slack", session: w1Only, query: new URLSearchParams({ code: "c", state }), cookieNonce: started.nonce }, deps)

    expect(result.code).toBe("forbidden")
    expect(exchangeCode).not.toHaveBeenCalled()
    expect(await store.listConnections("ws_a")).toEqual([])
    expect(await store.listConnections("ws_b")).toEqual([])
  })
})

describe("Outlook iCalUID dedupe never crosses workspaces (PGlite)", () => {
  it("finds the W2 Google row only from W2", async (context) => {
    if (!pg) {
      context.skip(`PGlite did not load: ${String(pgError)}`)
      return
    }

    const uid = "iso-shared@meetsum.test"
    const start = "2026-11-02T09:00:00.000Z"
    const raw = { conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://teams.microsoft.com/l/meetup-join/19%3ameeting_aXNv%40thread.v2/0" }] } }

    await pg.exec(`
      insert into workspace_accounts (id, domain, admin_email) values ('wa_iso', 'other.test', 'b@other.test') on conflict do nothing;
      insert into google_identities (id, workspace_account_id, subject_email, workspace_id)
        values ('gi_iso_b', 'wa_iso', 'b@other.test', 'ws_b') on conflict do nothing;
    `)
    await pg.query(
      `insert into calendar_events (id, provider, google_identity_id, google_event_id, workspace_id, ical_uid, title, starts_at, organizer_email, raw)
       values ('ce_iso_b', 'google', 'gi_iso_b', 'ce_iso_b', 'ws_b', $1, 'W2 meeting', $2::timestamptz, 'b@other.test', $3::jsonb)`,
      [uid, start, JSON.stringify(raw)]
    )
    await pg.query(
      `insert into meetings (id, calendar_event_id, title, source, status, started_at, workspace_id, owner_user_id, visibility)
       values ('m_iso_b', 'ce_iso_b', 'W2 meeting', 'google_meet', 'scheduled', $1::timestamptz, 'ws_b', 'user_b', 'workspace')`,
      [start]
    )

    const lookup = (workspaceId: string) =>
      findCanonicalMeetingId(pg as TestPg, {
        workspaceId,
        icalUid: uid,
        startsAt: start,
        calendarEventId: "ce_outlook_incoming",
        organizerEmail: "b@other.test",
        event: raw as never,
        owner: { userId: "user_b", email: "b@other.test" },
      })

    expect(await lookup("ws_a")).toBeUndefined()
    // Control: the same lookup in W2 does dedupe (the test is not vacuous).
    expect(await lookup("ws_b")).toBe("m_iso_b")
  })
})

describe("every integrations route answers 404 for another workspace's ids", () => {
  let store: IntegrationStore

  beforeEach(async () => {
    resetRateLimitsForTesting()
    store = createMemoryIntegrationStore()
    setIntegrationStoreForTesting(store)
    setIntegrationQueuePortForTesting(createRecordingQueue([]))
    setProviderTransportForTesting(async () => Response.json({ ok: true, channel: { is_member: true }, channels: [], response_metadata: { next_cursor: "" } }))
    await seedStore(store)
    await store.insertDelivery({
      id: "intd_b",
      workspaceId: "ws_b",
      ruleId: "intr_iso_b",
      connectionId: "intc_b",
      provider: "slack",
      origin: "rule",
      meetingId: "m_b",
      idempotencyKey: "k_b",
      status: "failed",
      maxAttempts: 5,
    })
    await store.upsertLink({ workspaceId: "ws_b", connectionId: "intc_b", meetingId: "m_b", provider: "slack" }, { objectKind: "slack_message", destinationKey: "C1", externalId: "9.9" })
  })

  afterEach(() => {
    setRouteCtx(undefined)
    setIntegrationStoreForTesting(undefined)
    setIntegrationQueuePortForTesting(undefined)
    setProviderTransportForTesting(undefined)
  })

  async function asW1Admin() {
    setRouteCtx(
      await createTestCtx({
        role: "owner",
        userId: "user_admin",
        workspaceId: "ws_a",
        database: createInMemoryMeetingDatabase([testMeeting({ id: "m_a" }), testMeeting({ id: "m_b", workspaceId: "ws_b" })]),
      })
    )
  }

  it("never resolves a W2 connection, rule, delivery or meeting from W1", async () => {
    await asW1Admin()

    const slack = { provider: "slack", channelId: "C1", channelName: "general" }
    const calls: Array<[string, () => Promise<Response>]> = [
      ["PATCH connection", () => patchConnection(jsonRequest("http://localhost/x", "PATCH", { config: { allowManualSend: false } }), routeParams({ id: "intc_b" }))],
      ["DELETE connection", () => deleteConnection(new Request("http://localhost/x", { method: "DELETE" }), routeParams({ id: "intc_b" }))],
      ["test connection", () => testConnection(new Request("http://localhost/x", { method: "POST" }), routeParams({ id: "intc_b" }))],
      ["picker", () => pickerOptions(new Request("http://localhost/x?purpose=rule"), routeParams({ id: "intc_b", picker: "channels" }))],
      ["create rule on W2 connection", () => createRuleRoute(jsonRequest("http://localhost/x", "POST", { provider: "slack", connectionId: "intc_b", name: "x", trigger: "meeting.completed", destination: slack }), routeParams({}))],
      ["PATCH rule", () => patchRule(jsonRequest("http://localhost/x", "PATCH", { name: "x" }), routeParams({ id: "intr_iso_b" }))],
      ["DELETE rule", () => deleteRule(new Request("http://localhost/x", { method: "DELETE" }), routeParams({ id: "intr_iso_b" }))],
      ["GET delivery", () => getDelivery(new Request("http://localhost/x"), routeParams({ id: "intd_b" }))],
      ["retry delivery", () => retryDelivery(new Request("http://localhost/x", { method: "POST" }), routeParams({ id: "intd_b" }))],
      ["send with W2 connection", () => sendRoute(jsonRequest("http://localhost/x", "POST", { connectionId: "intc_b", destination: slack }), routeParams({ id: "m_a" }))],
      ["send for W2 meeting", () => sendRoute(jsonRequest("http://localhost/x", "POST", { connectionId: "intc_a", destination: slack }), routeParams({ id: "m_b" }))],
      ["GET prefs of W2 meeting", () => getPrefs(new Request("http://localhost/x"), routeParams({ id: "m_b" }))],
      ["PUT prefs of W2 meeting", () => putPrefs(jsonRequest("http://localhost/x", "PUT", { emailRecap: "on" }), routeParams({ id: "m_b" }))],
      ["Notion export of W2 meeting", () => exportNotion(jsonRequest("http://localhost/x", "POST", {}), routeParams({ id: "m_b" }))],
      ["Docs export of W2 meeting", () => exportGoogleDocs(jsonRequest("http://localhost/x", "POST", {}), routeParams({ id: "m_b" }))],
    ]

    for (const [name, call] of calls) {
      expect((await call()).status, name).toBe(404)
    }

    // Lists show W1 rows only.
    const connections = await (await listConnections(new Request("http://localhost/x"), routeParams({}))).json()
    const rules = await (await listRules(new Request("http://localhost/x"), routeParams({}))).json()
    const deliveries = await (await listDeliveries(new Request("http://localhost/x"), routeParams({}))).json()

    expect(connections.connections.map((row: { id: string }) => row.id)).toEqual(["intc_a"])
    expect(rules.rules.map((row: { id: string }) => row.id)).toEqual(["intr_iso_a"])
    expect(deliveries.deliveries).toEqual([])

    // W2 rows are untouched.
    expect((await store.getConnection("ws_b", "intc_b"))?.status).toBe("active")
    expect(await store.getRule("ws_b", "intr_iso_b")).toMatchObject({ name: "Rule", enabled: true })
    expect((await store.getDelivery("ws_b", "intd_b"))?.status).toBe("failed")
    expect(await store.getPrefs("ws_b", "m_b")).toBeUndefined()
  })
})
