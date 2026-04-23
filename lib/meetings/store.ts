import { getDatabasePool } from "@/lib/db/client"
import { DEMO_MEETINGS } from "@/lib/meetings/demo-data"
import {
  createInMemoryMeetingRepository,
  type MeetingRepository,
} from "@/lib/meetings/repository"
import { createPostgresMeetingRepository } from "@/lib/meetings/postgres-repository"

export function createMeetingRepositoryFromEnv(): MeetingRepository {
  if (process.env.MEETSUM_STORAGE === "postgres") {
    return createPostgresMeetingRepository(getDatabasePool())
  }

  return createInMemoryMeetingRepository(DEMO_MEETINGS)
}

export const meetingRepository = createMeetingRepositoryFromEnv()
