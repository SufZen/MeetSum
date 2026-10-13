/**
 * LLM entry point (owner: Package A). Every structured LLM call goes through
 * `generateStructured`: routing (Gemini default, Claude optional), the
 * provider fallback chain, zod validation + repair, cost and `ai_runs`.
 *
 * With no provider configured (no key and no injected client) every call
 * fails fast with `LlmError("config")` and never touches the network.
 */
import { createAnthropicProvider } from "@/lib/ai/llm/anthropic"
import {
  GEMINI_FREE_TIER_WARNING,
  getDefaultLlmPreference,
  getGeminiTier,
  isAnthropicConfigured,
  isGeminiLlmConfigured,
} from "@/lib/ai/llm/config"
import { createGeminiProvider } from "@/lib/ai/llm/gemini"
import {
  candidateRoutes,
  LLM_TASKS,
  resolveRoutes,
  runRoutes,
  type LlmPreference,
  type LlmRoute,
} from "@/lib/ai/llm/router"
import { recordLlmRun } from "@/lib/ai/llm/runs"
import { isStructuredReplayEnabled, replayStructured } from "@/lib/ai/llm/structured-replay"
import type {
  LlmProvider,
  LlmResult,
  LlmStatus,
  LlmStructuredRequest,
  LlmTask,
} from "@/lib/ai/llm/types"
import { getAppSettings } from "@/lib/settings/app-settings"

export * from "@/lib/ai/llm/types"
export { LlmChainError, HEURISTIC_FALLBACK_TASKS } from "@/lib/ai/llm/router"
export type { LlmPreference, LlmRoute } from "@/lib/ai/llm/router"

type Env = Record<string, string | undefined>
type ProviderMap = Record<LlmRoute["provider"], LlmProvider>

/** Deadline of an interactive (user-waiting) LLM request. */
export const INTERACTIVE_LLM_TIMEOUT_MS = 60_000

/**
 * Options for interactive LLM tasks (prep brief, follow-up, sentiment POST):
 * a 60s abort deadline and one transport retry, so a stuck provider never
 * holds a request (or the caller's budget) for the SDK's default minutes.
 */
export function interactiveLlmOptions(): { signal: AbortSignal; maxRetries: number } {
  return { signal: AbortSignal.timeout(INTERACTIVE_LLM_TIMEOUT_MS), maxRetries: 1 }
}

let overrides: Partial<ProviderMap> | undefined
let defaults: ProviderMap | undefined

/** Test seam: inject providers (e.g. over mocked SDK clients); `undefined` resets. */
export function setLlmProvidersForTesting(providers?: Partial<ProviderMap>) {
  overrides = providers
  defaults = undefined
}

function getProviders(): ProviderMap {
  defaults ??= { anthropic: createAnthropicProvider(), gemini: createGeminiProvider() }

  return {
    anthropic: overrides?.anthropic ?? defaults.anthropic,
    gemini: overrides?.gemini ?? defaults.gemini,
  }
}

let freeTierWarned = false

function warnFreeTierOnce() {
  if (freeTierWarned) return
  freeTierWarned = true
  console.warn(GEMINI_FREE_TIER_WARNING)
}

async function workspacePreference(workspaceId: string): Promise<LlmPreference> {
  try {
    const settings = await getAppSettings(workspaceId)
    const preference = settings.llmProviderPreference

    if (preference === "anthropic" || preference === "gemini") return preference
  } catch {
    // Settings unavailable (e.g. no database): fall back to the env default.
  }

  return getDefaultLlmPreference()
}

export async function generateStructured<T>(req: LlmStructuredRequest<T>): Promise<LlmResult<T>> {
  const providers = getProviders()
  const preference = req.preference ?? (await workspacePreference(req.ctx.workspaceId))
  const routes = resolveRoutes(req.task, {
    preference,
    provider: req.provider,
    model: req.model,
    isConfigured: (provider) => providers[provider].isConfigured(),
  })
  const record = req.record !== false

  try {
    // M10 A: e2e structured replay (MEETSUM_LLM_REPLAY_DIR; refused in production).
    const result = isStructuredReplayEnabled() ? await replayStructured(req) : await runRoutes(req, routes, providers)
    const freeTier = result.provider === "gemini" && getGeminiTier() === "free"

    if (freeTier) warnFreeTierOnce()

    const aiRunId = record
      ? await recordLlmRun(req.ctx, req.task, result, {
          batch: req.batch,
          metadata: { ...req.runMetadata, ...(freeTier ? { geminiTier: "free" } : {}) },
        })
      : undefined

    return { ...result, ...(aiRunId ? { aiRunId } : {}) }
  } catch (error) {
    if (record) {
      await recordLlmRun(req.ctx, req.task, error, { batch: req.batch, metadata: req.runMetadata })
    }
    throw error
  }
}

/** Configured providers and the resolved routes (no network). */
export function getLlmStatus(
  options: { preference?: LlmPreference; env?: Env } = {}
): LlmStatus {
  const env = options.env ?? process.env
  const preference = options.preference ?? getDefaultLlmPreference(env)
  const configured = {
    gemini: overrides?.gemini ? overrides.gemini.isConfigured(env) : isGeminiLlmConfigured(env),
    anthropic: overrides?.anthropic
      ? overrides.anthropic.isConfigured(env)
      : isAnthropicConfigured(env),
  }
  const geminiTier = getGeminiTier(env)
  const warnings: string[] = []
  const warningCodes: NonNullable<LlmStatus["warningCodes"]> = []
  const routes: LlmStatus["routes"] = {}

  for (const task of LLM_TASKS) {
    routes[task as LlmTask] = candidateRoutes(task, preference, env).filter(
      (route) => configured[route.provider]
    )
  }

  if (!configured.gemini && !configured.anthropic) {
    warnings.push(
      "No LLM provider configured: summaries use the heuristic fallback (set GOOGLE_GEMINI_API_KEY, optionally ANTHROPIC_API_KEY)"
    )
    warningCodes.push("llm_warning_no_provider")
  }
  if (configured.gemini && geminiTier === "free") {
    warnings.push(GEMINI_FREE_TIER_WARNING)
    warningCodes.push("llm_warning_gemini_free_tier")
  }
  if (preference === "anthropic" && !configured.anthropic) {
    warnings.push("LLM preference is anthropic but ANTHROPIC_API_KEY is not set; using Gemini")
    warningCodes.push("llm_warning_anthropic_missing")
  }

  return {
    providers: [
      { id: "gemini", configured: configured.gemini },
      { id: "anthropic", configured: configured.anthropic },
      { id: "heuristic", configured: true },
    ],
    routes,
    preference,
    geminiTier,
    warnings,
    warningCodes,
    heuristicOnly: !configured.gemini && !configured.anthropic,
  }
}
