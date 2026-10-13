/**
 * Postgres IntegrationStore over migration 027 (hand-written SQL). Owner:
 * Package A. Every per-row statement carries `workspace_id = $1`; the only
 * unscoped statements are the `system*` sweeps. Caps and child-id checks
 * are single `insert … select … where` statements, so a cross-workspace or
 * over-cap insert writes nothing.
 */
import { randomUUID } from "node:crypto"

import type { Queryable } from "@/lib/db/client"
import type {
  IntegrationLink,
  IntegrationRuleDTO,
  MeetingIntegrationPrefs,
} from "@/lib/integrations/core/types"
import {
  DELIVERY_LEASE_MS,
  MAX_CONNECTIONS_PER_WORKSPACE,
  MAX_RULES_PER_EVENT,
  MAX_RULES_PER_WORKSPACE,
  linkKeyParts,
  type ConnectionPatch,
  type DeliveryPatch,
  type IntegrationStore,
  type OAuthStateRow,
  type RulePatch,
  type StoredConnection,
  type StoredDelivery,
  type StoredRule,
} from "@/lib/integrations/core/store"

type Row = Record<string, unknown>

type PoolLike = Queryable & {
  connect?: () => Promise<Queryable & { release: () => void }>
}

function iso(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  if (value instanceof Date) return value.toISOString()

  const parsed = new Date(String(value))

  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString()
}

function str(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value)
}

function json<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T
    } catch {
      return fallback
    }
  }
  return value as T
}

function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T
}

function toConnection(row: Row): StoredConnection {
  return defined({
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    provider: row.provider as StoredConnection["provider"],
    userId: str(row.user_id),
    status: row.status as StoredConnection["status"],
    accountLabel: String(row.account_label),
    externalAccountId: String(row.external_account_id),
    scopes: Array.isArray(row.scopes) ? (row.scopes as string[]) : [],
    accessTokenEnc: str(row.access_token_enc),
    refreshTokenEnc: str(row.refresh_token_enc),
    tokenType: str(row.token_type),
    expiresAt: iso(row.expires_at),
    config: json<Record<string, unknown>>(row.config, {}),
    generation: Number(row.token_generation ?? 0) || 0,
    refreshLeaseUntil: iso(row.refresh_lease_until),
    createdByUserId: str(row.created_by_user_id),
    lastUsedAt: iso(row.last_used_at),
    lastRefreshedAt: iso(row.last_refreshed_at),
    lastError: str(row.last_error),
    revokedAt: iso(row.revoked_at),
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: iso(row.updated_at) ?? new Date(0).toISOString(),
  })
}

function toRule(row: Row): StoredRule {
  return defined({
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    provider: row.provider as StoredRule["provider"],
    connectionId: str(row.connection_id) ?? null,
    name: String(row.name),
    enabled: Boolean(row.enabled),
    trigger: row.trigger_event as StoredRule["trigger"],
    filters: json<IntegrationRuleDTO["filters"]>(row.filters, {}),
    destination: json<IntegrationRuleDTO["destination"]>(row.destination, {} as IntegrationRuleDTO["destination"]),
    content: json<IntegrationRuleDTO["content"]>(row.content, {} as IntegrationRuleDTO["content"]),
    includePrivate: Boolean(row.include_private),
    createdByUserId: str(row.created_by_user_id),
    disabledReason: str(row.disabled_reason),
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: iso(row.updated_at) ?? new Date(0).toISOString(),
  })
}

function toDelivery(row: Row): StoredDelivery {
  return defined({
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    ruleId: str(row.rule_id),
    connectionId: str(row.connection_id),
    provider: row.provider as StoredDelivery["provider"],
    origin: row.origin as StoredDelivery["origin"],
    eventName: str(row.event_name),
    eventId: str(row.event_id),
    meetingId: str(row.meeting_id),
    actionItemId: str(row.action_item_id),
    idempotencyKey: String(row.idempotency_key),
    status: row.status as StoredDelivery["status"],
    skipReason: str(row.skip_reason) as StoredDelivery["skipReason"],
    attempts: Number(row.attempts ?? 0),
    maxAttempts: Number(row.max_attempts ?? 5),
    progress: json<Record<string, unknown>>(row.progress, {}),
    externalRef: json<Record<string, unknown>>(row.external_ref, {}),
    lastError: str(row.last_error),
    requestedByUserId: str(row.requested_by_user_id),
    leaseUntil: iso(row.lease_until),
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: iso(row.updated_at) ?? new Date(0).toISOString(),
    completedAt: iso(row.completed_at),
  })
}

function toLink(row: Row): IntegrationLink {
  return defined({
    id: String(row.id),
    connectionId: String(row.connection_id),
    provider: row.provider as IntegrationLink["provider"],
    meetingId: String(row.meeting_id),
    objectKind: row.object_kind as IntegrationLink["objectKind"],
    destinationKey: String(row.destination_key ?? ""),
    actionItemId: String(row.action_item_id ?? ""),
    externalId: String(row.external_id),
    externalUrl: str(row.external_url),
    contentHash: str(row.content_hash),
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: iso(row.updated_at) ?? new Date(0).toISOString(),
  })
}

function toPrefs(row: Row): MeetingIntegrationPrefs {
  return defined({
    meetingId: String(row.meeting_id),
    workspaceId: String(row.workspace_id),
    allowPrivatePush: Boolean(row.allow_private_push),
    allowPrivateSetByUserId: str(row.allow_private_set_by_user_id),
    emailRecap: (str(row.email_recap) ?? "inherit") as MeetingIntegrationPrefs["emailRecap"],
    updatedByUserId: str(row.updated_by_user_id),
    updatedAt: iso(row.updated_at),
  })
}

function toState(row: Row): OAuthStateRow {
  return defined({
    nonce: String(row.nonce),
    workspaceId: String(row.workspace_id),
    userId: String(row.user_id),
    provider: String(row.provider),
    codeVerifierEnc: str(row.code_verifier_enc),
    returnTo: str(row.return_to),
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    expiresAt: iso(row.expires_at) ?? new Date(0).toISOString(),
    usedAt: iso(row.used_at),
  })
}

const CONNECTION_COLUMNS: Record<Exclude<keyof ConnectionPatch, "config" | "generation">, { column: string; cast?: string }> = {
  status: { column: "status" },
  accountLabel: { column: "account_label" },
  scopes: { column: "scopes", cast: "text[]" },
  tokenType: { column: "token_type" },
  lastUsedAt: { column: "last_used_at", cast: "timestamptz" },
  lastRefreshedAt: { column: "last_refreshed_at", cast: "timestamptz" },
  revokedAt: { column: "revoked_at", cast: "timestamptz" },
  accessTokenEnc: { column: "access_token_enc" },
  refreshTokenEnc: { column: "refresh_token_enc" },
  expiresAt: { column: "expires_at", cast: "timestamptz" },
  lastError: { column: "last_error" },
  refreshLeaseUntil: { column: "refresh_lease_until", cast: "timestamptz" },
}

const RULE_COLUMNS: Record<keyof RulePatch, { column: string; cast?: string }> = {
  name: { column: "name" },
  enabled: { column: "enabled" },
  trigger: { column: "trigger_event" },
  filters: { column: "filters", cast: "jsonb" },
  destination: { column: "destination", cast: "jsonb" },
  content: { column: "content", cast: "jsonb" },
  includePrivate: { column: "include_private" },
  createdByUserId: { column: "created_by_user_id" },
  disabledReason: { column: "disabled_reason" },
}

const DELIVERY_COLUMNS: Record<keyof DeliveryPatch, { column: string; cast?: string }> = {
  status: { column: "status" },
  attempts: { column: "attempts" },
  maxAttempts: { column: "max_attempts" },
  progress: { column: "progress", cast: "jsonb" },
  externalRef: { column: "external_ref", cast: "jsonb" },
  skipReason: { column: "skip_reason" },
  lastError: { column: "last_error" },
  completedAt: { column: "completed_at", cast: "timestamptz" },
  leaseUntil: { column: "lease_until", cast: "timestamptz" },
}

/** `set a = $n, …` from a patch (undefined skipped, null clears). */
function setClause(
  patch: object,
  columns: Record<string, { column: string; cast?: string }>,
  values: unknown[]
): string[] {
  const sets: string[] = []

  for (const [key, value] of Object.entries(patch)) {
    const spec = columns[key]

    if (!spec || value === undefined) continue
    values.push(spec.cast === "jsonb" && value !== null ? JSON.stringify(value) : value)
    sets.push(`${spec.column} = $${values.length}${spec.cast ? `::${spec.cast}` : ""}`)
  }

  return sets
}

export function createPostgresIntegrationStore(db: Queryable): IntegrationStore {
  async function rows(client: Queryable, sql: string, values: unknown[] = []): Promise<Row[]> {
    return (await client.query(sql, values)).rows as Row[]
  }

  async function transaction<T>(fn: (client: Queryable) => Promise<T>): Promise<T> {
    const pool = db as PoolLike
    const connection = typeof pool.connect === "function" ? await pool.connect() : undefined
    const client: Queryable = connection ?? db

    try {
      await client.query("begin")
      const result = await fn(client)

      await client.query("commit")
      return result
    } catch (error) {
      await client.query("rollback").catch(() => undefined)
      throw error
    } finally {
      connection?.release()
    }
  }

  async function updateConnectionWith(
    client: Queryable,
    workspaceId: string,
    id: string,
    patch: ConnectionPatch,
    expectedGeneration?: number
  ) {
    const values: unknown[] = [workspaceId, id]
    const { config, generation, ...rest } = patch
    const sets = setClause(rest, CONNECTION_COLUMNS, values)

    if (config !== undefined) {
      values.push(JSON.stringify(config))
      sets.push(`config = $${values.length}::jsonb`)
    }
    if (generation !== undefined) {
      values.push(generation)
      sets.push(`token_generation = $${values.length}::int`)
    }
    sets.push("updated_at = now()")

    let condition = ""

    if (expectedGeneration !== undefined) {
      values.push(expectedGeneration)
      condition = ` and status = 'active' and token_generation = $${values.length}`
    }

    const [row] = await rows(
      client,
      `update integration_connections set ${sets.join(", ")} where workspace_id = $1 and id = $2${condition} returning *`,
      values
    )

    return row ? toConnection(row) : undefined
  }

  const store: IntegrationStore = {
    kind: "postgres",

    async findConnectionByAccount(workspaceId, provider, userId, externalAccountId) {
      const [row] = await rows(
        db,
        `select * from integration_connections
          where workspace_id = $1 and provider = $2 and coalesce(user_id, '') = $3
            and external_account_id = $4 and status <> 'revoked'
          limit 1`,
        [workspaceId, provider, userId ?? "", externalAccountId]
      )

      return row ? toConnection(row) : undefined
    },

    async createConnection(input) {
      const [row] = await rows(
        db,
        `insert into integration_connections (
           id, workspace_id, provider, user_id, status, account_label, external_account_id, scopes,
           access_token_enc, refresh_token_enc, token_type, expires_at, config, created_by_user_id,
           last_used_at, last_refreshed_at, last_error, revoked_at, token_generation)
         select $1, $2, $3, $4, $5, $6, $7, $8::text[], $9, $10, $11, $12::timestamptz, $13::jsonb, $14,
                $15::timestamptz, $16::timestamptz, $17, $18::timestamptz, $19::int
          where (select count(*) from integration_connections
                  where workspace_id = $2 and status <> 'revoked') < ${MAX_CONNECTIONS_PER_WORKSPACE}
         returning *`,
        [
          input.id,
          input.workspaceId,
          input.provider,
          input.userId ?? null,
          input.status,
          input.accountLabel,
          input.externalAccountId,
          input.scopes,
          input.accessTokenEnc ?? null,
          input.refreshTokenEnc ?? null,
          input.tokenType ?? null,
          input.expiresAt ?? null,
          JSON.stringify(input.config ?? {}),
          input.createdByUserId ?? null,
          input.lastUsedAt ?? null,
          input.lastRefreshedAt ?? null,
          input.lastError ?? null,
          input.revokedAt ?? null,
          input.generation ?? 0,
        ]
      )

      return row ? { ok: true, connection: toConnection(row) } : { ok: false, reason: "cap" }
    },

    async getConnection(workspaceId, id) {
      const [row] = await rows(db, "select * from integration_connections where workspace_id = $1 and id = $2", [
        workspaceId,
        id,
      ])

      return row ? toConnection(row) : undefined
    },

    async listConnections(workspaceId, options = {}) {
      return (
        await rows(
          db,
          `select * from integration_connections where workspace_id = $1
             ${options.includeRevoked ? "" : "and status <> 'revoked'"}
           order by created_at, id`,
          [workspaceId]
        )
      ).map(toConnection)
    },

    async updateConnection(workspaceId, id, patch) {
      return updateConnectionWith(db, workspaceId, id, patch)
    },

    async updateConnectionIfCurrent(workspaceId, id, generation, patch) {
      return updateConnectionWith(db, workspaceId, id, patch, generation)
    },

    async acquireRefreshLease(workspaceId, id, generation, until, at) {
      const [row] = await rows(
        db,
        `update integration_connections
            set refresh_lease_until = $4::timestamptz, updated_at = now()
          where workspace_id = $1 and id = $2 and status = 'active' and token_generation = $3
            and (refresh_lease_until is null or refresh_lease_until <= $5::timestamptz)
          returning *`,
        [workspaceId, id, generation, until.toISOString(), at.toISOString()]
      )

      return row ? toConnection(row) : undefined
    },

    async withConnectionLock(workspaceId, id, fn) {
      return transaction(async (client) => {
        const [row] = await rows(
          client,
          "select * from integration_connections where workspace_id = $1 and id = $2 for update",
          [workspaceId, id]
        )

        return fn(row ? toConnection(row) : undefined, (patch, expectedGeneration) =>
          updateConnectionWith(client, workspaceId, id, patch, expectedGeneration)
        )
      })
    },

    async systemListActiveConnections(provider) {
      return (
        await rows(db, "select * from integration_connections where provider = $1 and status = 'active' order by id", [
          provider,
        ])
      ).map(toConnection)
    },

    async createOAuthState(row) {
      await db.query(
        `insert into integration_oauth_states (nonce, workspace_id, user_id, provider, code_verifier_enc, return_to, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7::timestamptz)`,
        [row.nonce, row.workspaceId, row.userId, row.provider, row.codeVerifierEnc ?? null, row.returnTo ?? null, row.expiresAt]
      )
    },

    async consumeOAuthState(nonce, at = new Date()) {
      const [row] = await rows(
        db,
        `update integration_oauth_states set used_at = $2::timestamptz
          where nonce = $1 and used_at is null and expires_at > $2::timestamptz
          returning *`,
        [nonce, at.toISOString()]
      )

      return row ? toState(row) : undefined
    },

    async systemDeleteExpiredOAuthStates(at = new Date()) {
      const deleted = await rows(db, "delete from integration_oauth_states where expires_at <= $1::timestamptz returning nonce", [
        at.toISOString(),
      ])

      return deleted.length
    },

    async createRule(input) {
      if (input.provider === "email") {
        const [existing] = await rows(
          db,
          `update integration_rules set name = $2, enabled = $3, trigger_event = $4, filters = $5::jsonb,
                  destination = $6::jsonb, content = $7::jsonb, include_private = $8, created_by_user_id = $9,
                  disabled_reason = $10, updated_at = now()
            where workspace_id = $1 and provider = 'email'
            returning *`,
          [
            input.workspaceId,
            input.name,
            input.enabled,
            input.trigger,
            JSON.stringify(input.filters),
            JSON.stringify(input.destination),
            JSON.stringify(input.content),
            input.includePrivate,
            input.createdByUserId ?? null,
            input.disabledReason ?? null,
          ]
        )

        if (existing) return { ok: true, rule: toRule(existing) }
      }

      const values = [
        input.id,
        input.workspaceId,
        input.connectionId,
        input.provider,
        input.name,
        input.enabled,
        input.trigger,
        JSON.stringify(input.filters),
        JSON.stringify(input.destination),
        JSON.stringify(input.content),
        input.includePrivate,
        input.createdByUserId ?? null,
        input.disabledReason ?? null,
      ]
      const connectionCheck =
        input.provider === "email"
          ? "$3::text is null"
          : `exists (select 1 from integration_connections c
                      where c.workspace_id = $2 and c.id = $3 and c.provider = $4 and c.status = 'active')`
      const [row] = await rows(
        db,
        `insert into integration_rules (id, workspace_id, connection_id, provider, name, enabled, trigger_event,
                                        filters, destination, content, include_private, created_by_user_id, disabled_reason)
         select $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, $13
          where ${connectionCheck}
            and (select count(*) from integration_rules where workspace_id = $2) < ${MAX_RULES_PER_WORKSPACE}
         returning *`,
        values
      )

      if (row) return { ok: true, rule: toRule(row) }

      if (input.provider !== "email") {
        const [connection] = await rows(
          db,
          `select 1 from integration_connections
            where workspace_id = $1 and id = $2 and provider = $3 and status = 'active'`,
          [input.workspaceId, input.connectionId, input.provider]
        )

        if (!connection) return { ok: false, reason: "connection_not_found" }
      }

      return { ok: false, reason: "cap" }
    },

    async getRule(workspaceId, id) {
      const [row] = await rows(db, "select * from integration_rules where workspace_id = $1 and id = $2", [workspaceId, id])

      return row ? toRule(row) : undefined
    },

    async listRules(workspaceId) {
      return (await rows(db, "select * from integration_rules where workspace_id = $1 order by created_at, id", [workspaceId])).map(
        toRule
      )
    },

    async updateRule(workspaceId, id, patch) {
      const values: unknown[] = [workspaceId, id]
      const sets = setClause(patch, RULE_COLUMNS, values)

      sets.push("updated_at = now()")

      const [row] = await rows(
        db,
        `update integration_rules set ${sets.join(", ")} where workspace_id = $1 and id = $2 returning *`,
        values
      )

      return row ? toRule(row) : undefined
    },

    async deleteRule(workspaceId, id) {
      const deleted = await rows(db, "delete from integration_rules where workspace_id = $1 and id = $2 returning id", [
        workspaceId,
        id,
      ])

      return deleted.length > 0
    },

    async listEnabledRulesForEvent(workspaceId, trigger, limit = MAX_RULES_PER_EVENT) {
      return (
        await rows(
          db,
          `select * from integration_rules
            where workspace_id = $1 and trigger_event = $2 and enabled
            order by created_at, id
            limit $3`,
          [workspaceId, trigger, Math.min(limit, MAX_RULES_PER_EVENT)]
        )
      ).map(toRule)
    },

    async disableRulesForConnection(workspaceId, connectionId, reason) {
      return (
        await rows(
          db,
          `update integration_rules set enabled = false, disabled_reason = $3, updated_at = now()
            where workspace_id = $1 and connection_id = $2 and enabled
            returning id`,
          [workspaceId, connectionId, reason]
        )
      ).map((row) => String(row.id))
    },

    async insertDelivery(input) {
      const [row] = await rows(
        db,
        `insert into integration_deliveries (id, workspace_id, rule_id, connection_id, provider, origin, event_name, event_id,
                                             meeting_id, action_item_id, idempotency_key, status, skip_reason, max_attempts,
                                             progress, external_ref, last_error, requested_by_user_id, completed_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16::jsonb, $17, $18, $19::timestamptz)
         on conflict (workspace_id, idempotency_key) do nothing
         returning *`,
        [
          input.id,
          input.workspaceId,
          input.ruleId ?? null,
          input.connectionId ?? null,
          input.provider,
          input.origin,
          input.eventName ?? null,
          input.eventId ?? null,
          input.meetingId ?? null,
          input.actionItemId ?? null,
          input.idempotencyKey,
          input.status,
          input.skipReason ?? null,
          input.maxAttempts,
          JSON.stringify(input.progress ?? {}),
          JSON.stringify(input.externalRef ?? {}),
          input.lastError ?? null,
          input.requestedByUserId ?? null,
          input.completedAt ?? null,
        ]
      )

      if (row) return { delivery: toDelivery(row), created: true }

      const [existing] = await rows(
        db,
        "select * from integration_deliveries where workspace_id = $1 and idempotency_key = $2",
        [input.workspaceId, input.idempotencyKey]
      )

      if (!existing) throw new Error("integration delivery insert conflicted without a row")
      return { delivery: toDelivery(existing), created: false }
    },

    async getDelivery(workspaceId, id) {
      const [row] = await rows(db, "select * from integration_deliveries where workspace_id = $1 and id = $2", [
        workspaceId,
        id,
      ])

      return row ? toDelivery(row) : undefined
    },

    async listDeliveries(workspaceId, filter = {}) {
      const values: unknown[] = [workspaceId]
      const where = ["workspace_id = $1"]
      const add = (sql: string, value: unknown) => {
        values.push(value)
        where.push(sql.replace("?", `$${values.length}`))
      }

      if (filter.status) add("status = ?", filter.status)
      if (filter.provider) add("provider = ?", filter.provider)
      if (filter.ruleId) add("rule_id = ?", filter.ruleId)
      if (filter.meetingId) add("meeting_id = ?", filter.meetingId)
      if (filter.before) {
        const [at, id] = filter.before.split("|")
        const date = iso(at)

        if (date) {
          values.push(date, id ?? "")
          where.push(`(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length})`)
        }
      }

      values.push(Math.min(Math.max(filter.limit ?? 50, 1), 200))

      return (
        await rows(
          db,
          `select * from integration_deliveries where ${where.join(" and ")}
            order by created_at desc, id desc limit $${values.length}`,
          values
        )
      ).map(toDelivery)
    },

    async claimDelivery(workspaceId, id, at = new Date(), leaseMs = DELIVERY_LEASE_MS) {
      const [row] = await rows(
        db,
        `update integration_deliveries
            set status = 'running', attempts = attempts + 1, lease_until = $4::timestamptz, updated_at = now()
          where workspace_id = $1 and id = $2
            and (status in ('queued', 'retrying')
                 or (status = 'running' and (lease_until is null or lease_until <= $3::timestamptz)))
          returning *`,
        [workspaceId, id, at.toISOString(), new Date(at.getTime() + leaseMs).toISOString()]
      )

      return row ? toDelivery(row) : undefined
    },

    async requeueRetryableDelivery(workspaceId, id, maxAttempts) {
      const [row] = await rows(
        db,
        `update integration_deliveries
            set status = 'queued', attempts = 0, max_attempts = $3, skip_reason = null, last_error = null,
                completed_at = null, lease_until = null, updated_at = now()
          where workspace_id = $1 and id = $2
            and (status in ('failed', 'partial') or (status = 'skipped' and skip_reason = 'needs_reauth'))
          returning *`,
        [workspaceId, id, maxAttempts]
      )

      return row ? toDelivery(row) : undefined
    },

    async systemListExpiredDeliveryLeases(at, limit = 100) {
      return (
        await rows(
          db,
          `select * from integration_deliveries
            where status = 'running' and lease_until <= $1::timestamptz
            order by lease_until asc limit $2`,
          [at.toISOString(), limit]
        )
      ).map(toDelivery)
    },

    async reclaimExpiredDelivery(workspaceId, id, at, patch) {
      const values: unknown[] = [workspaceId, id]
      const sets = setClause({ ...patch, leaseUntil: null }, DELIVERY_COLUMNS, values)

      sets.push("updated_at = now()")
      values.push(at.toISOString())

      const [row] = await rows(
        db,
        `update integration_deliveries set ${sets.join(", ")}
          where workspace_id = $1 and id = $2 and status = 'running' and lease_until <= $${values.length}::timestamptz
          returning *`,
        values
      )

      return row ? toDelivery(row) : undefined
    },

    async updateDelivery(workspaceId, id, patch) {
      const values: unknown[] = [workspaceId, id]
      const sets = setClause(patch, DELIVERY_COLUMNS, values)

      sets.push("updated_at = now()")

      const [row] = await rows(
        db,
        `update integration_deliveries set ${sets.join(", ")} where workspace_id = $1 and id = $2 returning *`,
        values
      )

      return row ? toDelivery(row) : undefined
    },

    async cancelQueuedDeliveriesForConnection(workspaceId, connectionId) {
      return (
        await rows(
          db,
          `update integration_deliveries set status = 'cancelled', completed_at = now(), updated_at = now()
            where workspace_id = $1 and connection_id = $2 and status in ('queued', 'retrying')
            returning id`,
          [workspaceId, connectionId]
        )
      ).map((row) => String(row.id))
    },

    async countRecapEmailsSince(workspaceId, since) {
      const [row] = await rows(
        db,
        `select coalesce(sum((entry->>'n')::int), 0)::int as n
           from integration_deliveries d
           cross join lateral jsonb_array_elements(
             case when jsonb_typeof(d.progress->'sentLog') = 'array' then d.progress->'sentLog' else '[]'::jsonb end
           ) entry
          where d.workspace_id = $1 and d.provider = 'email' and d.updated_at > $2::timestamptz
            and (entry->>'at')::timestamptz > $2::timestamptz`,
        [workspaceId, since.toISOString()]
      )

      return Number(row?.n ?? 0)
    },

    async systemListStaleQueuedDeliveries(before, limit = 100) {
      return (
        await rows(
          db,
          `select id, workspace_id from integration_deliveries
            where status = 'queued' and updated_at < $1::timestamptz
            order by updated_at asc limit $2`,
          [before.toISOString(), limit]
        )
      ).map((row) => ({ id: String(row.id), workspaceId: String(row.workspace_id) }))
    },

    async systemDeleteDeliveriesBefore(before) {
      return (
        await rows(db, "delete from integration_deliveries where created_at < $1::timestamptz returning id", [before.toISOString()])
      ).length
    },

    async getLink(scope, key) {
      const parts = linkKeyParts(key)
      const [row] = await rows(
        db,
        `select * from integration_links
          where workspace_id = $1 and connection_id = $2 and meeting_id = $3
            and object_kind = $4 and destination_key = $5 and action_item_id = $6`,
        [scope.workspaceId, scope.connectionId, scope.meetingId, parts.objectKind, parts.destinationKey, parts.actionItemId]
      )

      return row ? toLink(row) : undefined
    },

    async listLinks(scope, objectKind, destinationKey) {
      const values: unknown[] = [scope.workspaceId, scope.connectionId, scope.meetingId, objectKind]

      if (destinationKey !== undefined) values.push(destinationKey)

      return (
        await rows(
          db,
          `select * from integration_links
            where workspace_id = $1 and connection_id = $2 and meeting_id = $3 and object_kind = $4
              ${destinationKey !== undefined ? "and destination_key = $5" : ""}
            order by created_at, id`,
          values
        )
      ).map(toLink)
    },

    async upsertLink(scope, key) {
      const parts = linkKeyParts(key)
      // The connection must belong to the workspace (child-id join).
      const [row] = await rows(
        db,
        `insert into integration_links (id, workspace_id, connection_id, provider, meeting_id, object_kind,
                                        destination_key, action_item_id, external_id, external_url, content_hash)
         select $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
          where exists (select 1 from integration_connections c where c.workspace_id = $2 and c.id = $3)
         on conflict (connection_id, meeting_id, object_kind, destination_key, action_item_id)
         do update set external_id = excluded.external_id, external_url = excluded.external_url,
                       content_hash = excluded.content_hash, updated_at = now()
           where integration_links.workspace_id = excluded.workspace_id
         returning *`,
        [
          `intl_${randomUUID()}`,
          scope.workspaceId,
          scope.connectionId,
          scope.provider,
          scope.meetingId,
          parts.objectKind,
          parts.destinationKey,
          parts.actionItemId,
          key.externalId,
          key.externalUrl ?? null,
          key.contentHash ?? null,
        ]
      )

      if (!row) throw new Error("integration link refused: connection not in workspace")
      return toLink(row)
    },

    async removeLink(scope, key) {
      const parts = linkKeyParts(key)

      await db.query(
        `delete from integration_links
          where workspace_id = $1 and connection_id = $2 and meeting_id = $3
            and object_kind = $4 and destination_key = $5 and action_item_id = $6`,
        [scope.workspaceId, scope.connectionId, scope.meetingId, parts.objectKind, parts.destinationKey, parts.actionItemId]
      )
    },

    async getPrefs(workspaceId, meetingId) {
      const [row] = await rows(db, "select * from meeting_integration_prefs where workspace_id = $1 and meeting_id = $2", [
        workspaceId,
        meetingId,
      ])

      return row ? toPrefs(row) : undefined
    },

    async upsertPrefs(workspaceId, meetingId, patch) {
      const setPrivateBy = patch.allowPrivateSetByUserId !== undefined
      // The meeting must belong to the workspace.
      const [row] = await rows(
        db,
        `insert into meeting_integration_prefs (meeting_id, workspace_id, allow_private_push, allow_private_set_by_user_id,
                                                email_recap, updated_by_user_id)
         select $2, $1, coalesce($3::boolean, false), $4, coalesce($5, 'inherit'), $6
          where exists (select 1 from meetings m where m.id = $2 and m.workspace_id = $1)
         on conflict (meeting_id) do update set
           allow_private_push = coalesce($3::boolean, meeting_integration_prefs.allow_private_push),
           allow_private_set_by_user_id = case when $7::boolean then $4 else meeting_integration_prefs.allow_private_set_by_user_id end,
           email_recap = coalesce($5, meeting_integration_prefs.email_recap),
           updated_by_user_id = coalesce($6, meeting_integration_prefs.updated_by_user_id),
           updated_at = now()
           where meeting_integration_prefs.workspace_id = $1
         returning *`,
        [
          workspaceId,
          meetingId,
          patch.allowPrivatePush ?? null,
          setPrivateBy ? patch.allowPrivateSetByUserId : null,
          patch.emailRecap ?? null,
          patch.updatedByUserId ?? null,
          setPrivateBy,
        ]
      )

      if (!row) throw new Error("meeting not in workspace")
      return toPrefs(row)
    },

    async listUnsubscribed(workspaceId, emails) {
      const lowered = [...new Set(emails.map((email) => email.trim().toLowerCase()).filter(Boolean))]

      if (!lowered.length) return new Set()

      return new Set(
        (
          await rows(
            db,
            "select email_lower from email_recap_unsubscribes where workspace_id = $1 and email_lower = any($2::text[])",
            [workspaceId, lowered]
          )
        ).map((row) => String(row.email_lower))
      )
    },

    async addUnsubscribe(workspaceId, emailLower, source) {
      await db.query(
        `insert into email_recap_unsubscribes (workspace_id, email_lower, source) values ($1, $2, $3)
         on conflict (workspace_id, email_lower) do nothing`,
        [workspaceId, emailLower.trim().toLowerCase(), source]
      )
    },
  }

  return store
}
