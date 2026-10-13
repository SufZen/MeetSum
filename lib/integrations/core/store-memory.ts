/**
 * In-memory IntegrationStore (demo mode and tests). Mirrors the Postgres
 * semantics: workspace filters, caps, the email-rule singleton, delivery
 * idempotency keys and the link unique key. Owner: Package A.
 */
import { randomUUID } from "node:crypto"

import type { IntegrationLink, MeetingIntegrationPrefs } from "@/lib/integrations/core/types"
import {
  MAX_CONNECTIONS_PER_WORKSPACE,
  MAX_RULES_PER_EVENT,
  MAX_RULES_PER_WORKSPACE,
  linkKeyParts,
  type ConnectionPatch,
  type IntegrationStore,
  type OAuthStateRow,
  type StoredConnection,
  type StoredDelivery,
  type StoredRule,
} from "@/lib/integrations/core/store"

const clone = <T>(value: T): T => structuredClone(value)

function now() {
  return new Date().toISOString()
}

function applyConnectionPatch(row: StoredConnection, patch: ConnectionPatch): StoredConnection {
  const next: StoredConnection = { ...row, updatedAt: now() }

  for (const [key, value] of Object.entries(patch) as [keyof ConnectionPatch, unknown][]) {
    if (value === undefined) continue
    if (value === null) delete (next as Record<string, unknown>)[key]
    else (next as Record<string, unknown>)[key] = clone(value)
  }

  return next
}

function patchObject<T extends object>(row: T, patch: object): T {
  const next = { ...row } as Record<string, unknown>

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (value === null) delete next[key]
    else next[key] = clone(value)
  }

  next.updatedAt = now()
  return next as T
}

export function createMemoryIntegrationStore(): IntegrationStore {
  const connections = new Map<string, StoredConnection>()
  const states = new Map<string, OAuthStateRow>()
  const rules = new Map<string, StoredRule>()
  const deliveries = new Map<string, StoredDelivery>()
  const links = new Map<string, IntegrationLink & { workspaceId: string }>()
  const prefs = new Map<string, MeetingIntegrationPrefs>()
  const unsubscribes = new Map<string, { source: string; createdAt: string }>()
  const locks = new Map<string, Promise<unknown>>()

  const scoped = <T extends { workspaceId: string }>(row: T | undefined, workspaceId: string) =>
    row && row.workspaceId === workspaceId ? row : undefined

  const linkId = (connectionId: string, meetingId: string, parts: ReturnType<typeof linkKeyParts>) =>
    [connectionId, meetingId, parts.objectKind, parts.destinationKey, parts.actionItemId].join("\u0000")

  const store: IntegrationStore = {
    kind: "memory",

    async findConnectionByAccount(workspaceId, provider, userId, externalAccountId) {
      const row = [...connections.values()].find(
        (candidate) =>
          candidate.workspaceId === workspaceId &&
          candidate.provider === provider &&
          (candidate.userId ?? "") === (userId ?? "") &&
          candidate.externalAccountId === externalAccountId &&
          candidate.status !== "revoked"
      )

      return row && clone(row)
    },

    async createConnection(input) {
      const active = [...connections.values()].filter(
        (row) => row.workspaceId === input.workspaceId && row.status !== "revoked"
      )

      if (active.length >= MAX_CONNECTIONS_PER_WORKSPACE) return { ok: false, reason: "cap" }
      if (
        active.some(
          (row) =>
            row.provider === input.provider &&
            (row.userId ?? "") === (input.userId ?? "") &&
            row.externalAccountId === input.externalAccountId
        )
      ) {
        throw new Error("duplicate key value violates unique constraint uq_integration_connections_account")
      }

      const row: StoredConnection = { ...clone(input), createdAt: now(), updatedAt: now() }

      connections.set(row.id, row)
      return { ok: true, connection: clone(row) }
    },

    async getConnection(workspaceId, id) {
      const row = scoped(connections.get(id), workspaceId)

      return row && clone(row)
    },

    async listConnections(workspaceId, options = {}) {
      return [...connections.values()]
        .filter((row) => row.workspaceId === workspaceId && (options.includeRevoked || row.status !== "revoked"))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map(clone)
    },

    async updateConnection(workspaceId, id, patch) {
      const row = scoped(connections.get(id), workspaceId)

      if (!row) return undefined

      const next = applyConnectionPatch(row, patch)

      connections.set(id, next)
      return clone(next)
    },

    async withConnectionLock(workspaceId, id, fn) {
      const previous = locks.get(id) ?? Promise.resolve()
      let release!: () => void
      const current = new Promise<void>((resolve) => {
        release = resolve
      })
      const chained = previous.then(() => current)

      locks.set(id, chained)
      await previous

      try {
        const row = scoped(connections.get(id), workspaceId)

        return await fn(row && clone(row), (patch) => store.updateConnection(workspaceId, id, patch))
      } finally {
        release()
        if (locks.get(id) === chained) locks.delete(id)
      }
    },

    async systemListActiveConnections(provider) {
      return [...connections.values()].filter((row) => row.provider === provider && row.status === "active").map(clone)
    },

    async createOAuthState(row) {
      states.set(row.nonce, { ...clone(row), createdAt: now() })
    },

    async consumeOAuthState(nonce, at = new Date()) {
      const row = states.get(nonce)

      if (!row || row.usedAt || Date.parse(row.expiresAt) <= at.getTime()) return undefined

      row.usedAt = at.toISOString()
      return clone(row)
    },

    async systemDeleteExpiredOAuthStates(at = new Date()) {
      let count = 0

      for (const [nonce, row] of states) {
        if (Date.parse(row.expiresAt) <= at.getTime()) {
          states.delete(nonce)
          count += 1
        }
      }

      return count
    },

    async createRule(input) {
      if (input.provider === "email") {
        const existing = [...rules.values()].find((row) => row.workspaceId === input.workspaceId && row.provider === "email")

        if (existing) {
          const { id: _id, workspaceId: _ws, connectionId: _conn, provider: _provider, ...rest } = input

          void _id
          void _ws
          void _conn
          void _provider
          const next = patchObject(existing, { ...rest, disabledReason: input.disabledReason ?? null })

          rules.set(existing.id, next)
          return { ok: true, rule: clone(next) }
        }
      } else {
        const connection = input.connectionId ? scoped(connections.get(input.connectionId), input.workspaceId) : undefined

        if (!connection || connection.provider !== input.provider || connection.status !== "active") {
          return { ok: false, reason: "connection_not_found" }
        }
      }

      if ([...rules.values()].filter((row) => row.workspaceId === input.workspaceId).length >= MAX_RULES_PER_WORKSPACE) {
        return { ok: false, reason: "cap" }
      }

      const row: StoredRule = { ...clone(input), createdAt: now(), updatedAt: now() }

      if (!row.disabledReason) delete row.disabledReason
      rules.set(row.id, row)
      return { ok: true, rule: clone(row) }
    },

    async getRule(workspaceId, id) {
      const row = scoped(rules.get(id), workspaceId)

      return row && clone(row)
    },

    async listRules(workspaceId) {
      return [...rules.values()]
        .filter((row) => row.workspaceId === workspaceId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map(clone)
    },

    async updateRule(workspaceId, id, patch) {
      const row = scoped(rules.get(id), workspaceId)

      if (!row) return undefined

      const next = patchObject(row, patch)

      rules.set(id, next)
      return clone(next)
    },

    async deleteRule(workspaceId, id) {
      if (!scoped(rules.get(id), workspaceId)) return false

      rules.delete(id)
      for (const delivery of deliveries.values()) {
        if (delivery.ruleId === id) delete delivery.ruleId
      }
      return true
    },

    async listEnabledRulesForEvent(workspaceId, trigger, limit = MAX_RULES_PER_EVENT) {
      return [...rules.values()]
        .filter((row) => row.workspaceId === workspaceId && row.enabled && row.trigger === trigger)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
        .slice(0, Math.min(limit, MAX_RULES_PER_EVENT))
        .map(clone)
    },

    async disableRulesForConnection(workspaceId, connectionId, reason) {
      const ids: string[] = []

      for (const row of rules.values()) {
        if (row.workspaceId === workspaceId && row.connectionId === connectionId && row.enabled) {
          rules.set(row.id, patchObject(row, { enabled: false, disabledReason: reason }))
          ids.push(row.id)
        }
      }

      return ids
    },

    async insertDelivery(input) {
      const existing = [...deliveries.values()].find(
        (row) => row.workspaceId === input.workspaceId && row.idempotencyKey === input.idempotencyKey
      )

      if (existing) return { delivery: clone(existing), created: false }

      const row: StoredDelivery = {
        attempts: 0,
        progress: {},
        externalRef: {},
        ...clone(input),
        createdAt: now(),
        updatedAt: now(),
      }

      deliveries.set(row.id, row)
      return { delivery: clone(row), created: true }
    },

    async getDelivery(workspaceId, id) {
      const row = scoped(deliveries.get(id), workspaceId)

      return row && clone(row)
    },

    async listDeliveries(workspaceId, filter = {}) {
      const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200)
      const [beforeAt, beforeId] = filter.before?.split("|") ?? []

      return [...deliveries.values()]
        .filter(
          (row) =>
            row.workspaceId === workspaceId &&
            (!filter.status || row.status === filter.status) &&
            (!filter.provider || row.provider === filter.provider) &&
            (!filter.ruleId || row.ruleId === filter.ruleId) &&
            (!filter.meetingId || row.meetingId === filter.meetingId) &&
            (!beforeAt ||
              row.createdAt < beforeAt ||
              (row.createdAt === beforeAt && Boolean(beforeId) && row.id < (beforeId ?? "")))
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
        .slice(0, limit)
        .map(clone)
    },

    async claimDelivery(workspaceId, id) {
      const row = scoped(deliveries.get(id), workspaceId)

      if (!row || !["queued", "retrying", "running"].includes(row.status)) return undefined

      const next = patchObject(row, { status: "running", attempts: row.attempts + 1 })

      deliveries.set(id, next)
      return clone(next)
    },

    async updateDelivery(workspaceId, id, patch) {
      const row = scoped(deliveries.get(id), workspaceId)

      if (!row) return undefined

      const next = patchObject(row, patch)

      deliveries.set(id, next)
      return clone(next)
    },

    async cancelQueuedDeliveriesForConnection(workspaceId, connectionId) {
      const ids: string[] = []

      for (const row of deliveries.values()) {
        if (
          row.workspaceId === workspaceId &&
          row.connectionId === connectionId &&
          (row.status === "queued" || row.status === "retrying")
        ) {
          deliveries.set(row.id, patchObject(row, { status: "cancelled", completedAt: now() }))
          ids.push(row.id)
        }
      }

      return ids
    },

    async countRecapEmailsSince(workspaceId, since) {
      let total = 0

      for (const row of deliveries.values()) {
        if (row.workspaceId !== workspaceId || row.provider !== "email") continue

        const log = Array.isArray(row.progress.sentLog) ? (row.progress.sentLog as { at?: string; n?: number }[]) : []

        for (const entry of log) {
          if (entry.at && Date.parse(entry.at) > since.getTime()) total += Number(entry.n) || 0
        }
      }

      return total
    },

    async systemDeleteDeliveriesBefore(before) {
      let count = 0

      for (const [id, row] of deliveries) {
        if (Date.parse(row.createdAt) < before.getTime()) {
          deliveries.delete(id)
          count += 1
        }
      }

      return count
    },

    async getLink(scope, key) {
      const row = links.get(linkId(scope.connectionId, scope.meetingId, linkKeyParts(key)))

      if (!row || row.workspaceId !== scope.workspaceId) return undefined

      const { workspaceId: _ws, ...link } = row

      void _ws
      return clone(link)
    },

    async listLinks(scope, objectKind, destinationKey) {
      return [...links.values()]
        .filter(
          (row) =>
            row.workspaceId === scope.workspaceId &&
            row.connectionId === scope.connectionId &&
            row.meetingId === scope.meetingId &&
            row.objectKind === objectKind &&
            (destinationKey === undefined || row.destinationKey === destinationKey)
        )
        .map(({ workspaceId: _ws, ...link }) => {
          void _ws
          return clone(link)
        })
    },

    async upsertLink(scope, key) {
      const parts = linkKeyParts(key)
      const id = linkId(scope.connectionId, scope.meetingId, parts)
      const existing = links.get(id)
      const row = {
        id: existing?.id ?? `intl_${randomUUID()}`,
        workspaceId: scope.workspaceId,
        connectionId: scope.connectionId,
        provider: scope.provider,
        meetingId: scope.meetingId,
        ...parts,
        externalId: key.externalId,
        ...(key.externalUrl ? { externalUrl: key.externalUrl } : {}),
        ...(key.contentHash ? { contentHash: key.contentHash } : {}),
        createdAt: existing?.createdAt ?? now(),
        updatedAt: now(),
      }

      links.set(id, row)

      const { workspaceId: _ws, ...link } = row

      void _ws
      return clone(link)
    },

    async removeLink(scope, key) {
      const id = linkId(scope.connectionId, scope.meetingId, linkKeyParts(key))

      if (links.get(id)?.workspaceId === scope.workspaceId) links.delete(id)
    },

    async getPrefs(workspaceId, meetingId) {
      const row = prefs.get(meetingId)

      return row && row.workspaceId === workspaceId ? clone(row) : undefined
    },

    async upsertPrefs(workspaceId, meetingId, patch) {
      const existing = prefs.get(meetingId)

      if (existing && existing.workspaceId !== workspaceId) throw new Error("meeting belongs to another workspace")

      const next: MeetingIntegrationPrefs = {
        meetingId,
        workspaceId,
        allowPrivatePush: existing?.allowPrivatePush ?? false,
        emailRecap: existing?.emailRecap ?? "inherit",
        ...(existing?.allowPrivateSetByUserId ? { allowPrivateSetByUserId: existing.allowPrivateSetByUserId } : {}),
        updatedAt: now(),
      }

      if (patch.allowPrivatePush !== undefined) next.allowPrivatePush = patch.allowPrivatePush
      if (patch.allowPrivateSetByUserId === null) delete next.allowPrivateSetByUserId
      else if (patch.allowPrivateSetByUserId !== undefined) next.allowPrivateSetByUserId = patch.allowPrivateSetByUserId
      if (patch.emailRecap !== undefined) next.emailRecap = patch.emailRecap
      if (patch.updatedByUserId) next.updatedByUserId = patch.updatedByUserId

      prefs.set(meetingId, next)
      return clone(next)
    },

    async listUnsubscribed(workspaceId, emails) {
      return new Set(
        emails.map((email) => email.trim().toLowerCase()).filter((email) => unsubscribes.has(`${workspaceId}\u0000${email}`))
      )
    },

    async addUnsubscribe(workspaceId, emailLower, source) {
      const key = `${workspaceId}\u0000${emailLower.trim().toLowerCase()}`

      if (!unsubscribes.has(key)) unsubscribes.set(key, { source, createdAt: now() })
    },
  }

  return store
}
