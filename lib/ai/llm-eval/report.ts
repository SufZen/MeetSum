/**
 * Markdown report for the Hebrew summary eval (M5 D8). Ids, tags, model
 * names and numbers only: the report never contains transcript text,
 * summaries or judge rationales, so it can be committed.
 */
import type { CandidateMetrics, LlmEvalReport } from "@/lib/ai/llm-eval/run"
import { EVAL_CRITERIA } from "@/lib/ai/llm-eval/types"

function pct(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined ? "—" : `${(value * 100).toFixed(digits)}%`
}

function num(value: number | null | undefined, digits = 2): string {
  return value === null || value === undefined ? "—" : value.toFixed(digits)
}

function usd(value: number | null | undefined): string {
  return value === null || value === undefined ? "unknown" : `$${value.toFixed(4)}`
}

function ms(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${Math.round(value)} ms`
}

function table(header: string[], rows: string[][]): string {
  return [
    `| ${header.join(" | ")} |`,
    `|${header.map(() => "---").join("|")}|`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n")
}

function metricsRow(metrics: CandidateMetrics, baseline: string): string[] {
  return [
    `\`${metrics.candidate}\`${metrics.candidate === baseline ? " (baseline)" : ""}`,
    pct(metrics.recall),
    pct(metrics.precision),
    pct(metrics.ownerAccuracy),
    pct(metrics.dueAccuracy),
    pct(metrics.languagePassRate),
    pct(metrics.citationValidity),
    num(metrics.chaptersMean, 1),
    ms(metrics.latencyP50Ms),
    usd(metrics.costPerMeetingUsd),
    String(metrics.errors),
  ]
}

const CRITERION_LABELS: Record<(typeof EVAL_CRITERIA)[number], string> = {
  faithfulness: "Faithfulness",
  coverage: "Coverage",
  hebrew_fluency: "Hebrew fluency",
  action_item_recall: "Action-item recall",
}

export function renderLlmEvalMarkdown(report: LlmEvalReport): string {
  const syntheticMeetings = report.meetings.filter((meeting) => meeting.synthetic).length
  const lines: string[] = ["# Hebrew summary eval (M5 D8)", ""]

  if (report.synthetic) {
    lines.push(
      "> **SYNTHETIC replay — pending live run.** Every meeting is a synthetic fixture and every candidate",
      "> output and judge verdict is a hand-written recording, not a model run. The numbers below exercise",
      "> the harness and the decision rule; they are **not** evidence for a routing decision. Re-run with keys",
      "> (`npm run llm:evaluate -- --live --batch --output-md docs/parity/llm-eval.md`) to replace this file.",
      ""
    )
  } else if (report.mode === "replay") {
    lines.push("> Replay of recorded live model outputs.", "")
  }

  lines.push(
    "## Run",
    "",
    table(
      ["Field", "Value"],
      [
        ["Date", report.generatedAt],
        ["Git SHA", `\`${report.gitSha}\``],
        ["Mode", `${report.mode}${report.batch ? " (judges via Message Batches)" : ""}`],
        ["Fixture SHA-256", `\`${report.fixtureSha256}\``],
        ["Meetings", `${report.meetings.length} (${syntheticMeetings} synthetic, ${report.meetings.length - syntheticMeetings} real)`],
        ["Baseline", `\`${report.baseline}\``],
        ["Candidates", report.candidates.map((spec) => `\`${spec}\``).join(", ")],
        ["Judges", report.judges.map((spec) => `\`${spec}\``).join(", ")],
      ]
    ),
    "",
    "Provider policy: Gemini is the default provider. By default the harness compares `gemini-3.8-flash`",
    "against the cheaper `gemini-3.5-flash-lite` baseline; Claude Haiku and Sonnet are added only when",
    "`ANTHROPIC_API_KEY` is set. The judge is Claude Opus with a Claude key, otherwise a Gemini Pro model",
    "(`MEETSUM_EVAL_JUDGES` overrides).",
    "",
    "## Meetings",
    "",
    table(
      ["Meeting", "Synthetic", "Language", "Segments", "Reference tasks", "Tags"],
      report.meetings.map((meeting) => [
        `\`${meeting.id}\``,
        meeting.synthetic ? "yes" : "no",
        meeting.language,
        String(meeting.segments),
        String(meeting.referenceActionItems),
        meeting.tags.join(", ") || "—",
      ])
    ),
    "",
    "## Prices (USD per million tokens)",
    "",
    table(
      ["Model", "Input", "Output", "Cache read", "Cache write"],
      report.prices.map(({ model, price }) =>
        price
          ? [`\`${model}\``, num(price.input, 3), num(price.output, 3), num(price.cacheRead, 3), num(price.cacheWrite, 3)]
          : [`\`${model}\``, "unset", "unset", "—", "—"]
      )
    ),
    "",
    "Gemini prices come from `GOOGLE_GEMINI_PRICE_*` (summary model) or `MEETSUM_LLM_PRICES_JSON`; unset",
    "prices make cost unknown, and an unknown cost blocks the decision rule.",
    "",
    "## Pairwise win rates",
    "",
    "Each pair is judged in both orders; inconsistent verdicts count as a tie. Win rate counts a tie as",
    "half a win; intervals are Wilson 95%.",
    ""
  )

  if (!report.comparisons.length) lines.push("No comparisons (one candidate or no judge verdicts).", "")

  for (const comparison of report.comparisons) {
    lines.push(
      `### \`${comparison.challenger}\` vs \`${comparison.baseline}\` — judge \`${comparison.judge}\``,
      "",
      table(
        ["Criterion", "Wins / ties / losses", "Win rate", "95% CI", "n"],
        EVAL_CRITERIA.map((criterion) => {
          const result = comparison.criteria[criterion]

          return [
            CRITERION_LABELS[criterion],
            `${result.wins} / ${result.ties} / ${result.losses}`,
            pct(result.rate),
            result.n ? `${pct(result.low)} – ${pct(result.high)}` : "—",
            String(result.n),
          ]
        })
      ),
      "",
      `Order consistency (both orders agree): ${pct(comparison.orderConsistency)}.`,
      ""
    )
  }

  lines.push(
    `Judge agreement: ${report.judgeAgreement === null ? "n/a (one judge)" : pct(report.judgeAgreement)}.`,
    "",
    "## Deterministic metrics",
    "",
    table(
      [
        "Candidate",
        "Task recall",
        "Task precision",
        "Owner match",
        "Due match",
        "Language check",
        "Citation validity",
        "Chapters",
        "Latency p50",
        "Cost / meeting",
        "Errors",
      ],
      report.perCandidate.map((metrics) => metricsRow(metrics, report.baseline))
    ),
    "",
    "Task matching: greedy one-to-one by normalized title-token overlap ≥ 0.5 (Hebrew one-letter",
    "prefixes peeled); owner by full or first name; `dueOn` exact. Citation validity: cited segment ids",
    "that exist in the transcript.",
    "",
    "## Decision",
    "",
    "Rule (docs/parity/m5.md D8, applied to each challenger against the baseline): adopt when the",
    "faithfulness + fluency win rate is ≥ 55% with the CI lower bound > 45%, task recall is non-inferior",
    "(Δ ≥ −0.05) and cost is ≤ 3× the baseline.",
    ""
  )

  if (!report.decisions.length) lines.push("No challenger to decide on.", "")

  for (const decision of report.decisions) {
    const outcome =
      decision.outcome === "adopt"
        ? "adopt the challenger"
        : decision.outcome === "keep_baseline"
          ? "keep the baseline"
          : "insufficient data"

    lines.push(
      `- \`${decision.challenger}\` vs \`${decision.baseline}\`: **${outcome}**${report.synthetic ? " (SYNTHETIC — not a decision)" : ""}`,
      ...decision.reasons.map((reason) => `  - ${reason}`)
    )
  }

  lines.push(
    "",
    "The orchestrator records a live outcome in the router defaults (`lib/ai/llm/router.ts`).",
    "",
    "## Reproduce",
    "",
    "```sh",
    "npm run llm:evaluate                       # replay tests/fixtures/llm-eval/recorded (no keys)",
    "npm run llm:evaluate -- --live --batch     # needs GOOGLE_GEMINI_API_KEY (and ANTHROPIC_API_KEY for Claude)",
    "npm run llm:evaluate -- --live --record tests/fixtures/llm-eval/recorded-live",
    "```",
    ""
  )

  return lines.join("\n")
}
