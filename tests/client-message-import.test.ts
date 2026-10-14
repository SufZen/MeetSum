/**
 * M10 C (docs/parity/m10.md, lever 2): client modules never import a message
 * module at run time, so no dictionary strings ship in client JS. The
 * `client-message-import` rule in design-system/check.mjs enforces it; this
 * test pins what the rule catches and what it lets through.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "vitest"

import { scan } from "../design-system/check.mjs"

const root = mkdtempSync(join(tmpdir(), "ds-cmi-"))

function file(rel: string, source: string) {
  const full = join(root, rel)

  mkdirSync(join(full, ".."), { recursive: true })
  writeFileSync(full, source)
}

file("components/a.tsx", `"use client"\nimport { formatMessage } from "@/lib/i18n/dictionaries"\n`)
file("components/b.tsx", `"use client"\nimport { m9ShareMessages } from "@/lib/i18n/m9/share"\n`)
file("components/c.tsx", `"use client"\nimport { getTasksMessages, type TasksMessages } from "@/lib/i18n/m5/tasks"\n`)
file("components/ok-type.tsx", `"use client"\nimport type { Dictionary } from "@/lib/i18n/dictionaries"\nimport { type TasksMessages } from "@/lib/i18n/m5/tasks"\n`)
file("components/ok-messages.tsx", `"use client"\nimport { formatMessage, translate } from "@/lib/i18n/messages"\nimport { formatDate } from "@/lib/i18n/format"\n`)
file("components/ok-server.tsx", `import { getDictionary } from "@/lib/i18n/dictionaries"\n`)

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe("client-message-import rule", () => {
  it("flags run-time message-module imports in client files only", () => {
    const { report } = scan({ selectedRules: ["client-message-import"], cwd: root, roots: ["components"] }) as {
      report: Record<string, { total: number; files: Record<string, number> }>
    }

    expect(report["client-message-import"]!.files).toEqual({
      "components/a.tsx": 1,
      "components/b.tsx": 1,
      "components/c.tsx": 1,
    })
  })

  it("passes on the repository (the root error page is the one reasoned exception)", () => {
    const { report } = scan({ selectedRules: ["client-message-import"] }) as {
      report: Record<string, { total: number; allowlisted: number }>
    }

    expect(report["client-message-import"]!.total).toBe(0)
    expect(report["client-message-import"]!.allowlisted).toBe(1)
  })
})
