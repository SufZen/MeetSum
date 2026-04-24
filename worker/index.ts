import { createMeetSumWorker } from "@/lib/jobs/processor"

const worker = createMeetSumWorker()

worker.on("completed", (job) => {
  console.log(`MeetSum job completed: ${job.name} ${job.id}`)
})

worker.on("failed", (job, error) => {
  console.error(`MeetSum job failed: ${job?.name} ${job?.id}`, error)
})

process.on("SIGTERM", async () => {
  await worker.close()
  process.exit(0)
})

process.on("SIGINT", async () => {
  await worker.close()
  process.exit(0)
})

console.log("MeetSum worker started")
