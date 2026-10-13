/**
 * Hebrew summary eval runner (M5 D8).
 *
 *   --replay <dir>   score recorded candidate outputs and judge verdicts
 *                    (no keys, no network, deterministic; the CI path)
 *   --live           run candidates through the intelligence pipeline with
 *                    the provider/model forced, then judge every pair
 *   --batch          (live) judge requests use Message Batches (−50%)
 *   --record <dir>   (live) write scrubbed recordings for later replay
 *
 * Without a mode flag the committed recordings are replayed.
 */
import { execFileSync } from "node:child_process"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

import {
  DEFAULT_BASELINE,
  estimateCostUsd,
  evalPriceTable,
  parseModelSpec,
  resolveCandidates,
  resolveJudges,
  type EvalEnv,
  type ModelPrice,
} from "@/lib/ai/llm-eval/candidates"
import {
  DEFAULT_FIXTURES_DIR,
  DEFAULT_MANIFEST,
  loadFixtures,
  loadManifestMeetings,
} from "@/lib/ai/llm-eval/fixtures"
import { runJudge } from "@/lib/ai/llm-eval/judge"
import {
  combineVerdicts,
  decideRoute,
  DECISION_CRITERIA,
  matchActionItems,
  mean,
  percentile,
  tally,
  winRate,
  type RouteDecision,
  type WinTally,
} from "@/lib/ai/llm-eval/metrics"
import {
  EVAL_CRITERIA,
  type CandidateRecording,
  type CandidateRecordingFile,
  type EvalCriterion,
  type EvalMeetingFixture,
  type JudgeRecordingFile,
  type JudgeVerdictRecord,
  type ModelSpec,
  type RecordingManifest,
} from "@/lib/ai/llm-eval/types"

export const DEFAULT_RECORDED_DIR = "tests/fixtures/llm-eval/recorded"

export type LlmEvalOptions = {
  mode: "replay" | "live"
  replayDir: string
  recordDir?: string
  batch: boolean
  fixturesDir: string
  manifest: string
  candidates?: string
  baseline?: string
  judges?: string
  meeting?: string
  outputMd?: string
  outputJson?: string
}

function takeValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1]

  if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value`)
  return value
}

export function parseLlmEvalArgs(argv: string[], env: EvalEnv = process.env): LlmEvalOptions {
  const options: LlmEvalOptions = {
    mode: "replay",
    replayDir: DEFAULT_RECORDED_DIR,
    batch: false,
    fixturesDir: DEFAULT_FIXTURES_DIR,
    manifest: env.MEETSUM_EVAL_MANIFEST || DEFAULT_MANIFEST,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]

    switch (flag) {
      case "--replay":
        options.mode = "replay"
        if (argv[index + 1] && !argv[index + 1].startsWith("--")) options.replayDir = takeValue(argv, index++, flag)
        break
      case "--live":
        options.mode = "live"
        break
      case "--batch":
        options.batch = true
        break
      case "--record":
        options.recordDir = takeValue(argv, index++, flag)
        break
      case "--fixtures":
        options.fixturesDir = takeValue(argv, index++, flag)
        break
      case "--manifest":
        options.manifest = takeValue(argv, index++, flag)
        break
      case "--candidates":
        options.candidates = takeValue(argv, index++, flag)
        break
      case "--baseline":
        options.baseline = parseModelSpec(takeValue(argv, index++, flag)).spec
        break
      case "--judges":
        options.judges = takeValue(argv, index++, flag)
        break
      case "--meeting":
        options.meeting = takeValue(argv, index++, flag)
        break
      case "--output-md":
        options.outputMd = takeValue(argv, index++, flag)
        break
      case "--output-json":
        options.outputJson = takeValue(argv, index++, flag)
        break
      default:
        throw new Error(`Unknown flag ${flag}`)
    }
  }

  if (options.mode === "replay" && (options.recordDir || options.batch)) {
    throw new Error("--record and --batch need --live")
  }

  return options
}

/* ------------------------------------------------------------ report */

export type CandidateMetrics = {
  candidate: ModelSpec
  meetings: number
  errors: number
  recall: number | null
  precision: number | null
  ownerAccuracy: number | null
  dueAccuracy: number | null
  languagePassRate: number | null
  citationValidity: number | null
  chaptersMean: number | null
  latencyP50Ms: number | null
  costPerMeetingUsd: number | null
}

export type CriterionResult = WinTally & { n: number; rate: number; low: number; high: number }

export type PairComparison = {
  challenger: ModelSpec
  baseline: ModelSpec
  judge: ModelSpec
  criteria: Record<EvalCriterion, CriterionResult>
  /** Fraction of comparisons where both orders agreed. */
  orderConsistency: number | null
}

export type LlmEvalReport = {
  generatedAt: string
  gitSha: string
  mode: "replay" | "live"
  /** Every meeting and every recording is synthetic. */
  synthetic: boolean
  batch: boolean
  fixtureSha256: string
  meetings: Array<{ id: string; synthetic: boolean; language: string; segments: number; referenceActionItems: number; tags: string[] }>
  baseline: ModelSpec
  candidates: ModelSpec[]
  judges: ModelSpec[]
  prices: Array<{ model: string; price: ModelPrice | null }>
  perCandidate: CandidateMetrics[]
  comparisons: PairComparison[]
  /** Judges agreeing on the combined verdict (null with one judge). */
  judgeAgreement: number | null
  decisions: RouteDecision[]
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null
}

export function scoreCandidate(
  candidate: ModelSpec,
  meetings: EvalMeetingFixture[],
  outputs: Record<string, CandidateRecording | undefined>,
  prices: Record<string, ModelPrice>
): CandidateMetrics {
  const model = parseModelSpec(candidate).model
  let matched = 0
  let referenceTotal = 0
  let predictedTotal = 0
  let ownerExpected = 0
  let ownerMatched = 0
  let dueExpected = 0
  let dueMatched = 0
  let citations = 0
  let validCitations = 0
  let languageChecked = 0
  let languagePassed = 0
  let errors = 0
  const chapters: number[] = []
  const latencies: number[] = []
  const costs: Array<number | null> = []

  for (const meeting of meetings) {
    const output = outputs[meeting.id]

    if (!output || output.error) {
      errors += 1
      continue
    }

    const match = matchActionItems(output.actionItems, meeting.reference.actionItems)
    const segmentIds = new Set(meeting.segments.map((segment) => segment.id))

    matched += match.matched
    referenceTotal += match.reference
    predictedTotal += match.predicted
    ownerExpected += match.ownerExpected
    ownerMatched += match.ownerMatched
    dueExpected += match.dueExpected
    dueMatched += match.dueMatched
    citations += output.citations.length
    validCitations += output.citations.filter((id) => segmentIds.has(id)).length
    if (output.languageCheck && output.languageCheck !== "skipped") {
      languageChecked += 1
      if (output.languageCheck === "passed") languagePassed += 1
    }
    chapters.push(output.chapterCount)
    latencies.push(output.latencyMs)
    costs.push(
      typeof output.costUsd === "number"
        ? output.costUsd
        : output.usage
          ? estimateCostUsd(model, output.usage, prices)
          : null
    )
  }

  const knownCosts = costs.filter((cost): cost is number => cost !== null)

  return {
    candidate,
    meetings: meetings.length,
    errors,
    recall: ratio(matched, referenceTotal),
    precision: ratio(matched, predictedTotal),
    ownerAccuracy: ratio(ownerMatched, ownerExpected),
    dueAccuracy: ratio(dueMatched, dueExpected),
    languagePassRate: ratio(languagePassed, languageChecked),
    citationValidity: ratio(validCitations, citations),
    chaptersMean: mean(chapters),
    latencyP50Ms: percentile(latencies, 50),
    costPerMeetingUsd: knownCosts.length && knownCosts.length === costs.length ? mean(knownCosts) : null,
  }
}

type CombinedOutcomes = Record<EvalCriterion, Array<ModelSpec | "tie">>

function combinedOutcomes(
  records: JudgeVerdictRecord[],
  challenger: ModelSpec,
  baseline: ModelSpec,
  meetingIds: Set<string>
): { outcomes: CombinedOutcomes; perComparison: Array<{ key: string; criterion: EvalCriterion; outcome: ModelSpec | "tie" }>; consistent: number; total: number } {
  const outcomes = Object.fromEntries(EVAL_CRITERIA.map((criterion) => [criterion, []])) as unknown as CombinedOutcomes
  const perComparison: Array<{ key: string; criterion: EvalCriterion; outcome: ModelSpec | "tie" }> = []
  let consistent = 0
  let total = 0

  for (const meetingId of meetingIds) {
    const ab = records.find((record) => record.meetingId === meetingId && record.a === challenger && record.b === baseline)
    const ba = records.find((record) => record.meetingId === meetingId && record.a === baseline && record.b === challenger)

    if (!ab || !ba) continue

    for (const criterion of EVAL_CRITERIA) {
      const outcome = combineVerdicts(ab.verdicts[criterion]?.winner, ba.verdicts[criterion]?.winner, challenger, baseline)

      if (!outcome) continue
      outcomes[criterion].push(outcome)
      perComparison.push({ key: `${meetingId}:${criterion}`, criterion, outcome })
      total += 1
      const flipped = ab.verdicts[criterion].winner === "A" ? "B" : ab.verdicts[criterion].winner === "B" ? "A" : "tie"

      if (ba.verdicts[criterion].winner === flipped) consistent += 1
    }
  }

  return { outcomes, perComparison, consistent, total }
}

export function buildReport(input: {
  meetings: EvalMeetingFixture[]
  fixtureSha256: string
  baseline: ModelSpec
  candidates: ModelSpec[]
  judges: ModelSpec[]
  outputs: Record<ModelSpec, Record<string, CandidateRecording | undefined>>
  verdicts: Record<ModelSpec, JudgeVerdictRecord[]>
  prices: Record<string, ModelPrice>
  mode: "replay" | "live"
  synthetic: boolean
  batch: boolean
  generatedAt: string
  gitSha: string
}): LlmEvalReport {
  const perCandidate = input.candidates.map((candidate) =>
    scoreCandidate(candidate, input.meetings, input.outputs[candidate] ?? {}, input.prices)
  )
  const meetingIds = new Set(input.meetings.map((meeting) => meeting.id))
  const challengers = input.candidates.filter((candidate) => candidate !== input.baseline)
  const comparisons: PairComparison[] = []
  const decisions: RouteDecision[] = []
  let agreements = 0
  let agreementTotal = 0

  for (const challenger of challengers) {
    const perJudge = input.judges.map((judge) => ({
      judge,
      ...combinedOutcomes(input.verdicts[judge] ?? [], challenger, input.baseline, meetingIds),
    }))

    for (const result of perJudge) {
      comparisons.push({
        challenger,
        baseline: input.baseline,
        judge: result.judge,
        criteria: Object.fromEntries(
          EVAL_CRITERIA.map((criterion) => {
            const counts = tally(result.outcomes[criterion], challenger)

            return [criterion, { ...counts, ...winRate(counts) }]
          })
        ) as Record<EvalCriterion, CriterionResult>,
        orderConsistency: ratio(result.consistent, result.total),
      })
    }

    if (perJudge.length >= 2) {
      const [first, ...rest] = perJudge

      for (const comparison of first.perComparison) {
        for (const other of rest) {
          const match = other.perComparison.find((candidate) => candidate.key === comparison.key)

          if (!match) continue
          agreementTotal += 1
          if (match.outcome === comparison.outcome) agreements += 1
        }
      }
    }

    const quality = perJudge.flatMap((result) => DECISION_CRITERIA.flatMap((criterion) => result.outcomes[criterion]))
    const challengerMetrics = perCandidate.find((metrics) => metrics.candidate === challenger)
    const baselineMetrics = perCandidate.find((metrics) => metrics.candidate === input.baseline)

    decisions.push(
      decideRoute({
        challenger,
        baseline: input.baseline,
        quality: tally(quality, challenger),
        recallChallenger: challengerMetrics?.recall ?? null,
        recallBaseline: baselineMetrics?.recall ?? null,
        costChallenger: challengerMetrics?.costPerMeetingUsd ?? null,
        costBaseline: baselineMetrics?.costPerMeetingUsd ?? null,
      })
    )
  }

  const models = [...new Set([...input.candidates, ...input.judges].map((spec) => parseModelSpec(spec).model))]

  return {
    generatedAt: input.generatedAt,
    gitSha: input.gitSha,
    mode: input.mode,
    synthetic: input.synthetic,
    batch: input.batch,
    fixtureSha256: input.fixtureSha256,
    meetings: input.meetings.map((meeting) => ({
      id: meeting.id,
      synthetic: meeting._synthetic,
      language: meeting.language,
      segments: meeting.segments.length,
      referenceActionItems: meeting.reference.actionItems.length,
      tags: meeting.tags ?? [],
    })),
    baseline: input.baseline,
    candidates: input.candidates,
    judges: input.judges,
    prices: models.map((model) => ({ model, price: input.prices[model] ?? null })),
    perCandidate,
    comparisons,
    judgeAgreement: ratio(agreements, agreementTotal),
    decisions,
  }
}

/* ------------------------------------------------------------ replay */

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T
}

export function specSlug(spec: ModelSpec): string {
  return spec.replace(/[^a-z0-9.-]+/gi, "_")
}

async function loadRecordings(dir: string): Promise<{
  manifest: RecordingManifest
  outputs: Record<ModelSpec, Record<string, CandidateRecording>>
  verdicts: Record<ModelSpec, JudgeVerdictRecord[]>
  synthetic: boolean
}> {
  const manifest = await readJson<RecordingManifest>(path.join(dir, "manifest.json"))
  const outputs: Record<ModelSpec, Record<string, CandidateRecording>> = {}
  const verdicts: Record<ModelSpec, JudgeVerdictRecord[]> = {}
  let synthetic = manifest.synthetic

  for (const file of (await readdir(path.join(dir, "candidates"))).filter((name) => name.endsWith(".json")).sort()) {
    const recording = await readJson<CandidateRecordingFile>(path.join(dir, "candidates", file))

    outputs[recording.candidate] = recording.outputs
    synthetic &&= recording.synthetic === true
  }
  for (const file of (await readdir(path.join(dir, "judgements"))).filter((name) => name.endsWith(".json")).sort()) {
    const recording = await readJson<JudgeRecordingFile>(path.join(dir, "judgements", file))

    verdicts[recording.judge] = recording.records
    synthetic &&= recording.synthetic === true
  }

  return { manifest, outputs, verdicts, synthetic }
}

/* -------------------------------------------------------------- live */

/** Runs one candidate on one meeting (default: Package A's pipeline). */
export type CandidateRunner = (input: {
  candidate: ModelSpec
  meeting: EvalMeetingFixture
}) => Promise<CandidateRecording>

export type JudgeRunner = typeof runJudge

type PipelineIntelligence = {
  overview?: string
  decisions?: string[]
  actionItems?: Array<{ title: string; owner?: string; ownerText?: string; dueOn?: string; dueDate?: string; sourceSegmentId?: string }>
  items?: Array<{ refs?: Array<{ segmentId: string }> }>
  chapters?: Array<{ startSegmentId?: string }>
  generation?: {
    languageCheck?: "passed" | "failed" | "skipped"
    usage?: CandidateRecording["usage"]
    costUsd?: number | null
  }
}

type PipelineModule = {
  runIntelligencePipeline?: (
    meeting: Record<string, unknown>,
    options: { provider: string; model: string; language?: string; templateKey?: string }
  ) => Promise<PipelineIntelligence>
}

/** Package A's pipeline, loaded lazily so the harness builds without it. */
const PIPELINE_MODULE = "@/lib/intelligence/pipeline"

export function toCandidateRecording(
  meeting: EvalMeetingFixture,
  intelligence: PipelineIntelligence,
  latencyMs: number
): CandidateRecording {
  const citations = [
    ...(intelligence.items ?? []).flatMap((item) => (item.refs ?? []).map((ref) => ref.segmentId)),
    ...(intelligence.chapters ?? []).flatMap((chapter) => (chapter.startSegmentId ? [chapter.startSegmentId] : [])),
    ...(intelligence.actionItems ?? []).flatMap((item) => (item.sourceSegmentId ? [item.sourceSegmentId] : [])),
  ]

  return {
    meetingId: meeting.id,
    // Real meetings: no summary prose in recordings (scrubbed).
    overview: meeting._synthetic ? intelligence.overview : undefined,
    decisions: intelligence.decisions ?? [],
    actionItems: (intelligence.actionItems ?? []).map((item) => ({
      title: item.title,
      owner: item.owner ?? item.ownerText,
      dueOn: item.dueOn ?? item.dueDate?.slice(0, 10),
    })),
    citations,
    chapterCount: intelligence.chapters?.length ?? 0,
    languageCheck: intelligence.generation?.languageCheck,
    latencyMs,
    usage: intelligence.generation?.usage,
    costUsd: intelligence.generation?.costUsd ?? null,
  }
}

export const pipelineCandidateRunner: CandidateRunner = async ({ candidate, meeting }) => {
  const { provider, model } = parseModelSpec(candidate)
  const pipeline = (await import(/* @vite-ignore */ PIPELINE_MODULE)) as PipelineModule

  if (!pipeline.runIntelligencePipeline) {
    throw new Error("runIntelligencePipeline is not available (Package A)")
  }

  const started = Date.now()
  const intelligence = await pipeline.runIntelligencePipeline(
    {
      id: meeting.id,
      title: meeting.title,
      source: "upload",
      language: meeting.language === "mixed" ? "he" : meeting.language,
      status: "completed",
      retention: "audio",
      startedAt: meeting.startedAt,
      participants: [],
      workspaceId: "llm-eval",
      transcript: meeting.segments,
    },
    { provider, model }
  )

  return toCandidateRecording(meeting, intelligence, Date.now() - started)
}

export type LlmEvalDeps = {
  env?: EvalEnv
  now?: () => Date
  gitSha?: () => string
  runCandidate?: CandidateRunner
  runJudge?: JudgeRunner
  log?: (message: string) => void
}

function defaultGitSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
  } catch {
    return "unknown"
  }
}

async function writeRecordings(
  dir: string,
  input: {
    baseline: ModelSpec
    candidates: ModelSpec[]
    judges: ModelSpec[]
    outputs: Record<ModelSpec, Record<string, CandidateRecording | undefined>>
    verdicts: Record<ModelSpec, JudgeVerdictRecord[]>
    synthetic: boolean
    now: Date
  }
) {
  await mkdir(path.join(dir, "candidates"), { recursive: true })
  await mkdir(path.join(dir, "judgements"), { recursive: true })

  const manifest: RecordingManifest = {
    synthetic: input.synthetic,
    recordedAt: input.now.toISOString(),
    baseline: input.baseline,
    candidates: input.candidates,
    judges: input.judges,
  }

  await writeFile(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  for (const candidate of input.candidates) {
    const file: CandidateRecordingFile = {
      candidate,
      synthetic: input.synthetic,
      outputs: Object.fromEntries(
        Object.entries(input.outputs[candidate] ?? {}).filter((entry): entry is [string, CandidateRecording] => Boolean(entry[1]))
      ),
    }

    await writeFile(path.join(dir, "candidates", `${specSlug(candidate)}.json`), `${JSON.stringify(file, null, 2)}\n`)
  }
  for (const judge of input.judges) {
    const records = (input.verdicts[judge] ?? []).map((record) =>
      input.synthetic
        ? record
        : {
            ...record,
            // Real meetings: rationales may paraphrase the transcript.
            verdicts: Object.fromEntries(
              Object.entries(record.verdicts).map(([criterion, verdict]) => [criterion, { ...verdict, rationale: "" }])
            ) as JudgeVerdictRecord["verdicts"],
          }
    )
    const file: JudgeRecordingFile = { judge, synthetic: input.synthetic, records }

    await writeFile(path.join(dir, "judgements", `${specSlug(judge)}.json`), `${JSON.stringify(file, null, 2)}\n`)
  }
}

/* -------------------------------------------------------------- main */

export async function runLlmEvaluation(options: LlmEvalOptions, deps: LlmEvalDeps = {}): Promise<LlmEvalReport> {
  const env = deps.env ?? process.env
  const now = (deps.now ?? (() => new Date()))()
  const gitSha = (deps.gitSha ?? defaultGitSha)()
  const log = deps.log ?? (() => undefined)
  const fixtures = await loadFixtures(options.fixturesDir)
  const prices = evalPriceTable(env)
  const select = (meetings: EvalMeetingFixture[]) =>
    options.meeting ? meetings.filter((meeting) => meeting.id === options.meeting) : meetings

  if (options.mode === "replay") {
    const recorded = await loadRecordings(options.replayDir)
    const meetings = select(fixtures.meetings)
    const baseline = options.baseline ?? recorded.manifest.baseline

    return buildReport({
      meetings,
      fixtureSha256: fixtures.sha256,
      baseline,
      candidates: recorded.manifest.candidates,
      judges: recorded.manifest.judges,
      outputs: recorded.outputs,
      verdicts: recorded.verdicts,
      prices,
      mode: "replay",
      synthetic: recorded.synthetic && meetings.every((meeting) => meeting._synthetic),
      batch: false,
      generatedAt: now.toISOString(),
      gitSha,
    })
  }

  const meetings = select([...fixtures.meetings, ...(await loadManifestMeetings(options.manifest))])
  const candidates = resolveCandidates(env, options.candidates)
  const baseline = options.baseline ?? (candidates.includes(DEFAULT_BASELINE) ? DEFAULT_BASELINE : candidates[0])
  const judges = resolveJudges(env, options.judges)
  const runCandidate = deps.runCandidate ?? pipelineCandidateRunner
  const judge = deps.runJudge ?? runJudge
  const outputs: Record<ModelSpec, Record<string, CandidateRecording | undefined>> = {}
  const verdicts: Record<ModelSpec, JudgeVerdictRecord[]> = {}

  if (!candidates.includes(baseline)) throw new Error(`Baseline ${baseline} is not a candidate`)

  for (const candidate of candidates) {
    outputs[candidate] = {}
    for (const meeting of meetings) {
      try {
        log(`candidate ${candidate} · ${meeting.id}`)
        outputs[candidate][meeting.id] = await runCandidate({ candidate, meeting })
      } catch (error) {
        outputs[candidate][meeting.id] = {
          meetingId: meeting.id,
          decisions: [],
          actionItems: [],
          citations: [],
          chapterCount: 0,
          latencyMs: 0,
          error: error instanceof Error ? error.name : "error",
        }
      }
    }
  }

  for (const judgeSpec of judges) {
    verdicts[judgeSpec] = []
    for (const challenger of candidates.filter((candidate) => candidate !== baseline)) {
      for (const meeting of meetings) {
        const a = outputs[challenger][meeting.id]
        const b = outputs[baseline][meeting.id]

        if (!a || !b || a.error || b.error) continue
        for (const [first, second] of [
          [{ spec: challenger, output: a }, { spec: baseline, output: b }],
          [{ spec: baseline, output: b }, { spec: challenger, output: a }],
        ]) {
          try {
            log(`judge ${judgeSpec} · ${meeting.id} · ${first.spec} vs ${second.spec}`)
            verdicts[judgeSpec].push(await judge({ judge: judgeSpec, meeting, a: first, b: second, batch: options.batch }))
          } catch (error) {
            log(`judge failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
    }
  }

  if (options.recordDir) {
    // Live model outputs are real recordings even on synthetic meetings.
    await writeRecordings(options.recordDir, { baseline, candidates, judges, outputs, verdicts, synthetic: false, now })
  }

  return buildReport({
    meetings,
    fixtureSha256: fixtures.sha256,
    baseline,
    candidates,
    judges,
    outputs,
    verdicts,
    prices,
    mode: "live",
    synthetic: false,
    batch: options.batch,
    generatedAt: now.toISOString(),
    gitSha,
  })
}
