/**
 * M8 integrations persistence (docs/parity/m8.md, "Model and rules").
 * Owner: Package A. One interface over the seven 027 tables with a memory
 * implementation (demo/tests) and a Postgres one (hand-written SQL).
 *
 * Isolation: every per-row method takes a `workspaceId` and filters on it;
 * a row of another workspace is "not found". The only unscoped methods are
 * named `system*` (worker sweeps). Child ids are joined within the
 * workspace (a rule can only reference a same-workspace, same-provider,
 * active connection).
 *
 * Token columns (`*_enc`) exist only on `StoredConnection`; nothing outside
 * core/tokens.ts and core/connections.ts reads them, and DTO mapping drops
 * them (core/connections.ts `toConnectionDTO`).
 */
import { getDatabasePool } from "@/lib/db/client"
import type {
  ConnectionStatus,
  DeliveryOrigin,
  DeliveryProgress,
  DeliverySkipReason,
  DeliveryStatus,
  EmailRecapPreference,
  IntegrationLink,
  IntegrationLinkKey,
  IntegrationRuleDTO,
  MeetingIntegrationPrefs,
  ProviderId,
  RuleProviderId,
  RuleTrigger,
} from "@/lib/integrations/core/types"

export type StoredConnection = {
  id: string
  workspaceId: string
  provider: ProviderId
  /** Personal connections only. */
  userId?: string
  status: ConnectionStatus
  accountLabel: string
  externalAccountId: string
  scopes: string[]
  /** `v2` ciphertexts bound to `${ws}:${id}:access_token` / `refresh_token`. */
  accessTokenEnc?: string
  refreshTokenEnc?: string
  tokenType?: string
  expiresAt?: string
  /** Non-secret config; never contains the reserved `_gen` key (see `generation`). */
  config: Record<string, unknown>
  /**
   * Token generation: bumped by every disconnect and reconnect. Token writes
   * are conditional on `status = 'active'` and the generation read before
   * the write, so a refresh racing a disconnect can never resurrect tokens.
   * Persisted as `config._gen` (no dedicated column in migration 027).
   */
  generation: number
  createdByUserId?: string
  lastUsedAt?: string
  lastRefreshedAt?: string
  lastError?: string
  revokedAt?: string
  createdAt: string
  updatedAt: string
}

export type ConnectionPatch = Partial<
  Pick<
    StoredConnection,
    | "status"
    | "accountLabel"
    | "scopes"
    | "tokenType"
    | "config"
    | "lastUsedAt"
    | "lastRefreshedAt"
    | "revokedAt"
  >
> & {
  /** `null` clears. */
  accessTokenEnc?: string | null
  refreshTokenEnc?: string | null
  expiresAt?: string | null
  lastError?: string | null
  generation?: number
}

/** Key under which `generation` is persisted inside `config`. */
export const GENERATION_CONFIG_KEY = "_gen"

export type NewConnection = Omit<StoredConnection, "createdAt" | "updatedAt" | "generation"> & { generation?: number }

export type OAuthStateRow = {
  nonce: string
  workspaceId: string
  userId: string
  provider: string
  codeVerifierEnc?: string
  returnTo?: string
  createdAt: string
  expiresAt: string
  usedAt?: string
}

export type StoredRule = IntegrationRuleDTO & { workspaceId: string }

export type NewRule = Omit<StoredRule, "createdAt" | "updatedAt" | "disabledReason"> & {
  disabledReason?: string
}

export type RulePatch = Partial<
  Pick<
    StoredRule,
    "name" | "enabled" | "trigger" | "filters" | "destination" | "content" | "includePrivate" | "createdByUserId"
  >
> & { disabledReason?: string | null }

export type StoredDelivery = {
  id: string
  workspaceId: string
  ruleId?: string
  connectionId?: string
  provider: RuleProviderId | ProviderId
  origin: DeliveryOrigin
  eventName?: string
  eventId?: string
  meetingId?: string
  actionItemId?: string
  idempotencyKey: string
  status: DeliveryStatus
  skipReason?: DeliverySkipReason
  attempts: number
  maxAttempts: number
  progress: DeliveryProgress
  externalRef: Record<string, unknown>
  lastError?: string
  requestedByUserId?: string
  createdAt: string
  updatedAt: string
  completedAt?: string
}

export type NewDelivery = Omit<StoredDelivery, "createdAt" | "updatedAt" | "attempts" | "progress" | "externalRef"> & {
  progress?: DeliveryProgress
  externalRef?: Record<string, unknown>
}

export type DeliveryPatch = Partial<
  Pick<StoredDelivery, "status" | "attempts" | "maxAttempts" | "progress" | "externalRef">
> & {
  skipReason?: DeliverySkipReason | null
  lastError?: string | null
  completedAt?: string | null
}

export type DeliveryListFilter = {
  status?: DeliveryStatus
  provider?: string
  ruleId?: string
  meetingId?: string
  /** Cursor: rows created strictly before this `createdAt|id`. */
  before?: string
  limit?: number
}

export type LinkScope = { workspaceId: string; connectionId: string; meetingId: string }

export type PrefsPatch = {
  allowPrivatePush?: boolean
  allowPrivateSetByUserId?: string | null
  emailRecap?: EmailRecapPreference
  updatedByUserId?: string
}

export type UnsubscribeSource = "link" | "one_click" | "admin"

/** Caps enforced in the store (docs/parity/m8.md, "Caps"). */
export const MAX_CONNECTIONS_PER_WORKSPACE = 20
export const MAX_RULES_PER_WORKSPACE = 50
export const MAX_RULES_PER_EVENT = 50

export type CreateConnectionResult = { ok: true; connection: StoredConnection } | { ok: false; reason: "cap" }
export type CreateRuleResult =
  | { ok: true; rule: StoredRule }
  | { ok: false; reason: "cap" | "connection_not_found" }

export interface IntegrationStore {
  readonly kind: "memory" | "postgres"

  // Connections -----------------------------------------------------------
  /** Non-revoked connection with this account key (reconnect target). */
  findConnectionByAccount(
    workspaceId: string,
    provider: ProviderId,
    userId: string | undefined,
    externalAccountId: string
  ): Promise<StoredConnection | undefined>
  /** Insert unless the workspace already has 20 non-revoked connections. */
  createConnection(input: NewConnection): Promise<CreateConnectionResult>
  getConnection(workspaceId: string, id: string): Promise<StoredConnection | undefined>
  listConnections(workspaceId: string, options?: { includeRevoked?: boolean }): Promise<StoredConnection[]>
  updateConnection(workspaceId: string, id: string, patch: ConnectionPatch): Promise<StoredConnection | undefined>
  /**
   * Row lock for token refresh (`select … for update` in Postgres; a
   * per-row mutex in memory). `update` writes inside the lock.
   */
  withConnectionLock<T>(
    workspaceId: string,
    id: string,
    fn: (
      connection: StoredConnection | undefined,
      /** With `expectedGeneration`, a compare-and-set write (see `updateConnectionIfCurrent`). */
      update: (patch: ConnectionPatch, expectedGeneration?: number) => Promise<StoredConnection | undefined>
    ) => Promise<T>
  ): Promise<T>
  /**
   * Compare-and-set token write: applies only while the row is `active` and
   * still at `generation`. Undefined when the write lost (disconnected,
   * reconnected or flagged meanwhile).
   */
  updateConnectionIfCurrent(
    workspaceId: string,
    id: string,
    generation: number,
    patch: ConnectionPatch
  ): Promise<StoredConnection | undefined>
  /** SYSTEM: active connections of one provider (tick jobs), instance-wide. */
  systemListActiveConnections(provider: ProviderId): Promise<StoredConnection[]>

  // OAuth states ----------------------------------------------------------
  createOAuthState(row: Omit<OAuthStateRow, "createdAt" | "usedAt">): Promise<void>
  /** Atomically marks the unused, unexpired row used and returns it. */
  consumeOAuthState(nonce: string, now?: Date): Promise<OAuthStateRow | undefined>
  /** SYSTEM (daily sweep). */
  systemDeleteExpiredOAuthStates(now?: Date): Promise<number>

  // Rules -----------------------------------------------------------------
  /**
   * Insert (cap 50 per workspace). A non-email rule's connection must be in
   * the same workspace, of the same provider and active. The email rule is
   * a singleton: an existing one is updated in place.
   */
  createRule(input: NewRule): Promise<CreateRuleResult>
  getRule(workspaceId: string, id: string): Promise<StoredRule | undefined>
  listRules(workspaceId: string): Promise<StoredRule[]>
  updateRule(workspaceId: string, id: string, patch: RulePatch): Promise<StoredRule | undefined>
  deleteRule(workspaceId: string, id: string): Promise<boolean>
  /** Enabled rules for an event, oldest first, at most `limit` (50). */
  listEnabledRulesForEvent(workspaceId: string, trigger: RuleTrigger, limit?: number): Promise<StoredRule[]>
  /** Returns the ids disabled. */
  disableRulesForConnection(workspaceId: string, connectionId: string, reason: string): Promise<string[]>

  // Deliveries ------------------------------------------------------------
  /** `on conflict (workspace_id, idempotency_key) do nothing`; returns the existing row on conflict. */
  insertDelivery(input: NewDelivery): Promise<{ delivery: StoredDelivery; created: boolean }>
  getDelivery(workspaceId: string, id: string): Promise<StoredDelivery | undefined>
  listDeliveries(workspaceId: string, filter?: DeliveryListFilter): Promise<StoredDelivery[]>
  /**
   * Lock for one attempt: `queued|retrying|running` → `running`,
   * attempts + 1. Undefined for terminal rows (a no-op job).
   */
  claimDelivery(workspaceId: string, id: string): Promise<StoredDelivery | undefined>
  updateDelivery(workspaceId: string, id: string, patch: DeliveryPatch): Promise<StoredDelivery | undefined>
  /** `queued|retrying` rows of a connection → `cancelled`; returns the ids. */
  cancelQueuedDeliveriesForConnection(workspaceId: string, connectionId: string): Promise<string[]>
  /** Recap emails recorded in `progress.sentLog` since `since` (hourly cap). */
  countRecapEmailsSince(workspaceId: string, since: Date): Promise<number>
  /** SYSTEM (daily sweep). */
  systemDeleteDeliveriesBefore(before: Date): Promise<number>

  // Links -----------------------------------------------------------------
  getLink(scope: LinkScope, key: IntegrationLinkKey): Promise<IntegrationLink | undefined>
  listLinks(scope: LinkScope, objectKind: IntegrationLink["objectKind"], destinationKey?: string): Promise<IntegrationLink[]>
  upsertLink(
    scope: LinkScope & { provider: ProviderId },
    key: IntegrationLinkKey & { externalId: string; externalUrl?: string; contentHash?: string }
  ): Promise<IntegrationLink>
  removeLink(scope: LinkScope, key: IntegrationLinkKey): Promise<void>

  // Meeting prefs ---------------------------------------------------------
  getPrefs(workspaceId: string, meetingId: string): Promise<MeetingIntegrationPrefs | undefined>
  upsertPrefs(workspaceId: string, meetingId: string, patch: PrefsPatch): Promise<MeetingIntegrationPrefs>

  // Email unsubscribes ----------------------------------------------------
  /** Lowercased addresses of `emails` that unsubscribed in this workspace. */
  listUnsubscribed(workspaceId: string, emails: readonly string[]): Promise<Set<string>>
  addUnsubscribe(workspaceId: string, emailLower: string, source: UnsubscribeSource): Promise<void>
}

let override: IntegrationStore | undefined
let memory: IntegrationStore | undefined

/** Resolved at call time (never at module load) so `next build` needs no DATABASE_URL. */
export async function getIntegrationStore(): Promise<IntegrationStore> {
  if (override) return override

  if (process.env.MEETSUM_STORAGE === "postgres") {
    const { createPostgresIntegrationStore } = await import("@/lib/integrations/core/store-postgres")

    return createPostgresIntegrationStore(getDatabasePool())
  }

  if (!memory) {
    const { createMemoryIntegrationStore } = await import("@/lib/integrations/core/store-memory")

    memory = createMemoryIntegrationStore()
  }

  return memory
}

/** Tests: force a store (undefined restores env-based selection and a fresh memory store). */
export function setIntegrationStoreForTesting(store: IntegrationStore | undefined) {
  override = store
  if (!store) memory = undefined
}

export function linkKeyParts(key: IntegrationLinkKey) {
  return {
    objectKind: key.objectKind,
    destinationKey: key.destinationKey ?? "",
    actionItemId: key.objectKind === "hubspot_task" ? (key.actionItemId ?? "") : "",
  }
}
