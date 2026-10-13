/**
 * M9 Step 0 scanner (docs/parity/m9.md item 12): static accessibility checks
 * over `components/**\/*.tsx` and `app/**\/*.tsx` (excluding `app/api`):
 * - icon-only `<button>` / `<Button>` needs `aria-label` (or aria-labelledby / title / sr-only text);
 * - `<img>` needs `alt`;
 * - `onClick` on `div` / `span` needs `role`, `tabIndex` and a key handler;
 * - form controls (`input`, `Input`, `textarea`, `Textarea`, `select`) need a
 *   label (`aria-label`, `aria-labelledby`, an `id` for `<label htmlFor>`, or a
 *   wrapping label element);
 * - `role="dialog"` only inside `components/ui/**`.
 * Elements with a spread attribute are skipped (the spread may carry the
 * attribute). Opt-out: `// a11y-allow: <reason>` on the line or the line above.
 * Strict since the M9 Integration step: zero findings outside reasoned
 * `a11y-allow` lines (the per-file baseline is gone).
 */
import ts from "typescript"
import { describe, expect, it } from "vitest"

import {
  attributeNames,
  attributeValue,
  isAllowed,
  lineOf,
  listUiFiles,
  parseFile,
  tagNameOf,
  visit,
  type Finding,
  type ScanFile,
} from "./helpers/tsx-scan"

const FORM_CONTROLS = new Set(["input", "Input", "textarea", "Textarea", "select"])
const LABEL_WRAPPERS = new Set(["label", "Label", "FieldLabel"])
const KEY_HANDLERS = ["onKeyDown", "onKeyUp", "onKeyPress"]

type Jsx = ts.JsxElement | ts.JsxSelfClosingElement

function isIconElement(node: ts.Node): boolean {
  if (!ts.isJsxElement(node) && !ts.isJsxSelfClosingElement(node)) return false

  const tag = tagNameOf(node)

  return tag === "svg" || /Icon$/.test(tag) || tag === "CitedMark" || tag === "SigmaMark" || tag === "Spinner"
}

function isIconOnly(node: ts.JsxElement): boolean {
  let elements = 0

  for (const child of node.children) {
    if (ts.isJsxText(child)) {
      if (child.text.trim()) return false
    } else if (ts.isJsxExpression(child)) {
      if (child.expression) return false
    } else if (isIconElement(child)) {
      elements += 1
    } else {
      return false
    }
  }

  return elements > 0
}

function hasLabelAncestor(node: ts.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isJsxElement(current) && LABEL_WRAPPERS.has(tagNameOf(current))) return true
  }

  return false
}

function stringAttribute(node: Jsx, name: string): string | undefined {
  const initializer = attributeValue(node, name)?.initializer

  return initializer && ts.isStringLiteral(initializer) ? initializer.text : undefined
}

export function scanA11y(scan: ScanFile): Finding[] {
  const findings: Finding[] = []
  const inUi = scan.file.startsWith("components/ui/")
  const push = (node: ts.Node, rule: string) => {
    if (isAllowed(scan, node, "a11y-allow")) return
    findings.push({ file: scan.file, line: lineOf(scan, node), rule, text: node.getText(scan.source).split("\n")[0]!.slice(0, 80) })
  }

  visit(scan.source, (node) => {
    if (!ts.isJsxElement(node) && !ts.isJsxSelfClosingElement(node)) return

    const tag = tagNameOf(node)
    const { names, spread } = attributeNames(node)

    if (!inUi && stringAttribute(node, "role") === "dialog") push(node, "dialog-outside-ui")
    if (spread) return

    if ((tag === "button" || tag === "Button") && ts.isJsxElement(node) && isIconOnly(node)) {
      if (!names.has("aria-label") && !names.has("aria-labelledby") && !names.has("title")) push(node, "icon-button-label")
    }

    if (tag === "img" && !names.has("alt")) push(node, "img-alt")

    if ((tag === "div" || tag === "span") && names.has("onClick")) {
      if (!names.has("role") || !names.has("tabIndex") || !KEY_HANDLERS.some((handler) => names.has(handler))) {
        push(node, "click-non-interactive")
      }
    }

    if (FORM_CONTROLS.has(tag)) {
      const type = stringAttribute(node, "type")

      if (
        type !== "hidden" &&
        type !== "submit" &&
        !names.has("aria-label") &&
        !names.has("aria-labelledby") &&
        !names.has("id") &&
        !hasLabelAncestor(node)
      ) {
        push(node, "control-label")
      }
    }
  })

  return findings
}

describe("static accessibility (M9, strict)", () => {
  const findings = listUiFiles().flatMap((file) => scanA11y(parseFile(file)))

  it("detects the patterns it is meant to detect", () => {
    const rules = scanA11y(parseFile("tests/fixtures/a11y-scan-sample.tsx")).map((finding) => finding.rule)

    expect(rules).toEqual(["icon-button-label", "img-alt", "click-non-interactive", "control-label", "dialog-outside-ui"])
  })

  it("has no findings outside reasoned a11y-allow lines", () => {
    expect(findings).toEqual([])
  })
})
