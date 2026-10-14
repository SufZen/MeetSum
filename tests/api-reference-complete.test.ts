import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { routes } from "./helpers/api-routes"
import { apiPath, documentedHeadings, renderRouteIndex, routeInventory, undocumentedHandlers, withRouteIndex } from "./helpers/api-reference"

/**
 * M10 D3: docs/api-reference.md documents every app/api handler. Each one
 * needs a "### `METHOD[, METHOD] /api/path`" section, and the generated
 * route index (npm run api:reference) must be current.
 */
const doc = readFileSync("docs/api-reference.md", "utf8").replace(/\r\n/g, "\n")
const entries = routeInventory()

describe("docs/api-reference.md", () => {
  it("covers every route file under app/api", () => {
    expect(entries.length).toBe(routes.length)
    expect(entries.length).toBeGreaterThanOrEqual(150)
  })

  it("has a section for every handler", () => {
    expect(undocumentedHandlers(doc, entries)).toEqual([])
  })

  it("documents no path or method that does not exist", () => {
    const known = new Map(entries.map((entry) => [entry.path, new Set(entry.methods.map((method) => method.method))]))
    const stale = documentedHeadings(doc).flatMap((heading) =>
      heading.methods.filter((method) => !known.get(heading.path)?.has(method)).map((method) => `${method} ${heading.path}`)
    )

    expect(stale).toEqual([])
  })

  it("carries the current generated route index (run npm run api:reference)", () => {
    expect(withRouteIndex(doc, renderRouteIndex(entries))).toBe(doc)
  })

  it("guards are resolved for every handler", () => {
    expect(entries.flatMap((entry) => entry.methods.filter((method) => method.guard.kind === "unknown").map((method) => `${method.method} ${entry.path}`))).toEqual([])
  })

  it("maps dynamic segments to :params", () => {
    expect(apiPath("meetings/[id]/participants/[participantId]")).toBe("/api/meetings/:id/participants/:participantId")
  })
})
