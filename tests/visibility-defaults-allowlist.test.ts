import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

/**
 * M10 R6: read paths and the processor fail closed on a missing meeting
 * visibility (M9). The only places allowed to default a missing visibility
 * to "workspace" are the creation default (the M2 product default for a new
 * meeting) and display-only values. Any new default fails here; fix the call
 * site to fail closed, or add it below with a reason.
 */
const ALLOWLIST: Record<string, string> = {
  "lib/meetings/repository.ts": "creation default for a new meeting in the memory repository (M2 product default)",
  "lib/meetings/postgres-repository.ts": "creation default for a new meeting insert (M2 product default; the column default matches)",
  "lib/search/eval/pglite.ts": "dev/test seed for the offline search eval; writes fixtures, never reads for access",
  "app/api/meetings/[id]/visibility/route.ts": "audit metadata only: the 'previous' value recorded when the owner changes visibility",
  "components/meeting-visibility-control.tsx": "display only: the control's selected value; the server decides access",
}

const ROOTS = ["lib", "app", "components", "hooks", "worker", "mcp", "scripts"]
const PATTERN = /isibility\w*\s*(\?\?|\|\|)\s*["'`]workspace["'`]|isibility\w*\s*=\s*["'`]workspace["'`]\s*[,)}]/

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue
    const full = path.join(dir, name)

    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx|mts|mjs)$/.test(name)) out.push(full)
  }

  return out
}

function offenders(): Map<string, number> {
  const found = new Map<string, number>()

  for (const root of ROOTS) {
    for (const file of walk(root)) {
      const lines = readFileSync(file, "utf8").split("\n")
      const count = lines.filter((line) => PATTERN.test(line)).length

      if (count > 0) found.set(file.split(path.sep).join("/"), count)
    }
  }

  return found
}

describe("missing visibility never silently means workspace", () => {
  const found = offenders()

  it("only allowlisted files default a missing visibility to workspace", () => {
    const unexpected = [...found.keys()].filter((file) => !(file in ALLOWLIST))

    expect(unexpected, "fail closed instead, or allowlist with a reason").toEqual([])
  })

  it("each allowlisted file has exactly one such default, and every entry is still needed", () => {
    for (const file of Object.keys(ALLOWLIST)) {
      expect(found.get(file), file).toBe(1)
      expect(ALLOWLIST[file].length, file).toBeGreaterThan(10)
    }
  })

  it("detects the patterns it guards", () => {
    expect(PATTERN.test('const v = meeting.visibility ?? "workspace"')).toBe(true)
    expect(PATTERN.test("const v = row.visibility || 'workspace'")).toBe(true)
    expect(PATTERN.test('function f({ visibility = "workspace" }) {}')).toBe(true)
    expect(PATTERN.test('if (visibility === "workspace") return')).toBe(false)
  })
})
