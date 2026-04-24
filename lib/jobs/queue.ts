import { Queue } from "bullmq"

import { meetingRepository } from "@/lib/meetings/store"

export type MeetSumJobName =
  | "media.ingest"
  | "meeting.transcribe"
  | "meeting.summarize"
  | "meeting.index"
  | "google.calendar.poll"
  | "google.drive.poll"
  | "google.gmail.poll"
  | "webhook.deliver"
  | "realizeos.export"

export type MeetSumJobPayload = {
  meetingId?: string
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

export async function enqueueMeetSumJob(
  name: MeetSumJobName,
  payload: MeetSumJobPayload = {}
) {
  const record = await meetingRepository.createJob({
    name,
    meetingId: payload.meetingId,
    payload,
  })

  await getMeetSumQueue().add(name, { ...payload, jobRecordId: record.id }, {
    jobId: record.id,
    attempts: 3,
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
