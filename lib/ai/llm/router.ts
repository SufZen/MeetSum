/**
 * Model routing and the provider fallback chain (A4).
 *
 * Cost decision (M5): Gemini is the default. `auto` routes every task to
 * Gemini first (summary model for long-form tasks, the cheap flash-lite model
 * for title/tags/type, extraction and sentiment) and uses Claude only as the
 * fallback, and only when `ANTHROPIC_API_KEY` is set. `anthropic` puts Claude
 * first. The eval judge is Claude Opus. `MEETSUM_LLM_ROUTES` (JSON, task ->
 * "provider:model" or a list of them) overrides the table.
 *
 * Chain: primary, then the other configured provider. The heuristic fallback
 * for `summary` is applied by the intelligence pipeline when the chain fails.
 */
import {
  getAnthropicModels,
  getGeminiModels,
} from "@/lib/ai/llm/config"
import {
  LlmError,
  type LlmAttempt,
  type LlmErrorKind,
  type LlmProvider,
  type LlmProviderId,
  type LlmResult,
  type LlmStructuredRequest,
  type LlmTask,
} from "@/lib/ai/llm/types"

type Env = Record<string, string | undefined>

export type LlmPreference = "auto" | "anthropic" | "gemini"

export type LlmRoute = { provider: Exclude<LlmProviderId, "heuristic">; model: string }

export const LLM_TASKS: readonly LlmTask[] = [
  "summary",
  "title_tags_type",
  "extraction",
  "sentiment",
  "prep_brief",
  "follow_up",
  "chat",
  "judge",
]

/** Tasks whose chain may end in the heuristic summary (`fallbackUsed`). */
export const HEURISTIC_FALLBACK_TASKS: ReadonlySet<LlmTask> = new Set<LlmTask>(["summary"])

const FAST_TASKS: ReadonlySet<LlmTask> = new Set<LlmTask>([
  "title_tags_type",
  "extraction",
  "sentiment",
])

/** Model a provider uses for a task, or undefined when it has no route. */
export function modelFor(
  provider: LlmRoute["provider"],
  task: LlmTask,
  env: Env = process.env
): string | undefined {
  if (provider === "anthropic") {
    const models = getAnthropicModels(env)

    if (task === "judge") return models.judge
    return FAST_TASKS.has(task) ? models.fast : models.summary
  }

  const models = getGeminiModels(env)

  if (task === "judge") return undefined
  return FAST_TASKS.has(task) ? models.fast : models.summary
}

function providerOfModel(model: string): LlmRoute["provider"] | undefined {
  if (/^claude/i.test(model)) return "anthropic"
  if (/^gemini/i.test(model)) return "gemini"
  return undefined
}

function parseRouteEntry(entry: unknown): LlmRoute | undefined {
  if (typeof entry !== "string") return undefined

  const [provider, ...rest] = entry.split(":")
  const model = rest.join(":").trim()

  if ((provider === "anthropic" || provider === "gemini") && model) return { provider, model }
  return undefined
}

/** `MEETSUM_LLM_ROUTES` override for a task (invalid JSON is ignored). */
export function routeOverride(task: LlmTask, env: Env = process.env): LlmRoute[] | undefined {
  const raw = env.MEETSUM_LLM_ROUTES?.trim()

  if (!raw) return undefined

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const value = parsed?.[task]
    const entries = Array.isArray(value) ? value : value === undefined ? [] : [value]
    const routes = entries.map(parseRouteEntry).filter((route): route is LlmRoute => Boolean(route))

    return routes.length ? routes : undefined
  } catch {
    return undefined
  }
}

/** Ordered candidate routes before filtering by configuration. */
export function candidateRoutes(
  task: LlmTask,
  preference: LlmPreference,
  env: Env = process.env
): LlmRoute[] {
  const override = routeOverride(task, env)

  if (override) return override

  const order: LlmRoute["provider"][] =
    task === "judge"
      ? ["anthropic"]
      : preference === "anthropic"
        ? ["anthropic", "gemini"]
        : ["gemini", "anthropic"]

  return order.flatMap((provider) => {
    const model = modelFor(provider, task, env)

    return model ? [{ provider, model }] : []
  })
}

export type ResolveRoutesOptions = {
  preference?: LlmPreference
  env?: Env
  isConfigured: (provider: LlmRoute["provider"]) => boolean
  /** Forced provider/model (eval). */
  provider?: LlmProviderId
  model?: string
}

/** Routes to try, in order, restricted to configured providers. */
export function resolveRoutes(task: LlmTask, options: ResolveRoutesOptions): LlmRoute[] {
  const env = options.env ?? process.env
  const forcedProvider =
    options.provider && options.provider !== "heuristic"
      ? options.provider
      : options.model
        ? providerOfModel(options.model)
        : undefined

  if (options.provider === "heuristic") return []
  if (forcedProvider) {
    const model =
      options.model ??
      modelFor(forcedProvider, task, env) ??
      (forcedProvider === "gemini" ? getGeminiModels(env).summary : getAnthropicModels(env).summary)

    return options.isConfigured(forcedProvider) ? [{ provider: forcedProvider, model }] : []
  }

  return candidateRoutes(task, options.preference ?? "auto", env).filter((route) =>
    options.isConfigured(route.provider)
  )
}

/** The chain failed on every route; carries every attempt for `ai_runs`. */
export class LlmChainError extends LlmError {
  constructor(
    message: string,
    kind: LlmErrorKind,
    provider: string,
    readonly attempts: LlmAttempt[]
  ) {
    super(message, kind, provider, false)
    this.name = "LlmChainError"
  }
}

/** Runs the routes in order until one succeeds. */
export async function runRoutes<T>(
  req: LlmStructuredRequest<T>,
  routes: LlmRoute[],
  providers: Record<LlmRoute["provider"], LlmProvider>
): Promise<Omit<LlmResult<T>, "aiRunId">> {
  const attempts: LlmAttempt[] = []
  let lastError: LlmError | undefined

  if (!routes.length) {
    throw new LlmChainError(
      `No LLM provider is configured for task ${req.task} (set GOOGLE_GEMINI_API_KEY or ANTHROPIC_API_KEY)`,
      "config",
      "none",
      []
    )
  }

  for (const route of routes) {
    const startedAt = Date.now()

    try {
      const result = await providers[route.provider].generate(req, route.model)

      attempts.push({
        provider: route.provider,
        model: result.model,
        ok: true,
        latencyMs: result.latencyMs,
      })
      return { ...result, attempts, fallbackUsed: attempts.length > 1 }
    } catch (error) {
      const llmError =
        error instanceof LlmError
          ? error
          : new LlmError(error instanceof Error ? error.message : String(error), "unknown", route.provider, false)

      lastError = llmError
      attempts.push({
        provider: route.provider,
        model: route.model,
        ok: false,
        kind: llmError.kind,
        error: llmError.message.slice(0, 500),
        latencyMs: Date.now() - startedAt,
      })
      if (req.signal?.aborted) break
    }
  }

  throw new LlmChainError(
    `All LLM routes failed for ${req.task}: ${lastError?.message ?? "unknown error"}`,
    lastError?.kind ?? "unknown",
    lastError?.provider ?? "none",
    attempts
  )
}
