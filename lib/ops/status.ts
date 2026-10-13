import { getAsrChainConfig, getAsrRouterStatus, type AsrRouterStatus } from "@/lib/ai/asr/router"
import { getDatabasePool } from "@/lib/db/client"
import {
  getGeminiProviderMode,
  getLocalWhisperProviderConfig,
  getTranscriptionProviderMode,
  isGeminiConfigured,
  isLocalWhisperConfigured,
} from "@/lib/ai/providers"
import { getLlmStatus } from "@/lib/ai/llm"
import { getAnthropicModels, getGeminiModels, getGeminiTier } from "@/lib/ai/llm/config"
import { getWorkspaceAuthStatus } from "@/lib/google/auth"
import { getGoogleWorkspaceOAuthConnectionStatus } from "@/lib/google/oauth-tokens"
import { getWorkspaceGoogleSubject } from "@/lib/google/workspace-subject"

export type ProviderStatus = {
  id: string
  label: string
  configured: boolean
  detail: string
  mode?: string
  /** Visible configuration/privacy warning (e.g. Gemini free tier). */
  warning?: string
}

export type WorkspaceStatus = {
  google: {
    /** Resolved Workspace subject, or null when none is configured. */
    subject: string | null
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
  const transcriptionMode = getTranscriptionProviderMode()
  const localWhisperConfig = getLocalWhisperProviderConfig()
  const localWhisperConfigured = isLocalWhisperConfigured()
  const workspaceAuth = getWorkspaceAuthStatus()
  const asr = getAsrChainConfig()
  const asrProvider = (id: string) => asr.providers.find((provider) => provider.id === id)
  const runpod = asrProvider("runpod-ivrit")
  const modal = asrProvider("modal-worker")
  const soniox = asrProvider("soniox")
  const llm = getLlmStatus()
  const geminiModels = getGeminiModels()
  const anthropicModels = getAnthropicModels()
  const geminiTier = getGeminiTier()
  const geminiFreeWarning = llm.warnings?.find((warning) => warning.startsWith("GEMINI_TIER=free"))

  return [
    {
      id: "asr-router",
      label: "Hebrew ASR chain",
      configured: asr.chain.length > 0,
      mode: asr.chain.join(" → ") || "none",
      detail: asr.chain.length
        ? `Hebrew: ${asr.chain.join(" → ")}; other languages: ${asr.nonHebrewChain.join(" → ") || "none"}`
        : "No ASR provider configured (RunPod, Modal, Soniox or local Whisper)",
    },
    {
      id: "runpod-ivrit",
      label: "RunPod Hebrew ASR (ivrit-ai)",
      configured: Boolean(runpod?.configured),
      mode: runpod?.model,
      detail: runpod?.configured
        ? "Serverless GPU transcription + diarization configured"
        : "Missing RUNPOD_API_KEY / RUNPOD_ASR_ENDPOINT_ID",
    },
    {
      id: "modal-worker",
      label: "Modal Hebrew ASR (asr-worker)",
      configured: Boolean(modal?.configured),
      mode: modal?.model,
      detail: modal?.configured
        ? "Serverless GPU transcription + diarization on Modal configured"
        : "Optional; missing MODAL_ASR_URL / MODAL_ASR_TOKEN",
    },
    {
      id: "soniox",
      label: "Soniox",
      configured: Boolean(soniox?.configured),
      mode: soniox?.model,
      detail: soniox?.configured
        ? "Async transcription + diarization configured"
        : "Optional; missing SONIOX_API_KEY",
    },
    {
      id: "gemini",
      label: geminiMode === "vertex-ai" ? "Gemini on Vertex AI" : "Gemini",
      configured: geminiConfigured,
      mode: geminiMode,
      detail: geminiConfigured
        ? `Default LLM (summary ${geminiModels.summary}, fast ${geminiModels.fast}) via ${geminiMode}, ${geminiTier} tier`
        : geminiMode === "vertex-ai"
          ? "Missing Vertex project/location or GOOGLE_APPLICATION_CREDENTIALS"
          : "Missing GOOGLE_GEMINI_API_KEY",
      ...(geminiConfigured && geminiFreeWarning ? { warning: geminiFreeWarning } : {}),
    },
    {
      id: "anthropic",
      label: "Claude (Anthropic)",
      configured: llm.providers.some((provider) => provider.id === "anthropic" && provider.configured),
      mode: anthropicModels.summary,
      detail: llm.providers.some((provider) => provider.id === "anthropic" && provider.configured)
        ? `Optional LLM (summary ${anthropicModels.summary}, fast ${anthropicModels.fast}); fallback after Gemini under auto`
        : "Optional; missing ANTHROPIC_API_KEY",
    },
    {
      id: "llm-router",
      label: "LLM routing",
      configured: !llm.heuristicOnly,
      mode: llm.preference,
      detail: llm.heuristicOnly
        ? "No LLM provider configured: summaries use the heuristic fallback"
        : `Summary: ${(llm.routes.summary ?? []).map((route) => `${route.provider}:${route.model}`).join(" → ")}`,
      ...(llm.warnings?.length ? { warning: llm.warnings.join(" ") } : {}),
    },
    {
      id: "local-whisper",
      label: "Local Hebrew ASR",
      configured: localWhisperConfigured,
      mode: localWhisperConfig.model,
      detail: localWhisperConfigured
        ? `Optional transcription provider configured at ${localWhisperConfig.baseUrl} (${transcriptionMode})`
        : "Optional ivrit-ai faster-whisper server not configured",
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

/**
 * ASR chain with live provider health (5 s timeout each) and circuit
 * breaker state, for the ops dashboard / `GET /api/asr/status`.
 */
export async function getAsrOpsStatus(): Promise<AsrRouterStatus> {
  return getAsrRouterStatus()
}

/**
 * Google + sync + job health of one workspace. Without a workspaceId nothing
 * tenant-specific is read (fail closed): sync states come from the
 * workspace's own Google identities, job counts from its jobs rows.
 */
export async function getWorkspaceStatus(options: {
  sessionEmail?: string | null
  workspaceId: string
  /** The workspace's `google_subject` (ctx.workspace.googleSubject). */
  googleSubject?: string | null
}): Promise<WorkspaceStatus> {
  const sync: WorkspaceStatus["sync"] = []
  const jobs = { queued: 0, active: 0, failed: 0 }
  const workspaceId = options.workspaceId?.trim()

  if (process.env.MEETSUM_STORAGE === "postgres" && workspaceId) {
    const pool = getDatabasePool()
    const [syncResult, jobsResult] = await Promise.all([
      pool.query(
        `
          select s.source, s.status, s.updated_at, s.last_synced_at, s.last_error
               , s.next_poll_at, s.metadata
          from google_sync_states s
          join google_identities gi on gi.id = s.google_identity_id
          where gi.workspace_id = $1
          order by s.updated_at desc
        `,
        [workspaceId]
      ),
      pool.query(
        `
          select status, count(*)::int as count
          from jobs
          where workspace_id = $1
          group by status
        `,
        [workspaceId]
      ),
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

  const workspaceSubject = workspaceId
    ? getWorkspaceGoogleSubject({ id: workspaceId, googleSubject: options.googleSubject })
    : undefined
  const authStatus = getWorkspaceAuthStatus(
    workspaceSubject ?? (options.sessionEmail?.trim().toLowerCase() || null)
  )
  const userOAuth = authStatus.subject
    ? await getGoogleWorkspaceOAuthConnectionStatus(authStatus.subject)
    : { connected: false }
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
