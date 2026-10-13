/**
 * M9 follow-up: unknown routes render a localized 404, never Next's default
 * English page without lang/dir.
 */
import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import nextConfig from "@/next.config.mjs"
import { routeLocale } from "@/proxy"

const root = path.resolve(__dirname, "..")

describe("not-found routes", () => {
  it("an unknown path under a locale calls notFound()", async () => {
    const { default: UnknownLocalePath } = await import("@/app/[locale]/[...rest]/page")
    let digest = ""

    try {
      UnknownLocalePath()
    } catch (error) {
      digest = String((error as { digest?: string }).digest)
    }

    expect(digest).toMatch(/404/)
  })

  it("the global 404 has its own Hebrew RTL document with an English line", () => {
    const source = readFileSync(path.join(root, "app/global-not-found.tsx"), "utf8")

    expect(source).toContain('<html lang="he" dir="rtl"')
    expect(source).toContain('import "./globals.css"')
    expect(source).toContain('lang="en" dir="ltr"')
    expect((nextConfig as { experimental?: { globalNotFound?: boolean } }).experimental?.globalNotFound).toBe(true)
  })

  it("the locale layout redirects an unsupported locale segment into the default locale", () => {
    const source = readFileSync(path.join(root, "app/[locale]/layout.tsx"), "utf8")

    expect(source).toContain("redirect(`/${DEFAULT_LOCALE}/${encodeURIComponent(locale)}`)")
    expect(source).not.toMatch(/^\s*notFound\(\)/m)
  })

  it("a bad locale or locale-less path redirects into the default locale (then the localized 404)", () => {
    expect(routeLocale("/xx", { acceptLanguage: "he" })).toEqual({ kind: "redirect", pathname: "/he/xx", status: 307 })
    expect(routeLocale("/xx/yy", { acceptLanguage: "he" })).toEqual({ kind: "redirect", pathname: "/he/xx/yy", status: 307 })
    expect(routeLocale("/he/this-page-does-not-exist", {})).toEqual({ kind: "pass" })
  })
})
