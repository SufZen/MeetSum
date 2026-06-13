import { getDatabasePool } from "@/lib/db/client"
import { DEMO_MEETINGS } from "@/lib/meetings/demo-data"
import {
  createInMemoryMeetingRepository,
  type MeetingRepository,
} from "@/lib/meetings/repository"
import { createPostgresMeetingRepository } from "@/lib/meetings/postgres-repository"

export function createMeetingRepositoryFromEnv(
  env: NodeJS.ProcessEnv = process.env
): MeetingRepository {
  if (env.MEETSUM_STORAGE === "postgres") {
    return createPostgresMeetingRepository(getDatabasePool())
  }

  // The in-memory repository serves demo data and discards all writes. In
  // production a misconfigured MEETSUM_STORAGE must fail loudly, not silently
  // serve a throwaway demo.
  if (env.NODE_ENV === "production" && env.MEETSUM_ALLOW_DEMO_STORAGE !== "true") {
    throw new Error(
      'MEETSUM_STORAGE must be "postgres" in production. ' +
        "Set MEETSUM_ALLOW_DEMO_STORAGE=true only for throwaway demo deployments."
    )
  }

  return createInMemoryMeetingRepository(DEMO_MEETINGS)
}

export const meetingRepository = createMeetingRepositoryFromEnv()
