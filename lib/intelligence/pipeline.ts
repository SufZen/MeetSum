/**
 * Core intelligence pipeline (A7): title/tags/type, the core summary
 * (sections, cited items, chapters, action items), citation validation,
 * chapter normalization, action-item enrichment (Package B), the language
 * check with one corrective retry, and IntelligenceV2 assembly.
 *
 * Gemini is the default provider; Claude is used only when configured. With
 * no provider (or when every route fails) the heuristic V2 summary is
 * returned with `generation.provider = "heuristic"` and `fallbackUsed`.
 */
import {
  generateStructured,
  LlmError,
  type LlmErrorKind,
  type LlmProviderId,
  type LlmResult,
  type LlmUsage,
} from "@/lib/ai/llm"
import { getMaxTranscriptTokens, isLanguageCheckEnabled } from "@/lib/ai/llm/config"
import { addUsage, ZERO_USAGE } from "@/lib/ai/llm/pricing"
import { resolveOutputLanguage } from "@/lib/ai/policy"
import {
  buildSummaryInstructions,
  DEFAULT_TIME_ZONE,
  languageRetryInstruction,
} from "@/lib/ai/prompts/summary"
import { buildTitleInstructions } from "@/lib/ai/prompts/title"
import { PROMPT_VERSION } from "@/lib/ai/prompts/version"
import { requestedTemplateKey, selectTemplate } from "@/lib/ai/templates/registry"
import {
  buildSummarySchema,
  MAX_TOPICS,
  titleTagsTypeSchema,
  validateSummaryOutput,
  type SummaryOutput,
  type TitleTagsTypeOutput,
} from "@/lib/ai/templates/schema"
import {
  isReservedSectionKey,
  type ReservedSectionKey,
  type SummaryTemplateDef,
} from "@/lib/ai/templates/types"
import { normalizeTaskTitle } from "@/lib/meetings/action-item-merge"
import type {
  MeetingParticipant,
  MeetingRecord,
  MeetingSpeaker,
  TranscriptSegment,
} from "@/lib/meetings/repository"
import { DEFAULT_APP_SETTINGS, getAppSettings, type AppSettings } from "@/lib/settings/app-settings"
import { enrichActionItems } from "@/lib/tasks/enrich"
import type { TaskMember } from "@/lib/tasks/types"

import { normalizeChapters } from "./chapters"
import { resolveActionItemSource, resolveRefs } from "./citations"
import {
  buildMeetingIntelligence,
  cleanupTranscriptSegments,
  detectMeetingLanguages,
  generateAutoTags,
} from "./index"
import { checkOutputLanguage, summaryProse } from "./language-check"
import { normalizeIntelligence, sha1Hex, summaryItemId } from "./normalize"
import { cleanAiTitle } from "./title"
import {
  formatTranscriptForPrompt,
  transcriptEndMs,
  windowSegments,
  type PromptTranscript,
} from "./transcript-format"
import type {
  IntelligenceGeneration,
  MeetingIntelligence,
  MeetingTag,
  SmartTask,
  SummaryItem,
  SummaryItemKind,
  TemplateSectionOutput,
  TimestampedQuote,
} from "./types"

export type IntelligencePipelineOptions = {
  templateKey?: string
  language?: string
  provider?: LlmProviderId
  model?: string
  jobId?: string
  /** Workspace settings (loaded when omitted). */
  settings?: AppSettings
  /** Workspace members for owner resolution. */
  members?: TaskMember[]
  signal?: AbortSignal
}

export type IntelligenceRunMetadata = {
  provider: string
  model: string
  fallbackUsed: boolean
  fallbackReason?: string
  costUsd: number | null
  usage: LlmUsage
  aiRunIds: string[]
  templateKey: string
  language: string
  languageCheck: "passed" | "failed" | "skipped"
  promptVersion: string
  title?: string
  meetingType?: string
}

export type IntelligencePipelineResult = {
  intelligence: MeetingIntelligence
  run: IntelligenceRunMetadata
}

const TRANSIENT_LLM_KINDS: ReadonlySet<LlmErrorKind> = new Set<LlmErrorKind>(["rate_limit", "timeout", "server"])

/**
 * A transient provider failure (rate limit, timeout, 5xx) while the meeting
 * already has an LLM summary: the job is retried (BullMQ) instead of
 * replacing that summary with the heuristic one.
 */
export class TransientSummaryError extends Error {
  readonly retryable = true

  constructor(readonly kind: LlmErrorKind) {
    super(`Summary provider temporarily unavailable (${kind}); keeping the existing summary`)
    this.name = "TransientSummaryError"
  }
}

const MAX_FALLBACK_REASON_CHARS = 200

/** Single-line, control-free, capped (it lands in logs and ai_runs). */
export function sanitizeFallbackReason(reason: string): string {
  const clean = reason.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim()

  return clean.length > MAX_FALLBACK_REASON_CHARS ? `${clean.slice(0, MAX_FALLBACK_REASON_CHARS - 1)}…` : clean
}

/**
 * Why the heuristic summary was used: error kind and provider only. Error
 * messages are never included (parse and provider errors can carry model
 * output or transcript text).
 */
function fallbackReasonOf(error: unknown): string {
  if (error instanceof LlmError) return sanitizeFallbackReason(`${error.kind} (${error.provider})`)
  return sanitizeFallbackReason(error instanceof Error ? error.name || "Error" : "unknown error")
}

function hasLlmSummary(meeting: MeetingRecord): boolean {
  const provider = meeting.intelligence?.generation?.provider

  return Boolean(provider && provider !== "heuristic")
}

const HEURISTIC_MODEL = "heuristic-v1"
const MAX_ACTION_ITEMS = 25
const MAX_QUOTES = 5

const LIST_KINDS: Array<[keyof Pick<SummaryOutput, "decisions" | "risks" | "openQuestions" | "commitments" | "nextSteps">, SummaryItemKind]> = [
  ["decisions", "decision"],
  ["risks", "risk"],
  ["openQuestions", "open_question"],
  ["commitments", "commitment"],
  ["nextSteps", "next_step"],
]

const RESERVED_KIND: Partial<Record<ReservedSectionKey, SummaryItemKind>> = {
  decisions: "decision",
  risks: "risk",
  open_questions: "open_question",
  commitments: "commitment",
  next_steps: "next_step",
}

const MEETING_TAGS: ReadonlySet<string> = new Set<MeetingTag>([
  "technical",
  "finance",
  "real-estate",
  "sales",
  "operations",
  "legal",
  "product",
  "follow-up-needed",
  "urgent",
  "hebrew",
  "english",
  "portuguese",
  "spanish",
  "italian",
  "mixed-language",
])

async function loadSettings(meeting: MeetingRecord, settings?: AppSettings): Promise<AppSettings> {
  if (settings) return settings
  if (!meeting.workspaceId) return { ...DEFAULT_APP_SETTINGS }

  try {
    return await getAppSettings(meeting.workspaceId)
  } catch {
    return { ...DEFAULT_APP_SETTINGS }
  }
}

function participantNames(meeting: MeetingRecord): string[] {
  const names = [
    ...(meeting.speakers ?? []).map((speaker) => speaker.displayName ?? ""),
    ...(meeting.participantDetails ?? []).map((participant) => participant.name),
    ...meeting.participants,
  ]
    .map((name) => name.trim())
    .filter(Boolean)

  return [...new Set(names)].slice(0, 30)
}

/** Heuristic items get refs when their text is a transcript segment. */
function attachHeuristicRefs(items: SummaryItem[], segments: TranscriptSegment[]): SummaryItem[] {
  const byText = new Map(segments.map((segment) => [segment.text.trim(), segment]))

  return items.map((item) => {
    if (item.refs.length) return item

    const segment = byText.get(item.text.trim())

    return segment ? { ...item, refs: [{ segmentId: segment.id, startMs: segment.startMs }] } : item
  })
}

/** Heuristic V2 (no chapters): the fallback when no LLM route succeeds. */
export function buildHeuristicIntelligence(
  meeting: MeetingRecord,
  options: { language?: string; templateKey?: string; reason?: string } = {}
): MeetingIntelligence {
  const legacy = buildMeetingIntelligence(meeting)
  const normalized = normalizeIntelligence(legacy)
  const segments = cleanupTranscriptSegments(meeting.transcript ?? [])

  return {
    ...normalized,
    version: 2,
    items: attachHeuristicRefs(normalized.items ?? [], segments),
    generation: {
      provider: "heuristic",
      model: HEURISTIC_MODEL,
      promptVersion: PROMPT_VERSION,
      ...(options.templateKey ? { templateKey: options.templateKey } : {}),
      ...(options.language ? { language: options.language } : {}),
      languageCheck: "skipped",
      fallbackUsed: true,
      costUsd: null,
      generatedAt: new Date().toISOString(),
    },
  }
}

function heuristicResult(
  meeting: MeetingRecord,
  options: {
    language: string
    templateKey: string
    reason: string
    usage?: LlmUsage
    aiRunIds?: string[]
    costUsd?: number | null
    title?: TitleTagsTypeOutput
  }
): IntelligencePipelineResult {
  const intelligence = buildHeuristicIntelligence(meeting, options)

  if (options.title) applyTitleOutput(intelligence, options.title)
  if (intelligence.generation) {
    intelligence.generation.usage = options.usage ?? ZERO_USAGE
    intelligence.generation.costUsd = options.costUsd ?? null
    intelligence.generation.aiRunIds = options.aiRunIds ?? []
  }

  return {
    intelligence,
    run: {
      provider: "heuristic",
      model: HEURISTIC_MODEL,
      fallbackUsed: true,
      fallbackReason: sanitizeFallbackReason(options.reason),
      costUsd: options.costUsd ?? null,
      usage: options.usage ?? ZERO_USAGE,
      aiRunIds: options.aiRunIds ?? [],
      templateKey: options.templateKey,
      language: options.language,
      languageCheck: "skipped",
      promptVersion: PROMPT_VERSION,
      ...(intelligence.title ? { title: intelligence.title } : {}),
      ...(intelligence.meetingType ? { meetingType: intelligence.meetingType } : {}),
    },
  }
}

function applyTitleOutput(intelligence: MeetingIntelligence, output: TitleTagsTypeOutput) {
  const title = cleanAiTitle(output.title)
  const topics = output.topics.map((topic) => topic.trim()).filter(Boolean).slice(0, MAX_TOPICS)
  const tags = output.tags.filter((tag) => MEETING_TAGS.has(tag)) as MeetingTag[]

  if (title) intelligence.title = title
  intelligence.meetingType = output.meetingType
  if (topics.length) intelligence.topics = topics
  intelligence.tags = [...new Set([...intelligence.tags, ...tags])]
}

function sumCost(left: number | null, right: number | null): number | null {
  if (left === null && right === null) return null
  return Math.round(((left ?? 0) + (right ?? 0)) * 1e8) / 1e8
}

type Accumulator = { usage: LlmUsage; costUsd: number | null; aiRunIds: string[] }

function accumulate(acc: Accumulator, result: LlmResult<unknown>) {
  acc.usage = addUsage(acc.usage, result.usage)
  acc.costUsd = sumCost(acc.costUsd, result.costUsd)
  if (result.aiRunId) acc.aiRunIds.push(result.aiRunId)
}

/** Merges map-reduce window outputs (deterministic reduce). */
export function mergeSummaryOutputs(outputs: SummaryOutput[]): SummaryOutput {
  const sections = new Map<string, SummaryOutput["sections"][number]>()

  for (const output of outputs) {
    for (const section of output.sections) {
      const existing = sections.get(section.key)

      if (existing) {
        existing.items.push(...section.items)
        if (section.text) existing.text = [existing.text, section.text].filter(Boolean).join("\n\n")
      } else {
        sections.set(section.key, { ...section, items: [...section.items] })
      }
    }
  }

  return {
    overview: outputs.map((output) => output.overview.trim()).filter(Boolean).join("\n\n"),
    sections: [...sections.values()],
    decisions: outputs.flatMap((output) => output.decisions),
    risks: outputs.flatMap((output) => output.risks),
    openQuestions: outputs.flatMap((output) => output.openQuestions),
    commitments: outputs.flatMap((output) => output.commitments),
    nextSteps: outputs.flatMap((output) => output.nextSteps),
    chapters: outputs.flatMap((output) => output.chapters),
    actionItems: outputs.flatMap((output) => output.actionItems),
    followUpDraft: outputs.map((output) => output.followUpDraft?.trim()).find(Boolean),
  }
}

function isIsoDate(value: string | undefined): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)))
}

type EnrichableTask = SmartTask & { ownerIsSourceSpeaker?: boolean; sourceSpeakerId?: string }

/**
 * Stable per-meeting task id: `action_items.id` is a global primary key, so
 * the same title in two meetings (recurring syncs) must not share an id.
 */
export function actionItemIdFor(meetingId: string, key: string): string {
  return `task_${sha1Hex(`${meetingId}\u0000${key}`).slice(0, 16)}`
}

function mapActionItems(
  output: SummaryOutput,
  transcript: PromptTranscript,
  meetingId: string
): EnrichableTask[] {
  const seen = new Set<string>()
  const tasks: EnrichableTask[] = []

  for (const raw of output.actionItems) {
    const title = raw.title.replace(/\s+/g, " ").trim().slice(0, 200)
    const key = normalizeTaskTitle(title)

    if (!title || !key || seen.has(key)) continue
    seen.add(key)

    const source = resolveActionItemSource(raw.sourceRef, raw.sourceQuote, transcript)
    const ownerText = raw.ownerText?.trim() || undefined
    const dueText = raw.dueText?.trim() || undefined
    const task: EnrichableTask = {
      id: actionItemIdFor(meetingId, key),
      title,
      status: "open",
      priority: raw.priority ?? "normal",
      confidence:
        typeof raw.confidence === "number" ? Math.min(1, Math.max(0, raw.confidence)) : 0.75,
      sourceQuote: source.quote,
      sourceStartMs: source.segment?.startMs ?? 0,
      kind: raw.kind ?? "explicit",
      origin: "ai",
      ...(ownerText ? { owner: ownerText, ownerText } : {}),
      ...(dueText ? { dueText } : {}),
      ...(isIsoDate(raw.dueDate) ? { dueDate: raw.dueDate } : {}),
      ...(source.segment ? { sourceSegmentId: source.segment.id } : {}),
      ...(raw.ownerIsSourceSpeaker ? { ownerIsSourceSpeaker: true } : {}),
      ...(source.segment?.speakerId ? { sourceSpeakerId: source.segment.speakerId } : {}),
    }

    tasks.push(task)
    if (tasks.length >= MAX_ACTION_ITEMS) break
  }

  return tasks
}

function stripEnrichmentHints(task: EnrichableTask): SmartTask {
  const { ownerIsSourceSpeaker, sourceSpeakerId, ...rest } = task

  void ownerIsSourceSpeaker
  void sourceSpeakerId
  return rest
}

function buildItems(output: SummaryOutput, transcript: PromptTranscript): SummaryItem[] {
  const items: SummaryItem[] = []
  const seen = new Set<string>()
  const push = (kind: SummaryItemKind, text: string, refs: string[], sectionKey?: string) => {
    const trimmed = text.trim()

    if (!trimmed) return

    const id = summaryItemId(kind, sectionKey ? `${sectionKey}:${trimmed}` : trimmed)

    if (seen.has(id)) return
    seen.add(id)
    items.push({
      id,
      kind,
      text: trimmed,
      refs: resolveRefs(refs, transcript),
      ...(sectionKey ? { sectionKey } : {}),
    })
  }

  for (const [field, kind] of LIST_KINDS) {
    for (const item of output[field]) push(kind, item.text, item.refs)
  }
  for (const section of output.sections) {
    if (isReservedSectionKey(section.key)) continue
    for (const item of section.items) push("section_item", item.text, item.refs, section.key)
  }

  return items
}

function buildSections(
  template: SummaryTemplateDef,
  output: SummaryOutput,
  items: SummaryItem[],
  language: string
): TemplateSectionOutput[] {
  const lang = language === "he" ? "he" : "en"

  return template.sections.map((spec) => {
    const title = spec.title[lang]

    if (isReservedSectionKey(spec.key)) {
      const kind = RESERVED_KIND[spec.key]

      return {
        key: spec.key,
        title,
        ...(spec.key === "overview" && output.overview.trim() ? { text: output.overview.trim() } : {}),
        itemIds: kind ? items.filter((item) => item.kind === kind).map((item) => item.id) : [],
      }
    }

    const text = output.sections
      .filter((section) => section.key === spec.key)
      .map((section) => section.text?.trim())
      .filter(Boolean)
      .join("\n\n")

    return {
      key: spec.key,
      title,
      ...(text ? { text } : {}),
      itemIds: items
        .filter((item) => item.kind === "section_item" && item.sectionKey === spec.key)
        .map((item) => item.id),
    }
  })
}

function buildQuotes(items: SummaryItem[], transcript: PromptTranscript): TimestampedQuote[] {
  const seen = new Set<string>()
  const quotes: TimestampedQuote[] = []

  for (const item of items) {
    for (const ref of item.refs) {
      if (seen.has(ref.segmentId) || quotes.length >= MAX_QUOTES) continue

      const segment = transcript.segments.find((candidate) => candidate.id === ref.segmentId)

      if (!segment) continue
      seen.add(ref.segmentId)
      quotes.push({ segmentId: segment.id, speaker: segment.speaker, startMs: segment.startMs, text: segment.text })
    }
  }

  return quotes.sort((left, right) => left.startMs - right.startMs)
}

function speakersOf(meeting: MeetingRecord): MeetingSpeaker[] {
  return meeting.speakers ?? []
}

function participantsOf(meeting: MeetingRecord): MeetingParticipant[] {
  return meeting.participantDetails ?? []
}

/**
 * Runs the full pipeline for a meeting with a transcript. Never throws for
 * provider failures: those end in the heuristic fallback.
 */
export async function runIntelligencePipeline(
  meeting: MeetingRecord,
  options: IntelligencePipelineOptions = {}
): Promise<IntelligencePipelineResult> {
  const settings = await loadSettings(meeting, options.settings)
  const segments = (meeting.transcript ?? []).filter((segment) => segment.text?.trim())
  const language = resolveOutputLanguage(meeting, settings, options.language)
  const requestedKey = requestedTemplateKey({
    override: options.templateKey,
    meetingTemplateKey: meeting.templateKey,
    workspaceTemplate: settings.summaryTemplate,
  })
  const workspaceId = meeting.workspaceId ?? ""

  if (!segments.length) {
    return heuristicResult(meeting, { language, templateKey: requestedKey, reason: "Meeting has no transcript" })
  }

  const transcript = formatTranscriptForPrompt(segments, speakersOf(meeting))
  const acc: Accumulator = { usage: ZERO_USAGE, costUsd: null, aiRunIds: [] }
  const ctxBase = {
    workspaceId,
    meetingId: meeting.id,
    jobId: options.jobId,
    promptVersion: PROMPT_VERSION,
  }
  const forced = { provider: options.provider, model: options.model, signal: options.signal }
  const maxTokens = getMaxTranscriptTokens()
  const mapReduce = transcript.estimatedTokens > maxTokens
  const participants = participantNames(meeting)

  // 1. Title, tags and meeting type (non-fatal).
  let titleOutput: TitleTagsTypeOutput | undefined

  try {
    const result = await generateStructured({
      task: "title_tags_type",
      ctx: { ...ctxBase, templateKey: requestedKey },
      language,
      sharedContext: mapReduce ? windowedText(transcript, maxTokens) : transcript.text,
      instructions: buildTitleInstructions({ language, currentTitle: meeting.title, participants }),
      schema: { name: "meeting_title_tags_type", zod: titleTagsTypeSchema },
      maxOutputTokens: 1_000,
      provider: forced.provider === "heuristic" ? undefined : forced.provider,
      signal: forced.signal,
    })

    titleOutput = result.value
    accumulate(acc, result as LlmResult<unknown>)
  } catch {
    // The summary still runs; template `auto` falls back by language.
  }

  // 2. Template.
  const template = await selectTemplate(workspaceId, requestedKey, {
    meetingType: titleOutput?.meetingType,
    language,
  })
  const schema = buildSummarySchema(template) as unknown as import("zod").ZodType<SummaryOutput>
  const validate = validateSummaryOutput(template)
  const durationMs = Math.max(meeting.durationMs ?? 0, transcriptEndMs(segments)) - segments[0].startMs
  const baseInstructions = buildSummaryInstructions({
    language,
    template,
    meetingTitle: meeting.title,
    startedAt: meeting.startedAt,
    timeZone: process.env.MEETSUM_DEFAULT_TIMEZONE?.trim() || DEFAULT_TIME_ZONE,
    participants,
    durationMs,
  })
  const ctx = { ...ctxBase, templateKey: template.key }

  const summarize = async (sharedContext: string, instructions: string, languageCheck?: string) => {
    const result = await generateStructured<SummaryOutput>({
      task: "summary",
      ctx,
      language,
      sharedContext,
      instructions,
      schema: { name: "meeting_summary", zod: schema },
      validate,
      maxOutputTokens: 16_000,
      provider: forced.provider === "heuristic" ? undefined : forced.provider,
      model: forced.model,
      signal: forced.signal,
      ...(languageCheck ? { runMetadata: { languageCheck } } : {}),
    })

    accumulate(acc, result as LlmResult<unknown>)
    return result
  }

  // 3. Core summary (map-reduce over 30-minute windows for huge transcripts).
  let output: SummaryOutput
  let lastResult: LlmResult<SummaryOutput>
  let languageCheck: "passed" | "failed" | "skipped" = "skipped"

  try {
    if (forced.provider === "heuristic") throw new LlmError("Heuristic forced", "config", "heuristic", false)

    if (mapReduce) {
      const outputs: SummaryOutput[] = []
      let windowResult: LlmResult<SummaryOutput> | undefined

      for (const window of windowSegments(segments)) {
        const windowTranscript = formatTranscriptForPrompt(window, speakersOf(meeting), {
          aliases: transcript.segmentToAlias,
        })

        windowResult = await summarize(windowTranscript.text, baseInstructions)
        outputs.push(windowResult.value)
      }
      if (!windowResult) throw new LlmError("No transcript windows", "invalid_output", "none", false)
      lastResult = windowResult
      output = mergeSummaryOutputs(outputs)
    } else {
      lastResult = await summarize(transcript.text, baseInstructions)
      output = lastResult.value
    }

    // 4. Language check with one corrective retry (not for map-reduce).
    if (isLanguageCheckEnabled() && (language === "he" || language === "en")) {
      const first = checkOutputLanguage(summaryProse(output), language)

      if (first.passed) {
        languageCheck = "passed"
      } else if (mapReduce) {
        languageCheck = "failed"
      } else {
        const retry = await summarize(
          transcript.text,
          `${languageRetryInstruction(language)}\n\n${baseInstructions}`
        )
        const second = checkOutputLanguage(summaryProse(retry.value), language)

        lastResult = retry
        output = retry.value
        languageCheck = second.passed ? "passed" : "failed"
      }
    }
  } catch (error) {
    // A transient failure must not replace an existing LLM summary with the
    // heuristic one: let the job retry. First-time processing still falls
    // back to the heuristic summary.
    if (error instanceof LlmError && TRANSIENT_LLM_KINDS.has(error.kind) && hasLlmSummary(meeting)) {
      throw new TransientSummaryError(error.kind)
    }

    const reason = fallbackReasonOf(error)

    return heuristicResult(meeting, {
      language,
      templateKey: template.key,
      reason,
      usage: acc.usage,
      costUsd: acc.costUsd,
      aiRunIds: acc.aiRunIds,
      title: titleOutput,
    })
  }

  // 5. Assemble IntelligenceV2.
  const items = buildItems(output, transcript)
  const chapters = normalizeChapters(output.chapters, transcript, {
    endMs: meeting.durationMs ? segments[0].startMs + meeting.durationMs : undefined,
  })
  const enriched = enrichActionItems(mapActionItems(output, transcript, meeting.id), {
    meetingStartedAt: meeting.startedAt,
    timeZone: process.env.MEETSUM_DEFAULT_TIMEZONE?.trim() || DEFAULT_TIME_ZONE,
    speakers: speakersOf(meeting),
    participants: participantsOf(meeting),
    members: options.members ?? [],
  }).map(stripEnrichmentHints)
  const cleaned = cleanupTranscriptSegments(segments)
  const itemTexts = (kind: SummaryItemKind) =>
    items.filter((item) => item.kind === kind).map((item) => item.text)
  // No citation, no claim: the legacy claim arrays (exports, search, prep,
  // follow-up) only carry cited items; the UI shows uncited ones flagged
  // from `items`.
  const citedTexts = (kind: SummaryItemKind) =>
    items.filter((item) => item.kind === kind && item.refs.length > 0).map((item) => item.text)
  const generation: IntelligenceGeneration = {
    provider: lastResult.provider,
    model: lastResult.model,
    promptVersion: PROMPT_VERSION,
    templateKey: template.key,
    language,
    languageCheck,
    fallbackUsed: lastResult.fallbackUsed,
    costUsd: acc.costUsd,
    usage: acc.usage,
    aiRunIds: acc.aiRunIds,
    generatedAt: new Date().toISOString(),
  }
  const quotes = buildQuotes(items, transcript)
  const intelligence: MeetingIntelligence = {
    version: 2,
    overview: output.overview.trim(),
    decisions: citedTexts("decision"),
    actionItems: enriched,
    risks: citedTexts("risk"),
    openQuestions: itemTexts("open_question"),
    commitments: citedTexts("commitment"),
    followUpDraft: output.followUpDraft?.trim() ?? "",
    timestampedQuotes: quotes.length
      ? quotes
      : cleaned.slice(0, MAX_QUOTES).map((segment) => ({
          segmentId: segment.id,
          speaker: segment.speaker,
          startMs: segment.startMs,
          text: segment.text,
        })),
    tags: generateAutoTags(cleaned),
    languageMetadata: detectMeetingLanguages(cleaned),
    items,
    sections: buildSections(template, output, items, language),
    ...(chapters.length ? { chapters } : {}),
    generation,
  }

  if (titleOutput) applyTitleOutput(intelligence, titleOutput)

  return {
    intelligence,
    run: {
      provider: lastResult.provider,
      model: lastResult.model,
      fallbackUsed: lastResult.fallbackUsed,
      ...(lastResult.fallbackUsed
        ? {
            fallbackReason: lastResult.attempts
              .filter((attempt) => !attempt.ok)
              .map((attempt) => `${attempt.provider}: ${attempt.kind ?? "error"}`)
              .join("; "),
          }
        : {}),
      costUsd: acc.costUsd,
      usage: acc.usage,
      aiRunIds: acc.aiRunIds,
      templateKey: template.key,
      language,
      languageCheck,
      promptVersion: PROMPT_VERSION,
      ...(intelligence.title ? { title: intelligence.title } : {}),
      ...(intelligence.meetingType ? { meetingType: intelligence.meetingType } : {}),
    },
  }
}

/** The leading part of a transcript that fits the token budget. */
function windowedText(transcript: PromptTranscript, maxTokens: number): string {
  const maxChars = maxTokens * 3

  return transcript.text.length > maxChars ? transcript.text.slice(0, maxChars) : transcript.text
}
