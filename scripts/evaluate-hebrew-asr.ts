/**
 * Hebrew ASR evaluation harness (M3 C4).
 *
 *   npm run asr:evaluate -- [--manifest <path>] [--providers a,b] [--sample <id>]
 *     [--collar <ms>] [--output-json <path>] [--output-md docs/parity/asr-eval.md]
 *     [--replay <dir>]
 *
 * Live mode transcribes every manifest sample with each provider through the
 * ASR router (one-provider chain, no fallback). `--replay <dir>` scores
 * recorded results (`<dir>/<sampleId>.<provider>.json`) without keys or
 * network; `<dir>/manifest.json` is used when present. Metrics: WER, CER,
 * Latin-token WER, glossary term recall, DER, RTF, cost per audio hour.
 * Reports never contain transcript text.
 */
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import { renderAsrEvalMarkdown } from "@/lib/ai/asr-eval/report"
import { parseAsrEvalArgs, runAsrEvaluation } from "@/lib/ai/asr-eval/run"

async function write(file: string, content: string) {
  await mkdir(path.dirname(path.resolve(file)), { recursive: true })
  await writeFile(file, content)
  console.log(`Report written to ${file}`)
}

async function main() {
  const options = parseAsrEvalArgs(process.argv.slice(2))
  const report = await runAsrEvaluation(options)

  console.table(
    report.samples.map((row) => ({
      sample: row.sampleId,
      provider: row.provider,
      wer: row.wer === null ? null : Number(row.wer.toFixed(4)),
      cer: row.cer === null ? null : Number(row.cer.toFixed(4)),
      der: row.der === null ? null : Number(row.der.toFixed(4)),
      rtf: row.rtf === null ? null : Number(row.rtf.toFixed(3)),
      error: row.error ?? "",
    }))
  )

  if (options.outputJson) await write(options.outputJson, `${JSON.stringify(report, null, 2)}\n`)
  if (options.outputMd) await write(options.outputMd, renderAsrEvalMarkdown(report))
  if (!options.outputJson && !options.outputMd) {
    console.log(`\n${JSON.stringify(report.aggregates, null, 2)}`)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
