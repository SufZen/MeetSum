/**
 * Delivery runner (`integration.deliver`, docs/parity/m8.md A5). Owner:
 * Package A. One attempt:
 *  1. claim the row (terminal rows are a no-op);
 *  2. re-read the meeting, the rule, the connection (aborts when it was
 *     revoked or flagged since dispatch), re-run the owner check, the
 *     privacy gate and the email recap mode with fresh prefs;
 *  3. `buildMeetingRecap` → `provider.deliver`;
 *  4. map errors: `auth|forbidden|invalid|not_found|config` → `failed`
 *     (auth also flags the connection `needs_reauth`); `rate_limited|
 *     retryable` → `retrying` with `Retry-After` or exponential backoff;
 *     on the final attempt `failed`, or `partial` when `progress` holds a
 *     partial success;
 *  5. on `failed`, emit `integration.delivery.failed` (ids only).
 * Stored errors are typed only (`storedIntegrationError`).
 */
import { auditIntegration } from "@/lib/integrations/core/audit"
import { toConnectionDTO } from "@/lib/integrations/core/connections"
import { evaluateRule } from "@/lib/integrations/core/dispatcher"
import { integrationLog, isUnrecoverableKind, publicIntegrationError, storedIntegrationError, toProviderError } from "@/lib/integrations/core/errors"
import { providerFetch } from "@/lib/integrations/core/http"
import { deliveryBackoffMs } from "@/lib/integrations/core/limits"
import { createLinkStore, findActiveShareUrl, meetingAppUrl, NO_LINKS, recapLocale } from "@/lib/integrations/core/links"
import { evaluatePrivacyGate } from "@/lib/integrations/core/privacy"
import { isConnectionStateError, markConnectionNeedsReauth } from "@/lib/integrations/core/reauth"
import { meetingFactsFromRecord } from "@/lib/integrations/core/rule-filters"
import { defaultIntegrationRuntime, type IntegrationRuntime } from "@/lib/integrations/core/runtime"
import type { StoredDelivery } from "@/lib/integrations/core/store"
import { getAccessToken } from "@/lib/integrations/core/tokens"
import {
  ProviderError,
  type DeliveryProgress,
  type DeliverySkipReason,
  type RuleContent,
  type RuleDestination,
} from "@/lib/integrations/core/types"
import { buildMeetingRecap, DEFAULT_RULE_CONTENT } from "@/lib/integrations/recap"

export type DeliveryOutcome =
  | { status: "noop" }
  | { status: "sent" | "partial" | "skipped" | "failed" | "cancelled" }
  | { status: "retrying"; delayMs: number }

/** Thrown by the worker so BullMQ retries with `delayMs`. */
export class RetryableDeliveryError extends Error {
  readonly delayMs: number

  constructor(delayMs: number) {
    super("integration delivery will be retried")
    this.name = "RetryableDeliveryError"
    this.delayMs = delayMs
  }
}

/** Manual-send request stored with the delivery (ids and toggles only). */
export type ManualRequest = { destination: RuleDestination; content: RuleContent }

/**
 * Keys that never mean "something was delivered": the manual request, and
 * the pending intents written before an external call (review fix #4:
 * Slack `slackIntent`, HubSpot `engagementIntent`/`taskIntents`, Notion
 * `pendingCreate` and its `mode`, email `pending`).
 */
const PROGRESS_INTERNAL_KEYS = new Set(["request", "slackIntent", "engagementIntent", "taskIntents", "pendingCreate", "mode", "pending"])

function hasPartialProgress(progress: DeliveryProgress): boolean {
  return Object.entries(progress).some(([key, value]) => {
    if (PROGRESS_INTERNAL_KEYS.has(key)) return false
    if (Array.isArray(value)) return value.length > 0
    if (value && typeof value === "object") return Object.keys(value).length > 0
    return value !== undefined && value !== null && value !== false && value !== ""
  })
}

export async function runIntegrationDelivery(
  input: { workspaceId: string; deliveryId: string; finalAttempt: boolean },
  runtime?: Partial<IntegrationRuntime>
): Promise<DeliveryOutcome> {
  const rt = await defaultIntegrationRuntime(runtime)
  const { store } = rt
  const ws = input.workspaceId
  const delivery = await store.claimDelivery(ws, input.deliveryId)

  if (!delivery) return { status: "noop" }

  const finish = async (
    status: "sent" | "partial" | "skipped" | "failed" | "cancelled",
    extra: { skipReason?: DeliverySkipReason; lastError?: string; externalRef?: Record<string, unknown>; progress?: DeliveryProgress } = {}
  ): Promise<DeliveryOutcome> => {
    await store.updateDelivery(ws, delivery.id, {
      status,
      completedAt: rt.now().toISOString(),
      ...(extra.skipReason ? { skipReason: extra.skipReason } : {}),
      ...(extra.lastError ? { lastError: extra.lastError } : {}),
      ...(extra.externalRef ? { externalRef: extra.externalRef } : {}),
      ...(extra.progress ? { progress: extra.progress } : {}),
    })
    return { status }
  }
  const skip = (reason: DeliverySkipReason) => finish("skipped", { skipReason: reason })

  // 2. Fresh reads.
  const meeting = delivery.meetingId ? await rt.getMeeting(ws, delivery.meetingId) : undefined

  if (!meeting || (meeting.workspaceId && meeting.workspaceId !== ws)) return skip("meeting_not_found")

  const facts = meetingFactsFromRecord(meeting, ws)
  const prefs = await store.getPrefs(ws, meeting.id)
  const rule = delivery.ruleId ? await store.getRule(ws, delivery.ruleId) : undefined

  if (delivery.origin === "rule" && (!rule || !rule.enabled)) return finish("cancelled")

  let destination: RuleDestination
  let content: RuleContent

  if (rule) {
    const members = await rt.listMembers(ws)
    const ownerIsMember = Boolean(rule.createdByUserId && members.some((member) => member.userId === rule.createdByUserId))
    const evaluation = evaluateRule({ rule, facts, prefs, ownerIsMember, internalDomains: [], checkFilters: false })

    if (evaluation.status === "skipped") return skip(evaluation.reason)
    destination = rule.destination
    content = rule.content
  } else {
    const request = delivery.progress.request as ManualRequest | undefined
    const privacy = evaluatePrivacyGate({
      facts,
      origin: "manual",
      ...(prefs ? { prefs } : {}),
      ...(delivery.requestedByUserId ? { requestedByUserId: delivery.requestedByUserId } : {}),
    })

    if (!request?.destination) return finish("failed", { lastError: storedIntegrationError(new ProviderError("invalid", "no destination"), delivery.provider) })
    if (!privacy.allowed) return skip("private_meeting")
    destination = request.destination
    content = request.content ?? DEFAULT_RULE_CONTENT
  }

  const provider = rt.getProvider(delivery.provider)

  if (!provider?.deliver) return finish("failed", { lastError: storedIntegrationError(new ProviderError("config", "no provider"), delivery.provider) })

  // Re-read the connection right before sending: abort when revoked/flagged.
  const connection = delivery.connectionId ? await store.getConnection(ws, delivery.connectionId) : undefined

  if (delivery.provider !== "email") {
    if (!connection || connection.status === "revoked") return skip("connection_inactive")
    if (connection.status !== "active") return skip("needs_reauth")
  }

  const locale = recapLocale(meeting.language)
  const share = content.link === "existing_share" ? await findActiveShareUrl(ws, meeting.id) : undefined
  const recap = buildMeetingRecap(meeting, {
    content,
    links: { meeting: meetingAppUrl(meeting.id, locale), ...(share ? { share } : {}) },
  })
  let progress: DeliveryProgress = { ...delivery.progress }
  const saveProgress = async (next: DeliveryProgress) => {
    progress = { ...next, ...(delivery.progress.request ? { request: delivery.progress.request } : {}) }
    await store.updateDelivery(ws, delivery.id, { progress })
  }

  try {
    const result = await provider.deliver({
      workspaceId: ws,
      delivery: deliveryDTO(delivery),
      ...(connection ? { connection: toConnectionDTO(connection) } : {}),
      getAccessToken: async () => {
        if (!connection) throw new ProviderError("config", "provider has no connection")
        return getAccessToken(ws, connection.id, { store })
      },
      ...(rule ? { rule: ruleDTO(rule) } : {}),
      destination,
      content,
      recap,
      meeting,
      progress: { ...progress },
      saveProgress,
      links: connection
        ? createLinkStore(store, { workspaceId: ws, connectionId: connection.id, meetingId: meeting.id, provider: connection.provider })
        : NO_LINKS,
      fetch: providerFetch,
    })

    if (connection) await store.updateConnection(ws, connection.id, { lastUsedAt: rt.now().toISOString() })

    const finalProgress = result.progress
      ? { ...result.progress, ...(delivery.progress.request ? { request: delivery.progress.request } : {}) }
      : progress
    const outcome = await finish(result.status, {
      externalRef: result.externalRef,
      progress: finalProgress,
      ...(result.skipReason ? { skipReason: result.skipReason } : {}),
    })

    if (result.status !== "skipped") {
      await auditIntegration({ workspaceId: ws, actor: "system:integrations" }, "integration.delivery.sent", { type: "integration_delivery", id: delivery.id }, {
        provider: delivery.provider,
        status: result.status,
        origin: delivery.origin,
        meetingId: meeting.id,
        ...(delivery.ruleId ? { ruleId: delivery.ruleId } : {}),
      })
    }
    return outcome
  } catch (caught) {
    const error = toProviderError(caught)
    const lastError = storedIntegrationError(error, delivery.provider)

    integrationLog.warn(`delivery ${delivery.id} attempt ${delivery.attempts} failed`, lastError)

    // CAS on the generation read before the call; connection-state errors
    // (`connection_changed`, `connection_inactive`) are not a rejected grant.
    if (error.kind === "auth" && connection && !isConnectionStateError(error)) {
      await markConnectionNeedsReauth(ws, connection.id, error, { store, generation: connection.generation })
    }

    if (isUnrecoverableKind(error.kind) || input.finalAttempt || delivery.attempts >= delivery.maxAttempts) {
      const status = hasPartialProgress(progress) ? "partial" : "failed"
      const outcome = await finish(status, {
        lastError,
        progress,
        ...(status === "partial" && error.providerCode === "hourly_cap" ? { skipReason: "hourly_cap" as const } : {}),
      })

      if (status === "failed") await reportFailure(rt, delivery, error.kind)
      return outcome
    }

    const delayMs = deliveryBackoffMs(delivery.attempts, error.retryAfterMs)

    await store.updateDelivery(ws, delivery.id, { status: "retrying", lastError, progress })
    return { status: "retrying", delayMs }
  }
}

async function reportFailure(rt: IntegrationRuntime, delivery: StoredDelivery, reason: string) {
  await auditIntegration({ workspaceId: delivery.workspaceId, actor: "system:integrations" }, "integration.delivery.failed", {
    type: "integration_delivery",
    id: delivery.id,
  }, { provider: delivery.provider, origin: delivery.origin, reason, attempts: delivery.attempts })
  await rt
    .emitDeliveryFailed(delivery.workspaceId, {
      deliveryId: delivery.id,
      provider: delivery.provider,
      ...(delivery.meetingId ? { meetingId: delivery.meetingId } : {}),
      reason,
    })
    .catch(() => undefined)
}

export function deliveryDTO(row: StoredDelivery) {
  return {
    id: row.id,
    ...(row.ruleId ? { ruleId: row.ruleId } : {}),
    ...(row.connectionId ? { connectionId: row.connectionId } : {}),
    provider: row.provider,
    origin: row.origin,
    ...(row.eventName ? { eventName: row.eventName } : {}),
    ...(row.meetingId ? { meetingId: row.meetingId } : {}),
    ...(row.actionItemId ? { actionItemId: row.actionItemId } : {}),
    status: row.status,
    ...(row.skipReason ? { skipReason: row.skipReason } : {}),
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    externalRef: { ...row.externalRef },
    ...(row.lastError ? { lastError: publicIntegrationError(row.lastError) } : {}),
    ...(row.requestedByUserId ? { requestedByUserId: row.requestedByUserId } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.completedAt ? { completedAt: row.completedAt } : {}),
  }
}

function ruleDTO(rule: NonNullable<Awaited<ReturnType<IntegrationRuntime["store"]["getRule"]>>>) {
  const { workspaceId: _ws, ...dto } = rule

  void _ws
  return dto
}
