/**
 * Ask answer text -> renderable blocks (docs/parity/m6.md, D2; owner:
 * Package D). Pure and client-safe.
 *
 * Rendering contract (C8): plain text with a minimal markdown subset —
 * paragraphs, bullets and `**bold**`. Nothing else is interpreted: HTML,
 * images and links stay literal text, and the caller renders text nodes only.
 *
 * Citation markers `[s12]`, `[a3]`, `[s1, s2]` and `[s1][s2]` become chips
 * when the alias is one of `done.citations`; an unknown alias stays plain
 * text (the server already dropped it from the citations, so it is never a
 * chip — no citation, no claim).
 */
import type { AskCitation } from "@/lib/ask/types"

export type AnswerInline =
  | { type: "text"; text: string; bold?: boolean }
  | { type: "cite"; citation: AskCitation }

export type AnswerBlock =
  | { type: "paragraph"; inlines: AnswerInline[] }
  | { type: "list"; items: AnswerInline[][] }

const MARKER = /\[\s*([sa]\d+(?:\s*[,،;]\s*[sa]\d+)*)\s*\]/gi
const BULLET = /^\s*(?:[-*•]|\d{1,2}[.)])\s+/

function citationMap(citations: readonly AskCitation[]): Map<string, AskCitation> {
  const map = new Map<string, AskCitation>()

  for (const citation of citations) {
    if (citation?.alias) map.set(citation.alias.toLowerCase(), citation)
  }

  return map
}

function pushText(out: AnswerInline[], text: string, bold: boolean) {
  if (!text) return

  const last = out[out.length - 1]

  if (last?.type === "text" && Boolean(last.bold) === bold) {
    last.text += text
    return
  }
  out.push(bold ? { type: "text", text, bold: true } : { type: "text", text })
}

function pushCite(out: AnswerInline[], citation: AskCitation) {
  // `[s1][s1]` or `[s1] [s1]`: one chip.
  for (let index = out.length - 1; index >= 0; index -= 1) {
    const item = out[index]

    if (item.type === "cite") {
      if (item.citation.alias === citation.alias) return
      break
    }
    if (item.text.trim()) break
  }
  out.push({ type: "cite", citation })
}

function inlineMarkers(text: string, bold: boolean, map: Map<string, AskCitation>, out: AnswerInline[]) {
  let cursor = 0

  for (const match of text.matchAll(MARKER)) {
    const index = match.index ?? 0
    const aliases = match[1].split(/\s*[,،;]\s*/).map((alias) => alias.toLowerCase())
    const known = aliases.map((alias) => map.get(alias))

    pushText(out, text.slice(cursor, index), bold)

    if (known.every((citation) => !citation)) {
      pushText(out, match[0], bold)
    } else {
      aliases.forEach((alias, position) => {
        const citation = known[position]

        if (citation) pushCite(out, citation)
        else pushText(out, `[${alias}]`, bold)
      })
    }
    cursor = index + match[0].length
  }
  pushText(out, text.slice(cursor), bold)
}

function parseInlines(line: string, map: Map<string, AskCitation>): AnswerInline[] {
  const out: AnswerInline[] = []
  const pieces = line.split("**")
  // An odd number of `**` leaves the last one unmatched: keep it literal.
  const balanced = pieces.length % 2 === 1

  pieces.forEach((piece, index) => {
    const bold = index % 2 === 1

    if (bold && !balanced && index === pieces.length - 1) {
      inlineMarkers(`**${piece}`, false, map, out)
      return
    }
    inlineMarkers(piece, bold, map, out)
  })

  return out
}

function trimInlines(inlines: AnswerInline[]): AnswerInline[] {
  const out = inlines.filter((inline) => inline.type === "cite" || inline.text.length > 0)
  const first = out[0]
  const last = out[out.length - 1]

  if (first?.type === "text") first.text = first.text.replace(/^\s+/, "")
  if (last?.type === "text") last.text = last.text.replace(/\s+$/, "")

  return out.filter((inline) => inline.type === "cite" || inline.text.length > 0)
}

export function segmentAnswer(text: string, citations: readonly AskCitation[]): AnswerBlock[] {
  const map = citationMap(citations)
  const blocks: AnswerBlock[] = []
  let paragraph: string[] = []
  let list: string[] = []

  const flushParagraph = () => {
    if (!paragraph.length) return

    const inlines = trimInlines(parseInlines(paragraph.join(" "), map))

    if (inlines.length) blocks.push({ type: "paragraph", inlines })
    paragraph = []
  }
  const flushList = () => {
    if (!list.length) return

    const items = list.map((item) => trimInlines(parseInlines(item, map))).filter((item) => item.length)

    if (items.length) blocks.push({ type: "list", items })
    list = []
  }

  for (const rawLine of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.trim()

    if (!line) {
      flushParagraph()
      flushList()
      continue
    }
    if (BULLET.test(line)) {
      flushParagraph()
      list.push(line.replace(BULLET, ""))
      continue
    }
    flushList()
    paragraph.push(line)
  }
  flushParagraph()
  flushList()

  return blocks
}

/** The chips actually shown, in order of first appearance. */
export function citedCitations(blocks: readonly AnswerBlock[]): AskCitation[] {
  const seen = new Set<string>()
  const out: AskCitation[] = []
  const visit = (inlines: readonly AnswerInline[]) => {
    for (const inline of inlines) {
      if (inline.type === "cite" && !seen.has(inline.citation.alias)) {
        seen.add(inline.citation.alias)
        out.push(inline.citation)
      }
    }
  }

  for (const block of blocks) {
    if (block.type === "paragraph") visit(block.inlines)
    else block.items.forEach(visit)
  }

  return out
}

/** Provisional (streaming) text: markers removed, whitespace tidied. */
export function stripCitationMarkers(text: string): string {
  return text
    .replace(MARKER, "")
    .replace(/\[\s*[sa]\d*$/i, "") // a marker still arriving
    .replace(/[ \t]+([.,;:!?،])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
}

/** Copy text: markers become `[n]`, followed by one source line per chip. */
export function answerCopyText(
  text: string,
  citations: readonly AskCitation[],
  linkFor: (citation: AskCitation) => string | undefined
): string {
  const map = citationMap(citations)
  const used: AskCitation[] = []
  const body = text.replace(MARKER, (whole, group: string) => {
    const found = group
      .split(/\s*[,،;]\s*/)
      .map((alias) => map.get(alias.toLowerCase()))
      .filter((citation): citation is AskCitation => Boolean(citation))

    if (!found.length) return whole

    for (const citation of found) if (!used.includes(citation)) used.push(citation)

    return found.map((citation) => `[${citation.n}]`).join("")
  })
  const sources = used
    .filter((citation) => !citation.unavailable)
    .map((citation) => {
      const link = linkFor(citation)

      return `[${citation.n}] ${citation.meetingTitle}${link ? ` ${link}` : ""}`
    })

  return sources.length ? `${body.trim()}\n\n${sources.join("\n")}` : body.trim()
}
