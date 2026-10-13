/**
 * Prompt-injection hygiene for Ask data (docs/parity/m6.md, C3).
 *
 * Meeting content (segment text, titles, speaker names, intelligence items)
 * is untrusted data. It goes inside `<passage>` blocks, so:
 * - `<` becomes `‹` exactly as M5's transcript formatter does
 *   (`neutralizeData`), and `>` becomes `›`, so the data can never close its
 *   block (`</passage>`), open `<question>` or fake a system tag;
 * - alias lookalikes inside data (`[s99]`, `[a3]`, `[s12 03:41 x]`) become
 *   `(s99)` so the model can't be tricked into citing a fabricated alias and
 *   our marker parser never sees them as citations;
 * - bidi controls are stripped (text can't visually reorder itself), and
 *   names also lose zero-width characters.
 */
import { neutralizeData } from "@/lib/ai/prompts/data-block"

const BIDI_CONTROLS = /[‪-‮⁦-⁩]/g
const ZERO_WIDTH = /[​-‍⁠﻿]/g
const BRACKET_ALIAS = /\[\s*([sa]\d+)\s*\]/gi
const BRACKET_ALIAS_LINE = /\[(?=\s*[sa]\d+[\s,;])/gi

/** Untrusted passage text: safe inside a data tag, no alias lookalikes. */
export function sanitizeData(text: string): string {
  return neutralizeData(text.replace(BIDI_CONTROLS, ""))
    .replace(/>/g, "›")
    .replace(BRACKET_ALIAS, "($1)")
    .replace(BRACKET_ALIAS_LINE, "(")
}

/** One line of passage text (whitespace collapsed). */
export function sanitizeLine(text: string): string {
  return sanitizeData(text.replace(/\s+/g, " ").trim())
}

/** Speaker names and other short labels: no brackets, no invisible characters. */
export function sanitizeName(name: string): string {
  return sanitizeLine(name.replace(ZERO_WIDTH, "").replace(/[[\]]/g, ""))
}

/** A value inside a double-quoted pseudo-attribute (`meeting="…"`). */
export function sanitizeAttribute(value: string): string {
  return sanitizeName(value).replace(/"/g, "״").slice(0, 200)
}

/**
 * The user's own question goes inside `<question>`: it is not meeting data,
 * but `<` is still neutralized so it can't close the tag.
 */
export function sanitizeQuestion(question: string): string {
  return neutralizeData(question.replace(BIDI_CONTROLS, "")).replace(/>/g, "›").trim()
}

/**
 * Model output is rendered as plain text with a minimal markdown subset
 * (paragraphs, bullets, bold). Images, links and HTML tags are removed so a
 * passage that smuggled `![x](https://evil)` can't turn into a request.
 */
export function stripUnsafeMarkdown(text: string): string {
  return text
    .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, "")
    .replace(/\[([^\]\n]*)\]\((?:[a-z][a-z0-9+.-]*:|\/|www\.)[^)\n]*\)/gi, "$1")
    .replace(/<\/?[a-z][^>\n]*>/gi, "")
    .replace(/\bhttps?:\/\/\S+/gi, "")
}
