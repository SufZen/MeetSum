/**
 * M9 checks that need a production build (docs/parity/m10.md, "m9-prod";
 * m9.md Acceptance 17.11): service-worker registration and its cache
 * contents, the offline navigation fallback, production error pages (no
 * error text or stack) and the manifest.
 *
 * Runs against `next build && next start` (NODE_ENV=production) with no
 * fakes, no replay and no bypass flags, after `npm run m9:e2e-seed`:
 *   npx playwright test --project=m9-prod
 */
import { expect, test } from "@playwright/test"

import { assertLocalBaseUrl, signIn } from "./m9-env"

const STACK_OR_MESSAGE = /\bat [\w.<>]+ \(|node_modules|Error: |webpack-internal|\.tsx?:\d+/

test.beforeAll(() => {
  assertLocalBaseUrl()
})

test.describe("17.11 service worker (production build)", () => {
  test("registers at /, precaches the offline page and icons, caches no API or page data", async ({ page, context }) => {
    await signIn(context, "owner", "he")
    await page.goto("/he")

    const registration = await page.evaluate(async () => {
      const ready = await Promise.race([
        navigator.serviceWorker.ready.then((value) => value),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 30_000)),
      ])

      return ready ? { scope: ready.scope, active: Boolean(ready.active) } : null
    })

    expect(registration, "the service worker registered and activated").not.toBeNull()
    expect(new URL(registration!.scope).pathname).toBe("/")
    expect(registration!.active).toBe(true)

    // Load a page so the worker can cache hashed static assets.
    await page.reload()

    const caches = await page.evaluate(async () => {
      const result: Record<string, string[]> = {}

      for (const name of await self.caches.keys()) {
        const cache = await self.caches.open(name)

        result[name] = (await cache.keys()).map((request) => new URL(request.url).pathname)
      }
      return result
    })
    const names = Object.keys(caches)

    expect(names.length).toBeGreaterThan(0)
    expect(names.every((name) => name.startsWith("meetsum-"))).toBe(true)

    const paths = Object.values(caches).flat()

    expect(paths).toEqual(expect.arrayContaining(["/offline.html", "/icons/icon-192.png", "/icons/icon-512.png"]))
    // Policy: only the precache and hashed /_next/static assets.
    expect(paths.filter((path) => !path.startsWith("/_next/static/") && !path.startsWith("/icons/") && path !== "/offline.html")).toEqual([])
  })

  test("an offline navigation falls back to the offline page", async ({ page, context }) => {
    await signIn(context, "owner", "he")
    await page.goto("/he")
    await page.evaluate(() => navigator.serviceWorker.ready)
    await page.reload()
    await context.setOffline(true)
    try {
      await page.goto("/he/tasks").catch(() => undefined)
      await expect(page.getByRole("heading", { name: "אין חיבור לאינטרנט" })).toBeVisible({ timeout: 15_000 })
    } finally {
      await context.setOffline(false)
    }
  })
})

test.describe("production error pages", () => {
  test("the 404 page is localized and shows no error text or stack", async ({ page, context }) => {
    await signIn(context, "owner", "he")

    const response = await page.goto("/he/this-page-does-not-exist")

    expect(response?.status()).toBe(404)
    // Next 16.2 sends every notFound() response (dev and production alike) as
    // its `<html id="__next_error__">` shell, without lang/dir; the client
    // render from the RSC payload then mounts the [locale] layout, which sets
    // them. So the check runs on the hydrated document (M10 integration;
    // docs/parity/m10.md "Integration: 404 document").
    await expect(page.locator("html")).toHaveAttribute("lang", "he")
    await expect(page.locator("html")).not.toHaveAttribute("id", "__next_error__")
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl")
    expect(await page.locator("body").innerText()).not.toMatch(STACK_OR_MESSAGE)
  })

  test("API errors carry codes, not stacks", async ({ page, context }) => {
    await signIn(context, "owner", "he")

    const missing = await page.request.get("/api/meetings/e2e_m9_no_such_meeting")
    const malformed = await page.request.post("/api/meetings", {
      headers: { "content-type": "application/json", origin: new URL(page.url() || "http://localhost:3000").origin },
      data: "{not json",
    })

    expect(missing.status()).toBe(404)
    expect(await missing.text()).not.toMatch(STACK_OR_MESSAGE)
    expect(malformed.status()).toBeGreaterThanOrEqual(400)
    expect(malformed.status()).toBeLessThan(500)
    expect(await malformed.text()).not.toMatch(STACK_OR_MESSAGE)
  })
})

test.describe("manifest", () => {
  test("is Hebrew-first and its icons resolve", async ({ request }) => {
    const response = await request.get("/manifest.webmanifest")

    expect(response.status()).toBe(200)

    const manifest = (await response.json()) as { lang: string; dir: string; start_url: string; icons: Array<{ src: string }> }

    expect(manifest.lang).toBe("he")
    expect(manifest.dir).toBe("rtl")
    expect(manifest.icons.length).toBeGreaterThan(0)
    for (const icon of manifest.icons) expect((await request.get(icon.src)).status(), icon.src).toBe(200)
  })
})
