/**
 * Provider registry (docs/parity/m8.md, Step 0 item 7). Owner: Package A.
 * Maps every provider id to its file under lib/integrations/<provider>/;
 * each provider file is owned by its package.
 */
import type { IntegrationProvider, ProviderId } from "@/lib/integrations/core/types"
import { emailRecapProvider } from "@/lib/integrations/email-recap/provider"
import { googleDocsProvider } from "@/lib/integrations/google-docs/provider"
import { hubspotProvider } from "@/lib/integrations/hubspot/provider"
import { microsoftProvider } from "@/lib/integrations/microsoft/provider"
import { notionProvider } from "@/lib/integrations/notion/provider"
import { slackProvider } from "@/lib/integrations/slack/provider"

const PROVIDERS: readonly IntegrationProvider[] = [
  slackProvider,
  microsoftProvider,
  notionProvider,
  hubspotProvider,
  googleDocsProvider,
  emailRecapProvider,
]

/** The provider for an id, or undefined for an unknown id (→ 404). */
export function getProvider(id: string): IntegrationProvider | undefined {
  return PROVIDERS.find((provider) => provider.id === id)
}

export function listProviders(): readonly IntegrationProvider[] {
  return PROVIDERS
}

export function isProviderId(id: string): id is ProviderId {
  return PROVIDERS.some((provider) => provider.id === id && provider.id !== "email")
}
