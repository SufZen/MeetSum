/**
 * Content-free audit for integrations (docs/parity/m8.md, "Security checks"
 * 7). Owner: Package A. Metadata keeps only allowlisted keys whose values
 * are ids, codes, counts or booleans; titles, content, addresses, tokens and
 * provider messages can never pass. Audit failures never break the caller.
 */
import { recordAuditLog, type AuditAction } from "@/lib/audit"
import { getLogger } from "@/lib/log"

const log = getLogger({ component: "integrations" })

const METADATA_KEYS = new Set([
  "provider",
  "status",
  "connectionId",
  "ruleId",
  "deliveryId",
  "meetingId",
  "origin",
  "trigger",
  "fields",
  "sent",
  "skipped",
  "failed",
  "reason",
  "kind",
  "addressHash",
  "attempts",
  "disabledRules",
  "cancelledDeliveries",
  "eventName",
  "skipReason",
  "scope",
  "personal",
  "updated",
  "source",
])

const SAFE_STRING = /^[A-Za-z0-9_.:@-]{0,128}$/

function safeValue(value: unknown): unknown {
  if (typeof value === "number" || typeof value === "boolean") return value
  if (typeof value === "string") return SAFE_STRING.test(value) && !value.includes("@") ? value : undefined
  if (Array.isArray(value)) {
    const items = value.filter((item) => typeof item === "string" && SAFE_STRING.test(item) && !item.includes("@"))

    return items.slice(0, 20)
  }
  return undefined
}

/** Allowlisted, content-free metadata. */
export function sanitizeAuditMetadata(metadata: Record<string, unknown> = {}): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(metadata)) {
    if (!METADATA_KEYS.has(key)) continue

    const safe = safeValue(value)

    if (safe !== undefined) result[key] = safe
  }

  return result
}

export type IntegrationAuditActor = {
  workspaceId: string
  actor?: string
  actorUserId?: string
  actorApiKeyId?: string
}

export async function auditIntegration(
  actor: IntegrationAuditActor,
  action: AuditAction,
  target: { type: string; id?: string },
  metadata: Record<string, unknown> = {}
): Promise<void> {
  try {
    await recordAuditLog({
      workspaceId: actor.workspaceId,
      ...(actor.actor ? { actor: actor.actor } : {}),
      ...(actor.actorUserId ? { actorUserId: actor.actorUserId } : {}),
      ...(actor.actorApiKeyId ? { actorApiKeyId: actor.actorApiKeyId } : {}),
      action,
      targetType: target.type,
      ...(target.id ? { targetId: target.id } : {}),
      metadata: sanitizeAuditMetadata(metadata),
    })
  } catch (error) {
    log.error({ errorName: error instanceof Error ? error.name : "error" }, "[integrations] audit failed")
  }
}
