import { beforeEach, describe, expect, it, vi } from "vitest"

import { disconnectConnection, upsertConnectionFromOAuth } from "@/lib/integrations/core/connections"
import { runIntegrationDelivery } from "@/lib/integrations/core/deliver"
import { runIntegrationDispatch } from "@/lib/integrations/core/dispatcher"
import { markConnectionNeedsReauth } from "@/lib/integrations/core/reauth"
import type { IntegrationStore } from "@/lib/integrations/core/store"
import { createMemoryIntegrationStore } from "@/lib/integrations/core/store-memory"
import { getAccessToken } from "@/lib/integrations/core/tokens"
import { ProviderError, type DeliverResult } from "@/lib/integrations/core/types"
import { createTestRuntime, testMeetingRecord, testRule } from "@/lib/integrations/testing/harness"

vi.mock("@/lib/audit", () => ({ recordAuditLog: vi.fn(async () => undefined) }))
// Disconnect never reaches a real provider revoke endpoint here.
vi.mock("@/lib/integrations/core/registry", async (original) => ({
  ...(await original<typeof import("@/lib/integrations/core/registry")>()),
  getProvider: () => undefined,
}))

/**
 * M8 review fix #1: `needs_reauth` is a compare-and-set on the generation
 * observed with the failure, so a stale failure never flips a freshly
 * reconnected (or revoked) connection.
 */

process.env.MEETSUM_SESSION_SECRET ??= "test-session-secret-for-integrations"

const exchange = (accessToken: string, refreshToken?: string) => ({
  accessToken,
  ...(refreshToken ? { refreshToken } : {}),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  scopes: ["a"],
  account: { externalId: "hub1", label: "hub.example" },
})

describe("needs_reauth generation CAS", () => {
  let store: IntegrationStore
  let connectionId: string
  const notify = vi.fn(async () => ({ skipped: false }))

  async function reconnect() {
    const again = await upsertConnectionFromOAuth(
      { workspaceId: "ws_a", provider: "hubspot", actorUserId: "user_admin", exchange: exchange("access-new", "refresh-new") },
      store
    )

    if (!again.ok) throw new Error("reconnect")
    return again.connection
  }

  beforeEach(async () => {
    store = createMemoryIntegrationStore()
    notify.mockClear()

    const created = await upsertConnectionFromOAuth(
      { workspaceId: "ws_a", provider: "hubspot", actorUserId: "user_admin", exchange: exchange("access-old", "refresh-old") },
      store
    )

    if (!created.ok) throw new Error("setup")
    connectionId = created.connection.id
  })

  it("ignores a stale-token failure observed before a reconnect", async () => {
    const observed = (await store.getConnection("ws_a", connectionId))!.generation
    const fresh = await reconnect()

    expect(fresh.generation).toBe(observed + 1)

    await markConnectionNeedsReauth("ws_a", connectionId, new ProviderError("auth", "401"), { store, notify, generation: observed })

    const after = await store.getConnection("ws_a", connectionId)

    expect(after?.status).toBe("active")
    expect(after?.lastError).toBeUndefined()
    expect(notify).not.toHaveBeenCalled()
  })

  it("flags the connection when the failure belongs to the current generation", async () => {
    const observed = (await store.getConnection("ws_a", connectionId))!.generation

    await markConnectionNeedsReauth("ws_a", connectionId, new ProviderError("auth", "401"), { store, notify, generation: observed })

    expect((await store.getConnection("ws_a", connectionId))?.status).toBe("needs_reauth")
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it("never flags a connection revoked by a disconnect racing the reauth mark", async () => {
    const row = (await store.getConnection("ws_a", connectionId))!

    await disconnectConnection(row, { workspaceId: "ws_a" }, store)
    await markConnectionNeedsReauth("ws_a", connectionId, new ProviderError("auth", "401"), { store, notify, generation: row.generation })

    expect((await store.getConnection("ws_a", connectionId))?.status).toBe("revoked")
    expect(notify).not.toHaveBeenCalled()
  })
})

describe("deliver does not flag reauth for connection-state errors", () => {
  it.each(["connection_changed", "connection_inactive"])("leaves the connection active for %s", async (providerCode) => {
    const rt = createTestRuntime({ meetings: [testMeetingRecord({ id: "m_a" })] })
    const deliver = vi.fn(async (): Promise<DeliverResult> => {
      throw new ProviderError("auth", "connection changed", { providerCode })
    })

    rt.providers.set("slack", { id: "slack", scope: "workspace", configured: () => true, deliver })

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

    await runIntegrationDelivery({ workspaceId: "ws_a", deliveryId: delivery.id, finalAttempt: false }, rt)

    expect((await rt.store.getConnection("ws_a", created.connection.id))?.status).toBe("active")
  })

  it("tags connection-state errors from getAccessToken with distinct provider codes", async () => {
    const store = createMemoryIntegrationStore()
    const created = await upsertConnectionFromOAuth(
      { workspaceId: "ws_a", provider: "hubspot", actorUserId: "user_admin", exchange: exchange("a", "r") },
      store
    )

    if (!created.ok) throw new Error("setup")
    await disconnectConnection(created.connection, { workspaceId: "ws_a" }, store)

    await expect(getAccessToken("ws_a", created.connection.id, { store })).rejects.toMatchObject({
      kind: "auth",
      providerCode: "connection_inactive",
    })
  })
})
