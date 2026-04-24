import { getDatabasePool } from "@/lib/db/client"

export type ProviderStatus = {
  id: string
  label: string
  configured: boolean
  detail: string
}

export type WorkspaceStatus = {
  google: {
    subject: string
    serviceAccountEmailConfigured: boolean
    serviceAccountKeyConfigured: boolean
    keyFileConfigured: boolean
    strategy: "json-key" | "key-file" | "missing"
  }
  sync: Array<{
    source: string
    status: string
    updatedAt?: string
    lastSyncedAt?: string
    lastError?: string
  }>
  jobs: {
    queued: number
    active: number
    failed: number
  }
}

export function getProviderStatus(): ProviderStatus[] {
  return [
    {
      id: "gemini",
      label: "Gemini",
      configured: Boolean(process.env.GOOGLE_GEMINI_API_KEY),
      detail: process.env.GOOGLE_GEMINI_API_KEY
        ? "Audio and summary provider configured"
        : "Missing GOOGLE_GEMINI_API_KEY",
    },
    {
      id: "workspace",
      label: "Google Workspace",
      configured: Boolean(
        process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL &&
          (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY ||
            process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE)
      ),
      detail:
        process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY ||
        process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE
          ? "Domain-wide delegation credentials configured"
          : "Missing service-account signing material",
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
          last_error: string | null
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
          lastError: value.last_error ?? undefined,
        }
      })
    )

    for (const row of jobsResult.rows as Array<{ status: string; count: number }>) {
      if (row.status === "queued") jobs.queued = row.count
      if (row.status === "active") jobs.active = row.count
      if (row.status === "failed") jobs.failed = row.count
    }
  }

  const keyFileConfigured = Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE)
  const serviceAccountKeyConfigured = Boolean(
    process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
  )

  return {
    google: {
      subject:
        process.env.GOOGLE_WORKSPACE_SUBJECT ??
        process.env.GOOGLE_WORKSPACE_ADMIN_EMAIL ??
        "info@realization.co.il",
      serviceAccountEmailConfigured: Boolean(
        process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ||
          process.env.GOOGLE_WORKSPACE_SERVICE_ACCOUNT
      ),
      serviceAccountKeyConfigured,
      keyFileConfigured,
      strategy: serviceAccountKeyConfigured
        ? "json-key"
        : keyFileConfigured
          ? "key-file"
          : "missing",
    },
    sync,
    jobs,
  }
}
