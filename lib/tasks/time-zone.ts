import { resolveTimeZone } from "@/lib/i18n/time-zone"

/**
 * Time zone that anchors due phrases and "overdue" (M5). Since M9 a thin
 * wrapper over the shared resolver (`lib/i18n/time-zone.ts`): pass the
 * user's and workspace's zones when known; otherwise
 * `MEETSUM_DEFAULT_TIMEZONE`, then Asia/Jerusalem. Every candidate is
 * validated against `Intl.supportedValuesOf("timeZone")`.
 */
export function getTaskTimeZone(
  env: NodeJS.ProcessEnv = process.env,
  scope: { user?: string | null; workspace?: string | null } = {}
): string {
  return resolveTimeZone({ ...scope, env: env.MEETSUM_DEFAULT_TIMEZONE })
}
