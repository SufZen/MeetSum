import { Queue } from "bullmq"

import { meetingRepository } from "@/lib/meetings/store"

export type MeetSumJobName =
  | "media.ingest"
  | "artifact.import"
  | "meeting.transcribe"
  | "meeting.summarize"
  | "meeting.index"
  | "google.calendar.poll"
  | "google.drive.poll"
  | "google.gmail.poll"
  | "google.meet.poll"
  | "webhook.deliver"
  | "realizeos.export"
  | "teams.subscription.renew"
  | "media.retention"

export type MeetSumJobPayload = {
  meetingId?: string
  /** M2 contract: owning workspace (required after Integration). */
  workspaceId?: string
  [key: string]: unknown
}

let queue: Queue<MeetSumJobPayload, unknown, MeetSumJobName> | undefined

export function getMeetSumQueue() {
  queue ??= new Queue<MeetSumJobPayload, unknown, MeetSumJobName>("meetsum", {
    connection: {
      url: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
    },
  })

  return queue
}

export function getJobAttempts(
  env: Record<string, string | undefined> = process.env
) {
  const parsed = Number(env.MEETSUM_JOB_ATTEMPTS)

  return Number.isInteger(parsed) && parsed > 0 ? parsed : 3
}

export async function enqueueMeetSumJob(
  name: MeetSumJobName,
  payload: MeetSumJobPayload = {}
) {
  const attempts = getJobAttempts()
  const record = await meetingRepository.createJob({
    name,
    meetingId: payload.meetingId,
    payload,
    retryOfJobId:
      typeof payload.retryOfJobId === "string" ? payload.retryOfJobId : undefined,
    maxAttempts: attempts,
  })

  await getMeetSumQueue().add(name, { ...payload, jobRecordId: record.id }, {
    jobId: record.id,
    attempts,
    backoff: { type: "exponential", delay: 3000 },
    removeOnComplete: 250,
    removeOnFail: 500,
  })

  return record
}

export async function closeMeetSumQueue() {
  if (queue) {
    await queue.close()
    queue = undefined
  }
}
