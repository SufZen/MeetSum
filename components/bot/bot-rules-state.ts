/**
 * Pure bot-rules settings logic (M7 C3): draft validation mirroring the
 * server's clamps (lib/settings/bot-rules.ts is authoritative), the consent
 * gate, the recording-suffixed name preview and domain chips.
 */
import type { BotRules, BotRulesPatch } from "@/lib/bot/types"
import type { BotMessageKey } from "@/lib/i18n/m7/bot"

export const LEAD_MIN = 0
export const LEAD_MAX = 600
export const LEAD_STEP = 15
export const BOT_NAME_MAX = 60
export const CONSENT_MAX = 500

export type BotRulesDraft = Omit<BotRules, "consentAcknowledgedAt" | "consentAcknowledgedByUserId">

export function draftFromRules(rules: BotRules): BotRulesDraft {
  const {
    consentAcknowledgedAt: _at,
    consentAcknowledgedByUserId: _by,
    ...draft
  } = rules

  void [_at, _by]

  return {
    ...draft,
    consentMessage: { ...draft.consentMessage },
    skipTitlePatterns: [...draft.skipTitlePatterns],
    internalDomains: [...draft.internalDomains],
  }
}

/** "MeetSum Notetaker · Recording" — the name always signals recording. */
export function botNamePreview(name: string, suffix: string): string {
  const base = name.trim() || "MeetSum Notetaker"

  return base.toLocaleLowerCase().includes(suffix.toLocaleLowerCase()) ? base : `${base} · ${suffix}`
}

const DOMAIN = /^(?=.{3,253}$)(?!-)[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})+$/

/** Lowercase bare host from "user@x.co.il", "@x.co.il" or "https://x.co.il/"; undefined if invalid. */
export function normalizeDomain(input: string): string | undefined {
  const value = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^.*@/, "")
    .replace(/\/.*$/, "")
    .replace(/\.$/, "")

  return DOMAIN.test(value) ? value : undefined
}

export function addDomainChip(domains: readonly string[], input: string): string[] {
  const domain = normalizeDomain(input)

  if (!domain || domains.includes(domain)) return [...domains]

  return [...domains, domain]
}

export function parseSkipPatterns(text: string): string[] {
  return [...new Set(text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))].slice(0, 50)
}

const URL_LIKE = /(?:https?:\/\/|www\.)\S+/i

export type BotRulesErrors = Partial<Record<"botName" | "consentHe" | "consentEn" | "autoJoin", BotMessageKey>>

export function validateBotRulesDraft(draft: BotRulesDraft, consentAcknowledged: boolean): BotRulesErrors {
  const errors: BotRulesErrors = {}
  const name = draft.botName.trim()

  if (!name || name.length > BOT_NAME_MAX) errors.botName = "botFieldInvalid"
  for (const [field, text] of [
    ["consentHe", draft.consentMessage.he],
    ["consentEn", draft.consentMessage.en],
  ] as const) {
    const value = text.trim()

    if (draft.consentEnabled && (!value || value.length > CONSENT_MAX || URL_LIKE.test(value))) {
      errors[field] = "botFieldInvalid"
    }
  }
  if (draft.autoJoin !== "off" && !consentAcknowledged) errors.autoJoin = "botConsentAckRequired"

  return errors
}

export function clampLead(seconds: number): number {
  if (!Number.isFinite(seconds)) return 60

  return Math.min(LEAD_MAX, Math.max(LEAD_MIN, Math.round(seconds)))
}

/** The PUT body: only what changed, plus `acknowledgeConsent` when newly ticked. */
export function buildBotRulesPatch(
  saved: BotRules,
  draft: BotRulesDraft,
  acknowledgeNow: boolean
): BotRulesPatch {
  const patch: BotRulesPatch = {}
  const base = draftFromRules(saved)

  for (const key of Object.keys(draft) as Array<keyof BotRulesDraft>) {
    if (JSON.stringify(draft[key]) !== JSON.stringify(base[key])) {
      ;(patch as Record<string, unknown>)[key] = draft[key]
    }
  }
  if (acknowledgeNow && !saved.consentAcknowledgedAt) patch.acknowledgeConsent = true

  return patch
}
