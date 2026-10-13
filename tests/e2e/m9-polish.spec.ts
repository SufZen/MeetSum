/**
 * M9 browser e2e (docs/parity/m9.md, Acceptance 17; Package C4), in he and en.
 *
 * Prerequisites (no real keys; the orchestrator runs them):
 *   docker compose up postgres redis
 *   npm run db:migrate && npm run m9:e2e-seed
 *   app + worker with NODE_ENV=development
 *   E2E_BASE_URL=http://localhost:3000 npm run test:e2e -- m9-polish
 *
 * The seed writes sessions, ids and expected numbers to E2E_ENV_FILE
 * (default `.secrets/e2e-m9.env`, gitignored). Covered here: locale and RTL
 * (17.1), the Hebrew PDF download from Package B (17.5), share with a
 * password (17.6, Package B), the bell (17.8), the analytics dashboard
 * (17.9) and onboarding (17.10). Shell routing, dialogs, turn undo, the
 * service worker and the offline recorder (17.2–17.4, 17.7, 17.11, 17.12)
 * belong to the packages that build them; the screenshot matrix and axe run
 * live in m9-screenshots.spec.ts.
 *
 * If Playwright browsers can't be installed on the host, the orchestrator
 * runs the same steps with agent-browser and attaches screenshots.
 */
import { expect, test } from "@playwright/test"

import { dictionaries } from "@/lib/i18n/dictionaries"
import { pluralMessage } from "@/lib/i18n/messages"

import { BASE_URL, assertLocalBaseUrl, env, signIn } from "./m9-env"

const LOCALES = ["he", "en"] as const

type Locale = (typeof LOCALES)[number]

const dict = (locale: Locale) => dictionaries[locale] as unknown as Record<string, string>
const ORIGIN = { origin: BASE_URL }

test.beforeAll(() => {
  assertLocalBaseUrl()
})

test.describe("17.1 locale resolution and RTL", () => {
  test("a cold / follows Accept-Language; legacy prefixes redirect", async ({ browser }) => {
    for (const [language, locale, dir] of [
      ["he-IL,he;q=0.9", "he", "rtl"],
      ["en-US,en;q=0.9", "en", "ltr"],
    ] as const) {
      const context = await browser.newContext({ extraHTTPHeaders: { "accept-language": language } })
      const page = await context.newPage()

      await page.goto("/")
      await expect(page).toHaveURL(new RegExp(`/${locale}(/login)?(\\?|$)`))
      await expect(page.locator("html")).toHaveAttribute("lang", locale)
      await expect(page.locator("html")).toHaveAttribute("dir", dir)
      await context.close()
    }

    const response = await fetch(`${BASE_URL}/pt/tasks`, { redirect: "manual", headers: { "accept-language": "he-IL" } })

    expect(response.status).toBe(308)
    expect(new URL(response.headers.get("location") ?? "", BASE_URL).pathname).toBe("/he/tasks")
  })
})

for (const locale of LOCALES) {
  test.describe(`M9 in ${locale}`, () => {
    test(`17.8 bell (${locale}): unread count, bdi names, mark all read, no private titles`, async ({ page, context }) => {
      await signIn(context, "admin", locale)
      await page.goto(`/${locale}`)

      const unread = Number(env.E2E_M9_ADMIN_UNREAD)
      const label = pluralMessage(dict(locale), locale, "notifBellUnread", unread)
      const bell = page.getByRole("button", { name: label, exact: true })

      await expect(bell).toBeVisible({ timeout: 30_000 })
      await bell.click()

      const popover = page.locator("[data-slot=popover-content]")

      await expect(popover.getByRole("heading", { name: dict(locale).notifTitle })).toBeVisible()
      await expect(popover.locator("li bdi").first()).toBeVisible()
      await expect(popover.getByText(dict(locale).notifMeetingUnavailable)).toBeVisible()
      await expect(popover).not.toContainText(env.E2E_M9_PRIVATE_MEETING_TITLE ?? "never")

      if (locale === "en") {
        await popover.getByRole("button", { name: dict(locale).notifMarkAllRead }).click()
        await expect(page.getByRole("button", { name: dict(locale).notifBellLabel, exact: true })).toBeVisible()
      }
    })

    test(`17.9 analytics (${locale}): admin and member KPIs, coverage, table view, LTR axis`, async ({ page, context }) => {
      for (const [who, expected] of [
        ["admin", env.E2E_M9_ADMIN_MEETINGS],
        ["member", env.E2E_M9_MEMBER_MEETINGS],
      ] as const) {
        await signIn(context, who, locale)
        await page.goto(`/${locale}/analytics`)

        await expect(page.getByRole("heading", { level: 1, name: dict(locale).analyticsTitle })).toBeVisible({ timeout: 30_000 })

        const kpi = page.locator(".ms-card", { hasText: dict(locale).analyticsMeetings }).first()

        await expect(kpi).toContainText(String(expected))
        await expect(page.getByText(dict(locale).analyticsCoverage.split("{")[0]!.trim()).first()).toBeVisible()

        if (who === "admin") {
          await expect(page.locator("body")).not.toContainText(env.E2E_M9_PRIVATE_MEETING_TITLE ?? "never")
          await expect(page.locator("[data-slot=chart]").first()).toBeVisible()
          await expect(page.locator("[dir=ltr] [data-slot=chart]").first()).toBeVisible()

          const trend = page.locator("section", { hasText: dict(locale).analyticsTrend }).first()

          await trend.getByRole("button", { name: dict(locale).analyticsShowTable }).click()
          await expect(trend.getByRole("table")).toBeVisible()
          await expect(trend.getByRole("button", { name: dict(locale).analyticsShowChart })).toHaveAttribute("aria-pressed", "true")
        }
      }
    })
  })
}

test.describe("17.10 onboarding", () => {
  test("a fresh owner is redirected, can skip and dismiss, and is not redirected again", async ({ page, context }) => {
    await signIn(context, "fresh", "he")
    await page.goto("/he")
    await expect(page).toHaveURL(/\/he\/onboarding/, { timeout: 30_000 })

    const he = dict("he")

    await expect(page.getByRole("heading", { level: 1, name: he.onboardingTitle })).toBeVisible()
    await expect(page.locator("[data-icon=directional]").first()).toBeAttached()
    await page.getByRole("button", { name: he.onboardingSkip, exact: true }).click()
    await expect(page.locator("#onboarding-step-heading")).toBeFocused()

    // Finish from the last step (stores completion) and land on the inbox.
    for (let step = 0; step < 4; step += 1) {
      const finish = page.getByRole("button", { name: he.onboardingFinish, exact: true })

      if (await finish.isVisible()) break
      await page.getByRole("button", { name: he.onboardingNext, exact: true }).click()
    }
    await page.getByRole("button", { name: he.onboardingFinish, exact: true }).click()
    await expect(page).toHaveURL(/\/he(\?|$)/, { timeout: 30_000 })
    await page.reload()
    await expect(page).not.toHaveURL(/onboarding/)
  })
})

test.describe("17.5 Hebrew PDF (Package B)", () => {
  test("the download keeps the Hebrew name and embeds Plex Sans Hebrew", async ({ page, context }) => {
    await signIn(context, "owner", "he")

    const response = await page.request.get(`/api/meetings/${encodeURIComponent(env.E2E_M9_HEBREW_MEETING_ID ?? "")}/export/pdf`)

    expect(response.status()).toBe(200)
    expect(response.headers()["content-disposition"]).toMatch(/filename\*=UTF-8''[^;]*%D7%/)

    const body = await response.body()

    expect(body.subarray(0, 8).toString("latin1")).toBe("%PDF-1.7")
    expect(body.toString("latin1")).toContain("IBMPlexSansHebrew")
  })
})

test.describe("17.6 share with a password (Package B)", () => {
  test("the gate is localized, a wrong password fails, the right one opens, clearing removes the gate", async ({ browser, context, page }) => {
    const token = env.E2E_M9_PROTECTED_SHARE_TOKEN
    const password = env.E2E_M9_SHARE_PASSWORD

    test.skip(!token || !password, "Run npm run m9:e2e-seed")

    const visitor = await browser.newContext({ extraHTTPHeaders: { "accept-language": "he-IL" } })
    const share = await visitor.newPage()

    await share.goto(`/share/${token}`)
    await expect(share.locator("html")).toHaveAttribute("dir", "rtl")

    const field = share.locator("input[type=password]")

    await expect(field).toBeVisible({ timeout: 30_000 })
    await field.fill("wrong-password-123")
    await field.press("Enter")
    await expect(field).toBeVisible()
    await field.fill(password!)
    await field.press("Enter")
    await expect(share.locator("input[type=password]")).toHaveCount(0, { timeout: 30_000 })
    await expect(share.locator("body")).toContainText("Lisboa Riverside")

    // The owner clears the password; a fresh visitor opens without the gate.
    await signIn(context, "owner", "he")

    const cleared = await page.request.patch(`/api/meetings/${encodeURIComponent(env.E2E_M9_HEBREW_MEETING_ID ?? "")}/share`, {
      data: { password: null },
      headers: ORIGIN,
    })

    expect(cleared.status()).toBe(200)

    const fresh = await browser.newContext()
    const reopened = await fresh.newPage()

    await reopened.goto(`/share/${token}`)
    await expect(reopened.locator("body")).toContainText("Lisboa Riverside", { timeout: 30_000 })
    await expect(reopened.locator("input[type=password]")).toHaveCount(0)
    await visitor.close()
    await fresh.close()
  })
})
