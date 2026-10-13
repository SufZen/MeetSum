import { beforeEach, describe, expect, it, vi } from "vitest"

import { createTestCtx, jsonRequest, routeParams, setRouteCtx, testMeeting } from "./helpers/route-ctx"

vi.mock("@/lib/auth/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/authz")>()
  const { mockAuthzModule } = await import("./helpers/route-ctx")

  return mockAuthzModule(actual)
})

const i18n = vi.hoisted(() => ({ locale: "he" as "he" | "en", timeZone: "Asia/Jerusalem" }))

vi.mock("@/lib/i18n/server", () => ({
  getRequestI18n: vi.fn(async (options: { locale?: string } = {}) => ({
    locale: options.locale === "en" || options.locale === "he" ? options.locale : i18n.locale,
    dir: "rtl",
    timeZone: i18n.timeZone,
    dictionary: {},
  })),
}))

import { POST as exportDocx } from "@/app/api/meetings/[id]/export/docx/route"
import { POST as exportMarkdown } from "@/app/api/meetings/[id]/export/markdown/route"
import { POST as exportPdf } from "@/app/api/meetings/[id]/export/pdf/route"
import { filenameFromContentDisposition } from "@/lib/http/content-disposition"
import { parsePdf, visualRtl } from "@/tests/helpers/pdf-text"

const BASE = "http://localhost"

const meeting = testMeeting({
  id: "m_9a1b2c3d4e",
  title: "סיכום רבעוני",
  startedAt: "2026-10-13T06:30:00.000Z",
  transcript: [{ id: "s1", speaker: "דנה", startMs: 0, endMs: 2000, text: "שלום לכולם" }],
})

beforeEach(async () => {
  i18n.locale = "he"
  setRouteCtx(await createTestCtx({ role: "member", meetings: [meeting] }))
})

describe("export routes: Content-Disposition (M9 B3)", () => {
  const routes = [
    ["pdf", exportPdf, "application/pdf"],
    ["markdown", exportMarkdown, "text/markdown"],
    ["docx", exportDocx, "application/vnd.openxmlformats"],
  ] as const

  for (const [format, handler, type] of routes) {
    it(`${format}: keeps the Hebrew name in filename* with the dated ASCII fallback`, async () => {
      const response = await handler(
        jsonRequest(`${BASE}/api/meetings/${meeting.id}/export/${format}`, "POST", {}),
        routeParams({ id: meeting.id })
      )
      const header = response.headers.get("content-disposition") ?? ""
      const ext = format === "markdown" ? "md" : format

      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain(type)
      expect(header).toContain(`filename="meetsum-2026-10-13-m9a1b2c3.${ext}"`)
      expect(filenameFromContentDisposition(header)).toBe(`סיכום רבעוני.${ext}`)
    })
  }

  it("404s an invisible meeting without rendering", async () => {
    const response = await exportPdf(
      jsonRequest(`${BASE}/api/meetings/m_missing/export/pdf`, "POST", {}),
      routeParams({ id: "m_missing" })
    )

    expect(response.status).toBe(404)
  })
})

describe("PDF route: viewer locale", () => {
  it("uses the request locale for the chrome (Hebrew page numbers)", async () => {
    const response = await exportPdf(
      jsonRequest(`${BASE}/api/meetings/${meeting.id}/export/pdf`, "POST", {}),
      routeParams({ id: meeting.id })
    )
    const pdf = parsePdf(Buffer.from(await response.arrayBuffer()))
    const lines = pdf.pages.flatMap((page) => page.lines).join("\n")

    expect(pdf.header).toBe("%PDF-1.7")
    expect(lines).toContain(visualRtl("תמליל"))
    expect(lines).toContain(visualRtl("עמוד"))
  })

  it("honours ?locale=en from the export menu while the content stays Hebrew", async () => {
    const response = await exportPdf(
      jsonRequest(`${BASE}/api/meetings/${meeting.id}/export/pdf?locale=en`, "POST", {}),
      routeParams({ id: meeting.id })
    )
    const lines = parsePdf(Buffer.from(await response.arrayBuffer())).pages.flatMap((page) => page.lines).join("\n")

    expect(lines).toContain("Transcript")
    expect(lines).toContain("Page 1 of 1")
    expect(lines).toContain(visualRtl("שלום לכולם"))
  })
})
