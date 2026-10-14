/**
 * M10 A: playwright.config.ts has one project per CI matrix job, each
 * matching its specs and nothing else, plus the artifact settings the
 * e2e workflow uploads (docs/parity/m10.md, "E2E in CI").
 */
import { readdirSync, readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import config from "@/playwright.config"

const SUITES = ["core", "m6", "m8", "m9", "m9-prod"]
const specs = readdirSync("tests/e2e").filter((name) => name.endsWith(".spec.ts"))

function matches(project: NonNullable<typeof config.projects>[number], file: string): boolean {
  const pattern = project.testMatch

  return pattern instanceof RegExp ? pattern.test(file) : false
}

describe("playwright config", () => {
  it("writes artifacts to test-results and the HTML/JSON reports, with no webServer", () => {
    expect(config.outputDir).toBe("test-results")
    expect(config.webServer).toBeUndefined()
    expect(JSON.stringify(config.reporter)).toContain("test-results/results.json")
    expect(JSON.stringify(config.reporter)).toContain('"html"')
    expect(config.use?.screenshot).toBe("only-on-failure")
    expect(config.use?.video).toBe("retain-on-failure")
    expect(config.use?.trace).toBe("retain-on-failure")
  })

  it("has one project per CI matrix job", () => {
    expect(config.projects?.map((project) => project.name)).toEqual(SUITES)
  })

  it("every spec belongs to exactly one project, and every project has a spec", () => {
    for (const spec of specs) {
      expect(config.projects!.filter((project) => matches(project, spec)).map((project) => project.name), spec).toHaveLength(1)
    }
    for (const project of config.projects!) {
      expect(specs.some((spec) => matches(project, spec)), project.name).toBe(true)
    }
  })

  it("the workflow runs the same suites", () => {
    const workflow = readFileSync(".github/workflows/e2e.yml", "utf8")

    for (const suite of SUITES) expect(workflow).toMatch(new RegExp(`suite: ${suite}\\b`))
  })
})
