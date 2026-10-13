/**
 * Privacy gate (docs/parity/m8.md, "Privacy gate"), pure. Owner: Package A.
 * The ONE function every push goes through: the dispatcher, the delivery
 * worker (after re-reading the meeting, so a meeting made private after
 * enqueue is caught) and the manual-send route.
 *
 * - `workspace` / `link` → allowed (subject to filters).
 * - `private` or unknown → allowed only when the meeting OWNER opted in:
 *   (a) rules: the owner's own rule with `include_private` (the rule
 *       creator is the current owner; membership is checked by the caller);
 *   (b) any origin: `meeting_integration_prefs.allow_private_push` set by
 *       the current owner.
 *   A manual send of a private meeting therefore needs the owner's
 *   per-meeting opt-in, whoever sends it. Admins never opt a meeting in for
 *   someone else.
 */
import type { DeliveryOrigin, MeetingFacts, MeetingIntegrationPrefs } from "@/lib/integrations/core/types"

export type PrivacyInput = {
  facts: Pick<MeetingFacts, "visibility" | "ownerUserId">
  origin: DeliveryOrigin
  rule?: { includePrivate: boolean; createdByUserId?: string }
  prefs?: Pick<MeetingIntegrationPrefs, "allowPrivatePush" | "allowPrivateSetByUserId">
  /** Informational for manual sends; never grants access by itself. */
  requestedByUserId?: string
}

export type PrivacyDecision = { allowed: true; via: "shared" | "owner_rule" | "owner_pref" } | { allowed: false; reason: "private_meeting" }

export function evaluatePrivacyGate(input: PrivacyInput): PrivacyDecision {
  const visibility = input.facts.visibility

  if (visibility === "workspace" || visibility === "link") return { allowed: true, via: "shared" }

  const owner = input.facts.ownerUserId

  if (!owner) return { allowed: false, reason: "private_meeting" }

  if (input.origin === "rule" && input.rule?.includePrivate && input.rule.createdByUserId === owner) {
    return { allowed: true, via: "owner_rule" }
  }
  if (input.prefs?.allowPrivatePush && input.prefs.allowPrivateSetByUserId === owner) {
    return { allowed: true, via: "owner_pref" }
  }

  return { allowed: false, reason: "private_meeting" }
}
