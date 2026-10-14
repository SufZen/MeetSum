#!/usr/bin/env node
// MeetSum Cadence guardrails. Scans .tsx/.ts files for design-system
// violations and prints a per-rule, per-file report.
//
//   node design-system/check.mjs                              # report, exit 0
//   node design-system/check.mjs --strict                     # exit 1 on any violation or stale allowLines entry
//   node design-system/check.mjs --baseline <file>            # exit 1 if any rule's count rises above the baseline
//   node design-system/check.mjs --write-baseline <file>      # record the current counts
//   node design-system/check.mjs --json                       # machine-readable
//   node design-system/check.mjs components app               # custom roots (every rule)
//   node design-system/check.mjs --rules raw-palette,hex-literal  # only these rules
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
// M10 rule (docs/parity/m10.md, Package C; replaces M9's dictionary-runtime-import)
//   client-message-import     a "use client" file importing a message module at run time
//                             (dictionaries, *-messages, lib/i18n/m<N>/*) → useI18n() / provider messages
//
// Allowlists
//   allow / allowPrefix   whole files a rule skips.
//   allowLines            [{ file, pattern, reason }]: a hit whose source line matches `pattern`
//                         (a RegExp source) in `file` is allowlisted. Every entry needs a one-line
//                         reason and must still match at least one hit; a stale entry fails --strict.
//                         Allowlisted hits are reported separately and never count as violations.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const UI_ROOTS = ["components", "app"]
const CODE_ROOTS = ["components", "app", "lib", "hooks"]

// Message modules: the runtime dictionary and every per-milestone module.
const MESSAGE_MODULE = String.raw`@\/lib\/i18n\/(?:dictionaries|workspace-messages|asr-messages|player-messages|m\d+\/[\w-]+)`

export const RULES = {
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
    allowLines: [
      {
        file: "components/ui/chart.tsx",
        pattern: String.raw`\[stroke='#ccc'\]\]:stroke-border/50 .*\[stroke='#fff'\]\]:stroke-transparent`,
        reason:
          "Attribute selectors that match recharts' own default stroke attributes (#ccc grid, #fff dots/sectors) to restyle them with tokens; they style no colour themselves and cannot be rewritten.",
      },
    ],
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
  "client-message-import": {
    roots: CODE_ROOTS,
    // Counted only in files whose first statement is "use client"; type-only
    // imports (`import type`, or every name `type X`) are fine.
    re: new RegExp(String.raw`import\s+(?!type\s)(?:\{[^}]*\}|[\w*\s,]+?)\s*from\s*["']${MESSAGE_MODULE}["']`, "g"),
    clientOnly: true,
    skipMatch: (hit) => {
      const names = hit.match(/\{([^}]*)\}/)?.[1]

      return Boolean(names) && names.split(",").map((name) => name.trim()).filter(Boolean).every((name) => name.startsWith("type "))
    },
    allowLines: [
      {
        file: "app/global-error.tsx",
        pattern: String.raw`from "@/lib/i18n/m9/shell-error"`,
        reason:
          "The root error page replaces the root layout, so no I18nProvider exists; it imports the four-key bilingual shell-error module on purpose.",
      },
    ],
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

function lineAt(src, index) {
  const start = src.lastIndexOf("\n", index - 1) + 1
  const end = src.indexOf("\n", index)

  return src.slice(start, end === -1 ? src.length : end)
}

/**
 * Scans `roots` (or each rule's own roots) and returns
 * `{ report, total, allowlisted, staleAllowLines }`.
 *
 * @param {{ roots?: string[], selectedRules?: string[], cwd?: string }} [options]
 */
export function scan({ roots = [], selectedRules = Object.keys(RULES), cwd = process.cwd() } = {}) {
  const fileCache = new Map()
  const filesOf = (root) => {
    if (!fileCache.has(root)) fileCache.set(root, walk(join(cwd, root)))
    return fileCache.get(root)
  }
  const report = Object.fromEntries(selectedRules.map((r) => [r, { total: 0, allowlisted: 0, files: {}, allowlistedFiles: {} }]))
  const staleAllowLines = []

  for (const rule of selectedRules) {
    const spec = RULES[rule]
    const ruleRoots = roots.length ? roots : spec.roots
    const seen = new Set()
    const used = new Set()

    for (const root of ruleRoots) {
      for (const file of filesOf(root)) {
        const rel = relative(cwd, file).replaceAll("\\", "/")

        if (seen.has(rel)) continue
        seen.add(rel)
        if (spec.allow?.includes(rel)) continue
        if (spec.allowPrefix?.some((prefix) => rel.startsWith(prefix))) continue

        const src = readFileSync(file, "utf8")

        if (spec.clientOnly && !isClientFile(src)) continue

        for (const match of src.matchAll(spec.re)) {
          if (spec.skipMatch?.(match[0])) continue

          const line = lineAt(src, match.index)
          const entry = spec.allowLines?.find((allowed) => allowed.file === rel && new RegExp(allowed.pattern).test(line))

          if (entry) {
            used.add(entry)
            report[rule].allowlisted += 1
            report[rule].allowlistedFiles[rel] = (report[rule].allowlistedFiles[rel] ?? 0) + 1
          } else {
            report[rule].total += 1
            report[rule].files[rel] = (report[rule].files[rel] ?? 0) + 1
          }
        }
      }
    }

    // Only judge staleness when the entry's file was scanned (custom roots may skip it).
    for (const entry of spec.allowLines ?? []) {
      if (seen.has(entry.file) && !used.has(entry)) staleAllowLines.push(`${rule}: ${entry.file} /${entry.pattern}/`)
    }
  }

  const total = Object.values(report).reduce((a, r) => a + r.total, 0)
  const allowlisted = Object.values(report).reduce((a, r) => a + r.allowlisted, 0)

  return { report, total, allowlisted, staleAllowLines }
}

function main(args) {
  const strict = args.includes("--strict")
  const asJson = args.includes("--json")
  const optionValue = (name) => {
    const index = args.indexOf(name)

    return index === -1 ? undefined : args[index + 1]
  }
  const baselineFile = optionValue("--baseline")
  const writeBaselineFile = optionValue("--write-baseline")
  const rulesOption = optionValue("--rules")
  const optionValues = new Set([baselineFile, writeBaselineFile, rulesOption].filter(Boolean))
  const roots = args.filter((a) => !a.startsWith("--") && !optionValues.has(a))
  const selectedRules = rulesOption ? rulesOption.split(",").map((rule) => rule.trim()).filter(Boolean) : Object.keys(RULES)

  for (const rule of selectedRules) {
    if (!RULES[rule]) {
      console.error(`Unknown rule: ${rule}`)
      return 2
    }
  }

  const { report, total, allowlisted, staleAllowLines } = scan({ roots, selectedRules })
  const counts = Object.fromEntries(Object.entries(report).map(([rule, r]) => [rule, r.total]))

  if (writeBaselineFile) {
    writeFileSync(writeBaselineFile, `${JSON.stringify(counts, null, 2)}\n`)
  }

  const regressions = []
  const improvements = []
  if (baselineFile) {
    const baseline = JSON.parse(readFileSync(baselineFile, "utf8"))

    for (const [rule, count] of Object.entries(counts)) {
      const allowed = typeof baseline[rule] === "number" ? baseline[rule] : 0

      if (count > allowed) regressions.push(`${rule}: ${count} > baseline ${allowed}`)
      else if (count < allowed) improvements.push(`${rule}: ${count} < baseline ${allowed} (lower the baseline)`)
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ total, allowlisted, staleAllowLines, report, ...(baselineFile ? { regressions, improvements } : {}) }, null, 2))
  } else {
    console.log(`Cadence guardrails — ${roots.length ? roots.join(", ") : "per-rule roots"}`)
    for (const [rule, r] of Object.entries(report)) {
      console.log(`\n${rule.padEnd(26)} ${r.total}${r.allowlisted ? `  (+${r.allowlisted} allowlisted)` : ""}`)
      Object.entries(r.files).sort((a, b) => b[1] - a[1]).slice(0, 8).forEach(([f, n]) => console.log(`  ${String(n).padStart(4)}  ${f}`))
      Object.entries(r.allowlistedFiles).forEach(([f, n]) => console.log(`  ${String(n).padStart(4)}  ${f}  [allowlisted]`))
    }
    console.log(`\ntotal violations: ${total}`)
    console.log(`allowlisted (allowLines, with reasons): ${allowlisted}`)
    for (const line of staleAllowLines) console.error(`stale allowLines entry (no longer matches): ${line}`)
    if (baselineFile) {
      for (const line of improvements) console.log(`ratchet: ${line}`)
      for (const line of regressions) console.error(`ratchet FAILED: ${line}`)
      if (!regressions.length) console.log(`ratchet: no rule above ${baselineFile}`)
    }
  }

  // A stale allowLines entry fails both gates (the M10 baseline is all zeros,
  // so `--baseline` is as strict as `--strict` until Integration drops it).
  const staleFails = (strict || Boolean(baselineFile)) && staleAllowLines.length > 0

  return (strict && total > 0) || staleFails || regressions.length > 0 ? 1 : 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)))
}
