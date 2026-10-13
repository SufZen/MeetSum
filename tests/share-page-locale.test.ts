import { readFileSync } from "node:fs"
import { renderToStaticMarkup } from "react-dom/server"
import type { ReactElement } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  loadClipShare: vi.fn(),
  loadShare: vi.fn(),
  loadSharePageData: vi.fn(),
  cookie: undefined as string | undefined,
  acceptLanguage: null as string | null,
}))

vi.mock("@/app/share/[token]/load-share", () => ({
  loadClipShare: mocks.loadClipShare,
  loadShare: mocks.loadShare,
}))
vi.mock("@/lib/sharing/share-payload", () => ({ loadSharePageData: mocks.loadSharePageData }))
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "meetsum_locale" && mocks.cookie ? { value: mocks.cookie } : undefined) }),
  headers: async () => new Headers(mocks.acceptLanguage ? { "accept-language": mocks.acceptLanguage } : {}),
}))
vi.mock("@/lib/auth/session", () => ({ getSessionSecret: () => "secret" }))
// next/font/local is a build-time transform; the layout only needs the class names.
vi.mock("@/lib/fonts", () => ({ fontVariables: "font-vars" }))
vi.mock("@/components/share/shared-meeting-player", () => ({ SharedMeetingPlayer: () => null }))

import ShareLayout, { dynamic as layoutDynamic } from "@/app/share/[token]/layout"
import ShareNotFound from "@/app/share/[token]/not-found"
import PublicMeetingSharePage, { dynamic as pageDynamic } from "@/app/share/[token]/page"
import { resolveShareViewerLocale } from "@/lib/sharing/share-viewer-locale"

/**
 * M9 B7: the share page chrome follows the viewer (`?lang=` → cookie →
 * Accept-Language → meeting language → he) while content keeps the meeting
 * language; the password gate is localized; nothing is cached.
 */

const TOKEN = "b".repeat(32)

const hebrewPayload = {
  title: "פגישת צוות שבועית",
  startedAt: "2026-10-13T06:30:00.000Z",
  source: "upload",
  language: "he",
  lang: "he" as const,
  durationMs: 4_800_000,
  participants: ["דנה לוי", "Dana Levi"],
  overview: "פגישה עם Lisboa 12 משתתפים",
  decisions: ["התקציב (Q4) אושר"],
  actionItems: [{ key: "ai_1", title: "לשלוח את הסיכום", owner: "Dana Levi", dueDate: "2026-10-20", priority: "high" as const }],
}

async function renderPage(searchParams: Record<string, string> = {}) {
  const element = (await PublicMeetingSharePage({
    params: Promise.resolve({ token: TOKEN }),
    searchParams: Promise.resolve(searchParams),
  })) as ReactElement

  return renderToStaticMarkup(element)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.cookie = undefined
  mocks.acceptLanguage = null
  mocks.loadClipShare.mockResolvedValue({ kind: "not_clip" })
  mocks.loadShare.mockResolvedValue({ share: {}, meeting: { language: "he", title: "פגישה" } })
})

describe("resolveShareViewerLocale", () => {
  it("prefers ?lang=, then the cookie, then Accept-Language, then the meeting, then he", () => {
    expect(resolveShareViewerLocale({ lang: "en", cookie: "he", acceptLanguage: "he", meetingLocale: "he" })).toBe("en")
    expect(resolveShareViewerLocale({ lang: "pt", cookie: "en", meetingLocale: "he" })).toBe("en")
    expect(resolveShareViewerLocale({ cookie: "es", acceptLanguage: "en-US,he;q=0.5", meetingLocale: "he" })).toBe("en")
    expect(resolveShareViewerLocale({ acceptLanguage: "fr-FR, *", meetingLocale: "en" })).toBe("en")
    expect(resolveShareViewerLocale({ acceptLanguage: "iw" })).toBe("he")
    expect(resolveShareViewerLocale({})).toBe("he")
    expect(resolveShareViewerLocale({ lang: ["en", "he"] })).toBe("en")
  })
})

describe("share page chrome vs content", () => {
  it("renders English chrome for ?lang=en while the Hebrew content keeps lang=he dir=rtl", async () => {
    mocks.loadSharePageData.mockResolvedValue({ status: "ok", payload: hebrewPayload })

    const html = await renderPage({ lang: "en" })

    expect(html).toMatch(/<main lang="en" dir="ltr"/)
    expect(html).toContain(">Overview<")
    expect(html).toContain(">Decisions<")
    expect(html).toContain("2 participants")
    expect(html).toContain("High priority")
    expect(html).toMatch(/<h1 lang="he" dir="rtl"[^>]*>פגישת צוות שבועית<\/h1>/)
    expect(html).toMatch(/<p lang="he" dir="rtl"[^>]*>פגישה עם Lisboa‏ 12 משתתפים<\/p>/)
    expect(html).toContain("<bdi>Dana Levi</bdi>")
    expect(html).toContain("Due <bdi>2026-10-20</bdi>")
    expect(html).toContain("1 hr 20 min")
  })

  it("renders Hebrew chrome from Accept-Language with a Hebrew dual and Western digits", async () => {
    mocks.acceptLanguage = "he-IL,he;q=0.9"
    mocks.loadSharePageData.mockResolvedValue({ status: "ok", payload: hebrewPayload })

    const html = await renderPage()

    expect(html).toMatch(/<main lang="he" dir="rtl"/)
    expect(html).toContain(">סקירה<")
    expect(html).toContain("שני משתתפים")
    expect(html).toContain("שעה ו־20 דקות")
    expect(html).toContain("יעד: <bdi>2026-10-20</bdi>")
    expect(html).not.toMatch(/[٠-٩]/)
  })

  it("follows the cookie over Accept-Language", async () => {
    mocks.cookie = "en"
    mocks.acceptLanguage = "he"
    mocks.loadSharePageData.mockResolvedValue({ status: "ok", payload: hebrewPayload })

    expect(await renderPage()).toMatch(/<main lang="en" dir="ltr"/)
  })
})

describe("password gate", () => {
  it("is localized in Hebrew with the invalid-password error", async () => {
    mocks.loadSharePageData.mockResolvedValue({ status: "password_required" })

    const html = await renderPage({ error: "invalid" })

    expect(html).toMatch(/<main lang="he" dir="rtl"/)
    expect(html).toContain("הפגישה מוגנת בסיסמה")
    expect(html).toContain("פתיחת הפגישה")
    expect(html).toMatch(/role="alert"[^>]*>הסיסמה שגויה</)
    expect(html).toContain(`action="/api/share/${TOKEN}/verify"`)
    expect(html).not.toContain("פגישת צוות שבועית")
  })

  it("is localized in English with the rate-limit error and ignores unknown codes", async () => {
    mocks.loadSharePageData.mockResolvedValue({ status: "password_required" })

    expect(await renderPage({ lang: "en", error: "rate_limited" })).toContain("Too many attempts")
    expect(await renderPage({ lang: "en", error: "<script>" })).not.toContain("role=\"alert\"")
  })
})

describe("share layout and states", () => {
  it("sets <html lang dir> from the viewer, not the meeting", async () => {
    mocks.cookie = "en"
    mocks.loadShare.mockResolvedValue({ share: {}, meeting: { language: "he", title: "פגישה" } })

    const html = renderToStaticMarkup(
      (await ShareLayout({ children: null, params: Promise.resolve({ token: TOKEN }) })) as ReactElement
    )

    expect(html).toMatch(/<html lang="en" dir="ltr"/)
  })

  it("falls back to the meeting language for <html> without cookie or header", async () => {
    mocks.loadShare.mockResolvedValue({ share: {}, meeting: { language: "he", title: "פגישה" } })

    const html = renderToStaticMarkup(
      (await ShareLayout({ children: null, params: Promise.resolve({ token: TOKEN }) })) as ReactElement
    )

    expect(html).toMatch(/<html lang="he" dir="rtl"/)
  })

  it("renders a localized not-found that never says why", async () => {
    mocks.acceptLanguage = "en"
    const html = renderToStaticMarkup((await ShareNotFound()) as ReactElement)

    expect(html).toContain("The link is unavailable or has expired")
    mocks.acceptLanguage = "he"
    expect(renderToStaticMarkup((await ShareNotFound()) as ReactElement)).toContain("הקישור אינו זמין או שפג תוקפו")
  })

  it("is never statically cached and the error page never prints error.message", () => {
    expect(layoutDynamic).toBe("force-dynamic")
    expect(pageDynamic).toBe("force-dynamic")

    const errorPage = readFileSync("app/share/[token]/error.tsx", "utf8")

    expect(errorPage).not.toMatch(/error\.(message|stack)/)
  })

  it("keeps the client island off the runtime dictionaries object", () => {
    const island = readFileSync("components/share/shared-meeting-player.tsx", "utf8")

    expect(island).not.toMatch(/import\s*\{[^}]*\bdictionaries\b[^}]*\}\s*from\s*"@\/lib\/i18n\/dictionaries"/)
  })
})
