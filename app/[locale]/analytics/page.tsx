import { redirect } from "next/navigation"

import { AnalyticsDashboard } from "@/components/analytics/analytics-dashboard"
import { parseAnalyticsQuery, parseRangePreset } from "@/lib/analytics/dashboard/query"
import { canSeeMemberBreakdown, getAnalyticsOverview } from "@/lib/analytics/dashboard/service"
import type { AnalyticsInterval, AnalyticsScope } from "@/lib/analytics/dashboard/types"
import { getServerAuthState } from "@/lib/auth/authz"
import { getRequestI18n } from "@/lib/i18n/server"
import { DEFAULT_LOCALE, isSupportedLocale, type SupportedLocale } from "@/lib/i18n/locales"

export const dynamic = "force-dynamic"

/**
 * Workspace analytics dashboard (docs/parity/m9.md C2). Signed in, with a
 * workspace. Range, interval and scope come from the URL; the overview is
 * computed on the server for the caller (visible meetings only).
 */
export default async function AnalyticsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { locale } = await params
  const supportedLocale: SupportedLocale = isSupportedLocale(locale) ? locale : DEFAULT_LOCALE
  const auth = await getServerAuthState()

  if (auth.status === "unauthenticated") redirect(`/${supportedLocale}/login`)
  if (auth.status === "no_workspace") redirect(`/${supportedLocale}`)

  const ctx = auth.ctx
  const raw = await searchParams
  const one = (name: string) => {
    const value = raw[name]
    return Array.isArray(value) ? value[0] ?? null : value ?? null
  }
  const range = parseRangePreset(one("range"))
  const interval: AnalyticsInterval = one("interval") === "day" || one("interval") === "month" ? (one("interval") as AnalyticsInterval) : "week"
  const scope: AnalyticsScope = one("scope") === "me" ? "me" : "workspace"
  const { timeZone } = await getRequestI18n({ locale: supportedLocale })
  const parsed = parseAnalyticsQuery(new URLSearchParams({ range: String(range), interval, scope }), { timeZone })

  if (!parsed.ok || ctx.principal !== "user" || !ctx.user) redirect(`/${supportedLocale}`)

  const result = await getAnalyticsOverview(
    { workspaceId: ctx.workspace.id, userId: ctx.user.id, email: ctx.user.email, role: ctx.role },
    parsed.query
  )

  if (!result.ok) redirect(`/${supportedLocale}/analytics`)

  return (
    <AnalyticsDashboard
      locale={supportedLocale}
      overview={result.overview}
      filters={{ range, interval, scope }}
      canSeeMembers={canSeeMemberBreakdown(ctx.role)}
    />
  )
}
