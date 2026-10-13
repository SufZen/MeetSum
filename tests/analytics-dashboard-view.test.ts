/**
 * M9 C2 dashboard view (docs/parity/m9.md): the empty state shows no
 * numbers, the coverage line is present, member breakdown text depends on
 * the role, names are in <bdi>, filters live in the URL.
 */
import { createElement } from "react"
import { describe, expect, it } from "vitest"

import { AnalyticsDashboard, analyticsHref } from "@/components/analytics/analytics-dashboard"
import { emptyAnalyticsOverview } from "@/lib/analytics/dashboard/compute"
import type { AnalyticsOverview } from "@/lib/analytics/dashboard/types"

import { renderWithI18n } from "./helpers/render-i18n"

const QUERY = {
  from: "2026-09-30T21:00:00.000Z",
  to: "2026-10-31T22:00:00.000Z",
  interval: "week" as const,
  scope: "workspace" as const,
  timeZone: "Asia/Jerusalem",
}

const FILLED: AnalyticsOverview = {
  ...emptyAnalyticsOverview(QUERY),
  totals: { meetings: 4, durationMs: 8_100_000, avgDurationMs: 2_025_000 },
  series: [{ bucket: "2026-10-05", meetings: 4, durationMs: 8_100_000 }],
  talkTime: {
    byMember: [{ userId: "u1", name: "Dana Levi", ms: 2_700_000, share: 0.5 }],
    othersMs: 300_000,
    unconfirmedMs: 600_000,
    coverage: { withAnalytics: 34, total: 40 },
  },
  topics: [{ tag: "מכירות", total: 2, series: [{ bucket: "2026-10-05", count: 2 }] }],
}

function render(overview: AnalyticsOverview, canSeeMembers = true, locale: "he" | "en" = "he") {
  return renderWithI18n(
    createElement(AnalyticsDashboard, {
      locale,
      overview,
      filters: { range: 90, interval: "week", scope: "workspace" },
      canSeeMembers,
    }),
    locale
  )
}

describe("AnalyticsDashboard", () => {
  it("says there is not enough data and shows no numbers when empty", () => {
    const html = render(emptyAnalyticsOverview(QUERY))

    expect(html).toContain("אין עדיין מספיק נתונים לטווח הזה.")
    expect(html).not.toContain("זמן דיבור מחושב")
  })

  it("shows KPIs, the honest coverage line and table toggles", () => {
    const html = render(FILLED)

    expect(html).toContain("זמן דיבור מחושב מ־34 מתוך 40 פגישות")
    expect(html).toContain("הצגה כטבלה")
    expect(html).toContain("זמן דיבור לפי חברי הצוות")
    expect(html).toContain('aria-current="true"')
  })

  it("tells members the breakdown is for admins", () => {
    expect(render(FILLED, false, "en")).toContain("Admins see the breakdown by member.")
  })
})

describe("analyticsHref", () => {
  it("omits defaults and keeps the filters in the URL", () => {
    expect(analyticsHref("he", { range: 90, interval: "week", scope: "workspace" })).toBe("/he/analytics")
    expect(analyticsHref("en", { range: 30, interval: "day", scope: "me" })).toBe("/en/analytics?range=30&interval=day&scope=me")
  })
})
