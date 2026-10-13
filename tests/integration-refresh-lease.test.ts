import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { disconnectConnection, upsertConnectionFromOAuth } from "@/lib/integrations/core/connections"
import type { IntegrationStore } from "@/lib/integrations/core/store"
import { createMemoryIntegrationStore } from "@/lib/integrations/core/store-memory"
import { createPostgresIntegrationStore } from "@/lib/integrations/core/store-postgres"
import { getAccessToken, openToken, REFRESH_LEASE_MS } from "@/lib/integrations/core/tokens"
import { ProviderError, type IntegrationProvider, type TokenSet } from "@/lib/integrations/core/types"
import { createMigratedPglite, seedIntegrationFixtures, type TestPg } from "@/lib/integrations/testing/pglite"

vi.mock("@/lib/audit", () => ({ recordAuditLog: vi.fn(async () => undefined) }))
// Disconnect never reaches a real provider revoke endpoint here.
vi.mock("@/lib/integrations/core/registry", async (original) => ({
  ...(await original<typeof import("@/lib/integrations/core/registry")>()),
  getProvider: () => undefined,
}))

/**
 * M8 review fix #3: token refresh holds a short `refresh_lease_until` lease
 * (migration 029) instead of a DB transaction and row lock across the
 * provider call. Single flight and the generation compare-and-set stay; the
 * `lastError` of a failed refresh is written after the lease is released
 * and is never rolled back.
 */

process.env.MEETSUM_SESSION_SECRET ??= "test-session-secret-for-integrations"

let pg: TestPg | undefined

beforeAll(async () => {
  const created = await createMigratedPglite()

  pg = created.db
  if (pg) await seedIntegrationFixtures(pg)
}, 120_000)

afterAll(async () => {
  await pg?.close()
})

describe.each(["memory", "postgres"] as const)("refresh lease (%s)", (kind) => {
  let store: IntegrationStore
  let connectionId: string
  let refresh: ReturnType<typeof vi.fn<(token: string) => Promise<TokenSet>>>
  let revoke: ReturnType<typeof vi.fn<(tokens: TokenSet) => Promise<void>>>
  let provider: IntegrationProvider
  const notify = vi.fn(async () => ({ skipped: false }))
  const sleep = vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5))
  })

  const deps = () => ({ store, provider: () => provider, notify, sleep })

  async function connect(accessToken: string, refreshToken: string) {
    const result = await upsertConnectionFromOAuth(
      {
        workspaceId: "ws_a",
        provider: "hubspot",
        actorUserId: "user_admin",
        exchange: {
          accessToken,
          refreshToken,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          scopes: ["a"],
          account: { externalId: "hub1", label: "hub.example" },
        },
      },
      store
    )

    if (!result.ok) throw new Error("connect")
    return result.connection
  }

  beforeEach(async (context) => {
    if (kind === "postgres") {
      if (!pg) return context.skip()
      await pg.exec("delete from integration_connections")
      store = createPostgresIntegrationStore(pg)
    } else {
      store = createMemoryIntegrationStore()
    }
    notify.mockClear()
    sleep.mockClear()
    refresh = vi.fn(async (token: string) => ({
      accessToken: `access-after-${token}`,
      refreshToken: "refresh-rotated",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      scopes: ["a"],
    }))
    revoke = vi.fn(async () => undefined)
    provider = {
      id: "hubspot",
      scope: "workspace",
      configured: () => true,
      oauth: { pkce: false, scopes: [], authorizeUrl: () => "", exchangeCode: async () => { throw new Error("unused") }, refresh, revoke },
    }
    connectionId = (await connect("access-old", "refresh-old")).id
  })

  it("refreshes, persists the rotated token and releases the lease", async () => {
    expect(await getAccessToken("ws_a", connectionId, deps())).toBe("access-after-refresh-old")

    const row = await store.getConnection("ws_a", connectionId)

    expect(row && openToken(row, "refresh_token")).toBe("refresh-rotated")
    expect(row?.refreshLeaseUntil).toBeUndefined()
  })

  it("keeps lastError of a retryable refresh failure (written after the lease, never rolled back)", async () => {
    refresh.mockRejectedValue(new ProviderError("retryable", "503"))

    await expect(getAccessToken("ws_a", connectionId, deps())).rejects.toMatchObject({ kind: "retryable" })

    const row = await store.getConnection("ws_a", connectionId)

    expect(row?.status).toBe("active")
    expect(row?.lastError).toMatch(/kind=retryable provider=hubspot/)
    expect(row?.refreshLeaseUntil).toBeUndefined()
  })

  it("does not hold a row lock across the provider call: a disconnect completes meanwhile and the orphan tokens are revoked", async () => {
    let release!: () => void

    refresh.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { accessToken: "access-orphan", refreshToken: "refresh-orphan", scopes: [] }
    })

    const pending = getAccessToken("ws_a", connectionId, deps())

    await vi.waitFor(() => expect(refresh).toHaveBeenCalled())

    // Completes while the provider call is still in flight.
    await disconnectConnection((await store.getConnection("ws_a", connectionId))!, { workspaceId: "ws_a" }, store)
    expect((await store.getConnection("ws_a", connectionId))?.status).toBe("revoked")

    release()
    await expect(pending).rejects.toMatchObject({ kind: "auth", providerCode: "connection_changed" })
    expect(revoke).toHaveBeenCalledWith(expect.objectContaining({ accessToken: "access-orphan" }))
    expect((await store.getConnection("ws_a", connectionId))?.accessTokenEnc).toBeUndefined()
  })

  it("keeps a reconnected connection active when the old grant's refresh fails with invalid_grant", async () => {
    let release!: () => void

    refresh.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      throw new ProviderError("auth", "invalid_grant", { providerCode: "invalid_grant" })
    })

    const pending = getAccessToken("ws_a", connectionId, deps())

    await vi.waitFor(() => expect(refresh).toHaveBeenCalled())
    // A reconnect completes while the old refresh is in flight.
    await connect("access-new", "refresh-new")
    release()

    await expect(pending).rejects.toMatchObject({ kind: "auth" })

    const after = await store.getConnection("ws_a", connectionId)

    expect(after?.status).toBe("active")
    expect(after && openToken(after, "access_token")).toBe("access-new")
    expect(notify).not.toHaveBeenCalled()
  })

  it("waits for another holder's lease instead of refreshing twice (single flight across processes)", async () => {
    const row = (await store.getConnection("ws_a", connectionId))!
    const now = new Date()
    const leased = await store.acquireRefreshLease("ws_a", connectionId, row.generation, new Date(now.getTime() + REFRESH_LEASE_MS), now)

    expect(leased).toBeDefined()
    // A second lease on the same generation is refused while the first is live.
    expect(await store.acquireRefreshLease("ws_a", connectionId, row.generation, new Date(now.getTime() + REFRESH_LEASE_MS), now)).toBeUndefined()

    const waiting = getAccessToken("ws_a", connectionId, deps())

    await vi.waitFor(() => expect(sleep).toHaveBeenCalled())
    // The other process finishes its refresh.
    await store.updateConnectionIfCurrent("ws_a", connectionId, row.generation, {
      accessTokenEnc: (await import("@/lib/integrations/core/tokens")).sealToken("ws_a", connectionId, "access_token", "access-other"),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      refreshLeaseUntil: null,
    })

    expect(await waiting).toBe("access-other")
    expect(refresh).not.toHaveBeenCalled()
  })

  it("takes over an expired lease", async () => {
    const row = (await store.getConnection("ws_a", connectionId))!
    const past = new Date(Date.now() - 2 * REFRESH_LEASE_MS)

    expect(await store.acquireRefreshLease("ws_a", connectionId, row.generation, new Date(past.getTime() + 1000), past)).toBeDefined()
    expect(await getAccessToken("ws_a", connectionId, deps())).toBe("access-after-refresh-old")
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})
