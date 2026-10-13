import { renderToStaticMarkup } from "react-dom/server"
import type { ReactElement } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  loadClipShare: vi.fn(),
  loadShare: vi.fn(),
  loadSharePageData: vi.fn(),
}))

vi.mock("@/app/share/[token]/load-share", () => ({
  loadClipShare: mocks.loadClipShare,
  loadShare: mocks.loadShare,
}))
vi.mock("@/lib/sharing/share-payload", () => ({ loadSharePageData: mocks.loadSharePageData }))
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}))
vi.mock("@/lib/auth/session", () => ({ getSessionSecret: () => "secret" }))
vi.mock("@/components/share/shared-meeting-player", () => ({ SharedMeetingPlayer: () => null }))

import PublicMeetingSharePage from "@/app/share/[token]/page"
import type { ClipShareView } from "@/lib/clips/types"

/**
 * M5 C2 `/share/<token>`: a clip token renders only the clip (title,
 * proxied `<audio>`, excerpt with `dir` from the meeting language) and never
 * reaches the meeting loader; a clip token that fails its gate is a 404.
 */

const TOKEN = "a".repeat(32)

function view(overrides: Partial<ClipShareView["clip"]> = {}, language = "he"): ClipShareView {
  return {
    clip: {
      id: "clip_secret",
      workspaceId: "ws_secret",
      meetingId: "m_secret",
      title: "ההחלטה על התקציב",
      startMs: 61_000,
      endMs: 95_000,
      segmentIds: ["seg_secret"],
      transcriptExcerpt: "התקציב אושר, וה-API יעלה ביום ראשון",
      renderStatus: "ready",
      storageKey: "clips/ws_secret/clip_secret.m4a",
      createdByUserId: "user_secret",
      createdAt: "2026-10-01T10:00:00.000Z",
      updatedAt: "2026-10-01T10:00:00.000Z",
      ...overrides,
    },
    meeting: { title: "סטטוס שבועי", startedAt: "2026-10-01T10:00:00.000Z", language },
  }
}

async function render(token = TOKEN) {
  const element = (await PublicMeetingSharePage({
    params: Promise.resolve({ token }),
    searchParams: Promise.resolve({}),
  })) as ReactElement

  return renderToStaticMarkup(element)
}

describe("share page with a clip token", () => {
  beforeEach(() => vi.clearAllMocks())

  it("renders only the clip with proxied audio and RTL Hebrew text", async () => {
    mocks.loadClipShare.mockResolvedValue({ kind: "clip", view: view() })

    const html = await render()

    expect(html).toContain("ההחלטה על התקציב")
    expect(html).toContain("סטטוס שבועי")
    expect(html).toContain(`src="/api/share/${TOKEN}/media"`)
    expect(html).toMatch(/<blockquote dir="rtl" lang="he"/)
    expect(html).toContain("1:01 · 0:34")
    for (const secret of ["clip_secret", "ws_secret", "m_secret", "seg_secret", "user_secret", "clips/"]) {
      expect(html).not.toContain(secret)
    }
    expect(mocks.loadShare).not.toHaveBeenCalled()
    expect(mocks.loadSharePageData).not.toHaveBeenCalled()
  })

  it("shows a preparing note instead of audio until the clip renders", async () => {
    mocks.loadClipShare.mockResolvedValue({
      kind: "clip",
      view: view({ renderStatus: "pending", storageKey: undefined }, "en"),
    })

    const html = await render()

    expect(html).not.toContain("<audio")
    expect(html).toContain("The audio is still being prepared")
    expect(html).toMatch(/<blockquote dir="ltr" lang="en"/)
  })

  it("404s a clip token that fails its gate, without trying the meeting share", async () => {
    mocks.loadClipShare.mockResolvedValue({ kind: "clip_unavailable" })

    await expect(render()).rejects.toThrow()
    expect(mocks.loadSharePageData).not.toHaveBeenCalled()
  })

  it("falls through to the meeting share for other tokens", async () => {
    mocks.loadClipShare.mockResolvedValue({ kind: "not_clip" })
    mocks.loadSharePageData.mockResolvedValue(undefined)

    await expect(render()).rejects.toThrow()
    expect(mocks.loadSharePageData).toHaveBeenCalledWith(TOKEN, expect.anything())
  })
})
