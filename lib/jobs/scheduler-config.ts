export type ScheduledGoogleJobConfig = {
  enabled: boolean
  minutes: number
  payload: Record<string, unknown>
}

export type GoogleSyncScheduleConfig = {
  enabled: boolean
  calendar: ScheduledGoogleJobConfig
  drive: ScheduledGoogleJobConfig
  meet: ScheduledGoogleJobConfig
}

function positiveNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value)

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function getGoogleSyncScheduleConfig(
  env: Record<string, string | undefined> = process.env
): GoogleSyncScheduleConfig {
  return {
    enabled: env.MEETSUM_SCHEDULE_GOOGLE_SYNC !== "false",
    calendar: {
      enabled: env.MEETSUM_SCHEDULE_CALENDAR_SYNC !== "false",
      minutes: positiveNumber(env.MEETSUM_CALENDAR_POLL_MINUTES, 15),
      payload: { source: "calendar", scheduled: true },
    },
    drive: {
      enabled: env.MEETSUM_SCHEDULE_DRIVE_SYNC === "true",
      minutes: positiveNumber(env.MEETSUM_DRIVE_POLL_MINUTES, 30),
      payload: { source: "drive", scheduled: true },
    },
    meet: {
      enabled: env.MEETSUM_SCHEDULE_MEET_SYNC !== "false",
      minutes: positiveNumber(env.MEETSUM_MEET_POLL_MINUTES, 30),
      payload: {
        source: "meet",
        scheduled: true,
        limit: positiveNumber(env.MEETSUM_MEET_POLL_LIMIT, 10),
      },
    },
  }
}
