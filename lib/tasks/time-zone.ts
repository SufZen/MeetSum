import { DEFAULT_DUE_DATE_TIME_ZONE } from "@/lib/tasks/due-date"

/**
 * Time zone that anchors due phrases and "overdue" (M5). There is no
 * per-workspace zone yet, so `MEETSUM_DEFAULT_TIMEZONE` (default
 * Asia/Jerusalem) applies to every workspace.
 */
export function getTaskTimeZone(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.MEETSUM_DEFAULT_TIMEZONE?.trim()

  if (!configured) return DEFAULT_DUE_DATE_TIME_ZONE

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: configured })
    return configured
  } catch {
    return DEFAULT_DUE_DATE_TIME_ZONE
  }
}
