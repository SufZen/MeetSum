import { describe, expect, it } from "vitest"

import { getGoogleSyncScheduleConfig } from "@/lib/jobs/scheduler-config"

describe("Google sync scheduler config", () => {
  it("schedules Calendar and Meet metadata polling by default", () => {
    const config = getGoogleSyncScheduleConfig({})

    expect(config.enabled).toBe(true)
    expect(config.calendar).toMatchObject({
      enabled: true,
      minutes: 15,
      payload: { source: "calendar", scheduled: true },
    })
    expect(config.meet).toMatchObject({
      enabled: true,
      minutes: 30,
      payload: { source: "meet", scheduled: true, limit: 10 },
    })
    expect(config.drive.enabled).toBe(false)
  })

  it("allows Meet artifact polling to be disabled independently", () => {
    const config = getGoogleSyncScheduleConfig({
      MEETSUM_SCHEDULE_MEET_SYNC: "false",
      MEETSUM_MEET_POLL_MINUTES: "5",
      MEETSUM_MEET_POLL_LIMIT: "20",
    })

    expect(config.meet).toMatchObject({
      enabled: false,
      minutes: 5,
      payload: { source: "meet", scheduled: true, limit: 20 },
    })
  })
})
