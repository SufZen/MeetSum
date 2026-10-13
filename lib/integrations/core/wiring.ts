/**
 * Integration-step wiring (docs/parity/m8.md, "Integration step" 1): gives
 * Package B's providers Package A's real services. Called once when the
 * registry loads. A's modules that import the registry (store, tokens,
 * connections) are imported lazily, so there is no import cycle.
 *
 * - Microsoft: `providerFetch` plus the connection store and token service
 *   (`get`, row-locked `getAccessToken`, `mergeConfig`).
 * - HubSpot: `providerFetch` plus A's single `evaluatePrivacyGate`, fed with
 *   the meeting's per-meeting prefs (the provider never decides privacy on
 *   its own).
 * - The manual export runtime (Notion, Google Docs) defaults to A's
 *   services in `notion/manual-export-runtime.ts`.
 */
import { providerFetch } from "@/lib/integrations/core/http"
import { evaluatePrivacyGate } from "@/lib/integrations/core/privacy"
import type { DeliverInput } from "@/lib/integrations/core/types"
import { configureHubspotProvider } from "@/lib/integrations/hubspot/provider"
import { configureMicrosoftProvider, type MicrosoftConnectionAccess } from "@/lib/integrations/microsoft/provider"

const store = async () => (await import("@/lib/integrations/core/store")).getIntegrationStore()

export const microsoftConnectionAccess: MicrosoftConnectionAccess = {
  async get(workspaceId, connectionId) {
    const [db, { toConnectionDTO }] = await Promise.all([store(), import("@/lib/integrations/core/connections")])
    const row = await db.getConnection(workspaceId, connectionId)

    return row ? toConnectionDTO(row) : undefined
  },
  async getAccessToken(workspaceId, connectionId) {
    const { getAccessToken } = await import("@/lib/integrations/core/tokens")

    return getAccessToken(workspaceId, connectionId)
  },
  async mergeConfig(workspaceId, connectionId, patch) {
    const db = await store()

    // Under the row lock so a concurrent PATCH or sync never loses keys.
    await db.withConnectionLock(workspaceId, connectionId, async (row, update) => {
      if (!row) return
      await update({ config: { ...row.config, ...patch } })
    })
  },
}

/** A's privacy gate for a provider `deliver` call (re-reads the prefs). */
export async function deliverPrivacyGate(input: DeliverInput): Promise<boolean> {
  const prefs = await (await store()).getPrefs(input.workspaceId, input.meeting.id)

  return evaluatePrivacyGate({
    facts: {
      visibility: input.meeting.visibility,
      ...(input.meeting.ownerUserId ? { ownerUserId: input.meeting.ownerUserId } : {}),
    },
    origin: input.delivery.origin,
    ...(input.rule
      ? {
          rule: {
            includePrivate: input.rule.includePrivate,
            ...(input.rule.createdByUserId ? { createdByUserId: input.rule.createdByUserId } : {}),
          },
        }
      : {}),
    ...(prefs ? { prefs } : {}),
  }).allowed
}

let wired = false

export function wireIntegrationProviders(): void {
  if (wired) return
  wired = true

  configureMicrosoftProvider({ fetch: providerFetch, connections: microsoftConnectionAccess })
  configureHubspotProvider({ fetch: providerFetch, privacyGate: deliverPrivacyGate })
}
