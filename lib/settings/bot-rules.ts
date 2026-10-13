import { DEFAULT_BOT_RULES, type BotRules, type BotRulesPatch } from "@/lib/bot/types"

/**
 * Workspace bot auto-join rules, stored in workspace_settings(key='botRules')
 * with the same memory/postgres pattern as app-settings.ts (M7 A4).
 */

export type BotRulesActor = { userId?: string; apiKeyId?: string }

function cloneDefaults(): BotRules {
  return {
    ...DEFAULT_BOT_RULES,
    consentMessage: { ...DEFAULT_BOT_RULES.consentMessage },
    skipTitlePatterns: [...DEFAULT_BOT_RULES.skipTitlePatterns],
    internalDomains: [...DEFAULT_BOT_RULES.internalDomains],
  }
}

/** Step 0 stub: always the defaults (auto-join off). */
export async function getBotRules(workspaceId: string): Promise<BotRules> {
  void workspaceId

  return cloneDefaults()
}

/**
 * Validates, clamps and saves a patch. Enabling auto-join requires the
 * recording-consent acknowledgment (`consent_ack_required`).
 * Step 0 stub: throws.
 */
export async function updateBotRules(
  workspaceId: string,
  patch: BotRulesPatch,
  actor: BotRulesActor
): Promise<BotRules> {
  void workspaceId
  void patch
  void actor

  throw new Error("updateBotRules not implemented (M7)")
}
