import { createMeetSumWorker } from "@/lib/jobs/processor"
import { enqueueMeetSumJob } from "@/lib/jobs/queue"
import { getGoogleSyncScheduleConfig } from "@/lib/jobs/scheduler-config"
import { getWorkspaceSubject } from "@/lib/google/auth"
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

  const subject = getWorkspaceSubject()

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

scheduleGoogleSync()
console.log("MeetSum worker started")
