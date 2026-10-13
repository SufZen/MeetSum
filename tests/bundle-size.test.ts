/**
 * M9 Step 0: scripts/bundle-size.mjs parser and ratchet on fixtures
 * (Package D extends it with the real budget check).
 */
import path from "node:path"

import { describe, expect, it } from "vitest"

import { compare, parseClientReferenceManifest, routeOf } from "@/scripts/bundle-size.mjs"

const MANIFEST = `globalThis.__RSC_MANIFEST = globalThis.__RSC_MANIFEST || {};
globalThis.__RSC_MANIFEST["/[locale]/page"] = {"moduleLoading":{"prefix":""},"clientModules":{},
"entryJSFiles":{"[project]/node_modules/next/dist/client/components/builtin/not-found":["static/chunks/a.js"],
"[project]/app/[locale]/layout":["static/chunks/b.js"],
"[project]/app/[locale]/page":["static/chunks/b.js","/_next/static/chunks/c.js"]}};`

describe("bundle-size.mjs", () => {
  it("collects every entry's chunks once from a client-reference manifest", () => {
    expect(parseClientReferenceManifest(MANIFEST).sort()).toEqual(["static/chunks/a.js", "static/chunks/b.js", "static/chunks/c.js"])
  })

  it("derives the route from the manifest location", () => {
    const app = path.join(".next", "server", "app")

    expect(routeOf(app, path.join(app, "[locale]", "page_client-reference-manifest.js"))).toBe("/[locale]")
    expect(routeOf(app, path.join(app, "[locale]", "tasks", "page_client-reference-manifest.js"))).toBe("/[locale]/tasks")
    expect(routeOf(app, path.join(app, "page_client-reference-manifest.js"))).toBe("/")
  })

  it("fails on growth over baseline + maxGrowth, and over budget only when strict", () => {
    const budget = { maxGrowthKb: 5, routes: { "/[locale]": { budgetKb: 300, baselineKb: 400 } } }

    expect(compare({ "/[locale]": { kb: 404, chunks: 1 } }, budget)).toEqual({
      failures: [],
      warnings: ["/[locale]: 404 KB over the 300 KB budget"],
    })
    expect(compare({ "/[locale]": { kb: 406, chunks: 1 } }, budget).failures).toEqual([
      "/[locale]: 406 KB > baseline 400 KB + 5 KB",
    ])
    expect(compare({ "/[locale]": { kb: 301, chunks: 1 } }, budget, { strict: true }).failures).toEqual([
      "/[locale]: 301 KB over the 300 KB budget",
    ])
    expect(compare({}, budget).warnings).toEqual(["/[locale]: not found in the build"])
  })
})
