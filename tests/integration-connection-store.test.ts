import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  disconnectConnection,
  toConnectionDTO,
  upsertConnectionFromOAuth,
  validateConfigPatch,
} from "@/lib/integrations/core/connections"
import type { IntegrationStore } from "@/lib/integrations/core/store"
import { createMemoryIntegrationStore } from "@/lib/integrations/core/store-memory"
import { getAccessToken, openToken, tokenAad } from "@/lib/integrations/core/tokens"
import type { IntegrationConnectionDTO, OAuthExchangeResult } from "@/lib/integrations/core/types"
import { DEFAULT_RULE_CONTENT } from "@/lib/integrations/recap"

vi.mock("@/lib/audit", () => ({ recordAuditLog: vi.fn(async () => undefined) }))

/**
 * M8 A2: tokens never in DTOs, AAD swap fails, cross-workspace → not found,
 * reconnect keeps the id (rules survive), config allowlist, disconnect.
 */

process.env.MEETSUM_SESSION_SECRET ??= "test-session-secret-for-integrations"

const ACCESS = "xoxb-access-fixture"
const REFRESH = "xoxe-refresh-fixture"

function exchange(overrides: Partial<OAuthExchangeResult> = {}): OAuthExchangeResult {
  return {
    accessToken: ACCESS,
    refreshToken: REFRESH,
    scopes: ["chat:write"],
    tokenType: "bot",
    account: { externalId: "T123", label: "Acme" },
    ...overrides,
  }
}

describe("connection store and tokens", () => {
  let store: IntegrationStore

  beforeEach(() => {
    store = createMemoryIntegrationStore()
  })

  it("encrypts tokens with row-bound AAD and never puts them in a DTO", async () => {
    const result = await upsertConnectionFromOAuth(
      { workspaceId: "ws_a", provider: "slack", actorUserId: "user_admin", exchange: exchange() },
      store
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const row = result.connection

    expect(row.accessTokenEnc).toMatch(/^v2:/)
    expect(row.accessTokenEnc).not.toContain(ACCESS)
    expect(openToken(row, "access_token")).toBe(ACCESS)
    expect(openToken(row, "refresh_token")).toBe(REFRESH)
    expect(tokenAad("ws_a", row.id, "access_token")).toBe(`ws_a:${row.id}:access_token`)

    const dto = toConnectionDTO(row, { fake: false })
    const keys = Object.keys(dto) as (keyof IntegrationConnectionDTO)[]

    expect(keys.some((key) => /token|_enc/i.test(key))).toBe(false)
    expect(JSON.stringify(dto)).not.toMatch(/xox|v2:/)
    expect(dto).toMatchObject({ provider: "slack", accountLabel: "Acme", status: "active", createdByUserId: "user_admin" })
  })

  it("fails to decrypt a ciphertext moved to another row or field", async () => {
    const a = await upsertConnectionFromOAuth({ workspaceId: "ws_a", provider: "slack", actorUserId: "u", exchange: exchange() }, store)
    const b = await upsertConnectionFromOAuth(
      { workspaceId: "ws_a", provider: "slack", actorUserId: "u", exchange: exchange({ account: { externalId: "T999", label: "B" } }) },
      store
    )

    if (!a.ok || !b.ok) throw new Error("setup")

    expect(() => openToken({ ...b.connection, accessTokenEnc: a.connection.accessTokenEnc }, "access_token")).toThrow()
    expect(() => openToken({ ...a.connection, refreshTokenEnc: a.connection.accessTokenEnc }, "refresh_token")).toThrow()
    expect(() => openToken({ ...a.connection, workspaceId: "ws_b" }, "access_token")).toThrow()
  })

  it("is workspace scoped: another workspace's id is not found", async () => {
    const result = await upsertConnectionFromOAuth({ workspaceId: "ws_a", provider: "slack", actorUserId: "u", exchange: exchange() }, store)

    if (!result.ok) throw new Error("setup")
    expect(await store.getConnection("ws_b", result.connection.id)).toBeUndefined()
    await expect(getAccessToken("ws_b", result.connection.id, { store })).rejects.toMatchObject({ kind: "auth" })
    expect(await getAccessToken("ws_a", result.connection.id, { store })).toBe(ACCESS)
  })

  it("reconnects a needs_reauth connection in place, so its rules survive", async () => {
    const first = await upsertConnectionFromOAuth({ workspaceId: "ws_a", provider: "slack", actorUserId: "u", exchange: exchange() }, store)

    if (!first.ok) throw new Error("setup")

    const ruleResult = await store.createRule({
      id: "intr_1",
      workspaceId: "ws_a",
      provider: "slack",
      connectionId: first.connection.id,
      name: "R",
      enabled: true,
      trigger: "meeting.completed",
      filters: {},
      destination: { provider: "slack", channelId: "C1", channelName: "general" },
      content: DEFAULT_RULE_CONTENT,
      includePrivate: false,
    })

    expect(ruleResult.ok).toBe(true)
    await store.updateConnection("ws_a", first.connection.id, { status: "needs_reauth", lastError: "code=forbidden kind=auth" })

    const again = await upsertConnectionFromOAuth(
      { workspaceId: "ws_a", provider: "slack", actorUserId: "u", exchange: exchange({ accessToken: "xoxb-new", refreshToken: undefined }) },
      store
    )

    if (!again.ok) throw new Error("reconnect")
    expect(again.created).toBe(false)
    expect(again.connection.id).toBe(first.connection.id)
    expect(again.connection.status).toBe("active")
    expect(again.connection.lastError).toBeUndefined()
    expect(openToken(again.connection, "access_token")).toBe("xoxb-new")
    // The old refresh token is kept when none is returned.
    expect(openToken(again.connection, "refresh_token")).toBe(REFRESH)
    expect((await store.getRule("ws_a", "intr_1"))?.connectionId).toBe(first.connection.id)
  })

  it("answers cap when the workspace has 20 connections", async () => {
    for (let index = 0; index < 20; index += 1) {
      await upsertConnectionFromOAuth(
        { workspaceId: "ws_a", provider: "slack", actorUserId: "u", exchange: exchange({ account: { externalId: `T${index}`, label: "x" } }) },
        store
      )
    }
    expect(
      await upsertConnectionFromOAuth(
        { workspaceId: "ws_a", provider: "slack", actorUserId: "u", exchange: exchange({ account: { externalId: "T_new", label: "x" } }) },
        store
      )
    ).toEqual({ ok: false, reason: "cap" })
  })

  it("accepts only the per-provider config allowlist", () => {
    expect(validateConfigPatch("slack", { defaultChannelId: "C1", allowManualSend: false })).toEqual({
      ok: true,
      config: { defaultChannelId: "C1", allowManualSend: false },
    })
    expect(validateConfigPatch("slack", { defaultDatabaseId: "x" })).toMatchObject({ ok: false })
    expect(validateConfigPatch("slack", { allowManualSend: "yes" })).toMatchObject({ ok: false })
    expect(validateConfigPatch("microsoft", { calendarSyncEnabled: true })).toMatchObject({ ok: true })
    expect(validateConfigPatch("google_drive", { anything: 1 })).toMatchObject({ ok: false })
    expect(validateConfigPatch("notion", { defaultDatabaseId: "a\nb" })).toMatchObject({ ok: false })
  })

  it("disconnect wipes tokens, revokes, disables rules and cancels queued deliveries", async () => {
    const created = await upsertConnectionFromOAuth({ workspaceId: "ws_a", provider: "slack", actorUserId: "u", exchange: exchange() }, store)

    if (!created.ok) throw new Error("setup")
    await store.createRule({
      id: "intr_d",
      workspaceId: "ws_a",
      provider: "slack",
      connectionId: created.connection.id,
      name: "R",
      enabled: true,
      trigger: "meeting.completed",
      filters: {},
      destination: { provider: "slack", channelId: "C1", channelName: "general" },
      content: DEFAULT_RULE_CONTENT,
      includePrivate: false,
    })
    await store.insertDelivery({
      id: "intd_q",
      workspaceId: "ws_a",
      connectionId: created.connection.id,
      provider: "slack",
      origin: "rule",
      idempotencyKey: "k",
      status: "queued",
      maxAttempts: 5,
    })

    const result = await disconnectConnection(created.connection, { workspaceId: "ws_a", actorUserId: "u" }, store)
    const row = await store.getConnection("ws_a", created.connection.id)

    expect(result).toEqual({ disabledRules: 1, cancelledDeliveries: 1 })
    expect(row).toMatchObject({ status: "revoked" })
    expect(row?.accessTokenEnc).toBeUndefined()
    expect(row?.refreshTokenEnc).toBeUndefined()
    expect(await store.getRule("ws_a", "intr_d")).toMatchObject({ enabled: false, disabledReason: "connection_revoked" })
  })
})
