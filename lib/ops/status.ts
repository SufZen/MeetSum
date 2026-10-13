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
import { statusMessage, type StatusMessage, type StatusMessageCode } from "@/lib/ops/status-messages"

export type ProviderStatus = {
  id: string
  /** English name, for API compatibility; the UI translates `labelId`. */
  label: string
  /** Key into PROVIDER_LABEL_KEYS (lib/ops/status-messages); else `label` is a proper noun. */
  labelId: string
  configured: boolean
  /** English, for API compatibility; the UI shows `detailMessage`. */
  detail: string
  detailMessage: StatusMessage
  mode?: string
  /** Visible configuration/privacy warning (e.g. Gemini free tier). */
  warning?: string
  /** The warning as codes (the UI translates them). */
  warningMessages?: StatusMessage[]
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
    detailMessage: StatusMessage
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

  const optional = (configuredCode: StatusMessageCode, ok: boolean, env: string) =>
    ok ? statusMessage(configuredCode) : statusMessage("optional_missing_env", { env })
  const anthropicConfigured = llm.providers.some((provider) => provider.id === "anthropic" && provider.configured)
  const llmRoutes = (llm.routes.summary ?? []).map((route) => `${route.provider}:${route.model}`).join(" → ")
  const llmWarningMessages = (llm.warningCodes ?? []).map((code) => statusMessage(code))

  return [
    {
      id: "asr-router",
      label: "Hebrew ASR chain",
      labelId: "asr-router",
      configured: asr.chain.length > 0,
      mode: asr.chain.join(" → ") || "none",
      detail: asr.chain.length
        ? `Hebrew: ${asr.chain.join(" → ")}; other languages: ${asr.nonHebrewChain.join(" → ") || "none"}`
        : "No ASR provider configured (RunPod, Modal, Soniox or local Whisper)",
      detailMessage: asr.chain.length
        ? statusMessage("asr_chain", {
            chain: asr.chain.join(" → "),
            otherChain: asr.nonHebrewChain.join(" → ") || "—",
          })
        : statusMessage("asr_none"),
    },
    {
      id: "runpod-ivrit",
      label: "RunPod Hebrew ASR (ivrit-ai)",
      labelId: "runpod-ivrit",
      configured: Boolean(runpod?.configured),
      mode: runpod?.model,
      detail: runpod?.configured
        ? "Serverless GPU transcription + diarization configured"
        : "Missing RUNPOD_API_KEY / RUNPOD_ASR_ENDPOINT_ID",
      detailMessage: runpod?.configured
        ? statusMessage("runpod_configured")
        : statusMessage("missing_env", { env: "RUNPOD_API_KEY / RUNPOD_ASR_ENDPOINT_ID" }),
    },
    {
      id: "modal-worker",
      label: "Modal Hebrew ASR (asr-worker)",
      labelId: "modal-worker",
      configured: Boolean(modal?.configured),
      mode: modal?.model,
      detail: modal?.configured
        ? "Serverless GPU transcription + diarization on Modal configured"
        : "Optional; missing MODAL_ASR_URL / MODAL_ASR_TOKEN",
      detailMessage: optional("modal_configured", Boolean(modal?.configured), "MODAL_ASR_URL / MODAL_ASR_TOKEN"),
    },
    {
      id: "soniox",
      label: "Soniox",
      labelId: "soniox",
      configured: Boolean(soniox?.configured),
      mode: soniox?.model,
      detail: soniox?.configured
        ? "Async transcription + diarization configured"
        : "Optional; missing SONIOX_API_KEY",
      detailMessage: optional("soniox_configured", Boolean(soniox?.configured), "SONIOX_API_KEY"),
    },
    {
      id: "gemini",
      label: geminiMode === "vertex-ai" ? "Gemini on Vertex AI" : "Gemini",
      labelId: geminiMode === "vertex-ai" ? "gemini-vertex" : "gemini",
      configured: geminiConfigured,
      mode: geminiMode,
      detail: geminiConfigured
        ? `Default LLM (summary ${geminiModels.summary}, fast ${geminiModels.fast}) via ${geminiMode}, ${geminiTier} tier`
        : geminiMode === "vertex-ai"
          ? "Missing Vertex project/location or GOOGLE_APPLICATION_CREDENTIALS"
          : "Missing GOOGLE_GEMINI_API_KEY",
      detailMessage: geminiConfigured
        ? statusMessage("gemini_configured", {
            summary: geminiModels.summary,
            fast: geminiModels.fast,
            mode: geminiMode,
            tier: geminiTier,
          })
        : geminiMode === "vertex-ai"
          ? statusMessage("gemini_vertex_missing", {
              env: "GOOGLE_CLOUD_PROJECT / GOOGLE_CLOUD_LOCATION / GOOGLE_APPLICATION_CREDENTIALS",
            })
          : statusMessage("missing_env", { env: "GOOGLE_GEMINI_API_KEY" }),
      ...(geminiConfigured && geminiFreeWarning
        ? { warning: geminiFreeWarning, warningMessages: [statusMessage("llm_warning_gemini_free_tier")] }
        : {}),
    },
    {
      id: "anthropic",
      label: "Claude (Anthropic)",
      labelId: "anthropic",
      configured: anthropicConfigured,
      mode: anthropicModels.summary,
      detail: anthropicConfigured
        ? `Optional LLM (summary ${anthropicModels.summary}, fast ${anthropicModels.fast}); fallback after Gemini under auto`
        : "Optional; missing ANTHROPIC_API_KEY",
      detailMessage: anthropicConfigured
        ? statusMessage("anthropic_configured", { summary: anthropicModels.summary, fast: anthropicModels.fast })
        : statusMessage("optional_missing_env", { env: "ANTHROPIC_API_KEY" }),
    },
    {
      id: "llm-router",
      label: "LLM routing",
      labelId: "llm-router",
      configured: !llm.heuristicOnly,
      mode: llm.preference,
      detail: llm.heuristicOnly
        ? "No LLM provider configured: summaries use the heuristic fallback"
        : `Summary: ${llmRoutes}`,
      detailMessage: llm.heuristicOnly
        ? statusMessage("llm_heuristic_only")
        : statusMessage("llm_routes", { routes: llmRoutes }),
      ...(llm.warnings?.length ? { warning: llm.warnings.join(" "), warningMessages: llmWarningMessages } : {}),
    },
    {
      id: "local-whisper",
      label: "Local Hebrew ASR",
      labelId: "local-whisper",
      configured: localWhisperConfigured,
      mode: localWhisperConfig.model,
      detail: localWhisperConfigured
        ? `Optional transcription provider configured at ${localWhisperConfig.baseUrl} (${transcriptionMode})`
        : "Optional ivrit-ai faster-whisper server not configured",
      detailMessage: localWhisperConfigured
        ? statusMessage("local_whisper_configured", {
            url: String(localWhisperConfig.baseUrl ?? ""),
            mode: transcriptionMode,
          })
        : statusMessage("local_whisper_missing"),
    },
    {
      id: "workspace",
      label: "Google Workspace",
      labelId: "workspace",
      configured: workspaceAuth.configured,
      mode: workspaceAuth.strategy,
      detail: workspaceAuth.detail,
      detailMessage: workspaceAuth.detailMessage,
    },
    {
      id: "realizeos",
      label: "RealizeOS",
      labelId: "realizeos",
      configured: Boolean(process.env.REALIZEOS_API_URL),
      detail: process.env.REALIZEOS_API_URL
        ? "Outbound context endpoint configured"
        : "Missing REALIZEOS_API_URL",
      detailMessage: process.env.REALIZEOS_API_URL
        ? statusMessage("realizeos_configured")
        : statusMessage("missing_env", { env: "REALIZEOS_API_URL" }),
    },
    {
      id: "local-gemma",
      label: "Local Gemma",
      labelId: "local-gemma",
      configured: Boolean(process.env.LOCAL_GEMMA_URL),
      detail: process.env.LOCAL_GEMMA_URL
        ? "Local model URL configured"
        : "Optional local model not configured",
      detailMessage: process.env.LOCAL_GEMMA_URL
        ? statusMessage("local_gemma_configured")
        : statusMessage("local_gemma_missing"),
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
      detailMessage:
        authStatus.strategy === "user-oauth" && !userOAuth.connected
          ? statusMessage("workspace_oauth_disconnected")
          : authStatus.detailMessage,
      serviceAccountEmail: authStatus.serviceAccountEmail,
    },
    sync,
    jobs,
  }
}
