/**
 * Shared helper for the notification routes (docs/parity/m9.md C1).
 * Server-only.
 */
import type { AuthContext } from "@/lib/auth/authz"
import { DEFAULT_LOCALE, isSupportedLocale } from "@/lib/i18n/locales"
import type { NotificationReader } from "@/lib/notifications/store"

/** The reader for a signed-in user; undefined for API keys (403 `user_required`). */
export function notificationReader(request: Request, ctx: AuthContext): NotificationReader | undefined {
  if (ctx.principal !== "user" || !ctx.user) return undefined

  const requested = new URL(request.url).searchParams.get("locale") ?? ""

  return {
    userId: ctx.user.id,
    workspaceId: ctx.workspace.id,
    locale: isSupportedLocale(requested) ? requested : DEFAULT_LOCALE,
    meetings: ctx.meetings,
  }
}
