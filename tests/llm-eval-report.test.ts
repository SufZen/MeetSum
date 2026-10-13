import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { renderLlmEvalMarkdown } from "@/lib/ai/llm-eval/report"
import { parseLlmEvalArgs, runLlmEvaluation } from "@/lib/ai/llm-eval/run"
import type { CandidateRecordingFile, EvalMeetingFixture } from "@/lib/ai/llm-eval/types"

const FIXTURES = "tests/fixtures/llm-eval"

const fixedDeps = {
  now: () => new Date("2026-10-13T00:00:00.000Z"),
  gitSha: () => "0000000000000000000000000000000000000000",
  env: {},
}

/** Words (≥ 3 letters) of every transcript, summary and decision in the fixtures. */
function contentWords(): Set<string> {
  const words = new Set<string>()
  const add = (text: string | undefined) =>
    (text ?? "")
      .split(/[^\p{L}\p{N}-]+/u)
      .filter((word) => /\p{L}{3,}/u.test(word))
      .forEach((word) => words.add(word))

  for (const file of readdirSync(path.join(FIXTURES, "meetings"))) {
    const meeting = JSON.parse(readFileSync(path.join(FIXTURES, "meetings", file), "utf8")) as EvalMeetingFixture

    add(meeting.title)
    meeting.segments.forEach((segment) => add(segment.text))
    meeting.reference.actionItems.forEach((item) => add(item.title))
    meeting.reference.decisions.forEach(add)
  }
  for (const file of readdirSync(path.join(FIXTURES, "recorded", "candidates"))) {
    const recording = JSON.parse(readFileSync(path.join(FIXTURES, "recorded", "candidates", file), "utf8")) as CandidateRecordingFile

    Object.values(recording.outputs).forEach((output) => {
      add(output.overview)
      output.decisions.forEach(add)
    })
  }

  return words
}

/** Generic words that are allowed to appear in the report. */
const ALLOWED = new Set(["MVP", "API", "the", "and", "for", "with", "board", "sales", "product", "deal", "numbers", "Sarah"])

describe("renderLlmEvalMarkdown", () => {
  it("renders the synthetic replay report (snapshot) without any transcript or summary text", async () => {
    const report = await runLlmEvaluation(parseLlmEvalArgs([], {}), fixedDeps)
    const markdown = renderLlmEvalMarkdown(report)
    const reportWords = new Set(markdown.split(/[^\p{L}\p{N}-]+/u))
    const leaked = [...contentWords()].filter(
      (word) => reportWords.has(word) && !ALLOWED.has(word) && /[֐-׿]/u.test(word)
    )

    expect(leaked).toEqual([])
    expect(markdown).not.toMatch(/[֐-׿]/u)
    expect(markdown).not.toContain("Synthetic verdict")
    expect(markdown).toContain("SYNTHETIC replay — pending live run")
    expect(markdown).toContain("(SYNTHETIC — not a decision)")
    expect(markdown).toMatchSnapshot()
  })

  it("drops the synthetic banner for live reports", async () => {
    const report = await runLlmEvaluation(parseLlmEvalArgs([], {}), fixedDeps)
    const markdown = renderLlmEvalMarkdown({ ...report, synthetic: false, mode: "live" })

    expect(markdown).not.toContain("SYNTHETIC")
  })

  it("matches the committed docs/parity/llm-eval.md apart from date and SHA", async () => {
    const report = await runLlmEvaluation(parseLlmEvalArgs([], {}), fixedDeps)
    const strip = (text: string) =>
      text
        .replace(/\r\n/g, "\n")
        .replace(/^\| Date \|.*$/m, "| Date |")
        .replace(/^\| Git SHA \|.*$/m, "| Git SHA |")

    expect(strip(readFileSync("docs/parity/llm-eval.md", "utf8"))).toBe(strip(renderLlmEvalMarkdown(report)))
  })
})
