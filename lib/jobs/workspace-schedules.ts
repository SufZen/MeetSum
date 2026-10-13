import { getWorkspaceGoogleSubject } from "@/lib/google/workspace-subject"
import type {
  MeetSumJobName,
  WorkspaceScopedJobName,
  WorkspaceScopedJobPayload,
} from "@/lib/jobs/queue"
import { DEFAULT_WORKSPACE_ID } from "@/lib/workspaces/constants"

/**
 * Per-workspace schedules for the worker (M2): every tick re-reads the live
 * workspaces, so new workspaces (or a newly set google_subject) are picked up
 * without a restart, and each job carries its own workspaceId + subject.
 */

type Queryable = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>
}

export type GoogleSyncWorkspace = { workspaceId: string; subject: string }

type ScheduleDeps = {
  env?: NodeJS.ProcessEnv
  db?: Queryable
  enqueue?: (
    name: WorkspaceScopedJobName,
    payload: WorkspaceScopedJobPayload
  ) => Promise<unknown>
  log?: Pick<Console, "error" | "warn">
}

async function defaultDb(): Promise<Queryable> {
  return (await import("@/lib/db/client")).getDatabasePool()
}

async function defaultEnqueue(
  name: WorkspaceScopedJobName,
  payload: WorkspaceScopedJobPayload
) {
  return (await import("@/lib/jobs/queue")).enqueueMeetSumJob(name, payload)
}

/** Live workspaces that have a Google identity to poll as. */
export async function listGoogleSyncWorkspaces(
  deps: ScheduleDeps = {}
): Promise<GoogleSyncWorkspace[]> {
  const env = deps.env ?? process.env

  if (!deps.db && env.MEETSUM_STORAGE !== "postgres") {
    const subject = getWorkspaceGoogleSubject({ id: DEFAULT_WORKSPACE_ID }, env)

    return subject ? [{ workspaceId: DEFAULT_WORKSPACE_ID, subject }] : []
  }

  const db = deps.db ?? (await defaultDb())
  const result = await db.query(
    `
      select id, google_subject
      from workspaces
      where deleted_at is null
      order by created_at asc
    `
  )

  return (result.rows as Array<{ id: string; google_subject: string | null }>)
    .map((row) => ({
      workspaceId: row.id,
      subject: getWorkspaceGoogleSubject(
        { id: row.id, googleSubject: row.google_subject },
        env
      ),
    }))
    .filter((item): item is GoogleSyncWorkspace => Boolean(item.subject))
}

/** Enqueues one Google poll per configured workspace; returns how many. */
export async function enqueueWorkspaceGooglePolls(
  name: Extract<MeetSumJobName, `google.${string}`>,
  payload: Record<string, unknown>,
  deps: ScheduleDeps = {}
): Promise<number> {
  const enqueue = deps.enqueue ?? defaultEnqueue
  const log = deps.log ?? console
  const workspaces = await listGoogleSyncWorkspaces(deps)
  let queued = 0

  for (const workspace of workspaces) {
    try {
      await enqueue(name, {
        ...payload,
        workspaceId: workspace.workspaceId,
        subject: workspace.subject,
      })
      queued += 1
    } catch (error) {
      log.error(`Scheduled ${name} failed for ${workspace.workspaceId}`, error)
    }
  }

  return queued
}

/** Enqueues one `media.retention` job per live workspace. */
export async function enqueueWorkspaceRetention(
  deps: ScheduleDeps = {}
): Promise<number> {
  const enqueue = deps.enqueue ?? defaultEnqueue
  const log = deps.log ?? console
  const db = deps.db ?? (await defaultDb())
  const result = await db.query(
    `select id from workspaces where deleted_at is null order by created_at asc`
  )
  let queued = 0

  for (const row of result.rows as Array<{ id: string }>) {
    try {
      await enqueue("media.retention", { workspaceId: row.id, scheduled: true })
      queued += 1
    } catch (error) {
      log.error(`Scheduled media.retention failed for ${row.id}`, error)
    }
  }

  return queued
}
