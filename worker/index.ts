import { isTeamsSubscriptionConfigured } from "@/lib/capture/teams-subscriptions"
import { createMeetSumWorker } from "@/lib/jobs/processor"
import { enqueueMeetSumJob } from "@/lib/jobs/queue"
import {
  getCaptureScheduleConfig,
  getGoogleSyncScheduleConfig,
} from "@/lib/jobs/scheduler-config"
import { getConfiguredWorkspaceSubject } from "@/lib/google/workspace-subject"
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

function scheduleGoogleSync() {
  const config = getGoogleSyncScheduleConfig()

  if (!config.enabled) return

  const subject = getConfiguredWorkspaceSubject()

  if (!subject) {
    console.warn(
      "Scheduled Google sync is enabled but GOOGLE_WORKSPACE_SUBJECT is not set; skipping scheduled sync."
    )
    return
  }

  if (config.calendar.enabled) {
    scheduledTimers.push(
      setInterval(() => {
        void enqueueMeetSumJob("google.calendar.poll", {
          subject,
          ...config.calendar.payload,
        }).catch((error) => console.error("Scheduled Calendar sync failed", error))
      }, config.calendar.minutes * 60 * 1000)
    )
  }

  if (config.drive.enabled) {
    scheduledTimers.push(
      setInterval(() => {
        void enqueueMeetSumJob("google.drive.poll", {
          subject,
          ...config.drive.payload,
        }).catch((error) => console.error("Scheduled Drive sync failed", error))
      }, config.drive.minutes * 60 * 1000)
    )
  }

  if (config.meet.enabled) {
    scheduledTimers.push(
      setInterval(() => {
        void enqueueMeetSumJob("google.meet.poll", {
          subject,
          ...config.meet.payload,
        }).catch((error) => console.error("Scheduled Meet artifact sync failed", error))
      }, config.meet.minutes * 60 * 1000)
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

scheduleGoogleSync()
scheduleTeamsSubscriptionRenewal()
console.log("MeetSum worker started")
