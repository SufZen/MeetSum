/**
 * Rule dispatcher (`integration.dispatch`, docs/parity/m8.md A4). Owner:
 * Package A. For one platform event:
 *  1. enabled rules for `(ws, event)`, at most 50;
 *  2. meeting facts and prefs via the system repo of `ws`;
 *  3. rule-owner check, privacy gate, filters, email recap mode;
 *  4. `insert … on conflict (workspace_id, idempotency_key) do nothing`
 *     as `queued` or `skipped` (key `rule:{ruleId}:{event}:{meetingId}[:{actionItemId}]`,
 *     so reprocessing never re-posts);
 *  5. `integration.deliver` for each new queued row.
 * Every row is written in the event's workspace only.
 */
import { randomUUID } from "node:crypto"

import { integrationMaxAttempts } from "@/lib/integrations/core/limits"
import { evaluatePrivacyGate } from "@/lib/integrations/core/privacy"
import { deliverJobId, type IntegrationDispatchPayload } from "@/lib/integrations/core/queue"
import { matchesRuleFilters, meetingFactsFromRecord } from "@/lib/integrations/core/rule-filters"
import { defaultIntegrationRuntime, type IntegrationRuntime } from "@/lib/integrations/core/runtime"
import type { StoredRule } from "@/lib/integrations/core/store"
import {
  RULE_TRIGGERS,
  type DeliverySkipReason,
  type MeetingFacts,
  type MeetingIntegrationPrefs,
  type RuleTrigger,
} from "@/lib/integrations/core/types"

export function ruleIdempotencyKey(ruleId: string, event: string, meetingId: string, actionItemId?: string): string {
  return `rule:${ruleId}:${event}:${meetingId}${actionItemId ? `:${actionItemId}` : ""}`
}

export function isRuleTrigger(name: string): name is RuleTrigger {
  return (RULE_TRIGGERS as readonly string[]).includes(name)
}

/** Email recap mode: `off` always wins; `opt_in` needs the meeting pref `on`. */
export function emailRecapSkipReason(
  rule: Pick<StoredRule, "destination">,
  prefs: Pick<MeetingIntegrationPrefs, "emailRecap"> | undefined
): DeliverySkipReason | undefined {
  if (rule.destination.provider !== "email") return undefined

  const pref = prefs?.emailRecap ?? "inherit"

  if (pref === "off") return "recap_off"
  if (rule.destination.mode === "opt_in" && pref !== "on") return "recap_not_opted_in"
  return undefined
}

export type RuleEvaluation = { status: "queued" } | { status: "skipped"; reason: DeliverySkipReason }

/**
 * Shared by dispatch and the deliver-time re-check: owner membership,
 * privacy gate, filters (dispatch only), email mode.
 */
export function evaluateRule(input: {
  rule: StoredRule
  facts: MeetingFacts
  prefs: MeetingIntegrationPrefs | undefined
  ownerIsMember: boolean
  internalDomains: readonly string[]
  checkFilters: boolean
}): RuleEvaluation {
  const { rule, facts, prefs } = input

  if (!input.ownerIsMember) return { status: "skipped", reason: "rule_owner_inactive" }

  const privacy = evaluatePrivacyGate({
    facts,
    origin: "rule",
    rule: { includePrivate: rule.includePrivate, ...(rule.createdByUserId ? { createdByUserId: rule.createdByUserId } : {}) },
    ...(prefs ? { prefs } : {}),
  })

  if (!privacy.allowed) return { status: "skipped", reason: "private_meeting" }
  if (
    input.checkFilters &&
    !matchesRuleFilters(rule.filters, facts, { internalDomains: input.internalDomains, includePrivate: rule.includePrivate })
  ) {
    return { status: "skipped", reason: "filtered" }
  }

  const recap = emailRecapSkipReason(rule, prefs)

  return recap ? { status: "skipped", reason: recap } : { status: "queued" }
}

export type DispatchSummary = { queued: number; skipped: number; duplicates: number }

export async function runIntegrationDispatch(
  payload: IntegrationDispatchPayload,
  runtime?: Partial<IntegrationRuntime>
): Promise<DispatchSummary> {
  const summary: DispatchSummary = { queued: 0, skipped: 0, duplicates: 0 }

  if (!payload.workspaceId || !payload.meetingId || !isRuleTrigger(payload.eventName)) return summary

  const rt = await defaultIntegrationRuntime(runtime)
  const rules = await rt.store.listEnabledRulesForEvent(payload.workspaceId, payload.eventName, 50)

  if (!rules.length) return summary

  const meeting = await rt.getMeeting(payload.workspaceId, payload.meetingId)

  if (!meeting || (meeting.workspaceId && meeting.workspaceId !== payload.workspaceId)) return summary

  const facts = meetingFactsFromRecord(meeting, payload.workspaceId)
  const prefs = await rt.store.getPrefs(payload.workspaceId, payload.meetingId)
  const members = await rt.listMembers(payload.workspaceId)
  const memberIds = new Set(members.map((member) => member.userId))
  let internal: string[] | undefined

  for (const rule of rules) {
    if (rule.workspaceId !== payload.workspaceId) continue

    const ownerIsMember = Boolean(rule.createdByUserId && memberIds.has(rule.createdByUserId))

    if (!ownerIsMember) {
      await rt.store.updateRule(payload.workspaceId, rule.id, { enabled: false, disabledReason: "rule_owner_inactive" })
    }

    let evaluation = evaluateRule({
      rule,
      facts,
      prefs,
      ownerIsMember,
      internalDomains: rule.filters.participantDomains ? (internal ??= await rt.internalDomains(payload.workspaceId)) : [],
      checkFilters: true,
    })

    if (evaluation.status === "queued" && rule.connectionId) {
      const connection = await rt.store.getConnection(payload.workspaceId, rule.connectionId)

      if (!connection || connection.status === "revoked") evaluation = { status: "skipped", reason: "connection_inactive" }
      else if (connection.status !== "active") evaluation = { status: "skipped", reason: "needs_reauth" }
    }

    const now = rt.now().toISOString()
    const { delivery, created } = await rt.store.insertDelivery({
      id: `intd_${randomUUID()}`,
      workspaceId: payload.workspaceId,
      ruleId: rule.id,
      ...(rule.connectionId ? { connectionId: rule.connectionId } : {}),
      provider: rule.provider,
      origin: "rule",
      eventName: payload.eventName,
      eventId: payload.eventId,
      meetingId: payload.meetingId,
      ...(payload.actionItemId ? { actionItemId: payload.actionItemId } : {}),
      idempotencyKey: ruleIdempotencyKey(rule.id, payload.eventName, payload.meetingId, payload.actionItemId),
      status: evaluation.status,
      ...(evaluation.status === "skipped" ? { skipReason: evaluation.reason, completedAt: now } : {}),
      maxAttempts: integrationMaxAttempts(),
    })

    if (!created) {
      summary.duplicates += 1
      continue
    }
    if (delivery.status === "queued") {
      summary.queued += 1
      await rt.queue.enqueue(
        "integration.deliver",
        { workspaceId: payload.workspaceId, deliveryId: delivery.id },
        { jobId: deliverJobId(delivery.id) }
      )
    } else {
      summary.skipped += 1
    }
  }

  return summary
}
