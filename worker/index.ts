import { createMeetSumWorker } from "@/lib/jobs/processor"
import { enqueueMeetSumJob } from "@/lib/jobs/queue"
import { getWorkspaceSubject } from "@/lib/google/auth"

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
  if (process.env.MEETSUM_SCHEDULE_GOOGLE_SYNC === "false") return

  const subject = getWorkspaceSubject()
  const calendarMinutes = Number(process.env.MEETSUM_CALENDAR_POLL_MINUTES ?? 15)
  const driveMinutes = Number(process.env.MEETSUM_DRIVE_POLL_MINUTES ?? 30)

  scheduledTimers.push(
    setInterval(() => {
      void enqueueMeetSumJob("google.calendar.poll", {
        subject,
        source: "calendar",
        scheduled: true,
      }).catch((error) => console.error("Scheduled Calendar sync failed", error))
    }, calendarMinutes * 60 * 1000)
  )
  scheduledTimers.push(
    setInterval(() => {
      void enqueueMeetSumJob("google.drive.poll", {
        subject,
        source: "drive",
        scheduled: true,
      }).catch((error) => console.error("Scheduled Drive sync failed", error))
    }, driveMinutes * 60 * 1000)
  )
}

scheduleGoogleSync()
console.log("MeetSum worker started")
