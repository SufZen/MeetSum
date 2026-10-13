import { inflateSync } from "node:zlib"

/**
 * Minimal PDF reader for the M9 PDF tests: enough of pdfkit's output to check
 * what a reader sees. It inflates streams, maps Type0 glyph ids back to
 * Unicode through each font's ToUnicode CMap and returns every page's text in
 * **visual** order (lines top to bottom, runs left to right), plus the raw
 * objects for font-embedding checks. Not a general-purpose parser.
 */

export type PdfObject = { id: number; dict: string; stream?: Buffer }

export type PdfTextRun = { x: number; y: number; text: string; font: string }

export type ParsedPdf = {
  header: string
  objects: Map<number, PdfObject>
  /** BaseFont names of every embedded font (e.g. `ABCDEF+IBMPlexSansHebrew`). */
  baseFonts: string[]
  /** Font name → ToUnicode map (glyph id → string). */
  toUnicode: Map<string, Map<number, string>>
  pages: Array<{ runs: PdfTextRun[]; lines: string[] }>
}

function parseObjects(pdf: Buffer): Map<number, PdfObject> {
  const text = pdf.toString("latin1")
  const objects = new Map<number, PdfObject>()
  const re = /(\d+) 0 obj\s*([\s\S]*?)endobj/g

  for (let match = re.exec(text); match; match = re.exec(text)) {
    const id = Number(match[1])
    const body = match[2]!
    const streamAt = body.indexOf("stream")
    const bodyStart = match.index + match[0].indexOf(body)

    if (streamAt >= 0 && /\/Length/.test(body.slice(0, streamAt))) {
      const dict = body.slice(0, streamAt)
      let dataStart = bodyStart + streamAt + "stream".length

      if (text[dataStart] === "\r") dataStart += 1
      if (text[dataStart] === "\n") dataStart += 1

      const length = Number(/\/Length (\d+)/.exec(dict)?.[1] ?? 0)
      let data = pdf.subarray(dataStart, dataStart + length)

      if (/\/Filter \/FlateDecode/.test(dict)) data = inflateSync(data)

      objects.set(id, { id, dict, stream: data })
    } else {
      objects.set(id, { id, dict: body })
    }
  }

  return objects
}

function hexToString(hex: string): string {
  const units = hex.trim().split(/\s+/).map((part) => Number.parseInt(part, 16))

  return String.fromCharCode(...units)
}

function parseToUnicode(cmap: string): Map<number, string> {
  const map = new Map<number, string>()

  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const range of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[^\]]*\]|<[^>]*>)/g)) {
      const start = Number.parseInt(range[1]!, 16)
      const end = Number.parseInt(range[2]!, 16)
      const target = range[3]!

      if (target.startsWith("[")) {
        const entries = [...target.matchAll(/<([^>]*)>/g)].map((entry) => hexToString(entry[1]!))

        for (let gid = start; gid <= end; gid++) map.set(gid, entries[gid - start] ?? "")
      } else {
        const base = Number.parseInt(target.slice(1, -1), 16)

        for (let gid = start; gid <= end; gid++) map.set(gid, String.fromCharCode(base + gid - start))
      }
    }
  }

  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const entry of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([^>]*)>/g)) {
      map.set(Number.parseInt(entry[1]!, 16), hexToString(entry[2]!))
    }
  }

  return map
}

function ref(dict: string, key: string): number | undefined {
  const match = new RegExp(`/${key} (\\d+) 0 R`).exec(dict)

  return match ? Number(match[1]) : undefined
}

/** Glyph ids from a TJ array or Tj string (`<0012003a>` → [0x12, 0x3a]). */
function glyphIds(operand: string): number[] {
  const ids: number[] = []

  for (const hex of operand.matchAll(/<([0-9a-fA-F]*)>/g)) {
    for (let i = 0; i + 4 <= hex[1]!.length; i += 4) ids.push(Number.parseInt(hex[1]!.slice(i, i + 4), 16))
  }

  return ids
}

export function parsePdf(pdf: Buffer): ParsedPdf {
  const objects = parseObjects(pdf)
  const header = pdf.subarray(0, 8).toString("latin1")
  const baseFonts: string[] = []
  const toUnicode = new Map<string, Map<number, string>>()
  const fontsById = new Map<number, string>()

  for (const object of objects.values()) {
    if (!/\/Type \/Font/.test(object.dict) || !/\/Subtype \/Type0/.test(object.dict)) continue

    const name = /\/BaseFont \/([^\s/>]+)/.exec(object.dict)?.[1] ?? ""
    const cmapId = ref(object.dict, "ToUnicode")
    const cmap = cmapId ? objects.get(cmapId)?.stream?.toString("latin1") : undefined

    baseFonts.push(name)
    fontsById.set(object.id, name)
    toUnicode.set(name, cmap ? parseToUnicode(cmap) : new Map())
  }

  const pages: ParsedPdf["pages"] = []
  const pageObjects = [...objects.values()].filter((object) => /\/Type \/Page\b/.test(object.dict))

  for (const page of pageObjects) {
    let resources = page.dict
    const resourcesId = ref(page.dict, "Resources")

    if (resourcesId) resources = objects.get(resourcesId)?.dict ?? ""

    const fontDict = /\/Font\s*<<([\s\S]*?)>>/.exec(resources)?.[1] ?? ""
    const fontNames = new Map<string, string>()

    for (const entry of fontDict.matchAll(/\/(\w+) (\d+) 0 R/g)) {
      fontNames.set(entry[1]!, fontsById.get(Number(entry[2])) ?? "")
    }

    const contentsId = ref(page.dict, "Contents")
    const content = contentsId ? (objects.get(contentsId)?.stream?.toString("latin1") ?? "") : ""
    const runs: PdfTextRun[] = []

    for (const block of content.matchAll(/BT\b([\s\S]*?)\bET/g)) {
      const body = block[1]!
      const tm = /1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm/.exec(body)
      const fontRef = /\/(\w+) [\d.]+ Tf/.exec(body)?.[1] ?? ""
      const font = fontNames.get(fontRef) ?? ""
      const map = toUnicode.get(font) ?? new Map<number, string>()
      let text = ""

      for (const op of body.matchAll(/(\[[^\]]*\])\s*TJ|(<[^>]*>)\s*Tj/g)) {
        text += glyphIds(op[1] ?? op[2] ?? "")
          .map((gid) => map.get(gid) ?? "�")
          .join("")
      }

      if (tm && text) runs.push({ x: Number(tm[1]), y: Number(tm[2]), text, font })
    }

    const rows = new Map<number, PdfTextRun[]>()

    for (const run of runs) {
      const key = Math.round(run.y)
      const row = [...rows.keys()].find((candidate) => Math.abs(candidate - key) <= 2) ?? key

      rows.set(row, [...(rows.get(row) ?? []), run])
    }

    const lines = [...rows.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([, row]) => row.sort((a, b) => a.x - b.x).map((run) => run.text).join(""))

    pages.push({ runs, lines })
  }

  return { header, objects, baseFonts, toUnicode, pages }
}

/** Decodes a PDF string literal or hex string (UTF-16BE with BOM, or PDFDocEncoding). */
export function decodePdfString(raw: string): string {
  let bytes: number[]

  if (raw.startsWith("<")) {
    const hex = raw.slice(1, -1).replace(/\s+/g, "")

    bytes = hex.match(/../g)?.map((pair) => Number.parseInt(pair, 16)) ?? []
  } else {
    bytes = []
    const body = raw.slice(1, -1)

    for (let i = 0; i < body.length; i++) {
      const char = body[i]!

      if (char !== "\\") {
        bytes.push(char.charCodeAt(0))
        continue
      }

      const next = body[i + 1]!
      const octal = /^[0-7]{1,3}/.exec(body.slice(i + 1))

      if (octal) {
        bytes.push(Number.parseInt(octal[0], 8))
        i += octal[0].length
      } else {
        const escapes: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12 }

        bytes.push(escapes[next] ?? next.charCodeAt(0))
        i += 1
      }
    }
  }

  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = ""

    for (let i = 2; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!)

    return out
  }

  return String.fromCharCode(...bytes)
}

/** `/Key (…)` or `/Key <…>` from the document's Info dictionary. */
export function infoValue(pdf: ParsedPdf, key: string): { raw: string; text: string } | undefined {
  for (const object of pdf.objects.values()) {
    if (!/\/(Producer|Creator)\b/.test(object.dict)) continue

    const literal = String.raw`(\((?:\\.|[^\\)])*\)|<[0-9a-fA-F\s]*>)`
    const reference = new RegExp(String.raw`/${key} (\d+) 0 R`).exec(object.dict)
    const match = reference
      ? new RegExp(String.raw`^\s*${literal}`).exec(pdf.objects.get(Number(reference[1]))?.dict ?? "")
      : new RegExp(String.raw`/${key}\s*${literal}`).exec(object.dict)

    if (match) return { raw: match[1]!, text: decodePdfString(match[1]!) }
  }

  return undefined
}

/** Reverses a purely RTL logical string into its visual form (no marks). */
export function visualRtl(logical: string): string {
  return [...logical].reverse().join("")
}
