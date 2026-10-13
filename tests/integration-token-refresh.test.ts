import { beforeEach, describe, expect, it, vi } from "vitest"

import { upsertConnectionFromOAuth } from "@/lib/integrations/core/connections"
import type { IntegrationStore } from "@/lib/integrations/core/store"
import { createMemoryIntegrationStore } from "@/lib/integrations/core/store-memory"
import { getAccessToken, openToken } from "@/lib/integrations/core/tokens"
import { ProviderError, type IntegrationProvider, type TokenSet } from "@/lib/integrations/core/types"

vi.mock("@/lib/audit", () => ({ recordAuditLog: vi.fn(async () => undefined) }))

/**
 * M8 "Token refresh": refresh within 120 s of expiry under the row lock,
 * concurrent callers refresh once, a rotated refresh token is persisted,
 * `invalid_grant` → `needs_reauth` plus one notification.
 */

process.env.MEETSUM_SESSION_SECRET ??= "test-session-secret-for-integrations"

describe("getAccessToken refresh", () => {
  let store: IntegrationStore
  let connectionId: string
  let refresh: ReturnType<typeof vi.fn<(token: string) => Promise<TokenSet>>>
  let provider: IntegrationProvider
  const notify = vi.fn(async () => ({ skipped: false }))

  beforeEach(async () => {
    store = createMemoryIntegrationStore()
    notify.mockClear()
    refresh = vi.fn(async (token: string) => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return {
        accessToken: `access-after-${token}`,
        refreshToken: "refresh-rotated",
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        scopes: ["a"],
      }
    })
    provider = { id: "hubspot", scope: "workspace", configured: () => true, oauth: { pkce: false, scopes: [], authorizeUrl: () => "", exchangeCode: async () => { throw new Error("unused") }, refresh } }

    const created = await upsertConnectionFromOAuth(
      {
        workspaceId: "ws_a",
        provider: "hubspot",
        actorUserId: "user_admin",
        exchange: {
          accessToken: "access-old",
          refreshToken: "refresh-old",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          scopes: ["a"],
          account: { externalId: "hub1", label: "hub.example" },
        },
      },
      store
    )

    if (!created.ok) throw new Error("setup")
    connectionId = created.connection.id
  })

  const deps = () => ({ store, provider: () => provider, notify })

  it("does not refresh a token that is still fresh", async () => {
    await store.updateConnection("ws_a", connectionId, { expiresAt: new Date(Date.now() + 3600_000).toISOString() })

    expect(await getAccessToken("ws_a", connectionId, deps())).toBe("access-old")
    expect(refresh).not.toHaveBeenCalled()
  })

  it("refreshes once under concurrency and persists the rotated refresh token", async () => {
    const tokens = await Promise.all([1, 2, 3, 4].map(() => getAccessToken("ws_a", connectionId, deps())))

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledWith("refresh-old")
    expect(new Set(tokens)).toEqual(new Set(["access-after-refresh-old"]))

    const row = await store.getConnection("ws_a", connectionId)

    expect(row && openToken(row, "refresh_token")).toBe("refresh-rotated")
    expect(row?.lastRefreshedAt).toBeDefined()
  })

  it("marks the connection needs_reauth on invalid_grant and notifies the creator once", async () => {
    refresh.mockRejectedValue(new ProviderError("auth", "invalid_grant", { providerCode: "invalid_grant" }))

    await expect(getAccessToken("ws_a", connectionId, deps())).rejects.toMatchObject({ kind: "auth" })
    await expect(getAccessToken("ws_a", connectionId, deps())).rejects.toMatchObject({ kind: "auth" })

    const row = await store.getConnection("ws_a", connectionId)

    expect(row?.status).toBe("needs_reauth")
    expect(row?.lastError).toMatch(/^code=forbidden kind=auth provider=hubspot/)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith({ workspaceId: "ws_a", userId: "user_admin", connectionId, provider: "hubspot" })
  })

  it("keeps the connection active on a retryable refresh failure", async () => {
    refresh.mockRejectedValue(new ProviderError("retryable", "503"))

    await expect(getAccessToken("ws_a", connectionId, deps())).rejects.toMatchObject({ kind: "retryable" })
    expect((await store.getConnection("ws_a", connectionId))?.status).toBe("active")
  })
})
