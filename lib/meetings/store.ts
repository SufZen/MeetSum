import { getDatabasePool, type Queryable } from "@/lib/db/client"
import { DEMO_MEETINGS } from "@/lib/meetings/demo-data"
import {
  createInMemoryMeetingDatabase,
  createInMemoryMeetingRepository,
  createInMemoryShareLookup,
  type GetShareMediaByToken,
  type InMemoryMeetingDatabase,
  type MeetingRepository,
  type RepoScope,
} from "@/lib/meetings/repository"
import {
  createPostgresMeetingRepository,
  createPostgresShareLookup,
} from "@/lib/meetings/postgres-repository"
import { DEFAULT_WORKSPACE_ID } from "@/lib/workspaces/constants"

/** Where meetings live; scoped repositories are cheap views over it. */
export type MeetingBackend =
  | { kind: "postgres"; client: Queryable }
  | { kind: "memory"; db: InMemoryMeetingDatabase }

export function createMeetingBackendFromEnv(
  env: NodeJS.ProcessEnv = process.env
): MeetingBackend {
  if (env.MEETSUM_STORAGE === "postgres") {
    return { kind: "postgres", client: getDatabasePool() }
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

  return { kind: "memory", db: createInMemoryMeetingDatabase(DEMO_MEETINGS) }
}

/** Repository of `backend` restricted to `scope`. */
export function createScopedMeetingRepository(
  backend: MeetingBackend,
  scope: RepoScope
): MeetingRepository {
  return backend.kind === "postgres"
    ? createPostgresMeetingRepository(backend.client, scope)
    : createInMemoryMeetingRepository(backend.db, scope)
}

/**
 * Resolved at first use (not at module load) so `next build`, which imports
 * every route module while collecting page data, does not need runtime-only
 * configuration such as MEETSUM_STORAGE / DATABASE_URL. Production
 * misconfiguration is still caught at boot by instrumentation.ts and on
 * first use here.
 */
let cachedBackend: MeetingBackend | undefined

function getMeetingBackend(): MeetingBackend {
  cachedBackend ??= createMeetingBackendFromEnv()

  return cachedBackend
}

/**
 * Repository restricted to what `scope` may see (M2). Built per call: a
 * repository is never shared across scopes.
 */
export function getScopedMeetingRepository(scope: RepoScope): MeetingRepository {
  return createScopedMeetingRepository(getMeetingBackend(), scope)
}

/**
 * Repository for background work (worker, signed webhooks) filtered by
 * workspace only.
 */
export function getSystemMeetingRepository(workspaceId: string): MeetingRepository {
  return getScopedMeetingRepository({ kind: "system", workspaceId })
}

/**
 * Cross-workspace share-token lookup used by the public share pages. A token
 * resolves only while its share is active/unexpired and the meeting is
 * `link`-visible; the returned meeting carries its `workspaceId` so callers
 * can apply that workspace's `publicSharingEnabled` setting.
 */
export type ShareLookup = Pick<MeetingRepository, "getShareByToken"> & {
  /** Lightweight lookup for the share media routes (no transcript hydration). */
  getShareMediaByToken: GetShareMediaByToken
}

export function getShareLookup(): ShareLookup {
  const backend = getMeetingBackend()

  return backend.kind === "postgres"
    ? createPostgresShareLookup(backend.client)
    : createInMemoryShareLookup(backend.db)
}

/**
 * Workspace owning a meeting, or undefined when the meeting does not exist.
 * Deliberately unscoped: the worker uses it to pick the system repository of
 * a job that predates workspace-aware payloads. Never expose it to clients.
 */
export async function resolveMeetingWorkspaceId(
  meetingId: string
): Promise<string | undefined> {
  const backend = getMeetingBackend()

  if (backend.kind === "memory") {
    const meeting = backend.db.meetings.get(meetingId)

    return meeting ? (meeting.workspaceId ?? DEFAULT_WORKSPACE_ID) : undefined
  }

  const result = await backend.client.query(
    "select workspace_id from meetings where id = $1",
    [meetingId]
  )
  const row = result.rows[0] as { workspace_id?: string | null } | undefined

  return row ? (row.workspace_id ?? DEFAULT_WORKSPACE_ID) : undefined
}
