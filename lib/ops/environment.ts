import { getGeminiProviderMode, isGeminiConfigured } from "@/lib/ai/providers"
import { getWorkspaceAuthStatus } from "@/lib/google/auth"

export type RuntimeEnvironmentReport = {
  warnings: string[]
  providers: {
    geminiMode: ReturnType<typeof getGeminiProviderMode>
    geminiConfigured: boolean
    googleWorkspaceConfigured: boolean
  }
}

export function validateRuntimeEnvironment(): RuntimeEnvironmentReport {
  const warnings: string[] = []
  const workspace = getWorkspaceAuthStatus()
  const geminiConfigured = isGeminiConfigured()

  if (!workspace.configured) {
    warnings.push("Google Workspace sync is missing an auth strategy.")
  }
  if (workspace.strategy === "user-oauth") {
    if (!process.env.GOOGLE_OAUTH_CLIENT_ID || !process.env.GOOGLE_OAUTH_CLIENT_SECRET) {
      warnings.push(
        "Google Workspace OAuth requires GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET."
      )
    }
  } else if (workspace.strategy === "keyless-iam-signjwt") {
    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      warnings.push(
        "Google Workspace sync requires Application Default Credentials with iam.serviceAccounts.signJwt permission."
      )
    }
  }
  if (!geminiConfigured) {
    warnings.push("Gemini is not configured; AI actions will use fallbacks.")
  }
  if (!process.env.REALIZEOS_API_URL) {
    warnings.push("RealizeOS export is not configured.")
  }

  return {
    warnings,
    providers: {
      geminiMode: getGeminiProviderMode(),
      geminiConfigured,
      googleWorkspaceConfigured: workspace.configured,
    },
  }
}
