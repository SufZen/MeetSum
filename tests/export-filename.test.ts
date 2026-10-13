import { describe, expect, it } from "vitest"

import {
  contentDispositionAttachment,
  exportFileBaseName,
  filenameFromContentDisposition,
} from "@/lib/http/content-disposition"

/**
 * M8 C3: every export route names its file through
 * `contentDispositionAttachment` (RFC 6266 + RFC 5987), so Hebrew titles
 * survive and the client reads the name from the header, never a regex.
 */
describe("contentDispositionAttachment", () => {
  it("keeps a Hebrew title in filename* and gives an ASCII fallback", () => {
    const header = contentDispositionAttachment("פגישת צוות שבועית", "docx")

    expect(header).toMatch(/^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''/)
    expect(header).toContain(`filename*=UTF-8''${encodeURIComponent("פגישת צוות שבועית.docx")}`)
    expect(header).toContain('filename="meetsum-export.docx"')
  })

  it("keeps the ASCII part of a mixed title in the fallback", () => {
    const header = contentDispositionAttachment("Q4 תכנון roadmap", "pdf")

    expect(header).toContain('filename="Q4-roadmap.pdf"')
    expect(filenameFromContentDisposition(header)).toBe("Q4 תכנון roadmap.pdf")
  })

  it("strips quotes, backslashes, CR/LF and control characters (no header injection)", () => {
    const header = contentDispositionAttachment('a"b\\c\r\nSet-Cookie: x=1\u0000', "md")

    expect(header).not.toMatch(/[\r\n\u0000]/)
    expect(header.match(/"/g)).toHaveLength(2)
    expect(header).not.toContain("\\")
    expect(filenameFromContentDisposition(header)).toBe("abc Set-Cookie: x=1.md")
  })

  it("percent-encodes the RFC 5987 attr-char exceptions", () => {
    const header = contentDispositionAttachment("Plan (v2) * final's", "md")
    const star = /filename\*=UTF-8''(\S+)/.exec(header)?.[1] ?? ""

    expect(star).not.toMatch(/[()*' ]/)
    expect(decodeURIComponent(star)).toBe("Plan (v2) * final's.md")
  })

  it("falls back to meetsum-export for an empty title", () => {
    expect(exportFileBaseName("  \r\n ")).toBe("meetsum-export")
    expect(contentDispositionAttachment("", "pdf")).toContain('filename="meetsum-export.pdf"')
  })

  it("caps very long titles without splitting a surrogate pair", () => {
    const base = exportFileBaseName("😀".repeat(200))

    expect([...base].every((char) => char === "😀")).toBe(true)
    expect(base.length).toBeLessThanOrEqual(240)
  })
})

describe("filenameFromContentDisposition", () => {
  it("prefers filename* over filename", () => {
    expect(
      filenameFromContentDisposition(`attachment; filename="x.docx"; filename*=UTF-8''%D7%A9%D7%9C%D7%95%D7%9D.docx`)
    ).toBe("שלום.docx")
  })

  it("reads a plain quoted filename and tolerates junk", () => {
    expect(filenameFromContentDisposition('attachment; filename="report.pdf"')).toBe("report.pdf")
    expect(filenameFromContentDisposition("attachment; filename*=UTF-8''%E0%A4%A")).toBeUndefined()
    expect(filenameFromContentDisposition(null)).toBeUndefined()
  })

  it("never returns a path", () => {
    expect(filenameFromContentDisposition(`attachment; filename*=UTF-8''..%2F..%2Fetc%2Fpasswd`)).toBe("....etcpasswd")
  })
})
