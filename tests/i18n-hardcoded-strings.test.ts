/**
 * M9 Step 0 scanner (docs/parity/m9.md item 12): hardcoded UI strings in
 * `components/**\/*.tsx` and `app/**\/*.tsx` (excluding `app/api`), found with
 * the TypeScript compiler API:
 * - JSX text with 2+ consecutive Latin letters;
 * - string literals in aria-label|aria-description|aria-valuetext|title|
 *   placeholder|alt|label|description|emptyText;
 * - literal first arguments of `toast(…)` / `toast.*(…)`;
 * - `new Error("…")` in components (anything outside app/).
 * Brand names are removed before checking. Per-line opt-out:
 * `// i18n-allow: <reason>` (reason required) on the line or the line above.
 * Ratchet: per-file counts may only go down against
 * `tests/fixtures/i18n-baseline.json` (`UPDATE_I18N_BASELINE=1` rewrites it).
 * The Integration step deletes the baseline and runs strict.
 */
import ts from "typescript"
import { describe, expect, it } from "vitest"

import {
  attributesOf,
  countByFile,
  isAllowed,
  lineOf,
  listUiFiles,
  parseFile,
  ratchetRegressions,
  readBaseline,
  visit,
  writeBaseline,
  type Finding,
  type ScanFile,
} from "./helpers/tsx-scan"

const BASELINE_FILE = "tests/fixtures/i18n-baseline.json"

const TEXT_ATTRIBUTES = new Set([
  "aria-label",
  "aria-description",
  "aria-valuetext",
  "title",
  "placeholder",
  "alt",
  "label",
  "description",
  "emptyText",
])

/** Removed before checking for Latin words (longest first). */
export const BRAND_ALLOWLIST = [
  "Google Workspace",
  "Ctrl K",
  "⌘K",
  "MeetSum",
  "RealizeOS",
  "HubSpot",
  "Outlook",
  "Google",
  "Gmail",
  "Drive",
  "Meet",
  "Zoom",
  "Teams",
  "Slack",
  "Notion",
  "Vexa",
  "PDF",
  "DOCX",
  "Markdown",
  "API",
  "URL",
  "AI",
  "JSON",
  "EN",
  "HE",
  "MP3",
  "WebM",
]

const BRAND_PATTERN = new RegExp(
  BRAND_ALLOWLIST.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).sort((a, b) => b.length - a.length).join("|"),
  "g"
)

export function hasHardcodedLatin(text: string): boolean {
  return /[A-Za-z]{2,}/.test(text.replace(BRAND_PATTERN, " "))
}

function literalText(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isJsxExpression(node)) return literalText(node.expression)
  if (ts.isParenthesizedExpression(node)) return literalText(node.expression)

  return undefined
}

function isToastCall(node: ts.CallExpression): boolean {
  const callee = node.expression

  if (ts.isIdentifier(callee)) return callee.text === "toast"

  return ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "toast"
}

export function scanHardcodedStrings(scan: ScanFile): Finding[] {
  const findings: Finding[] = []
  // `new Error("…")` is a UI string in components (route files under app/ are pages).
  const inComponents = !scan.file.startsWith("app/")
  const push = (node: ts.Node, rule: string, text: string) => {
    if (!hasHardcodedLatin(text) || isAllowed(scan, node, "i18n-allow")) return
    findings.push({ file: scan.file, line: lineOf(scan, node), rule, text: text.trim().slice(0, 80) })
  }

  visit(scan.source, (node) => {
    if (ts.isJsxText(node)) {
      push(node, "jsx-text", node.text)
    } else if ((ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node))) {
      for (const property of attributesOf(node).properties) {
        if (!ts.isJsxAttribute(property) || !TEXT_ATTRIBUTES.has(property.name.getText())) continue

        const text = literalText(property.initializer)

        if (text !== undefined) push(property, `attr:${property.name.getText()}`, text)
      }
    } else if (ts.isCallExpression(node) && isToastCall(node)) {
      const text = literalText(node.arguments[0])

      if (text !== undefined) push(node, "toast", text)
    } else if (inComponents && ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Error") {
      const text = literalText(node.arguments?.[0])

      if (text !== undefined) push(node, "new-error", text)
    }
  })

  return findings
}

describe("hardcoded UI strings (M9 ratchet)", () => {
  const findings = listUiFiles().flatMap((file) => scanHardcodedStrings(parseFile(file)))
  const counts = countByFile(findings)

  if (process.env.UPDATE_I18N_BASELINE === "1") writeBaseline(BASELINE_FILE, counts)

  it("detects the patterns it is meant to detect", () => {
    const sample = parseFile("tests/fixtures/i18n-scan-sample.tsx")
    const rules = scanHardcodedStrings(sample).map((finding) => `${finding.rule}:${finding.text}`)

    expect(rules).toEqual([
      "new-error:Unable to load",
      "toast:Saved settings",
      "jsx-text:Upload queued",
      "attr:aria-label:Close dialog",
      "attr:placeholder:Search meetings",
    ])
  })

  it("never adds a hardcoded string to a file (per-file baseline)", () => {
    expect(ratchetRegressions(counts, readBaseline(BASELINE_FILE))).toEqual([])
  })
})
