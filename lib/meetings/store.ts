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
  // `next build` imports route modules to collect page data without runtime
  // env; the guard applies to the running server, not the build step.
  if (
    env.NODE_ENV === "production" &&
    env.NEXT_PHASE !== "phase-production-build" &&
    env.MEETSUM_ALLOW_DEMO_STORAGE !== "true"
  ) {
    throw new Error(
      'MEETSUM_STORAGE must be "postgres" in production. ' +
        "Set MEETSUM_ALLOW_DEMO_STORAGE=true only for throwaway demo deployments."
    )
  }

  return createInMemoryMeetingRepository(DEMO_MEETINGS)
}

let cachedRepository: MeetingRepository | undefined

export function getMeetingRepository(): MeetingRepository {
  cachedRepository ??= createMeetingRepositoryFromEnv()

  return cachedRepository
}

/**
 * Lazily resolved repository. Resolving at first use (instead of at module
 * load) keeps `next build` — which imports every route module while
 * collecting page data — from requiring runtime-only configuration such as
 * MEETSUM_STORAGE / DATABASE_URL. Production misconfiguration is still caught
 * at boot by instrumentation.ts (lib/ops/environment) and on first use here.
 */
export const meetingRepository: MeetingRepository = new Proxy(
  {} as MeetingRepository,
  {
    get(_target, property) {
      const repository = getMeetingRepository()
      const value = Reflect.get(repository, property, repository)

      return typeof value === "function" ? value.bind(repository) : value
    },
  }
)
