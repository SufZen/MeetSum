import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"

const { toastMock } = vi.hoisted(() => ({
  toastMock: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(() => "toast_1"),
    dismiss: vi.fn(),
  }),
}))

vi.mock("sonner", () => ({ toast: toastMock }))

import { exportMenuModel, MeetingExportMenu } from "@/components/meetings/meeting-export-menu"
import {
  downloadExport,
  downloadFilename,
  exportToGoogleDocs,
  sendTargetsFrom,
  sendToIntegration,
} from "@/lib/client/download-export"
import { contentDispositionAttachment } from "@/lib/http/content-disposition"

/**
 * M8 C3 export menu: Download (PDF, Markdown, DOCX) with the server's
 * filename, Google Docs with a connect fallback, and "Send to…" only for
 * writers, and for private meetings only when the viewer can manage them.
 */

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe("exportMenuModel", () => {
  it("offers DOCX next to PDF and Markdown", () => {
    expect(exportMenuModel({ visibility: "workspace", canManage: false, canWrite: true }).download).toEqual([
      "pdf",
      "markdown",
      "docx",
    ])
  })

  it("hides Send to for a private meeting the viewer cannot manage, with a hint", () => {
    expect(exportMenuModel({ visibility: "private", canManage: false, canWrite: true })).toMatchObject({
      sendTo: false,
      privateSendHint: true,
      googleDocs: true,
    })
    expect(exportMenuModel({ visibility: undefined, canManage: false, canWrite: true }).sendTo).toBe(false)
    expect(exportMenuModel({ visibility: "private", canManage: true, canWrite: true }).sendTo).toBe(true)
  })

  it("shows viewers (no meeting:write) Download and Docs only", () => {
    expect(exportMenuModel({ visibility: "workspace", canManage: false, canWrite: false })).toMatchObject({
      sendTo: false,
      privateSendHint: false,
      googleDocs: true,
    })
  })
})

describe("MeetingExportMenu render", () => {
  it("renders an RTL Hebrew menu button for the he locale and an LTR one for en", () => {
    const he = renderToStaticMarkup(
      createElement(MeetingExportMenu, {
        meetingId: "m_1",
        title: "פגישה",
        language: "he",
        visibility: "workspace",
        canManage: true,
        canWrite: true,
        locale: "he",
      })
    )
    const en = renderToStaticMarkup(
      createElement(MeetingExportMenu, {
        meetingId: "m_1",
        title: "Meeting",
        language: "he",
        visibility: "workspace",
        canManage: true,
        canWrite: true,
        locale: "en",
      })
    )

    expect(he).toMatch(/<button[^>]*dir="rtl"/)
    expect(he).toContain("ייצוא")
    expect(he).toContain('aria-haspopup="menu"')
    expect(en).toMatch(/<button[^>]*dir="ltr"/)
    expect(en).toContain("Export")
  })

  it("is disabled until a meeting is selected", () => {
    const html = renderToStaticMarkup(
      createElement(MeetingExportMenu, {
        meetingId: undefined,
        title: "",
        language: "",
        visibility: undefined,
        canManage: false,
        locale: "en",
      })
    )

    expect(html).toMatch(/<button[^>]*disabled/)
  })
})

describe("downloadExport", () => {
  function stubDom() {
    const anchor = { href: "", download: "", click: vi.fn() }

    vi.stubGlobal("document", { createElement: vi.fn(() => anchor) })
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:1")
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {})

    return anchor
  }

  it("downloads DOCX with the Hebrew filename from Content-Disposition", async () => {
    const anchor = stubDom()
    const fetchImpl = vi.fn(async () =>
      new Response(new Uint8Array([0x50, 0x4b]), {
        headers: { "content-disposition": contentDispositionAttachment("סיכום פגישה: Q4", "docx") },
      })
    )

    await expect(downloadExport({ id: "m_1", title: "ignored" }, "docx", { fetchImpl, locale: "he" })).resolves.toBe(true)
    expect(fetchImpl).toHaveBeenCalledWith("/api/meetings/m_1/export/docx?locale=he", { method: "POST" })
    expect(anchor.download).toBe("סיכום פגישה- Q4.docx")
    expect(anchor.click).toHaveBeenCalled()
    expect(toastMock.success).toHaveBeenCalledWith("קובץ Word‏ (DOCX) ירד")
  })

  it("falls back to the Unicode title (never a regex-stripped name) and toasts a failure", async () => {
    expect(downloadFilename(null, "פגישת צוות", "markdown")).toBe("פגישת צוות.md")

    stubDom()
    const failed = await downloadExport({ id: "m_1", title: "x" }, "pdf", {
      fetchImpl: vi.fn(async () => new Response("{}", { status: 500 })),
      locale: "en",
    })

    expect(failed).toBe(false)
    expect(toastMock.error).toHaveBeenCalledWith("Could not export PDF")
  })
})

describe("Google Docs and Send to helpers", () => {
  it("returns the connect URL on 409 and only for the OAuth start path", async () => {
    const connect = await exportToGoogleDocs("m_1", {
      fetchImpl: vi.fn(async () =>
        Response.json(
          { error: "google_docs_not_connected", connectUrl: "/api/integrations/google_drive/oauth/start?returnTo=%2Fhe" },
          { status: 409 }
        )
      ),
    })
    const evil = await exportToGoogleDocs("m_1", {
      fetchImpl: vi.fn(async () => Response.json({ connectUrl: "https://evil.example.com" }, { status: 409 })),
    })
    const done = await exportToGoogleDocs("m_1", {
      forceNew: true,
      fetchImpl: vi.fn(async (url: string | URL | Request) => {
        expect(String(url)).toBe("/api/meetings/m_1/export/google-docs?new=1")

        return Response.json({ documentId: "doc_1", url: "https://docs.google.com/document/d/doc_1/edit", updated: false })
      }),
    })

    expect(connect).toEqual({ kind: "connect", connectUrl: "/api/integrations/google_drive/oauth/start?returnTo=%2Fhe" })
    expect(evil).toEqual({ kind: "error" })
    expect(done).toMatchObject({ kind: "done", documentId: "doc_1" })
  })

  it("lists only active Slack/Notion/HubSpot connections that allow manual sends", () => {
    expect(
      sendTargetsFrom({
        connections: [
          { id: "c1", provider: "slack", status: "active", accountLabel: "Acme", config: {} },
          { id: "c2", provider: "notion", status: "needs_reauth", accountLabel: "N", config: {} },
          { id: "c3", provider: "hubspot", status: "active", accountLabel: "H", config: { allowManualSend: false } },
          { id: "c4", provider: "microsoft", status: "active", accountLabel: "M", config: {} },
          { id: "c5", provider: "notion", status: "active", accountLabel: "צוות", config: { allowManualSend: true } },
        ],
      })
    ).toEqual([
      { connectionId: "c1", provider: "slack", accountLabel: "Acme", needsDefault: true },
      { connectionId: "c5", provider: "notion", accountLabel: "צוות", needsDefault: true },
    ])
  })

  it("marks Slack/Notion targets without a default destination (HubSpot needs none)", () => {
    expect(
      sendTargetsFrom({
        connections: [
          { id: "s", provider: "slack", status: "active", accountLabel: "A", config: { defaultChannelId: "C1" } },
          { id: "n", provider: "notion", status: "active", accountLabel: "B", config: { defaultDatabaseId: "" } },
          { id: "h", provider: "hubspot", status: "active", accountLabel: "C", config: {} },
        ],
      })
    ).toEqual([
      { connectionId: "s", provider: "slack", accountLabel: "A" },
      { connectionId: "n", provider: "notion", accountLabel: "B", needsDefault: true },
      { connectionId: "h", provider: "hubspot", accountLabel: "C" },
    ])
  })

  it("sends with an Idempotency-Key and polls the delivery until it settles", async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    let polls = 0
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), ...(init ? { init } : {}) })
      if (String(url).endsWith("/integrations/send")) return Response.json({ deliveryId: "intd_9" }, { status: 202 })
      polls += 1

      return Response.json({ delivery: { id: "intd_9", status: polls < 2 ? "running" : "sent" } })
    }) as unknown as typeof fetch

    await expect(
      sendToIntegration("m_1", "c1", { fetchImpl, pollMs: 0, idempotencyKey: "33333333-aaaa-4bbb-8ccc-000000000001" })
    ).resolves.toBe("sent")
    expect(new Headers(calls[0].init?.headers).get("idempotency-key")).toBe("33333333-aaaa-4bbb-8ccc-000000000001")
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ connectionId: "c1" })
    expect(calls.slice(1).every((call) => call.url === "/api/integrations/deliveries/intd_9")).toBe(true)
  })
})
