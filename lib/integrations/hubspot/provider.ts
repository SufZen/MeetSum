import type { IntegrationProvider } from "@/lib/integrations/core/types"

/**
 * M8 Step 0 stub (owner: Package B): not configured, no OAuth, no deliver.
 * The package replaces this file with the real provider.
 */
export const hubspotProvider: IntegrationProvider = {
  id: "hubspot",
  scope: "workspace",
  configured: () => false,
}
