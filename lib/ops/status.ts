import { getDatabasePool } from "@/lib/db/client"
import { getGeminiProviderMode, isGeminiConfigured } from "@/lib/ai/providers"
import { getWorkspaceAuthStatus } from "@/lib/google/auth"
import { getGoogleWorkspaceOAuthConnectionStatus } from "@/lib/google/oauth-tokens"

export type ProviderStatus = {
  id: string
  label: string
  configured: boolean
  detail: string
  mode?: string
}

export type WorkspaceStatus = {
  google: {
    subject: string
    serviceAccountEmailConfigured: boolean
    serviceAccountKeyConfigured: boolean
    keyFileConfigured: boolean
    userOAuthConnected: boolean
    strategy:
      | "user-oauth"
      | "keyless-iam-signjwt"
      | "json-key"
      | "key-file"
      | "missing"
    configured: boolean
    detail: string
    serviceAccountEmail?: string
  }
  sync: Array<{
    source: string
    status: string
    updatedAt?: string
    lastSyncedAt?: string
    nextPollAt?: string
    lastError?: string
    stats?: Record<string, unknown>
  }>
  jobs: {
    queued: number
    active: number
    failed: number
  }
}

export function getProviderStatus(): ProviderStatus[] {
  const geminiMode = getGeminiProviderMode()
  const geminiConfigured = isGeminiConfigured()
  const workspaceAuth = getWorkspaceAuthStatus()

  return [
    {
      id: "gemini",
      label: geminiMode === "vertex-ai" ? "Gemini on Vertex AI" : "Gemini",
      configured: geminiConfigured,
      mode: geminiMode,
      detail: geminiConfigured
        ? `Audio and summary provider configured via ${geminiMode}`
        : geminiMode === "vertex-ai"
          ? "Missing Vertex project/location or GOOGLE_APPLICATION_CREDENTIALS"
          : "Missing GOOGLE_GEMINI_API_KEY",
    },
    {
      id: "workspace",
      label: "Google Workspace",
      configured: workspaceAuth.configured,
      mode: workspaceAuth.strategy,
      detail: workspaceAuth.detail,
    },
    {
      id: "realizeos",
      label: "RealizeOS",
      configured: Boolean(process.env.REALIZEOS_API_URL),
      detail: process.env.REALIZEOS_API_URL
        ? "Outbound context endpoint configured"
        : "Missing REALIZEOS_API_URL",
    },
    {
      id: "local-gemma",
      label: "Local Gemma",
      configured: Boolean(process.env.LOCAL_GEMMA_URL),
      detail: process.env.LOCAL_GEMMA_URL
        ? "Local model URL configured"
        : "Optional local model not configured",
    },
  ]
}

export async function getWorkspaceStatus(): Promise<WorkspaceStatus> {
  const sync: WorkspaceStatus["sync"] = []
  const jobs = { queued: 0, active: 0, failed: 0 }

  if (process.env.MEETSUM_STORAGE === "postgres") {
    const pool = getDatabasePool()
    const [syncResult, jobsResult] = await Promise.all([
      pool.query(`
        select source, status, updated_at, last_synced_at, last_error
             , next_poll_at, metadata
        from google_sync_states
        order by updated_at desc
      `),
      pool.query(`
        select status, count(*)::int as count
        from jobs
        group by status
      `),
    ])

    sync.push(
      ...syncResult.rows.map((row) => {
        const value = row as {
          source: string
          status: string
          updated_at: Date | string
          last_synced_at: Date | string | null
          next_poll_at: Date | string | null
          last_error: string | null
          metadata: Record<string, unknown> | null
        }

        return {
          source: value.source,
          status: value.status,
          updatedAt:
            value.updated_at instanceof Date
              ? value.updated_at.toISOString()
              : value.updated_at,
          lastSyncedAt: value.last_synced_at
            ? value.last_synced_at instanceof Date
              ? value.last_synced_at.toISOString()
              : value.last_synced_at
            : undefined,
          nextPollAt: value.next_poll_at
            ? value.next_poll_at instanceof Date
              ? value.next_poll_at.toISOString()
              : value.next_poll_at
            : undefined,
          lastError: value.last_error ?? undefined,
          stats: value.metadata ?? undefined,
        }
      })
    )

    for (const row of jobsResult.rows as Array<{ status: string; count: number }>) {
      if (row.status === "queued") jobs.queued = row.count
      if (row.status === "active") jobs.active = row.count
      if (row.status === "failed") jobs.failed = row.count
    }
  }

  const authStatus = getWorkspaceAuthStatus()
  const userOAuth = await getGoogleWorkspaceOAuthConnectionStatus(
    authStatus.subject
  )
  const keyFileConfigured = authStatus.strategy === "key-file"
  const serviceAccountKeyConfigured = authStatus.strategy === "json-key"

  return {
    google: {
      subject: authStatus.subject,
      serviceAccountEmailConfigured: Boolean(authStatus.serviceAccountEmail),
      serviceAccountKeyConfigured,
      keyFileConfigured,
      userOAuthConnected: userOAuth.connected,
      strategy: authStatus.strategy,
      configured:
        authStatus.strategy === "user-oauth"
          ? userOAuth.connected
          : authStatus.configured,
      detail:
        authStatus.strategy === "user-oauth" && !userOAuth.connected
          ? "Google Workspace OAuth is not connected. Sign in again to grant Workspace permissions."
          : authStatus.detail,
      serviceAccountEmail: authStatus.serviceAccountEmail,
    },
    sync,
    jobs,
  }
}
