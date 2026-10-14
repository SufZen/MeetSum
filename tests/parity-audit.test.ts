import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

/**
 * M10 D7: docs/parity/AUDIT.md has a section for every STATUS parity-matrix
 * row, every evidence path it cites exists, and no row claims ✓ without
 * evidence.
 */
const status = readFileSync("docs/parity/STATUS.md", "utf8").replace(/\r\n/g, "\n")
const audit = readFileSync("docs/parity/AUDIT.md", "utf8").replace(/\r\n/g, "\n")

function matrixRows(): string[] {
  const section = status.slice(status.indexOf("## Parity matrix"))
  const table = section.split("\n").slice(1)
  const rows: string[] = []

  for (const line of table) {
    if (line.startsWith("## ")) break
    if (!line.startsWith("|") || line.startsWith("|---") || line.startsWith("| Area")) continue
    rows.push(line.split("|")[1].trim())
  }

  return rows
}

function auditSection(row: string): string | undefined {
  const start = audit.indexOf(`\n### ${row}\n`)

  if (start === -1) return undefined
  const rest = audit.slice(start + 1)
  const next = rest.slice(4).search(/\n### |\n## |\n---/)

  return next === -1 ? rest : rest.slice(0, next + 4)
}

const PATH_PATTERN = /`((?:tests|lib|docs|scripts|app|components|db|mcp|design-system)\/[^`\s]+\.(?:ts|tsx|md|json|mjs|sql|py))`/g

describe("docs/parity/AUDIT.md", () => {
  const rows = matrixRows()

  it("reads the STATUS matrix", () => {
    expect(rows.length).toBeGreaterThanOrEqual(14)
  })

  it("has one section per STATUS matrix row", () => {
    expect(rows.filter((row) => !auditSection(row))).toEqual([])
  })

  it("scores every row in the summary table", () => {
    for (const row of rows) expect(audit, row).toContain(`| ${row} |`)
  })

  it("gives every row evidence, scores and a live-verification line", () => {
    for (const row of rows) {
      const section = auditSection(row) ?? ""

      expect(section, row).toMatch(/\*\*Evidence:\*\*/)
      expect(section, row).toMatch(/`tests\/[^`]+\.test\.ts`/)
      expect(section, row).toMatch(/\*\*Scores:\*\*/)
      expect(section, row).toMatch(/\*\*Live:\*\*/)
    }
  })

  it("cites only evidence paths that exist in the repo", () => {
    const missing = [...audit.matchAll(PATH_PATTERN)].map((match) => match[1]).filter((file) => !existsSync(path.join(process.cwd(), file)))

    expect([...new Set(missing)]).toEqual([])
  })

  it("states plainly that the live ASR WER and summary evals have not been run", () => {
    expect(audit).toContain("live table NOT run")
    expect(audit).toContain("live pairwise eval NOT run")
  })
})
