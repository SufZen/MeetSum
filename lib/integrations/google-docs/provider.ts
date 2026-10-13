import type { IntegrationProvider } from "@/lib/integrations/core/types"

/**
 * M8 Step 0 stub (owner: Package C): not configured, no OAuth, no deliver.
 * The package replaces this file with the real provider.
 */
export const googleDocsProvider: IntegrationProvider = {
  id: "google_drive",
  scope: "user",
  configured: () => false,
}
