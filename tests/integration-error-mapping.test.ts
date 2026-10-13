import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createTestCtx, jsonRequest, routeParams, setRouteCtx, testMeeting } from "./helpers/route-ctx"

vi.mock("@/lib/auth/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/authz")>()
  const { mockAuthzModule } = await import("./helpers/route-ctx")

  return mockAuthzModule(actual)
})

vi.mock("@/lib/audit", () => ({ recordAuditLog: vi.fn(async () => undefined) }))
vi.mock("@/lib/notifications/enqueue", () => ({ enqueueIntegrationReauthNotification: vi.fn(async () => undefined) }))

import { GET as pickerOptions } from "@/app/api/integrations/connections/[id]/options/[picker]/route"
import { POST as createRule } from "@/app/api/integrations/rules/route"
import { POST as sendToIntegration } from "@/app/api/meetings/[id]/integrations/send/route"
import { setProviderTransportForTesting } from "@/lib/integrations/core/http"
import { setIntegrationQueuePortForTesting } from "@/lib/integrations/core/queue"
import { flagNeedsReauthOnAuth } from "@/lib/integrations/core/reauth"
import { setIntegrationStoreForTesting, type IntegrationStore } from "@/lib/integrations/core/store"
import { createMemoryIntegrationStore } from "@/lib/integrations/core/store-memory"
import { sealTokenSet } from "@/lib/integrations/core/tokens"
import { ProviderError } from "@/lib/integrations/core/types"
import { createRecordingQueue } from "@/lib/integrations/testing/harness"
import { createInMemoryMeetingDatabase } from "@/lib/meetings/repository"
import { resetRateLimitsForTesting } from "@/lib/rate-limit"

/**
 * M8 Integration step, error mapping: a provider `auth` failure (Slack
 * `invalid_auth`, any 401) on a picker, a rule's destination check or a
 * manual send's destination check marks the connection `needs_reauth`
 * (the delivery worker and token refresh already did); other errors never
 * change the connection status.
 */

process.env.MEETSUM_SESSION_SECRET ??= "test-session-secret-for-integrations"

const BASE = "http://localhost/api"

describe("ProviderError auth → needs_reauth", () => {
  let store: IntegrationStore
  let slackError = "invalid_auth"

  beforeEach(async () => {
    resetRateLimitsForTesting()
    store = createMemoryIntegrationStore()
    setIntegrationStoreForTesting(store)
    setIntegrationQueuePortForTesting(createRecordingQueue([]))
    slackError = "invalid_auth"
    setProviderTransportForTesting(async () => Response.json({ ok: false, error: slackError }))

    const created = await store.createConnection({
      id: "intc_a",
      workspaceId: "ws_a",
      provider: "slack",
      status: "active",
      accountLabel: "Acme",
      externalAccountId: "T1",
      scopes: [],
      ...sealTokenSet("ws_a", "intc_a", { accessToken: "xoxb-mapping-token", scopes: [] }),
      config: {},
      createdByUserId: "user_admin",
    })

    if (!created.ok) throw new Error("setup")
    setRouteCtx(
      await createTestCtx({
        role: "admin",
        userId: "user_admin",
        database: createInMemoryMeetingDatabase([testMeeting({ id: "m_a" })]),
      })
    )
  })

  afterEach(() => {
    setRouteCtx(undefined)
    setIntegrationStoreForTesting(undefined)
    setIntegrationQueuePortForTesting(undefined)
    setProviderTransportForTesting(undefined)
  })

  const status = async () => (await store.getConnection("ws_a", "intc_a"))?.status

  it("flags the connection from a picker", async () => {
    const response = await pickerOptions(new Request(`${BASE}/x?purpose=rule`), routeParams({ id: "intc_a", picker: "channels" }))

    expect(response.status).toBe(409)
    expect(await status()).toBe("needs_reauth")
  })

  it("flags the connection from a rule's destination check", async () => {
    const response = await createRule(
      jsonRequest(`${BASE}/x`, "POST", {
        provider: "slack",
        connectionId: "intc_a",
        name: "r",
        trigger: "meeting.completed",
        destination: { provider: "slack", channelId: "C1", channelName: "general" },
      }),
      routeParams({})
    )

    expect(response.status).toBe(409)
    expect(await status()).toBe("needs_reauth")
  })

  it("flags the connection from a manual send's destination check", async () => {
    const response = await sendToIntegration(
      jsonRequest(`${BASE}/x`, "POST", { connectionId: "intc_a", destination: { provider: "slack", channelId: "C1", channelName: "general" } }),
      routeParams({ id: "m_a" })
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: "integration_needs_reauth" })
    expect(await status()).toBe("needs_reauth")
  })

  it("leaves the connection active for non-auth failures", async () => {
    slackError = "channel_not_found"
    const response = await sendToIntegration(
      jsonRequest(`${BASE}/x`, "POST", { connectionId: "intc_a", destination: { provider: "slack", channelId: "C1", channelName: "general" } }),
      routeParams({ id: "m_a" })
    )

    expect(response.status).toBe(400)
    expect(await status()).toBe("active")

    await flagNeedsReauthOnAuth("ws_a", "intc_a", new ProviderError("rate_limited", "x"), { store })
    await flagNeedsReauthOnAuth("ws_a", "intc_a", new Error("plain"), { store })
    expect(await status()).toBe("active")
  })
})
