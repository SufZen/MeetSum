/**
 * `meeting_generated_docs` persistence (M5 D4/D5): prep briefs and follow-up
 * email variants, one row per (meeting, kind, variant), cached by input hash.
 * Postgres when `MEETSUM_STORAGE=postgres`, otherwise in memory. Every query
 * joins `meetings` with the M2 visibility predicate.
 */
import { getDatabasePool, type Queryable } from "@/lib/db/client"
import type { RepoScope } from "@/lib/meetings/repository"
import { meetingScopeSql } from "@/lib/meetings/scope-sql"

export type GeneratedDocKind = "prep_brief" | "follow_up_email"

export type GeneratedDoc<T = unknown> = {
  id: string
  workspaceId: string
  meetingId: string
  kind: GeneratedDocKind
  /** e.g. `he` (prep) or `he:formal` (follow-up). */
  variant: string
  inputHash: string
  content: T
  sourceMeetingIds: string[]
  aiRunId?: string
  createdByUserId?: string
  createdAt: string
}

export type GeneratedDocsDeps = { client?: Queryable }

const memoryDocs = new Map<string, GeneratedDoc>()

/** Test hook: clears the in-memory store. */
export function resetMemoryGeneratedDocs() {
  memoryDocs.clear()
}

function memoryKey(meetingId: string, kind: GeneratedDocKind, variant: string) {
  return `${meetingId}\u0000${kind}\u0000${variant}`
}

function resolveClient(deps: GeneratedDocsDeps): Queryable | undefined {
  if (deps.client) return deps.client

  return process.env.MEETSUM_STORAGE === "postgres" ? getDatabasePool() : undefined
}

type DocRow = {
  id: string
  workspace_id: string
  meeting_id: string
  kind: GeneratedDocKind
  variant: string
  input_hash: string
  content: unknown
  source_meeting_ids: string[] | null
  ai_run_id: string | null
  created_by_user_id: string | null
  created_at: string | Date
}

function fromRow<T>(row: DocRow): GeneratedDoc<T> {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    meetingId: row.meeting_id,
    kind: row.kind,
    variant: row.variant,
    inputHash: row.input_hash,
    content: row.content as T,
    sourceMeetingIds: row.source_meeting_ids ?? [],
    aiRunId: row.ai_run_id ?? undefined,
    createdByUserId: row.created_by_user_id ?? undefined,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  }
}

/** Generated docs of a visible meeting, optionally one kind/variant. */
export async function listGeneratedDocs<T = unknown>(
  scope: RepoScope,
  meetingId: string,
  filter: { kind?: GeneratedDocKind; variant?: string } = {},
  deps: GeneratedDocsDeps = {}
): Promise<GeneratedDoc<T>[]> {
  const client = resolveClient(deps)

  if (!client) {
    return [...memoryDocs.values()]
      .filter(
        (doc) =>
          doc.meetingId === meetingId &&
          doc.workspaceId === scope.workspaceId &&
          (!filter.kind || doc.kind === filter.kind) &&
          (!filter.variant || doc.variant === filter.variant)
      )
      .sort((a, b) => a.variant.localeCompare(b.variant))
      .map((doc) => structuredClone(doc) as GeneratedDoc<T>)
  }

  const values: unknown[] = [meetingId]
  const conditions = ["d.meeting_id = $1", "d.workspace_id = m.workspace_id"]

  if (filter.kind) {
    values.push(filter.kind)
    conditions.push(`d.kind = $${values.length}`)
  }
  if (filter.variant) {
    values.push(filter.variant)
    conditions.push(`d.variant = $${values.length}`)
  }
  conditions.push(meetingScopeSql(scope, "m", values))

  const result = await client.query(
    `select d.* from meeting_generated_docs d
       join meetings m on m.id = d.meeting_id
      where ${conditions.join(" and ")}
      order by d.variant asc`,
    values
  )

  return (result.rows as DocRow[]).map((row) => fromRow<T>(row))
}

export async function getGeneratedDoc<T = unknown>(
  scope: RepoScope,
  meetingId: string,
  kind: GeneratedDocKind,
  variant: string,
  deps: GeneratedDocsDeps = {}
): Promise<GeneratedDoc<T> | undefined> {
  return (await listGeneratedDocs<T>(scope, meetingId, { kind, variant }, deps))[0]
}

/**
 * Inserts or replaces the (meeting, kind, variant) doc of a visible meeting.
 * Undefined when the meeting is not visible to the scope.
 */
export async function upsertGeneratedDoc<T>(
  scope: RepoScope,
  doc: Omit<GeneratedDoc<T>, "id" | "createdAt" | "workspaceId">,
  deps: GeneratedDocsDeps = {}
): Promise<GeneratedDoc<T> | undefined> {
  const client = resolveClient(deps)

  if (!client) {
    const stored: GeneratedDoc<T> = {
      ...doc,
      id: `gdoc_${crypto.randomUUID()}`,
      workspaceId: scope.workspaceId,
      createdAt: new Date().toISOString(),
    }

    memoryDocs.set(memoryKey(doc.meetingId, doc.kind, doc.variant), structuredClone(stored))
    return stored
  }

  const values: unknown[] = [
    `gdoc_${crypto.randomUUID()}`,
    doc.meetingId,
    doc.kind,
    doc.variant,
    doc.inputHash,
    JSON.stringify(doc.content),
    doc.sourceMeetingIds,
    doc.aiRunId ?? null,
    doc.createdByUserId ?? null,
  ]
  const visible = meetingScopeSql(scope, "m", values)
  const result = await client.query(
    `insert into meeting_generated_docs
       (id, workspace_id, meeting_id, kind, variant, input_hash, content, source_meeting_ids, ai_run_id, created_by_user_id)
     select $1, m.workspace_id, m.id, $3, $4, $5, $6::jsonb, $7::text[], $8, $9
       from meetings m
      where m.id = $2 and ${visible}
     on conflict (meeting_id, kind, variant) do update
       set input_hash = excluded.input_hash,
           content = excluded.content,
           source_meeting_ids = excluded.source_meeting_ids,
           ai_run_id = excluded.ai_run_id,
           created_by_user_id = excluded.created_by_user_id,
           created_at = now()
     returning *`,
    values
  )
  const row = result.rows[0] as DocRow | undefined

  return row ? fromRow<T>(row) : undefined
}
