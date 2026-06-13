import {
  getGeminiProviderMode,
  getTranscriptionProviderMode,
  isGeminiConfigured,
  isLocalWhisperConfigured,
} from "@/lib/ai/providers"
import { getWorkspaceAuthStatus } from "@/lib/google/auth"

export type RuntimeEnvironmentReport = {
  warnings: string[]
  fatal: string[]
  providers: {
    geminiMode: ReturnType<typeof getGeminiProviderMode>
    geminiConfigured: boolean
    googleWorkspaceConfigured: boolean
  }
}

function collectFatalIssues(env: NodeJS.ProcessEnv): string[] {
  const fatal: string[] = []
  const isProduction = env.NODE_ENV === "production"

  if (
    isProduction &&
    env.MEETSUM_STORAGE !== "postgres" &&
    env.MEETSUM_ALLOW_DEMO_STORAGE !== "true"
  ) {
    fatal.push(
      'MEETSUM_STORAGE must be "postgres" in production (or set MEETSUM_ALLOW_DEMO_STORAGE=true for a throwaway demo).'
    )
  }

  if (!env.MEETSUM_SESSION_SECRET) {
    fatal.push("MEETSUM_SESSION_SECRET is required.")
  } else if (
    env.WEBHOOK_SIGNING_SECRET &&
    env.MEETSUM_SESSION_SECRET === env.WEBHOOK_SIGNING_SECRET
  ) {
    fatal.push("MEETSUM_SESSION_SECRET must differ from WEBHOOK_SIGNING_SECRET.")
  }

  if (isProduction && !env.WEBHOOK_SIGNING_SECRET) {
    fatal.push("WEBHOOK_SIGNING_SECRET is required in production.")
  }

  if (isProduction && env.MEETSUM_STORAGE === "postgres" && !env.DATABASE_URL) {
    fatal.push("DATABASE_URL is required when MEETSUM_STORAGE=postgres.")
  }

  if (env.S3_ENDPOINT && (!env.S3_ACCESS_KEY || !env.S3_SECRET_KEY)) {
    fatal.push("S3_ENDPOINT is set but S3_ACCESS_KEY/S3_SECRET_KEY are incomplete.")
  }

  return fatal
}

export function validateRuntimeEnvironment(
  env: NodeJS.ProcessEnv = process.env
): RuntimeEnvironmentReport {
  const warnings: string[] = []
  const fatal = collectFatalIssues(env)
  const workspace = getWorkspaceAuthStatus()
  const geminiConfigured = isGeminiConfigured()
  const transcriptionMode = getTranscriptionProviderMode()

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
  if (
    (transcriptionMode === "local-whisper" || transcriptionMode === "auto") &&
    !isLocalWhisperConfigured()
  ) {
    warnings.push(
      "Local Whisper transcription is selected but LOCAL_TRANSCRIPTION_URL is missing."
    )
  }
  if (!process.env.REALIZEOS_API_URL) {
    warnings.push("RealizeOS export is not configured.")
  }

  return {
    warnings,
    fatal,
    providers: {
      geminiMode: getGeminiProviderMode(),
      geminiConfigured,
      googleWorkspaceConfigured: workspace.configured,
    },
  }
}

/**
 * Boot gate: logs warnings and throws on fatal misconfiguration so the process
 * fails loudly at startup instead of surfacing cryptic runtime errors.
 */
export function assertRuntimeEnvironment(
  env: NodeJS.ProcessEnv = process.env
): RuntimeEnvironmentReport {
  const report = validateRuntimeEnvironment(env)

  for (const warning of report.warnings) {
    console.warn(`[env] ${warning}`)
  }

  if (report.fatal.length > 0) {
    for (const issue of report.fatal) {
      console.error(`[env] FATAL: ${issue}`)
    }

    throw new Error(
      `MeetSum environment validation failed:\n- ${report.fatal.join("\n- ")}`
    )
  }

  return report
}
