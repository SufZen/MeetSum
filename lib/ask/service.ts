/**
 * AskMeetSum (docs/parity/m6.md, C7; owner: Package C).
 *
 * 1. Daily cap (`MEETSUM_ASK_DAILY_LIMIT_PER_USER`; API keys and
 *    non-persisted asks are counted in memory per principal). The per-minute
 *    `ask` rate limit is applied by the routes.
 * 2. Scope: meeting via the caller's scoped repository (invisible = 404),
 *    room via `listRooms()` (foreign = 404), or every visible meeting.
 * 3. Persist the user message (user principals, `persist !== false`).
 * 4. `thread`, then the context (full transcript, or `retrievePassages` with
 *    the caller's own search context; passages of meetings the caller can't
 *    see are dropped again here, defence in depth), then `context`.
 * 5. Refusal gate (no LLM call), else `streamText` -> provisional `delta`s.
 * 6. Citations and claims are validated, the message finalized, `done`.
 *
 * A client disconnect (`signal`) aborts the LLM call and saves `aborted`
 * with the partial content. Questions and passages are never logged, and
 * questions are not audited.
 */
import { streamText } from "@/lib/ai/llm/stream"
import { describeLlmFailure, LlmError, type LlmStreamEvent } from "@/lib/ai/llm/types"
import type { AuthContext } from "@/lib/auth/authz"
import { buildCitations, createMarkerStream, normalizeMarkers } from "@/lib/ask/citations"
import { enforceCitations } from "@/lib/ask/claims"
import { getAskConfig } from "@/lib/ask/config"
import {
  buildFullTranscriptContext,
  buildRetrievalContext,
  fullTranscriptTokenEstimate,
  type AskContext,
  type HistoryTurn,
} from "@/lib/ask/context"
import { resolveAskLanguage } from "@/lib/ask/language"
import { askMessage, type AskLanguage } from "@/lib/ask/messages"
import { ASK_PROMPT_VERSION } from "@/lib/ask/prompt"
import { createSentinelGate, isSentinelAnswer, shouldRefuseBeforeLlm, stripSentinel } from "@/lib/ask/refusal"
import { stripUnsafeMarkdown } from "@/lib/ask/sanitize"
import { createThreadStore, type MessageFinal, type ThreadStore } from "@/lib/ask/thread-store"
import type { AskJsonResponse, AskRequest, AskScope, AskStreamEvent } from "@/lib/ask/types"
import type { MeetingRecord } from "@/lib/meetings/repository"
import { searchContextFrom } from "@/lib/search/context"
import { retrievePassages } from "@/lib/search/retrieve"
import type { RetrievedPassage } from "@/lib/search/types"
import { getAppSettings } from "@/lib/settings/app-settings"

export type AskDeps = {
  retrieve: typeof retrievePassages
  stream: typeof streamText
  threadStore: (ctx: AuthContext) => ThreadStore | null
  settings: (workspaceId: string) => Promise<{ defaultLocale?: string; llmProviderPreference?: string }>
}

let depsOverride: Partial<AskDeps> | undefined

/** Test seam: replace retrieval, the LLM stream, the store or settings. */
export function setAskDepsForTesting(deps?: Partial<AskDeps>) {
  depsOverride = deps
}

function deps(): AskDeps {
  return {
    retrieve: depsOverride?.retrieve ?? retrievePassages,
    stream: depsOverride?.stream ?? streamText,
    threadStore: depsOverride?.threadStore ?? createThreadStore,
    settings: depsOverride?.settings ?? getAppSettings,
  }
}

/* Daily cap for principals without persisted questions (API keys, persist:false). */
const ephemeralCounts = new Map<string, { day: string; count: number }>()

export function resetAskCountersForTesting() {
  ephemeralCounts.clear()
}

function principalKeyOf(ctx: AuthContext): string {
  return `${ctx.workspace.id}|${ctx.principal === "user" ? `user:${ctx.user?.id}` : `key:${ctx.apiKey?.id}`}`
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function ephemeralCount(key: string): number {
  const entry = ephemeralCounts.get(key)

  return entry && entry.day === today() ? entry.count : 0
}

function bumpEphemeral(key: string) {
  ephemeralCounts.set(key, { day: today(), count: ephemeralCount(key) + 1 })
}

async function loadSettings(workspaceId: string) {
  try {
    return await deps().settings(workspaceId)
  } catch {
    return {}
  }
}

/** The scope target exists and the caller can see it (else 404). */
export async function checkAskScope(
  ctx: AuthContext,
  scope: AskScope
): Promise<{ ok: true; meeting?: MeetingRecord } | { ok: false }> {
  if (scope.kind === "meeting") {
    const meeting = scope.meetingId ? await ctx.meetings.getMeeting(scope.meetingId) : undefined

    return meeting ? { ok: true, meeting } : { ok: false }
  }
  if (scope.kind === "room") {
    const rooms = scope.roomId ? await ctx.meetings.listRooms() : []

    return rooms.some((room) => room.id === scope.roomId) ? { ok: true } : { ok: false }
  }
  return { ok: true }
}

/**
 * Passages the caller may cite: same workspace, the meeting itself in
 * meeting scope, otherwise meetings the caller's scoped repository returns
 * (and, in room scope, that belong to the room).
 */
async function citablePassages(
  ctx: AuthContext,
  scope: AskScope,
  passages: readonly RetrievedPassage[]
): Promise<RetrievedPassage[]> {
  const sameWorkspace = passages.filter((passage) => passage.chunk.workspaceId === ctx.workspace.id)

  if (scope.kind === "meeting") return sameWorkspace.filter((passage) => passage.chunk.meetingId === scope.meetingId)

  const allowed = new Set<string>()

  for (const meetingId of new Set(sameWorkspace.map((passage) => passage.chunk.meetingId))) {
    const meeting = await ctx.meetings.getMeeting(meetingId, { includeTranscript: false })

    if (!meeting) continue
    if (scope.kind === "room" && !(meeting.contexts ?? []).some((room) => room.id === scope.roomId)) continue
    allowed.add(meetingId)
  }
  return sameWorkspace.filter((passage) => allowed.has(passage.chunk.meetingId))
}

type Finalizer = (final: MessageFinal) => Promise<void>

function errorEvent(
  code: Extract<AskStreamEvent, { type: "error" }>["code"],
  language: AskLanguage
): AskStreamEvent {
  const key = {
    rate_limited: "rateLimited",
    daily_limit: "dailyLimit",
    llm_unavailable: "llmUnavailable",
    not_found: "notFound",
    internal: "internal",
  } as const

  return { type: "error", code, message: askMessage(language, key[code]) }
}

function refusedDone(language: AskLanguage, dropped = 0): Extract<AskStreamEvent, { type: "done" }> {
  return {
    type: "done",
    status: "refused",
    content: askMessage(language, "refusal"),
    citations: [],
    grounded: false,
    language,
    droppedUncitedSentences: dropped,
  }
}

function logFailure(stage: string, error: unknown) {
  // Error name/kind only: messages can carry prompt or transcript fragments.
  console.error(`AskMeetSum ${stage} failed:`, describeLlmFailure(error))
}

export async function* askStream(
  ctx: AuthContext,
  req: AskRequest,
  signal?: AbortSignal
): AsyncGenerator<AskStreamEvent> {
  const { retrieve, stream, threadStore } = deps()
  const config = getAskConfig()
  const question = req.question.trim()
  const settings = await loadSettings(ctx.workspace.id)
  const language = resolveAskLanguage(question, { override: req.language, workspaceDefault: settings.defaultLocale })
  const store = req.persist === false ? null : threadStore(ctx)
  const counterKey = principalKeyOf(ctx)
  let finalize: Finalizer = async () => {}

  try {
    // 1. Daily cap.
    const used = (store ? await store.countUserQuestionsToday() : 0) + ephemeralCount(counterKey)

    if (config.dailyLimitPerUser > 0 && used >= config.dailyLimitPerUser) {
      yield errorEvent("daily_limit", language)
      return
    }

    // 2. Scope.
    const scope = await checkAskScope(ctx, req.scope)

    if (!scope.ok) {
      yield errorEvent("not_found", language)
      return
    }

    // 3. Thread and user message.
    let threadId: string | null = null
    let userMessageId: string | null = null
    let assistantMessageId: string | null = null
    let history: HistoryTurn[] = []

    if (store) {
      if (req.threadId) {
        const existing = await store.getThread(req.threadId)

        if (!existing || JSON.stringify(existing.thread.scope) !== JSON.stringify(req.scope)) {
          yield errorEvent("not_found", language)
          return
        }
        threadId = existing.thread.id
        history = await store.getHistory(threadId, config.historyTurns * 2)
      } else {
        const created = await store.createThread({ scope: req.scope, title: question, language })

        if (!created) {
          yield errorEvent("not_found", language)
          return
        }
        threadId = created.id
      }
      userMessageId = await store.appendMessage(threadId, { role: "user", content: question, status: "complete", language })
      assistantMessageId = await store.appendMessage(threadId, { role: "assistant", content: "", status: "streaming", language })

      const messageId = assistantMessageId

      finalize = async (final) => {
        if (!messageId) return
        try {
          await store.finalizeMessage(messageId, final)
        } catch (error) {
          logFailure("finalize", error)
        }
      }
    } else {
      bumpEphemeral(counterKey)
    }

    yield { type: "thread", threadId, userMessageId, assistantMessageId }

    // 4. Context.
    const meeting = scope.meeting
    const transcriptTokens = meeting ? fullTranscriptTokenEstimate(meeting) : 0
    let context: AskContext

    if (meeting && transcriptTokens > 0 && transcriptTokens <= config.fullTranscriptTokens) {
      context = buildFullTranscriptContext({ meeting, language, question, history, historyTurns: config.historyTurns })
    } else {
      const previousQuestion = [...history].reverse().find((turn) => turn.role === "user")?.content
      const result = await retrieve(searchContextFrom(ctx), {
        question,
        ...(previousQuestion ? { previousQuestion } : {}),
        scope: req.scope,
        limit: config.maxPassages,
        budgetTokens: config.contextTokens,
      })
      const passages = await citablePassages(ctx, req.scope, result.passages)

      context = buildRetrievalContext({
        passages,
        searchMode: passages.length ? result.mode : "empty",
        topSimilarity: result.topSimilarity,
        lexicalHits: passages.length ? result.lexicalHits : 0,
        language,
        question,
        history,
        historyTurns: config.historyTurns,
        budgetTokens: config.contextTokens,
        maxPassages: config.maxPassages,
      })
    }

    const base: Omit<MessageFinal, "content" | "status" | "citations" | "grounded"> = {
      retrieval: context.retrieval,
      language,
      promptVersion: ASK_PROMPT_VERSION,
    }

    yield {
      type: "context",
      mode: context.mode,
      searchMode: context.searchMode,
      aliases: context.aliases,
    }

    // 5. Refusal gate: no LLM call, no cost.
    if (
      context.mode === "retrieval" &&
      shouldRefuseBeforeLlm({
        passages: context.retrieval?.chunkIds.length ?? 0,
        topSimilarity: context.retrieval?.topSimilarity ?? null,
        lexicalHits: context.retrieval?.lexicalHits ?? 0,
        minSimilarity: config.minSimilarity,
      })
    ) {
      const done = refusedDone(language)

      await finalize({ ...base, content: done.content, status: "refused", citations: [], grounded: false })
      yield done
      return
    }
    if (signal?.aborted) {
      await finalize({ ...base, content: "", status: "aborted", citations: [], grounded: null })
      return
    }

    const gate = createSentinelGate()
    const markers = createMarkerStream(context.aliases)
    let raw = ""
    let result: Extract<LlmStreamEvent, { type: "done" }> | undefined

    try {
      for await (const event of stream({
        task: "chat",
        ctx: { workspaceId: ctx.workspace.id, ...(meeting ? { meetingId: meeting.id } : {}), promptVersion: ASK_PROMPT_VERSION },
        language,
        system: context.system,
        messages: context.messages,
        maxOutputTokens: config.maxOutputTokens,
        ...(settings.llmProviderPreference === "anthropic" || settings.llmProviderPreference === "gemini"
          ? { preference: settings.llmProviderPreference }
          : {}),
        ...(signal ? { signal } : {}),
        runMetadata: {
          feature: "ask",
          askMode: context.mode,
          searchMode: context.searchMode,
          scope: req.scope.kind,
          passages: context.retrieval?.chunkIds.length ?? null,
        },
      })) {
        if (signal?.aborted) break
        if (event.type === "delta") {
          raw += event.text

          const shown = markers.push(gate.push(event.text))

          if (shown) yield { type: "delta", text: shown }
        } else if (event.type === "done") {
          result = event
        }
      }
    } catch (error) {
      if (!signal?.aborted) {
        logFailure("stream", error)
        await finalize({
          ...base,
          content: "",
          status: "error",
          citations: [],
          grounded: null,
          error: error instanceof LlmError ? `llm_${error.kind}` : "internal",
        })
        yield errorEvent(error instanceof LlmError ? "llm_unavailable" : "internal", language)
        return
      }
    }

    if (signal?.aborted || !result) {
      const partial = normalizeMarkers(stripUnsafeMarkdown(stripSentinel(raw)), context.aliases)

      await finalize({ ...base, content: partial, status: "aborted", citations: buildCitations(partial, context.aliases), grounded: null })
      return
    }

    // 6. Citations and claims.
    const usage = {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.cacheReadTokens,
    }
    const runFields = {
      provider: result.provider,
      model: result.model,
      ...(result.aiRunId ? { aiRunId: result.aiRunId } : {}),
      usage: result.usage,
      costUsd: result.costUsd,
    }
    const meta = { provider: result.provider, model: result.model, usage, costUsd: result.costUsd }

    if (isSentinelAnswer(result.text)) {
      const done = { ...refusedDone(language), ...meta }

      await finalize({ ...base, ...runFields, content: done.content, status: "refused", citations: [], grounded: false })
      yield done
      return
    }

    const cleaned = normalizeMarkers(stripUnsafeMarkdown(stripSentinel(result.text)), context.aliases)
    const claims = enforceCitations(cleaned, context.aliases, { strict: config.strictCitations })
    const citations = buildCitations(claims.content, context.aliases)

    if (!claims.citedSentences || !citations.length) {
      const done = { ...refusedDone(language, claims.droppedUncitedSentences), ...meta }

      await finalize({ ...base, ...runFields, content: done.content, status: "refused", citations: [], grounded: false })
      yield done
      return
    }

    const done: Extract<AskStreamEvent, { type: "done" }> = {
      type: "done",
      status: "complete",
      content: claims.content,
      citations,
      grounded: true,
      language,
      droppedUncitedSentences: claims.droppedUncitedSentences,
      ...meta,
    }

    await finalize({ ...base, ...runFields, content: done.content, status: "complete", citations, grounded: true })
    yield done
  } catch (error) {
    logFailure("request", error)
    await finalize({ retrieval: null, language, content: "", status: "error", citations: [], grounded: null, error: "internal" })
    yield errorEvent("internal", language)
  }
}

export type AskOnceResult = AskJsonResponse & {
  error?: { code: Extract<AskStreamEvent, { type: "error" }>["code"]; message: string }
}

/** JSON mode (MCP, CLI and the compat routes): the aggregated stream. */
export async function askOnce(ctx: AuthContext, req: AskRequest, signal?: AbortSignal): Promise<AskOnceResult> {
  let threadId: string | null = null
  const language = resolveAskLanguage(req.question.trim(), { override: req.language })

  for await (const event of askStream(ctx, req, signal)) {
    if (event.type === "thread") threadId = event.threadId
    if (event.type === "done") {
      return {
        threadId,
        status: event.status,
        content: event.content,
        citations: event.citations,
        grounded: event.grounded,
        language: event.language,
      }
    }
    if (event.type === "error") {
      return {
        threadId,
        status: "error",
        content: event.message,
        citations: [],
        grounded: false,
        language,
        error: { code: event.code, message: event.message },
      }
    }
  }

  return {
    threadId,
    status: "error",
    content: "",
    citations: [],
    grounded: false,
    language,
    error: { code: "internal", message: askMessage(language, "internal") },
  }
}
