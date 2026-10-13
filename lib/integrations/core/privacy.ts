/**
 * Privacy gate (docs/parity/m8.md, "Privacy gate"), pure. Owner: Package A.
 * Runs at dispatch and again at deliver time after re-reading the meeting.
 *
 * - `workspace` / `link` → allowed (subject to filters).
 * - `private` or unknown → allowed only when the meeting OWNER opted in:
 *   (a) their own rule with `include_private`, or
 *   (b) `meeting_integration_prefs.allow_private_push` set by the owner, or
 *   (c) a manual send requested by the owner themself.
 *   Admins never opt a meeting in for someone else.
 */
import type { DeliveryOrigin, MeetingFacts, MeetingIntegrationPrefs } from "@/lib/integrations/core/types"

export type PrivacyInput = {
  facts: Pick<MeetingFacts, "visibility" | "ownerUserId">
  origin: DeliveryOrigin
  rule?: { includePrivate: boolean; createdByUserId?: string }
  prefs?: Pick<MeetingIntegrationPrefs, "allowPrivatePush" | "allowPrivateSetByUserId">
  requestedByUserId?: string
}

export type PrivacyDecision = { allowed: true; via: "shared" | "owner_rule" | "owner_pref" | "owner_manual" } | { allowed: false; reason: "private_meeting" }

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
  if (input.origin === "manual" && input.requestedByUserId === owner) {
    return { allowed: true, via: "owner_manual" }
  }

  return { allowed: false, reason: "private_meeting" }
}
