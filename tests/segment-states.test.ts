/**
 * M9 D3: every required segment state exists, and error pages never render
 * `error.message` in production.
 */
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"

import { SEGMENT_FALLBACK_HE, SegmentError, SegmentNotFound, mayShowErrorDetail } from "@/components/segment-states"
import { m9ShellMessages } from "@/lib/i18n/m9/shell"

const root = path.resolve(__dirname, "..")

describe("segment state files", () => {
  const segments = ["app/[locale]", "app/[locale]/rooms/[id]", "app/[locale]/tasks", "app/[locale]/search", "app/[locale]/invite/[token]", "app/[locale]/invite/accept"]
  // The home page's skeleton lives in the `(home)` route group so that it
  // does not wrap every other `[locale]` route; routes that answer 404 for a
  // missing record have no loading.tsx, so notFound() runs before streaming
  // starts and the status is a real 404 (not a soft 200).
  const loadingFiles = ["app/[locale]/(home)/loading.tsx", "app/[locale]/tasks/loading.tsx", "app/[locale]/search/loading.tsx", "app/[locale]/invite/[token]/loading.tsx"]
  const hardNotFound = ["app/[locale]", "app/[locale]/rooms/[id]", "app/[locale]/invite/accept"]

  it.each(segments.flatMap((segment) => ["error.tsx", "not-found.tsx"].map((file) => `${segment}/${file}`)))(
    "%s exists",
    (file) => {
      expect(existsSync(path.join(root, file))).toBe(true)
    }
  )

  it.each(loadingFiles)("%s exists", (file) => {
    expect(existsSync(path.join(root, file))).toBe(true)
  })

  it.each(hardNotFound)("%s has no loading.tsx (a missing record answers HTTP 404)", (segment) => {
    expect(existsSync(path.join(root, segment, "loading.tsx"))).toBe(false)
  })

  it("global-error has its own Hebrew RTL document and no error.message", () => {
    const source = readFileSync(path.join(root, "app/global-error.tsx"), "utf8")

    expect(source).toContain('<html lang="he" dir="rtl">')
    expect(source).not.toContain("error.message")
  })

  it("error.tsx files are client components that delegate to SegmentError", () => {
    for (const segment of segments) {
      const source = readFileSync(path.join(root, segment, "error.tsx"), "utf8")

      expect(source.startsWith('"use client"')).toBe(true)
      expect(source).toContain("<SegmentError")
      expect(source).not.toContain("error.message")
    }
  })
})

describe("segment fallback copy", () => {
  it("matches the shell module's Hebrew values", () => {
    for (const [key, value] of Object.entries(SEGMENT_FALLBACK_HE)) {
      expect(m9ShellMessages.he[key as keyof typeof m9ShellMessages.he], key).toBe(value)
    }
  })
})

describe("SegmentError", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  const error = Object.assign(new Error("db password=hunter2 at pg://internal"), { digest: "abc123" })

  it("never shows error.message in production, only the digest", () => {
    vi.stubEnv("NODE_ENV", "production")

    const html = renderToStaticMarkup(createElement(SegmentError, { error, reset: () => undefined }))

    expect(html).not.toContain("hunter2")
    expect(html).toContain("abc123")
    expect(html).toContain("משהו השתבש")
    expect(html).toContain("נסו שוב")
  })

  it("shows detail only outside production", () => {
    expect(mayShowErrorDetail("production")).toBe(false)
    expect(mayShowErrorDetail("development")).toBe(true)
  })

  it("not found renders the Σ empty state with one next action", () => {
    const html = renderToStaticMarkup(createElement(SegmentNotFound))

    expect(html).toContain("הדף לא נמצא")
    expect(html.match(/<a /g)?.length).toBe(1)
  })
})
