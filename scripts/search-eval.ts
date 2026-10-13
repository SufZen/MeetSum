/**
 * M6 search retrieval eval (docs/parity/m6.md, B8).
 *
 *   npm run search:eval -- [--engines legacy,lexical,pglite,replay]
 *     [--out docs/parity/search-eval.md] [--corpus <path>]
 *     [--live [--record]]
 *
 * Default (no keys, no network): legacy baseline, the in-memory lexical
 * engine, PGlite (migration 025 + pg_trgm, real SQL legs) and, when
 * `tests/fixtures/search/embeddings.gemini-embedding-001-1536.json` exists,
 * the replay engine (recorded vectors).
 *
 * `--live` (MEETSUM_SEARCH_EVAL_LIVE=1 also works) embeds the corpus with the
 * configured provider (Gemini) and adds a `live` engine; `--record` writes the
 * replay fixture (vectors only, synthetic text). Reports never contain
 * transcript or query text.
 */
import { execFileSync } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import { getEmbeddingProvider } from "@/lib/ai/embeddings"
import { DEFAULT_CORPUS_PATH, loadCorpus } from "@/lib/search/eval/corpus"
import {
  createLegacyEngine,
  createLexicalEngine,
  createPgliteEngine,
  createReplayEngine,
  loadReplayFixture,
  recordReplayFixture,
  replayFixturePath,
  type EvalEngine,
} from "@/lib/search/eval/engines"
import { renderReport, runEngine, type EngineReport } from "@/lib/search/eval/run"
import { hebrewPrefixVariants } from "@/lib/search/hebrew-normalize"

type Args = { engines: string[]; out: string; corpus: string; live: boolean; record: boolean }

function parseArgs(argv: string[]): Args {
  const value = (flag: string) => {
    const index = argv.indexOf(flag)

    return index >= 0 ? argv[index + 1] : undefined
  }

  return {
    engines: (value("--engines") ?? "legacy,lexical,pglite,replay").split(",").map((name) => name.trim()),
    out: value("--out") ?? path.join("docs", "parity", "search-eval.md"),
    corpus: value("--corpus") ?? DEFAULT_CORPUS_PATH,
    live: argv.includes("--live") || process.env.MEETSUM_SEARCH_EVAL_LIVE === "1",
    record: argv.includes("--record"),
  }
}

function gitSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim()
  } catch {
    return "unknown"
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const corpus = loadCorpus(args.corpus)
  const notes: string[] = []
  const engines: EvalEngine[] = []

  if (hebrewPrefixVariants("והתקציב").length === 0) {
    notes.push("Package A's Hebrew normalizer is still the Step 0 stub here: lexical/pglite numbers are not representative.")
  }

  if (args.engines.includes("legacy")) engines.push(createLegacyEngine(corpus))
  if (args.engines.includes("lexical")) engines.push(createLexicalEngine(corpus))
  if (args.engines.includes("pglite")) {
    const pglite = await createPgliteEngine(corpus)

    if (pglite) engines.push(pglite)
    else notes.push("pglite: PGlite could not load on this host (skipped).")
  }

  let fixture = loadReplayFixture()

  if (args.live) {
    const provider = getEmbeddingProvider()

    if (!provider) throw new Error("--live needs a configured embedding provider (MEETSUM_EMBEDDING_PROVIDER / Gemini key)")

    const recorded = await recordReplayFixture(corpus, provider)

    engines.push(createReplayEngine(corpus, recorded, undefined, "live"))
    notes.push(`live: ${recorded.model}:${recorded.dimensions}, recorded ${recorded.recordedAt}.`)
    if (args.record) {
      const file = replayFixturePath({ model: recorded.model, dimensions: recorded.dimensions })

      await writeFile(file, `${JSON.stringify(recorded)}\n`)
      console.log(`Replay fixture written to ${file}`)
      fixture = recorded
    }
  }

  if (args.engines.includes("replay")) {
    if (fixture) engines.push(createReplayEngine(corpus, fixture))
    else notes.push("replay: no recorded embedding fixture yet (run `npm run search:eval -- --live --record` with a Gemini key).")
  }

  const reports: EngineReport[] = []

  for (const engine of engines) {
    reports.push(await runEngine(corpus, engine))
    await engine.close?.()
  }

  console.table(
    Object.fromEntries(
      reports.map((report) => [
        report.engine,
        {
          recall1: Number(report.metrics.overall.recall1.toFixed(3)),
          recall5: Number(report.metrics.overall.recall5.toFixed(3)),
          recall10: Number(report.metrics.overall.recall10.toFixed(3)),
          mrr10: Number(report.metrics.overall.mrr10.toFixed(3)),
        },
      ])
    )
  )

  const markdown = renderReport(reports, {
    date: new Date().toISOString().slice(0, 10),
    sha: gitSha(),
    corpusSha256: corpus.sha256,
    queryCount: corpus.queries.length,
    meetingCount: corpus.meetings.length,
    replayAvailable: Boolean(fixture),
    notes,
  })

  await mkdir(path.dirname(path.resolve(args.out)), { recursive: true })
  await writeFile(args.out, markdown)
  console.log(`Report written to ${args.out}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
