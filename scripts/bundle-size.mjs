// First-load JS per app route, gzipped (M9 Step 0, docs/parity/m9.md
// "Bundle budget"; owner: Package D). Run after `next build`.
//
//   node scripts/bundle-size.mjs --budget bundle-budget.json            # ratchet check
//   node scripts/bundle-size.mjs --budget bundle-budget.json --strict   # also fail over budgetKb
//   node scripts/bundle-size.mjs --budget bundle-budget.json --write-baseline
//   node scripts/bundle-size.mjs --json [--next-dir .next] [--no-polyfills]
//
// Method: a route's first-load chunks are `.next/build-manifest.json`
// `rootMainFiles` and `polyfillFiles` plus every `entryJSFiles` list in the
// route's `server/app/<route>/page_client-reference-manifest.js` (root/segment
// layouts, the page, the built-in not-found/global-error entries). Without the
// polyfills this is the chunk set of `.next/diagnostics/route-bundle-stats.json`;
// the polyfill chunk (~38.6 KB gz) is included because the M8 figure of
// 408.7 KB for `/[locale]` included it (Step 0 reproduced 408.8 KB on the M8
// build). `--no-polyfills` drops it. Each chunk is gzipped (level 9) and summed.
//
// Ratchet: a route fails when it grows more than `maxGrowthKb` over its
// recorded `baselineKb`. `budgetKb` is the target; it fails only with --strict
// (M10 C set the targets; the M10 Integration step turns --strict on in CI).
// Lowering a baseline is always allowed (--write-baseline only lowers unless
// --force). The M10 PR also reports `--no-polyfills` numbers: the polyfill
// chunk loads `nomodule`, so modern browsers skip it.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { pathToFileURL } from "node:url"
import vm from "node:vm"
import { gzipSync } from "node:zlib"

const MANIFEST = "page_client-reference-manifest.js"

/** Evaluates a client-reference manifest and returns its entryJSFiles lists. */
export function parseClientReferenceManifest(source) {
  const sandbox = { globalThis: {} }

  sandbox.globalThis = sandbox
  vm.runInNewContext(source, sandbox, { timeout: 1000 })

  const manifests = sandbox.__RSC_MANIFEST ?? {}
  const files = new Set()

  for (const manifest of Object.values(manifests)) {
    for (const list of Object.values(manifest?.entryJSFiles ?? {})) {
      for (const file of list) files.add(String(file).replace(/^\/?_next\//, ""))
    }
  }

  return [...files]
}

/**
 * Route path from a manifest location: `<app>/[locale]/tasks/page_client…` →
 * `/[locale]/tasks`. Route groups (`(home)`) are not part of the URL.
 */
export function routeOf(appDir, manifestPath) {
  const dir = relative(appDir, manifestPath)
    .split(sep)
    .slice(0, -1)
    .filter((part) => !/^\(.+\)$/.test(part))
    .join("/")

  return `/${dir}`.replace(/\/$/, "") || "/"
}

function findManifests(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)

    if (statSync(full).isDirectory()) findManifests(full, out)
    else if (name === MANIFEST) out.push(full)
  }

  return out
}

export function gzipKb(buffer) {
  return gzipSync(buffer, { level: 9 }).length / 1024
}

/** { route: { kb, chunks } } for every app route in a build. */
export function measure(nextDir = ".next", { polyfills = true } = {}) {
  const buildManifest = JSON.parse(readFileSync(join(nextDir, "build-manifest.json"), "utf8"))
  const root = [...(buildManifest.rootMainFiles ?? []), ...(polyfills ? (buildManifest.polyfillFiles ?? []) : [])]
  const appDir = join(nextDir, "server", "app")
  const sizes = new Map()
  const result = {}

  for (const manifestPath of findManifests(appDir)) {
    const route = routeOf(appDir, manifestPath)
    const chunks = [...new Set([...parseClientReferenceManifest(readFileSync(manifestPath, "utf8")), ...root])]
    let kb = 0

    for (const chunk of chunks) {
      if (!sizes.has(chunk)) {
        const file = join(nextDir, chunk)

        sizes.set(chunk, existsSync(file) ? gzipKb(readFileSync(file)) : 0)
      }
      kb += sizes.get(chunk)
    }

    result[route] = { kb: Math.round(kb * 10) / 10, chunks: chunks.length }
  }

  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)))
}

/** Compares measurements with a budget file; returns { failures, warnings }. */
export function compare(measured, budget, { strict = false } = {}) {
  const failures = []
  const warnings = []
  const maxGrowth = typeof budget.maxGrowthKb === "number" ? budget.maxGrowthKb : 5

  for (const [route, entry] of Object.entries(budget.routes ?? {})) {
    const current = measured[route]

    if (!current) {
      warnings.push(`${route}: not found in the build`)
      continue
    }
    if (typeof entry.baselineKb === "number" && current.kb > entry.baselineKb + maxGrowth) {
      failures.push(`${route}: ${current.kb} KB > baseline ${entry.baselineKb} KB + ${maxGrowth} KB`)
    }
    if (typeof entry.budgetKb === "number" && current.kb > entry.budgetKb) {
      ;(strict ? failures : warnings).push(`${route}: ${current.kb} KB over the ${entry.budgetKb} KB budget`)
    }
  }

  return { failures, warnings }
}

function main(argv) {
  const option = (name) => {
    const index = argv.indexOf(name)

    return index === -1 ? undefined : argv[index + 1]
  }
  const nextDir = option("--next-dir") ?? ".next"
  const budgetFile = option("--budget")

  if (!existsSync(join(nextDir, "build-manifest.json"))) {
    console.error(`bundle-size: ${nextDir}/build-manifest.json not found; run \`npm run build\` first.`)
    return 2
  }

  const measured = measure(nextDir, { polyfills: !argv.includes("--no-polyfills") })

  if (argv.includes("--json") || !budgetFile) {
    console.log(JSON.stringify(measured, null, 2))
    if (!budgetFile) return 0
  }

  const budget = JSON.parse(readFileSync(budgetFile, "utf8"))

  if (argv.includes("--write-baseline")) {
    for (const [route, entry] of Object.entries(budget.routes ?? {})) {
      const current = measured[route]?.kb

      if (current === undefined) continue
      if (argv.includes("--force") || typeof entry.baselineKb !== "number" || current < entry.baselineKb) {
        entry.baselineKb = current
      }
    }
    writeFileSync(budgetFile, `${JSON.stringify(budget, null, 2)}\n`)
  }

  const { failures, warnings } = compare(measured, budget, { strict: argv.includes("--strict") })

  for (const [route, entry] of Object.entries(budget.routes ?? {})) {
    const current = measured[route]

    if (current) console.log(`${route.padEnd(28)} ${String(current.kb).padStart(7)} KB gz  (baseline ${entry.baselineKb ?? "-"}, budget ${entry.budgetKb ?? "-"})`)
  }
  for (const line of warnings) console.warn(`bundle-size warning: ${line}`)
  for (const line of failures) console.error(`bundle-size FAILED: ${line}`)

  return failures.length ? 1 : 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main(process.argv.slice(2)))
}
