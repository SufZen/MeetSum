/**
 * M9 A1 (docs/parity/m9.md "Locales"): Accept-Language parsing, precedence
 * of URL → cookie → users.locale → Accept-Language → default, and the proxy
 * routing for every kind of path.
 */
import { NextRequest } from "next/server"
import { describe, expect, it } from "vitest"

import { DEFAULT_LOCALE, parseAcceptLanguage, resolveLocalePreference } from "@/lib/i18n/locales"
import { proxy, routeLocale } from "@/proxy"

describe("parseAcceptLanguage", () => {
  it("sorts by q-value and maps he, he-*, iw and en-*", () => {
    expect(parseAcceptLanguage("en-US;q=0.6, he-IL;q=0.9")).toEqual(["he", "en"])
    expect(parseAcceptLanguage("iw")).toEqual(["he"])
    expect(parseAcceptLanguage("en-GB,en;q=0.8")).toEqual(["en"])
    expect(parseAcceptLanguage("fr-FR, en;q=0.5")).toEqual(["en"])
  })

  it("ignores *, q=0 and malformed entries", () => {
    expect(parseAcceptLanguage("*")).toEqual([])
    expect(parseAcceptLanguage("he;q=0, en;q=0.1")).toEqual(["en"])
    expect(parseAcceptLanguage("he;q=abc, en")).toEqual(["en"])
    expect(parseAcceptLanguage("he;q=2, 12-34, en")).toEqual(["en"])
    expect(parseAcceptLanguage("")).toEqual([])
    expect(parseAcceptLanguage(null)).toEqual([])
  })

  it("keeps header order for equal q-values", () => {
    expect(parseAcceptLanguage("en, he")).toEqual(["en", "he"])
  })
})

describe("resolveLocalePreference", () => {
  it("prefers URL → cookie → users.locale → Accept-Language → default", () => {
    const all = { path: "/en/tasks", cookie: "he", userLocale: "en", acceptLanguage: "he" }

    expect(resolveLocalePreference(all)).toBe("en")
    expect(resolveLocalePreference({ ...all, path: "/tasks" })).toBe("he")
    expect(resolveLocalePreference({ ...all, path: undefined, cookie: undefined })).toBe("en")
    expect(resolveLocalePreference({ acceptLanguage: "en-US" })).toBe("en")
    expect(resolveLocalePreference({})).toBe(DEFAULT_LOCALE)
  })

  it("ignores legacy and unknown cookie and user values", () => {
    expect(resolveLocalePreference({ cookie: "pt", acceptLanguage: "en" })).toBe("en")
    expect(resolveLocalePreference({ cookie: "<script>", userLocale: "es", acceptLanguage: "he" })).toBe("he")
  })
})

describe("routeLocale (proxy)", () => {
  it("redirects every locale-less page path through the full chain", () => {
    expect(routeLocale("/", { acceptLanguage: "en-US" })).toEqual({ kind: "redirect", pathname: "/en", status: 307 })
    expect(routeLocale("/tasks", { acceptLanguage: "en-US" })).toEqual({
      kind: "redirect",
      pathname: "/en/tasks",
      status: 307,
    })
    expect(routeLocale("/rooms/r1", { cookie: "he", acceptLanguage: "en" })).toEqual({
      kind: "redirect",
      pathname: "/he/rooms/r1",
      status: 307,
    })
    expect(routeLocale("/search", {})).toEqual({ kind: "redirect", pathname: `/${DEFAULT_LOCALE}/search`, status: 307 })
  })

  it("308s legacy prefixes to the resolved locale keeping the path", () => {
    expect(routeLocale("/pt/tasks", { acceptLanguage: "he-IL" })).toEqual({
      kind: "redirect",
      pathname: "/he/tasks",
      status: 308,
    })
    expect(routeLocale("/es", { cookie: "en" })).toEqual({ kind: "redirect", pathname: "/en", status: 308 })
    expect(routeLocale("/it/rooms/r1", { cookie: "en" })).toEqual({ kind: "redirect", pathname: "/en/rooms/r1", status: 308 })
  })

  it("passes through supported prefixes and non-page paths", () => {
    for (const path of [
      "/he",
      "/en/tasks",
      "/api/settings",
      "/share/abc",
      "/sw.js",
      "/manifest.webmanifest",
      "/icons/icon-192.png",
      "/offline.html",
      "/_next/static/chunk.js",
      "/robots.txt",
    ]) {
      expect(routeLocale(path, { acceptLanguage: "en" }), path).toEqual({ kind: "pass" })
    }
  })
})

describe("proxy", () => {
  it("keeps the query and sends Vary on redirects", () => {
    const response = proxy(
      new NextRequest("http://localhost/tasks?panel=settings&section=integrations", {
        headers: { "accept-language": "he-IL,he;q=0.9" },
      })
    )

    expect(response.status).toBe(307)
    expect(response.headers.get("location")).toBe("http://localhost/he/tasks?panel=settings&section=integrations")
    expect(response.headers.get("vary")).toBe("Accept-Language, Cookie")
  })

  it("uses the locale cookie and 308s legacy prefixes", () => {
    const response = proxy(
      new NextRequest("http://localhost/pt/tasks?x=1", { headers: { cookie: "meetsum_locale=en" } })
    )

    expect(response.status).toBe(308)
    expect(response.headers.get("location")).toBe("http://localhost/en/tasks?x=1")
    expect(response.headers.get("vary")).toBe("Accept-Language, Cookie")
  })

  it("lets supported locales through", () => {
    const response = proxy(new NextRequest("http://localhost/en/tasks"))

    expect(response.headers.get("location")).toBeNull()
    expect(response.headers.get("x-middleware-next")).toBe("1")
  })
})
