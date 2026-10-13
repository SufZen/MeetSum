/**
 * Pairwise LLM judge (M5 D8). The judge sees the transcript (for
 * faithfulness) and two summaries labelled A and B, and returns a winner per
 * criterion with a ≤ 2-sentence rationale. Each pair is judged in both
 * orders by the caller.
 */
import { z } from "zod"

import { generateStructured } from "@/lib/ai/llm"
import { parseModelSpec } from "@/lib/ai/llm-eval/candidates"
import {
  EVAL_CRITERIA,
  type CandidateRecording,
  type EvalMeetingFixture,
  type JudgeVerdictRecord,
  type ModelSpec,
} from "@/lib/ai/llm-eval/types"

export const JUDGE_PROMPT_VERSION = "m5.judge.1"

const verdictSchema = z.object({ winner: z.enum(["A", "B", "tie"]), rationale: z.string() })

export const judgeSchema = z.object({
  faithfulness: verdictSchema,
  coverage: verdictSchema,
  hebrew_fluency: verdictSchema,
  action_item_recall: verdictSchema,
})

export type JudgeOutput = z.infer<typeof judgeSchema>

function timecode(ms: number): string {
  const seconds = Math.floor(ms / 1000)

  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
}

export function judgeTranscript(meeting: EvalMeetingFixture): string {
  return meeting.segments
    .map((segment) => `[${segment.id} ${timecode(segment.startMs)} ${segment.speaker}] ${segment.text}`)
    .join("\n")
}

function renderSummary(output: CandidateRecording): string {
  const lines = [
    `Overview: ${output.overview ?? "—"}`,
    "Decisions:",
    ...(output.decisions.length ? output.decisions.map((decision) => `- ${decision}`) : ["- —"]),
    "Action items:",
    ...(output.actionItems.length
      ? output.actionItems.map(
          (item) => `- ${item.title}${item.owner ? ` — ${item.owner}` : ""}${item.dueOn ? ` — ${item.dueOn}` : ""}`
        )
      : ["- —"]),
  ]

  return lines.join("\n")
}

export function judgeInstructions(a: CandidateRecording, b: CandidateRecording): string {
  return [
    "You are judging two summaries (A and B) of the same Hebrew or code-switched business meeting.",
    "For each criterion pick A, B or tie, with a rationale of at most two sentences. Do not quote the transcript.",
    "- faithfulness: every claim is supported by the transcript; invented facts lose.",
    "- coverage: the important topics, decisions and numbers are captured.",
    "- hebrew_fluency: natural Israeli business Hebrew; gender-neutral when gender is unknown; English tech terms kept in Latin script; dates as DD.MM.YYYY.",
    "- action_item_recall: the action items said in the meeting are present with the right owner and due date.",
    "Order does not matter; prefer tie over a guess.",
    "",
    "<summary_a>",
    renderSummary(a),
    "</summary_a>",
    "<summary_b>",
    renderSummary(b),
    "</summary_b>",
  ].join("\n")
}

/** One live judge call; the transcript is the cached shared context. */
export async function runJudge(input: {
  judge: ModelSpec
  meeting: EvalMeetingFixture
  a: { spec: ModelSpec; output: CandidateRecording }
  b: { spec: ModelSpec; output: CandidateRecording }
  batch?: boolean
}): Promise<JudgeVerdictRecord> {
  const judge = parseModelSpec(input.judge)
  const result = await generateStructured<JudgeOutput>({
    task: "judge",
    ctx: { workspaceId: "llm-eval", meetingId: input.meeting.id, promptVersion: JUDGE_PROMPT_VERSION },
    language: "en",
    sharedContext: `<transcript>\n${judgeTranscript(input.meeting)}\n</transcript>`,
    instructions: judgeInstructions(input.a.output, input.b.output),
    schema: { name: "pairwise_judgement", zod: judgeSchema },
    effort: "high",
    provider: judge.provider,
    model: judge.model,
    batch: input.batch,
  })
  const verdicts = Object.fromEntries(
    EVAL_CRITERIA.map((criterion) => [
      criterion,
      {
        winner: result.value[criterion].winner,
        rationale: result.value[criterion].rationale.split(/(?<=[.!?])\s+/).slice(0, 2).join(" "),
      },
    ])
  ) as JudgeVerdictRecord["verdicts"]

  return { meetingId: input.meeting.id, a: input.a.spec, b: input.b.spec, verdicts }
}
