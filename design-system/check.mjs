#!/usr/bin/env node
// MeetSum Cadence guardrails. Scans .tsx/.ts files for design-system
// violations and prints a per-rule, per-file report.
//
//   node design-system/check.mjs                              # report, exit 0
//   node design-system/check.mjs --strict                     # exit 1 if any violation
//   node design-system/check.mjs --baseline <file>            # exit 1 if any rule's count rises above the baseline
//   node design-system/check.mjs --write-baseline <file>      # record the current counts
//   node design-system/check.mjs --json                       # machine-readable
//   node design-system/check.mjs components app               # custom roots (every rule)
//
// Rules
//   physical-direction  ml-/mr-/pl-/pr-/left-/right-/text-left/border-l…  → use ms-/me-/ps-/pe-/start-/end-/text-start/border-s
//   raw-palette         bg-slate-200, text-blue-600…                     → semantic tokens (bg-surface-2, text-info-text)
//   arbitrary-colour    [#…], [oklch(…)], [rgb(…)], bg-[var(--…)]         → registered utilities (bg-surface, border-line)
//   arbitrary-size      text-[11px], h-[37px]…                            → type/space scale (text-2xs, h-9)
//   hex-literal         "#1a2b3c" in style props                          → tokens
// M9 rules (docs/parity/m9.md, Step 0 item 12)
//   locale-format             new Intl.DateTimeFormat|NumberFormat|RelativeTimeFormat, toLocale*String
//                             → lib/i18n/format.ts (allowlist: format.ts, lib/tasks/due-date.ts, components/ui/calendar.tsx)
//   window-dialog             window.prompt|confirm|alert          → PromptDialog / ConfirmDialog
//   hand-built-modal          `fixed inset-0` outside components/ui → components/ui Dialog
//   dictionary-runtime-import a "use client" file importing the runtime `dictionaries` object
//                             → props or useI18n()
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"

const args = process.argv.slice(2)
const strict = args.includes("--strict")
const asJson = args.includes("--json")
const optionValue = (name) => {
  const index = args.indexOf(name)

  return index === -1 ? undefined : args[index + 1]
}
const baselineFile = optionValue("--baseline")
const writeBaselineFile = optionValue("--write-baseline")
const optionValues = new Set([baselineFile, writeBaselineFile].filter(Boolean))
const roots = args.filter((a) => !a.startsWith("--") && !optionValues.has(a))

const UI_ROOTS = ["components", "app"]
const CODE_ROOTS = ["components", "app", "lib", "hooks"]

const RULES = {
  "physical-direction": {
    roots: UI_ROOTS,
    re: /(?<![\w-])(?:-?(?:ml|mr|pl|pr|left|right|border-l|border-r|rounded-l|rounded-r|rounded-tl|rounded-tr|rounded-bl|rounded-br|scroll-ml|scroll-mr|scroll-pl|scroll-pr)-[\w./[\]-]+|text-left|text-right|float-left|float-right)(?![\w-])/g,
  },
  "raw-palette": {
    roots: UI_ROOTS,
    re: /(?<![\w-])(?:bg|text|border|ring|outline|fill|stroke|from|via|to|divide|placeholder|decoration|shadow)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}(?:\/\d+)?(?![\w-])/g,
  },
  "arbitrary-colour": {
    roots: UI_ROOTS,
    re: /(?<![\w-])[\w:-]*-\[(?:#[0-9a-fA-F]{3,8}|oklch\([^\]]*\)|rgba?\([^\]]*\)|hsla?\([^\]]*\)|var\(--[\w-]+\))\]|(?<![\w-])(?:[\w-]+:)*(?:bg|text|border|ring|outline|fill|stroke|from|via|to|decoration|divide)-\(--[\w-]+\)/g,
  },
  "arbitrary-size": {
    roots: UI_ROOTS,
    re: /(?<![\w-])(?:text|leading|tracking|h|w|min-h|min-w|max-h|max-w|size|gap|p|px|py|m|mx|my|top|bottom|inset)-\[-?\d*\.?\d+(?:px|rem)\]/g, // em is allowed: it tracks the font size
  },
  "hex-literal": {
    roots: UI_ROOTS,
    re: /["'`]#[0-9a-fA-F]{3,8}["'`]/g,
  },
  "locale-format": {
    roots: CODE_ROOTS,
    re: /\bnew\s+Intl\.(?:DateTimeFormat|NumberFormat|RelativeTimeFormat)\b|\.toLocale(?:Date|Time)?String\s*\(/g,
    allow: ["lib/i18n/format.ts", "lib/tasks/due-date.ts", "components/ui/calendar.tsx"],
  },
  "window-dialog": {
    roots: CODE_ROOTS,
    re: /\bwindow\.(?:prompt|confirm|alert)\s*\(/g,
  },
  "hand-built-modal": {
    roots: UI_ROOTS,
    re: /(?<![\w:-])fixed\s+inset-0(?![\w-])/g,
    allowPrefix: ["components/ui/"],
  },
  "dictionary-runtime-import": {
    roots: CODE_ROOTS,
    // Counted only in files whose first statement is "use client" (see below).
    re: /import\s*\{(?:[^}]*[,{\s])?(?<!type\s)dictionaries\b[^}]*\}\s*from\s*["']@\/lib\/i18n\/dictionaries["']/g,
    clientOnly: true,
  },
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

const isClientFile = (src) => /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*["']use client["']/.test(src)

const fileCache = new Map()
function filesOf(root) {
  if (!fileCache.has(root)) fileCache.set(root, walk(root))
  return fileCache.get(root)
}

const report = Object.fromEntries(Object.keys(RULES).map((r) => [r, { total: 0, files: {} }]))
for (const [rule, spec] of Object.entries(RULES)) {
  const ruleRoots = roots.length ? roots : spec.roots
  const seen = new Set()

  for (const root of ruleRoots) {
    for (const file of filesOf(root)) {
      const rel = relative(process.cwd(), file).replaceAll("\\", "/")

      if (seen.has(rel)) continue
      seen.add(rel)
      if (spec.allow?.includes(rel)) continue
      if (spec.allowPrefix?.some((prefix) => rel.startsWith(prefix))) continue

      const src = readFileSync(file, "utf8")

      if (spec.clientOnly && !isClientFile(src)) continue

      const hits = src.match(spec.re)
      if (!hits) continue
      report[rule].total += hits.length
      report[rule].files[rel] = (report[rule].files[rel] ?? 0) + hits.length
    }
  }
}

const total = Object.values(report).reduce((a, r) => a + r.total, 0)
const counts = Object.fromEntries(Object.entries(report).map(([rule, r]) => [rule, r.total]))

if (writeBaselineFile) {
  writeFileSync(writeBaselineFile, `${JSON.stringify(counts, null, 2)}\n`)
}

let regressions = []
let improvements = []
if (baselineFile) {
  const baseline = JSON.parse(readFileSync(baselineFile, "utf8"))

  for (const [rule, count] of Object.entries(counts)) {
    const allowed = typeof baseline[rule] === "number" ? baseline[rule] : 0

    if (count > allowed) regressions.push(`${rule}: ${count} > baseline ${allowed}`)
    else if (count < allowed) improvements.push(`${rule}: ${count} < baseline ${allowed} (lower the baseline)`)
  }
}

if (asJson) {
  console.log(JSON.stringify({ total, report, ...(baselineFile ? { regressions, improvements } : {}) }, null, 2))
} else {
  console.log(`Cadence guardrails — ${roots.length ? roots.join(", ") : "per-rule roots"}`)
  for (const [rule, r] of Object.entries(report)) {
    console.log(`\n${rule.padEnd(26)} ${r.total}`)
    Object.entries(r.files).sort((a, b) => b[1] - a[1]).slice(0, 8).forEach(([f, n]) => console.log(`  ${String(n).padStart(4)}  ${f}`))
  }
  console.log(`\ntotal violations: ${total}`)
  if (baselineFile) {
    for (const line of improvements) console.log(`ratchet: ${line}`)
    for (const line of regressions) console.error(`ratchet FAILED: ${line}`)
    if (!regressions.length) console.log(`ratchet: no rule above ${baselineFile}`)
  }
}

process.exit((strict && total > 0) || regressions.length > 0 ? 1 : 0)
