/**
 * Hebrew summary evaluation harness (M5 D8).
 *
 *   npm run llm:evaluate -- [--replay [dir]] [--live [--batch] [--record <dir>]]
 *     [--candidates a,b] [--baseline spec] [--judges a,b] [--meeting <id>]
 *     [--fixtures <dir>] [--manifest <path>]
 *     [--output-md docs/parity/llm-eval.md] [--output-json <path>]
 *
 * Replay (default) scores the committed recordings without keys or network.
 * Live mode runs each candidate (`<provider>:<model>`) through the
 * intelligence pipeline and judges every challenger/baseline pair in both
 * orders. Gemini is the default provider; Claude candidates are added only
 * when ANTHROPIC_API_KEY is set. Reports never contain transcript text.
 */
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import { renderLlmEvalMarkdown } from "@/lib/ai/llm-eval/report"
import { parseLlmEvalArgs, runLlmEvaluation } from "@/lib/ai/llm-eval/run"

async function write(file: string, content: string) {
  await mkdir(path.dirname(path.resolve(file)), { recursive: true })
  await writeFile(file, content)
  console.log(`Report written to ${file}`)
}

async function main() {
  const options = parseLlmEvalArgs(process.argv.slice(2))
  const report = await runLlmEvaluation(options, { log: (message) => console.log(message) })

  console.table(
    report.perCandidate.map((row) => ({
      candidate: row.candidate,
      recall: row.recall === null ? null : Number(row.recall.toFixed(3)),
      precision: row.precision === null ? null : Number(row.precision.toFixed(3)),
      citations: row.citationValidity === null ? null : Number(row.citationValidity.toFixed(3)),
      costPerMeeting: row.costPerMeetingUsd,
      errors: row.errors,
    }))
  )
  for (const decision of report.decisions) {
    console.log(`${decision.challenger} vs ${decision.baseline}: ${decision.outcome}`)
  }

  if (options.outputJson) await write(options.outputJson, `${JSON.stringify(report, null, 2)}\n`)
  if (options.outputMd) await write(options.outputMd, renderLlmEvalMarkdown(report))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
