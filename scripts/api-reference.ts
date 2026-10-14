/**
 * npm run api:reference            -> rewrites the generated route index in docs/api-reference.md
 * npm run api:reference -- --check -> exits 1 when the index is stale or a handler has no section
 * npm run api:reference -- --list  -> prints the inventory (method, path, guard) as TSV
 *
 * The route list comes from tests/helpers/api-routes.ts (the route-coverage
 * discovery); guards are read from each handler's withAuthz / withSession /
 * withPublicRoute call. The per-area prose above the index is hand-written,
 * and tests/api-reference-complete.test.ts fails when a handler lacks a
 * `### \`METHOD /api/...\`` section (docs/parity/m10.md, D3).
 */
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

// tests/helpers/api-routes.ts (frozen, written for vitest's CJS-style
// globals) resolves app/api from __dirname, which ESM scripts lack.
;(globalThis as { __dirname?: string }).__dirname ??= path.join(process.cwd(), "tests", "helpers")

const { describeGuard, renderRouteIndex, routeInventory, undocumentedHandlers, withRouteIndex } = await import("../tests/helpers/api-reference")

const docPath = path.join(process.cwd(), "docs", "api-reference.md")
const entries = routeInventory()

if (process.argv.includes("--list")) {
  for (const entry of entries) {
    for (const { method, guard } of entry.methods) {
      const described = describeGuard(guard)

      console.log([method, entry.path, described.guard, described.apiKey].join("\t"))
    }
  }
  process.exit(0)
}

const doc = readFileSync(docPath, "utf8").replace(/\r\n/g, "\n")
const next = withRouteIndex(doc, renderRouteIndex(entries))
const missing = undocumentedHandlers(next, entries)

if (process.argv.includes("--check")) {
  let failed = false

  if (next !== doc) {
    console.error("docs/api-reference.md: the generated route index is stale; run `npm run api:reference`")
    failed = true
  }
  if (missing.length > 0) {
    console.error(`docs/api-reference.md: ${missing.length} handler(s) without a section:\n  ${missing.join("\n  ")}`)
    failed = true
  }
  if (failed) process.exit(1)
  console.log(`docs/api-reference.md is complete (${entries.length} route files)`)
} else {
  writeFileSync(docPath, next)
  console.log(`docs/api-reference.md: route index updated (${entries.length} route files)`)
  if (missing.length > 0) console.warn(`${missing.length} handler(s) still need a section:\n  ${missing.join("\n  ")}`)
}
