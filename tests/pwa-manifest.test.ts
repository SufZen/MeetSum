/**
 * M9 D4: the manifest (he/rtl, icons, shortcut), the /sw.js route headers,
 * the committed icons and the offline page.
 */
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import manifest from "@/app/manifest"
import { GET } from "@/app/sw.js/route"
import { SW_PRECACHE } from "@/lib/pwa/sw-routes"

const root = path.resolve(__dirname, "..")

describe("manifest", () => {
  const value = manifest()

  it("is Hebrew-first and standalone", () => {
    expect(value).toMatchObject({
      name: "MeetSum",
      lang: "he",
      dir: "rtl",
      start_url: "/?source=pwa",
      scope: "/",
      display: "standalone",
    })
    expect(value.theme_color).toMatch(/^#[0-9a-f]{6}$/)
    expect(value.background_color).toMatch(/^#[0-9a-f]{6}$/)
  })

  it("lists 192, 512 and maskable 512 icons that exist", () => {
    const icons = value.icons ?? []

    expect(icons.map((icon) => `${icon.sizes}:${icon.purpose}`)).toEqual(["192x192:any", "512x512:any", "512x512:maskable"])
    for (const icon of icons) expect(existsSync(path.join(root, "public", icon.src))).toBe(true)
  })

  it("has the new-recording shortcut", () => {
    expect(value.shortcuts?.[0]).toMatchObject({ name: "הקלטה חדשה", url: "/?panel=meetings&record=1" })
  })
})

describe("sw.js route", () => {
  it("serves the versioned script with no-cache and the scope header", async () => {
    const response = GET()

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8")
    expect(response.headers.get("cache-control")).toBe("no-cache")
    expect(response.headers.get("service-worker-allowed")).toBe("/")

    const source = await response.text()

    expect(source).toMatch(/const CACHE = "meetsum-[A-Za-z0-9._-]+"/)
    expect(source).toContain("networkOnlyNavigation")
  })
})

describe("precached files", () => {
  it("exist in public/", () => {
    for (const file of SW_PRECACHE) expect(existsSync(path.join(root, "public", file))).toBe(true)
  })

  it("the offline page is bilingual and self-contained", () => {
    const html = readFileSync(path.join(root, "public", "offline.html"), "utf8")

    expect(html).toContain('<html lang="he" dir="rtl">')
    expect(html).toContain("navigator.language")
    expect(html).toContain("You’re offline")
    expect(html).not.toMatch(/<script[^>]+src=/)
    expect(html).not.toMatch(/<link[^>]+stylesheet/)
  })
})
