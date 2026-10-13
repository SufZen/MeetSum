import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { CANARY, CANARY_VALUES, createIntegrationWorld, hebrewMeeting, NOTION_DB, SLACK_CHANNEL, standardRules, type World } from "./helpers/integration-world"
import { createTestCtx, jsonRequest, routeParams, setRouteCtx } from "./helpers/route-ctx"

vi.mock("@/lib/auth/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/authz")>()
  const { mockAuthzModule } = await import("./helpers/route-ctx")

  return mockAuthzModule(actual)
})

const audits = vi.hoisted(() => [] as unknown[])

vi.mock("@/lib/audit", () => ({ recordAuditLog: vi.fn(async (input: unknown) => void audits.push(input)) }))
vi.mock("@/lib/notifications/enqueue", () => ({ enqueueIntegrationReauthNotification: vi.fn(async () => undefined) }))

import { GET as unsubscribeGet, POST as unsubscribePost } from "@/app/api/email/unsubscribe/route"
import { GET as oauthStart } from "@/app/api/integrations/[provider]/oauth/start/route"
import { GET as pickerOptions } from "@/app/api/integrations/connections/[id]/options/[picker]/route"
import { DELETE as deleteConnection, PATCH as patchConnection } from "@/app/api/integrations/connections/[id]/route"
import { POST as testConnection } from "@/app/api/integrations/connections/[id]/test/route"
import { GET as listConnections } from "@/app/api/integrations/connections/route"
import { POST as retryDelivery } from "@/app/api/integrations/deliveries/[id]/retry/route"
import { GET as getDelivery } from "@/app/api/integrations/deliveries/[id]/route"
import { GET as listDeliveries } from "@/app/api/integrations/deliveries/route"
import { GET as listProviders } from "@/app/api/integrations/providers/route"
import { DELETE as deleteRule, PATCH as patchRule } from "@/app/api/integrations/rules/[id]/route"
import { GET as listRules, POST as createRule } from "@/app/api/integrations/rules/route"
import { POST as exportGoogleDocs } from "@/app/api/meetings/[id]/export/google-docs/route"
import { POST as exportNotion } from "@/app/api/meetings/[id]/export/notion/route"
import { GET as getPrefs, PUT as putPrefs } from "@/app/api/meetings/[id]/integration-prefs/route"
import { POST as sendRoute } from "@/app/api/meetings/[id]/integrations/send/route"
import type { SessionContext } from "@/lib/auth/authz"
import { completeOAuth, startOAuth } from "@/lib/integrations/core/oauth"
import { getAccessToken, openToken, sealTokenSet } from "@/lib/integrations/core/tokens"
import { createInMemoryMeetingDatabase } from "@/lib/meetings/repository"
import { resetRateLimitsForTesting } from "@/lib/rate-limit"
import type { WorkspaceRole } from "@/lib/workspaces/types"

/**
 * M8 Integration step: no token ever leaves the token store. With fixture
 * canary tokens it drives every app/api/integrations/** handler, the
 * export, send, prefs and unsubscribe routes, the OAuth start/complete
 * flow, a token refresh, rule and manual deliveries through the fake
 * providers (success and failure), retry and disconnect (with revoke).
 * Then no response body or header, audit record, log line, job payload,
 * delivery row (`last_error`, `progress`, `external_ref`), connection
 * `last_error`, link, pref or fake-provider log entry contains a token or
 * any `*_enc` ciphertext.
 */

describe("integration token secrecy", () => {
  let world: World
  const captured: string[] = []
  const logs: string[] = []

  async function as(role: WorkspaceRole, userId = "user_admin") {
    setRouteCtx(await createTestCtx({ role, userId, database: createInMemoryMeetingDatabase([...world.rt.meetings.values()]) }))
  }

  async function record(response: Response): Promise<Response> {
    const text = await response.clone().text()

    captured.push(text, JSON.stringify([...response.headers.entries()]))
    return response
  }

  beforeEach(async () => {
    resetRateLimitsForTesting()
    audits.length = 0
    captured.length = 0
    logs.length = 0
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logs.push(args.map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack ?? ""}` : typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "))
      })
    }
    world = await createIntegrationWorld([hebrewMeeting({ id: "m_he" }), hebrewMeeting({ id: "m_two", title: "Second" })])
    vi.stubEnv("SLACK_CLIENT_ID", "fake-slack-client")
    vi.stubEnv("SLACK_CLIENT_SECRET", "fake-slack-client-secret-value")
    vi.stubEnv("MEETSUM_OAUTH_REDIRECT_BASE", "http://localhost:3000")
    await world.store.createConnection({
      id: "intc_drive",
      workspaceId: "ws_a",
      provider: "google_drive",
      userId: "user_admin",
      status: "active",
      accountLabel: "admin drive",
      externalAccountId: "g_admin",
      scopes: [],
      ...sealTokenSet("ws_a", "intc_drive", { accessToken: "google-access-CANARY7739", refreshToken: "google-refresh-CANARY7740", scopes: [] }),
      config: {},
      createdByUserId: "user_admin",
    })
  })

  afterEach(async () => {
    setRouteCtx(undefined)
    vi.restoreAllMocks()
    await world.close()
  })

  it("never exposes a token or ciphertext anywhere", async () => {
    const forbidden = new Set<string>([...CANARY_VALUES, "google-access-CANARY7739", "google-refresh-CANARY7740", "fake-slack-bot-token"])
    const ciphertexts = async () => {
      for (const workspaceId of ["ws_a", "ws_b"]) {
        for (const row of await world.store.listConnections(workspaceId, { includeRevoked: true })) {
          if (row.accessTokenEnc) forbidden.add(row.accessTokenEnc)
          if (row.refreshTokenEnc) forbidden.add(row.refreshTokenEnc)
          for (const field of ["access_token", "refresh_token"] as const) {
            const value = openToken(row, field)

            if (value) forbidden.add(value)
          }
        }
      }
    }

    await ciphertexts()

    // Rules (one failing Slack destination to produce stored errors) and deliveries.
    const rules = await standardRules(world)

    await world.rule({
      provider: "slack",
      connectionId: world.connections.slack,
      destination: { provider: "slack", channelId: "CNOPE404", channelName: "gone" },
    })
    await world.dispatch("m_he")
    expect((await world.store.listDeliveries("ws_a")).some((row) => row.status === "failed" && row.lastError)).toBe(true)

    // A token refresh (the Slack fake rotates both tokens).
    await world.store.updateConnection("ws_a", world.connections.slack, { expiresAt: new Date(Date.now() - 1000).toISOString() })
    await getAccessToken("ws_a", world.connections.slack)
    await ciphertexts()

    // OAuth start/complete through the fake Slack authorize and token endpoints.
    const started = await startOAuth({ provider: "slack", workspaceId: "ws_a", userId: "user_admin", role: "admin", returnTo: "/he?panel=settings" })

    expect(started.ok).toBe(true)
    if (started.ok) {
      const state = new URL(started.location).searchParams.get("state") ?? ""
      const session = {
        user: { id: "user_admin", email: "admin@acme.test" },
        memberships: [{ workspaceId: "ws_a", userId: "user_admin", role: "admin", createdAt: "" }],
      } as unknown as SessionContext
      const done = await completeOAuth({
        provider: "slack",
        session,
        query: new URLSearchParams({ code: "fake-slack-code", state }),
        cookieNonce: started.nonce,
      })

      captured.push(JSON.stringify(done), started.location)
    }
    await ciphertexts()

    // Every integrations route, as an admin.
    await as("admin")
    const failed = (await world.store.listDeliveries("ws_a")).find((row) => row.status === "failed")!
    const calls: Array<() => Promise<Response>> = [
      () => listProviders(new Request("http://localhost/x"), routeParams({})),
      () => listConnections(new Request("http://localhost/x"), routeParams({})),
      () => patchConnection(jsonRequest("http://localhost/x", "PATCH", { config: { defaultChannelId: SLACK_CHANNEL } }), routeParams({ id: world.connections.slack })),
      () => testConnection(new Request("http://localhost/x", { method: "POST" }), routeParams({ id: world.connections.slack })),
      () => testConnection(new Request("http://localhost/x", { method: "POST" }), routeParams({ id: world.connections.notion })),
      () => testConnection(new Request("http://localhost/x", { method: "POST" }), routeParams({ id: world.connections.hubspot })),
      () => pickerOptions(new Request("http://localhost/x?purpose=rule"), routeParams({ id: world.connections.slack, picker: "channels" })),
      () => pickerOptions(new Request("http://localhost/x?purpose=rule"), routeParams({ id: world.connections.notion, picker: "databases" })),
      () => pickerOptions(new Request("http://localhost/x?purpose=rule"), routeParams({ id: world.connections.hubspot, picker: "deals" })),
      () => listRules(new Request("http://localhost/x"), routeParams({})),
      () =>
        createRule(
          jsonRequest("http://localhost/x", "POST", {
            provider: "notion",
            connectionId: world.connections.notion,
            name: "n",
            trigger: "summary.created",
            destination: { provider: "notion", databaseId: NOTION_DB, databaseTitle: "x" },
          }),
          routeParams({})
        ),
      () => patchRule(jsonRequest("http://localhost/x", "PATCH", { name: "renamed" }), routeParams({ id: rules.slack })),
      () => listDeliveries(new Request("http://localhost/x"), routeParams({})),
      () => getDelivery(new Request("http://localhost/x"), routeParams({ id: failed.id })),
      () => retryDelivery(new Request("http://localhost/x", { method: "POST" }), routeParams({ id: failed.id })),
      () => oauthStart(new Request("http://localhost/api/integrations/slack/oauth/start?returnTo=/he"), routeParams({ provider: "slack" })),
      () => getPrefs(new Request("http://localhost/x"), routeParams({ id: "m_he" })),
      () => putPrefs(jsonRequest("http://localhost/x", "PUT", { emailRecap: "on" }), routeParams({ id: "m_he" })),
      () =>
        sendRoute(
          jsonRequest("http://localhost/x", "POST", {
            connectionId: world.connections.slack,
            destination: { provider: "slack", channelId: SLACK_CHANNEL, channelName: "general" },
          }),
          routeParams({ id: "m_two" })
        ),
      () => sendRoute(jsonRequest("http://localhost/x", "POST", { connectionId: world.connections.slack, destination: { provider: "slack", channelId: "CNOPE404", channelName: "" } }), routeParams({ id: "m_two" })),
      () => exportNotion(jsonRequest("http://localhost/x", "POST", { databaseId: NOTION_DB }), routeParams({ id: "m_two" })),
      () => exportNotion(jsonRequest("http://localhost/x", "POST", { token: CANARY.notion.access }), routeParams({ id: "m_two" })),
      () => exportGoogleDocs(jsonRequest("http://localhost/x", "POST", {}), routeParams({ id: "m_two" })),
      () => unsubscribeGet(new Request("http://localhost/api/email/unsubscribe?token=bogus"), routeParams({})),
      () => unsubscribePost(new Request("http://localhost/api/email/unsubscribe?token=bogus", { method: "POST" }), routeParams({})),
      () => deleteRule(new Request("http://localhost/x", { method: "DELETE" }), routeParams({ id: rules.email })),
    ]

    for (const call of calls) {
      const response = await record(await call())

      expect(response.status, await response.clone().text()).toBeLessThan(500)
    }
    await world.drain()

    // A reauth-producing failure, then disconnect (best-effort revoke at the fake).
    await world.store.updateConnection("ws_a", world.connections.hubspot, { expiresAt: new Date(Date.now() - 1000).toISOString() })
    await record(await testConnection(new Request("http://localhost/x", { method: "POST" }), routeParams({ id: world.connections.hubspot })))
    await ciphertexts()
    await record(await deleteConnection(new Request("http://localhost/x", { method: "DELETE" }), routeParams({ id: world.connections.slack })))
    expect(world.providerRequests("slack", "auth.revoke").length).toBeGreaterThan(0)

    // Everything that could carry a token.
    const surfaces: Record<string, unknown> = {
      responses: captured,
      audits,
      logs,
      jobs: world.rt.jobs,
      failures: world.rt.failures,
      fakeProviderLog: world.server.requests(),
      emails: world.emails,
    }

    for (const workspaceId of ["ws_a", "ws_b"]) {
      surfaces[`deliveries:${workspaceId}`] = await world.store.listDeliveries(workspaceId, { limit: 500 })
      surfaces[`connectionErrors:${workspaceId}`] = (await world.store.listConnections(workspaceId, { includeRevoked: true })).map((row) => [row.lastError, row.config])
      surfaces[`rules:${workspaceId}`] = await world.store.listRules(workspaceId)
      for (const meetingId of ["m_he", "m_two"]) {
        surfaces[`prefs:${workspaceId}:${meetingId}`] = await world.store.getPrefs(workspaceId, meetingId)
        for (const connectionId of Object.values(world.connections)) {
          for (const kind of ["slack_message", "notion_page", "hubspot_engagement", "hubspot_task", "google_doc"] as const) {
            surfaces[`links:${workspaceId}:${meetingId}:${connectionId}:${kind}`] = await world.store.listLinks({ workspaceId, connectionId, meetingId }, kind)
          }
        }
      }
    }

    expect(forbidden.size).toBeGreaterThan(CANARY_VALUES.length)
    for (const [surface, value] of Object.entries(surfaces)) {
      const text = JSON.stringify(value) ?? ""

      for (const secret of forbidden) {
        expect(text.includes(secret), `${surface} leaks a token or ciphertext`).toBe(false)
      }
      expect(/"[a-z]+TokenEnc"|_token_enc/.test(text), `${surface} names a token column`).toBe(false)
    }
  })
})
