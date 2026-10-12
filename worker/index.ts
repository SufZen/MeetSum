import { isTeamsSubscriptionConfigured } from "@/lib/capture/teams-subscriptions"
import { createMeetSumWorker } from "@/lib/jobs/processor"
import { enqueueMeetSumJob } from "@/lib/jobs/queue"
import {
  getCaptureScheduleConfig,
  getGoogleSyncScheduleConfig,
  getRetentionScheduleConfig,
} from "@/lib/jobs/scheduler-config"
import {
  enqueueWorkspaceGooglePolls,
  enqueueWorkspaceRetention,
} from "@/lib/jobs/workspace-schedules"
import { assertRuntimeEnvironment } from "@/lib/ops/environment"

assertRuntimeEnvironment()

const worker = createMeetSumWorker()
const scheduledTimers: NodeJS.Timeout[] = []

worker.on("completed", (job) => {
  console.log(`MeetSum job completed: ${job.name} ${job.id}`)
})

worker.on("failed", (job, error) => {
  console.error(`MeetSum job failed: ${job?.name} ${job?.id}`, error)
})

process.on("SIGTERM", async () => {
  scheduledTimers.forEach((timer) => clearInterval(timer))
  await worker.close()
  process.exit(0)
})

process.on("SIGINT", async () => {
  scheduledTimers.forEach((timer) => clearInterval(timer))
  await worker.close()
  process.exit(0)
})

/**
 * Google polls run per workspace: each tick enqueues one job for every live
 * workspace with a Google subject (workspaces.google_subject), carrying that
 * workspace's id and subject. Workspaces without one are simply skipped.
 */
function scheduleGoogleSync() {
  const config = getGoogleSyncScheduleConfig()

  if (!config.enabled) return

  const schedules = [
    { name: "google.calendar.poll", job: config.calendar, label: "Calendar sync" },
    { name: "google.drive.poll", job: config.drive, label: "Drive sync" },
    { name: "google.meet.poll", job: config.meet, label: "Meet artifact sync" },
  ] as const

  for (const schedule of schedules) {
    if (!schedule.job.enabled) continue

    scheduledTimers.push(
      setInterval(() => {
        void enqueueWorkspaceGooglePolls(schedule.name, schedule.job.payload).catch(
          (error) => console.error(`Scheduled ${schedule.label} failed`, error)
        )
      }, schedule.job.minutes * 60 * 1000)
    )
  }
}

function scheduleTeamsSubscriptionRenewal() {
  if (!isTeamsSubscriptionConfigured()) return

  const { minutes } = getCaptureScheduleConfig().teamsSubscriptionRenew
  const enqueueRenewal = () =>
    void enqueueMeetSumJob("teams.subscription.renew", { scheduled: true }).catch(
      (error) => console.error("Scheduled Teams subscription renewal failed", error)
    )

  enqueueRenewal()
  scheduledTimers.push(setInterval(enqueueRenewal, minutes * 60 * 1000))
}

/** Daily audioRetentionDays enforcement, opt-in (MEETSUM_RETENTION_ENFORCE). */
function scheduleMediaRetention() {
  const config = getRetentionScheduleConfig()

  if (!config.enabled) return

  scheduledTimers.push(
    setInterval(() => {
      void enqueueWorkspaceRetention().catch((error) =>
        console.error("Scheduled media retention failed", error)
      )
    }, config.hours * 60 * 60 * 1000)
  )
}

scheduleGoogleSync()
scheduleTeamsSubscriptionRenewal()
scheduleMediaRetention()
console.log("MeetSum worker started")
