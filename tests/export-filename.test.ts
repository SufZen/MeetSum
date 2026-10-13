import { describe, expect, it } from "vitest"

import {
  contentDispositionAttachment,
  exportAsciiFilename,
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
    expect(contentDispositionAttachment("פגישת צוות שבועית", "docx", { id: "abc" })).toContain('filename="meetsum-abc.docx"')
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
    expect(filenameFromContentDisposition(header)).toBe("a-b-c Set-Cookie- x=1.md")
  })

  it("percent-encodes the RFC 5987 attr-char exceptions", () => {
    const header = contentDispositionAttachment("Plan (v2) * final's", "md")
    const star = /filename\*=UTF-8''(\S+)/.exec(header)?.[1] ?? ""

    expect(star).not.toMatch(/[()*' ]/)
    expect(decodeURIComponent(star)).toBe("Plan (v2) - final's.md")
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
    expect(filenameFromContentDisposition(`attachment; filename*=UTF-8''..%2F..%2Fetc%2Fpasswd`)).toBe("..-..-etc-passwd")
  })
})

describe("M9 filename hardening", () => {
  const meta = { date: "2026-10-13T09:00:00.000Z", id: "m_8f3c2a91-77b0" }

  it("gives a Hebrew title the dated ASCII fallback with the id prefix", () => {
    const header = contentDispositionAttachment("פגישת צוות שבועית", "pdf", meta)

    expect(header).toContain('filename="meetsum-2026-10-13-m8f3c2a9.pdf"')
    expect(filenameFromContentDisposition(header)).toBe("פגישת צוות שבועית.pdf")
  })

  it("uses the dated fallback when the title has fewer than 3 ASCII letters", () => {
    expect(exportAsciiFilename("סיכום Q4", "md", meta)).toBe("meetsum-2026-10-13-m8f3c2a9.md")
    expect(exportAsciiFilename("סיכום Q4 roadmap", "md", meta)).toBe("Q4-roadmap.md")
    expect(exportAsciiFilename("שלום", "docx", { date: new Date("2026-01-02T23:00:00Z") })).toBe("meetsum-2026-01-02.docx")
    expect(exportAsciiFilename("שלום", "docx")).toBe("meetsum-export.docx")
  })


  it("strips bidi controls (RLO spoofing) from both names", () => {
    const spoof = "invoice‮fdp.exe"
    const header = contentDispositionAttachment(spoof, "pdf", meta)
    const decoded = filenameFromContentDisposition(header) ?? ""

    expect(decoded).toBe("invoicefdp.exe.pdf")
    expect(decoded).not.toMatch(/[؜‎‏‪-‮⁦-⁩]/)
    expect(contentDispositionAttachment("⁧שלום⁩ ‏עולם‎", "md")).toContain(
      encodeURIComponent("שלום עולם.md")
    )
    expect(filenameFromContentDisposition(`attachment; filename*=UTF-8''a%E2%80%AEb.pdf`)).toBe("ab.pdf")
  })

  it("replaces Windows-forbidden characters and strips C1 controls", () => {
    expect(exportFileBaseName('a<b>c:d"e/f\\g|h?i*j\u0085k')).toBe("a-b-c-d-e-f-g-h-i-jk")
  })

  it("prefixes Windows reserved device names", () => {
    expect(exportFileBaseName("CON")).toBe("_CON")
    expect(exportFileBaseName("nul")).toBe("_nul")
    expect(exportFileBaseName("com1")).toBe("_com1")
    expect(exportFileBaseName("LPT9.backup")).toBe("_LPT9.backup")
    expect(exportFileBaseName("Console")).toBe("Console")
    expect(filenameFromContentDisposition("attachment; filename*=UTF-8''aux.pdf")).toBe("_aux.pdf")
  })

  it("trims trailing dots and spaces and applies NFC", () => {
    expect(exportFileBaseName("notes. . .")).toBe("notes")
    expect(exportFileBaseName("été")).toBe("été")
  })

  it("caps a 300-character title at 120 code points with the extension after the cap", () => {
    const title = "פ".repeat(150) + "a".repeat(150)
    const header = contentDispositionAttachment(title, "pdf", meta)
    const decoded = filenameFromContentDisposition(header) ?? ""

    expect([...decoded.replace(/\.pdf$/, "")]).toHaveLength(120)
    expect(decoded.endsWith(".pdf")).toBe(true)
  })

  it("keeps an emoji title intact in filename* and falls back to the dated name", () => {
    const header = contentDispositionAttachment("🎉🎉 launch", "pdf", meta)

    expect(filenameFromContentDisposition(header)).toBe("🎉🎉 launch.pdf")
    expect(header).toContain('filename="launch.pdf"')
    expect(exportAsciiFilename("🎉 יום", "pdf", meta)).toBe("meetsum-2026-10-13-m8f3c2a9.pdf")
  })
})
