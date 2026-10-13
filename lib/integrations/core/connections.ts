/**
 * Connection service (docs/parity/m8.md, A2 and "Disconnect"). Owner:
 * Package A. DTO mapping (never a token or `*_enc`), the encrypted upsert
 * that reconnects a `needs_reauth` connection in place (same id, so rules
 * survive), the per-provider config allowlist, disconnect, and the
 * `ProviderCtx` handed to providers.
 */
import { randomUUID } from "node:crypto"

import { auditIntegration, type IntegrationAuditActor } from "@/lib/integrations/core/audit"
import { integrationLog, publicIntegrationError, storedIntegrationError } from "@/lib/integrations/core/errors"
import { isFakeMode, providerFetch } from "@/lib/integrations/core/http"
import { getProvider } from "@/lib/integrations/core/registry"
import { getIntegrationStore, type IntegrationStore, type StoredConnection } from "@/lib/integrations/core/store"
import { getAccessToken, sealTokenSet, tokenSetForRevoke } from "@/lib/integrations/core/tokens"
import {
  PERSONAL_PROVIDER_IDS,
  type IntegrationConnectionDTO,
  type OAuthExchangeResult,
  type PersonalProviderId,
  type ProviderCtx,
  type ProviderId,
} from "@/lib/integrations/core/types"

export function isPersonalProvider(provider: string): provider is PersonalProviderId {
  return (PERSONAL_PROVIDER_IDS as readonly string[]).includes(provider)
}

/** The API shape: no token fields, `lastError` already redacted. */
export function toConnectionDTO(row: StoredConnection, options: { fake?: boolean } = {}): IntegrationConnectionDTO {
  const fake = options.fake ?? isFakeMode()

  return {
    id: row.id,
    provider: row.provider,
    status: row.status,
    accountLabel: row.accountLabel,
    scopes: [...row.scopes],
    ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}),
    ...(row.userId ? { userId: row.userId } : {}),
    ...(row.createdByUserId ? { createdByUserId: row.createdByUserId } : {}),
    createdAt: row.createdAt,
    ...(row.lastUsedAt ? { lastUsedAt: row.lastUsedAt } : {}),
    ...(row.lastError ? { lastError: publicIntegrationError(row.lastError) } : {}),
    config: { ...row.config },
    ...(fake ? { fake: true } : {}),
  }
}

/** Another member's personal connection, as an admin sees it: label and status only. */
export function toConnectionSummaryDTO(row: StoredConnection, options: { fake?: boolean } = {}): IntegrationConnectionDTO {
  const fake = options.fake ?? isFakeMode()

  return {
    id: row.id,
    provider: row.provider,
    status: row.status,
    accountLabel: row.accountLabel,
    scopes: [],
    ...(row.userId ? { userId: row.userId } : {}),
    createdAt: row.createdAt,
    config: {},
    ...(fake ? { fake: true } : {}),
  }
}

export type UpsertConnectionResult =
  | { ok: true; connection: StoredConnection; created: boolean }
  | { ok: false; reason: "cap" }

/**
 * Encrypted upsert on `(ws, provider, coalesce(user,''), externalId)`: an
 * existing non-revoked connection (e.g. `needs_reauth`) is reconnected in
 * place with the same id; otherwise a new one is inserted (cap 20).
 */
export async function upsertConnectionFromOAuth(
  input: {
    workspaceId: string
    provider: ProviderId
    userId?: string
    actorUserId: string
    exchange: OAuthExchangeResult
  },
  store?: IntegrationStore
): Promise<UpsertConnectionResult> {
  const db = store ?? (await getIntegrationStore())
  const { exchange } = input
  const userId = isPersonalProvider(input.provider) ? input.userId : undefined
  const existing = await db.findConnectionByAccount(input.workspaceId, input.provider, userId, exchange.account.externalId)

  if (existing) {
    // Under the row lock (like disconnect): a reconnect never interleaves
    // with a disconnect or another reconnect, and a row revoked meanwhile is
    // not resurrected (a new connection is created below instead).
    const reconnected = await db.withConnectionLock(input.workspaceId, existing.id, async (current, update) => {
      if (!current || current.status === "revoked") return undefined

      const sealed = sealTokenSet(input.workspaceId, current.id, exchange)

      return update({
        status: "active",
        accountLabel: exchange.account.label.slice(0, 200),
        scopes: exchange.scopes,
        accessTokenEnc: sealed.accessTokenEnc,
        // Keep the old refresh token unless the provider returned a new one.
        ...(sealed.refreshTokenEnc ? { refreshTokenEnc: sealed.refreshTokenEnc } : {}),
        tokenType: exchange.tokenType,
        expiresAt: exchange.expiresAt ?? null,
        config: { ...current.config, ...(exchange.config ?? {}) },
        // A reconnect starts a new token generation (in-flight refreshes and
        // stale reauth marks lose their compare-and-set).
        generation: current.generation + 1,
        refreshLeaseUntil: null,
        lastError: null,
        lastRefreshedAt: new Date().toISOString(),
      })
    })

    if (reconnected) return { ok: true, connection: reconnected, created: false }
  }

  const id = `intc_${randomUUID()}`
  const sealed = sealTokenSet(input.workspaceId, id, exchange)
  const created = await db.createConnection({
    id,
    workspaceId: input.workspaceId,
    provider: input.provider,
    ...(userId ? { userId } : {}),
    status: "active",
    accountLabel: exchange.account.label.slice(0, 200),
    externalAccountId: exchange.account.externalId,
    scopes: exchange.scopes,
    ...sealed,
    ...(exchange.tokenType ? { tokenType: exchange.tokenType } : {}),
    ...(exchange.expiresAt ? { expiresAt: exchange.expiresAt } : {}),
    config: { ...(exchange.config ?? {}) },
    createdByUserId: input.actorUserId,
    lastRefreshedAt: new Date().toISOString(),
  })

  return created.ok ? { ok: true, connection: created.connection, created: true } : created
}

/** Non-secret, per-provider config keys a PATCH may set (A2). */
export const CONFIG_ALLOWLIST: Readonly<Record<ProviderId, Readonly<Record<string, "string" | "boolean">>>> = {
  // The *Name/*Title keys store the picked label, so the UI shows names, not ids.
  slack: { defaultChannelId: "string", defaultChannelName: "string", allowManualSend: "boolean" },
  notion: { defaultDatabaseId: "string", defaultDatabaseTitle: "string", allowManualSend: "boolean" },
  hubspot: { defaultDealId: "string", defaultDealName: "string", allowManualSend: "boolean" },
  microsoft: { calendarSyncEnabled: "boolean" },
  google_drive: {},
}

export type ConfigPatchResult = { ok: true; config: Record<string, unknown> } | { ok: false; error: string }

/** Validates a config patch against the allowlist (`null` removes a string key). */
export function validateConfigPatch(provider: ProviderId, patch: unknown): ConfigPatchResult {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return { ok: false, error: "invalid_config" }

  const allowed = CONFIG_ALLOWLIST[provider]
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    const type = allowed[key]

    if (!type) return { ok: false, error: "config_key_not_allowed" }
    if (type === "boolean" && typeof value !== "boolean") return { ok: false, error: "invalid_config" }
    if (type === "string") {
      if (value !== null && (typeof value !== "string" || value.length > 200 || /[\u0000-\u001f]/.test(value))) {
        return { ok: false, error: "invalid_config" }
      }
    }
    result[key] = value
  }

  return { ok: true, config: result }
}

export function mergeConfig(current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const next = { ...current }

  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === "") delete next[key]
    else next[key] = value
  }

  return next
}

/** What providers receive for tests, pickers and destination checks. */
export function providerCtx(row: StoredConnection, store?: IntegrationStore): ProviderCtx {
  return {
    workspaceId: row.workspaceId,
    connection: toConnectionDTO(row),
    getAccessToken: () => getAccessToken(row.workspaceId, row.id, store ? { store } : {}),
    fetch: providerFetch,
  }
}

export type DisconnectResult = { disabledRules: number; cancelledDeliveries: number }

/**
 * Disconnect: best-effort provider revoke, wipe the tokens, `revoked`,
 * disable dependent rules (`connection_revoked`), cancel queued deliveries,
 * audit `integration.connection.revoked`.
 */
export async function disconnectConnection(
  row: StoredConnection,
  actor: IntegrationAuditActor,
  store?: IntegrationStore
): Promise<DisconnectResult> {
  const db = store ?? (await getIntegrationStore())

  // Under the (short) row lock. A refresh in flight holds no lock, only the
  // refresh lease: its token write is a CAS on the generation bumped here,
  // so it loses and revokes the tokens it got; a refresh that finished
  // before is read and revoked below.
  const tokens = await db.withConnectionLock(row.workspaceId, row.id, async (current, update) => {
    if (!current) return undefined

    const sealed = tokenSetForRevoke(current)

    await update({
      status: "revoked",
      revokedAt: new Date().toISOString(),
      accessTokenEnc: null,
      refreshTokenEnc: null,
      expiresAt: null,
      generation: current.generation + 1,
      refreshLeaseUntil: null,
    })
    return sealed
  })

  // Best effort at the provider; the local revoke above already happened.
  const provider = getProvider(row.provider)

  if (tokens && provider?.oauth?.revoke) {
    await provider.oauth.revoke(tokens).catch((error: unknown) => {
      integrationLog.warn(`${row.provider} revoke failed`, error)
    })
  }

  const disabled = await db.disableRulesForConnection(row.workspaceId, row.id, "connection_revoked")
  const cancelled = await db.cancelQueuedDeliveriesForConnection(row.workspaceId, row.id)

  await auditIntegration(actor, "integration.connection.revoked", { type: "integration_connection", id: row.id }, {
    provider: row.provider,
    disabledRules: disabled.length,
    cancelledDeliveries: cancelled.length,
  })

  return { disabledRules: disabled.length, cancelledDeliveries: cancelled.length }
}

/** Provider "Test connection": updates `last_used_at` / `last_error`, audits the outcome. */
export async function testConnection(
  row: StoredConnection,
  actor: IntegrationAuditActor,
  store?: IntegrationStore
): Promise<{ ok: boolean; error?: string }> {
  const db = store ?? (await getIntegrationStore())
  const provider = getProvider(row.provider)

  if (!provider?.test) return { ok: false, error: "test_not_supported" }

  try {
    await provider.test(providerCtx(row, db))
    await db.updateConnection(row.workspaceId, row.id, { lastUsedAt: new Date().toISOString(), lastError: null })
    await auditIntegration(actor, "integration.connection.tested", { type: "integration_connection", id: row.id }, {
      provider: row.provider,
      status: "ok",
    })
    return { ok: true }
  } catch (error) {
    const kind = (error as { kind?: string }).kind

    if (kind === "auth") {
      const { markConnectionNeedsReauth } = await import("@/lib/integrations/core/reauth")

      await markConnectionNeedsReauth(row.workspaceId, row.id, error, { store: db, generation: row.generation })
    } else {
      await db.updateConnection(row.workspaceId, row.id, { lastError: storedIntegrationError(error, row.provider) })
    }
    await auditIntegration(actor, "integration.connection.tested", { type: "integration_connection", id: row.id }, {
      provider: row.provider,
      status: "failed",
      kind: typeof kind === "string" ? kind : "unknown",
    })
    return { ok: false, error: typeof kind === "string" ? kind : "failed" }
  }
}
