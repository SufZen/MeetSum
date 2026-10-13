/**
 * Shared TypeScript-AST walker for the M9 static scanners
 * (`i18n-hardcoded-strings`, `a11y-static`). Parses `.tsx` sources with the
 * compiler API and reports findings as `{ file, line, rule, text }`.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"

import ts from "typescript"

export type Finding = { file: string; line: number; rule: string; text: string }

export type ScanFile = { file: string; source: ts.SourceFile; lines: string[] }

const ROOT = process.cwd()

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[]

  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }

  for (const name of entries) {
    if (name === "node_modules" || name.startsWith(".")) continue

    const full = path.join(dir, name)

    if (statSync(full).isDirectory()) walk(full, out)
    else if (name.endsWith(".tsx")) out.push(full)
  }

  return out
}

/** `components/**\/*.tsx` and `app/**\/*.tsx` except `app/api`. */
export function listUiFiles(): string[] {
  return [...walk(path.join(ROOT, "components")), ...walk(path.join(ROOT, "app"))]
    .map((file) => path.relative(ROOT, file).split(path.sep).join("/"))
    .filter((file) => !file.startsWith("app/api/"))
    .sort()
}

export function parseFile(file: string): ScanFile {
  const text = readFileSync(path.join(ROOT, file), "utf8")

  return {
    file,
    source: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
    lines: text.split(/\r?\n/),
  }
}

export function lineOf(scan: ScanFile, node: ts.Node): number {
  return scan.source.getLineAndCharacterOfPosition(node.getStart(scan.source)).line + 1
}

/** `// i18n-allow: <reason>` (or a11y-allow) on the node's line or the line above; the reason is required. */
export function isAllowed(scan: ScanFile, node: ts.Node, marker: "i18n-allow" | "a11y-allow"): boolean {
  const line = lineOf(scan, node)
  const pattern = new RegExp(`${marker}:\\s*\\S`)

  return [scan.lines[line - 1], scan.lines[line - 2]].some((text) => text !== undefined && pattern.test(text))
}

export function visit(node: ts.Node, fn: (node: ts.Node) => void): void {
  fn(node)
  ts.forEachChild(node, (child) => visit(child, fn))
}

export function tagNameOf(node: ts.JsxElement | ts.JsxSelfClosingElement): string {
  const tag = ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName

  return tag.getText()
}

export function attributesOf(node: ts.JsxElement | ts.JsxSelfClosingElement): ts.JsxAttributes {
  return ts.isJsxElement(node) ? node.openingElement.attributes : node.attributes
}

export function attributeNames(node: ts.JsxElement | ts.JsxSelfClosingElement): { names: Set<string>; spread: boolean } {
  const names = new Set<string>()
  let spread = false

  for (const property of attributesOf(node).properties) {
    if (ts.isJsxSpreadAttribute(property)) spread = true
    else names.add(property.name.getText())
  }

  return { names, spread }
}

export function attributeValue(node: ts.JsxElement | ts.JsxSelfClosingElement, name: string): ts.JsxAttribute | undefined {
  return attributesOf(node).properties.find(
    (property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && property.name.getText() === name
  )
}

/** Per-file counts, sorted, for a baseline fixture. */
export function countByFile(findings: Finding[]): Record<string, number> {
  const counts: Record<string, number> = {}

  for (const finding of findings) counts[finding.file] = (counts[finding.file] ?? 0) + 1

  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
}

/** Files whose count rose above the baseline (a missing file counts as 0). */
export function ratchetRegressions(counts: Record<string, number>, baseline: Record<string, number>): string[] {
  return Object.entries(counts)
    .filter(([file, count]) => count > (baseline[file] ?? 0))
    .map(([file, count]) => `${file}: ${count} > baseline ${baseline[file] ?? 0}`)
}

export function readBaseline(file: string): Record<string, number> {
  try {
    return JSON.parse(readFileSync(path.join(ROOT, file), "utf8")) as Record<string, number>
  } catch {
    return {}
  }
}

export function writeBaseline(file: string, counts: Record<string, number>): void {
  writeFileSync(path.join(ROOT, file), `${JSON.stringify(counts, null, 2)}\n`)
}
