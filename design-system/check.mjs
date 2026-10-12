#!/usr/bin/env node
// MeetSum Cadence guardrails. Scans .tsx/.ts files for design-system
// violations and prints a per-rule, per-file report.
//
//   node design-system/check.mjs                 # report, exit 0
//   node design-system/check.mjs --strict        # exit 1 if any violation
//   node design-system/check.mjs --json          # machine-readable
//   node design-system/check.mjs components app  # custom roots
//
// Rules
//   physical-direction  ml-/mr-/pl-/pr-/left-/right-/text-left/border-l…  → use ms-/me-/ps-/pe-/start-/end-/text-start/border-s
//   raw-palette         bg-slate-200, text-blue-600…                     → semantic tokens (bg-surface-2, text-info-text)
//   arbitrary-colour    [#…], [oklch(…)], [rgb(…)], bg-[var(--…)]         → registered utilities (bg-surface, border-line)
//   arbitrary-size      text-[11px], h-[37px]…                            → type/space scale (text-2xs, h-9)
//   hex-literal         "#1a2b3c" in style props                          → tokens
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const args = process.argv.slice(2)
const strict = args.includes("--strict")
const asJson = args.includes("--json")
const roots = args.filter((a) => !a.startsWith("--"))
const scan = roots.length ? roots : ["components", "app"]

const RULES = {
  "physical-direction": /(?<![\w-])(?:-?(?:ml|mr|pl|pr|left|right|border-l|border-r|rounded-l|rounded-r|rounded-tl|rounded-tr|rounded-bl|rounded-br|scroll-ml|scroll-mr|scroll-pl|scroll-pr)-[\w./[\]-]+|text-left|text-right|float-left|float-right)(?![\w-])/g,
  "raw-palette": /(?<![\w-])(?:bg|text|border|ring|outline|fill|stroke|from|via|to|divide|placeholder|decoration|shadow)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}(?:\/\d+)?(?![\w-])/g,
  "arbitrary-colour": /(?<![\w-])[\w:-]*-\[(?:#[0-9a-fA-F]{3,8}|oklch\([^\]]*\)|rgba?\([^\]]*\)|hsla?\([^\]]*\)|var\(--[\w-]+\))\]|(?<![\w-])(?:[\w-]+:)*(?:bg|text|border|ring|outline|fill|stroke|from|via|to|decoration|divide)-\(--[\w-]+\)/g,
  "arbitrary-size": /(?<![\w-])(?:text|leading|tracking|h|w|min-h|min-w|max-h|max-w|size|gap|p|px|py|m|mx|my|top|bottom|inset)-\[-?\d*\.?\d+(?:px|rem)\]/g, // em is allowed: it tracks the font size
  "hex-literal": /["'`]#[0-9a-fA-F]{3,8}["'`]/g,
}

function walk(dir, out = []) {
  let entries
  try { entries = readdirSync(dir) } catch { return out }
  for (const name of entries) {
    if (name === "node_modules" || name.startsWith(".")) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(tsx|ts)$/.test(name) && !name.endsWith(".d.ts")) out.push(p)
  }
  return out
}

const report = Object.fromEntries(Object.keys(RULES).map((r) => [r, { total: 0, files: {} }]))
for (const root of scan) {
  for (const file of walk(root)) {
    const src = readFileSync(file, "utf8")
    for (const [rule, re] of Object.entries(RULES)) {
      const hits = src.match(re)
      if (!hits) continue
      const rel = relative(process.cwd(), file).replaceAll("\\", "/")
      report[rule].total += hits.length
      report[rule].files[rel] = (report[rule].files[rel] ?? 0) + hits.length
    }
  }
}

const total = Object.values(report).reduce((a, r) => a + r.total, 0)
if (asJson) {
  console.log(JSON.stringify({ total, report }, null, 2))
} else {
  console.log(`Cadence guardrails — ${scan.join(", ")}`)
  for (const [rule, r] of Object.entries(report)) {
    console.log(`\n${rule.padEnd(20)} ${r.total}`)
    Object.entries(r.files).sort((a, b) => b[1] - a[1]).slice(0, 8).forEach(([f, n]) => console.log(`  ${String(n).padStart(4)}  ${f}`))
  }
  console.log(`\ntotal violations: ${total}`)
}
process.exit(strict && total > 0 ? 1 : 0)
