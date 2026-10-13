/**
 * PGlite harness for the eval's `pglite` engine and the PGlite search test
 * (docs/parity/m6.md, B8): applies `db/schema.sql` plus migration 025 with
 * pg_trgm (no pgvector in this PGlite build, so the 025 vector block is a
 * NOTICE) and seeds meetings plus their chunks. Real Postgres semantics for
 * the scoped SQL legs, without a server. Dev/test only.
 */
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"

import type { Queryable } from "@/lib/db/client"
import type { MeetingRecord } from "@/lib/meetings/repository"
import type { ChunkDraft } from "@/lib/search/types"

export type PgliteSearchDb = {
  /** Pool-like client: `withTransaction` runs begin/commit on it. */
  client: Queryable & { connect: () => Promise<Queryable & { release: () => void }> }
  hebrewTrigrams: boolean
  /** Multi-statement SQL (migrations). */
  exec: (sql: string) => Promise<void>
  close: () => Promise<void>
}

type PGliteLike = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>
  exec: (text: string) => Promise<unknown>
  close: () => Promise<void>
}

/** Null when PGlite or its pg_trgm extension cannot load on this host. */
export async function createPgliteSearchDb(root = process.cwd()): Promise<PgliteSearchDb | null> {
  let db: PGliteLike

  try {
    const { PGlite } = await import("@electric-sql/pglite")
    const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm")

    db = (await PGlite.create({ extensions: { pg_trgm } })) as unknown as PGliteLike
  } catch {
    return null
  }

  await db.exec(readFileSync(path.join(root, "db", "schema.sql"), "utf8"))
  await db.exec(readFileSync(path.join(root, "db", "migrations", "025_search_ask.sql"), "utf8"))

  const trigrams = (await db.query("select coalesce(array_length(show_trgm('תקציב'), 1), 0) as n")).rows[0] as { n: number }
  const query = (text: string, values?: unknown[]) => db.query(text, values)

  return {
    client: { query, connect: async () => ({ query, release: () => undefined }) },
    hebrewTrigrams: Number(trigrams.n) > 0,
    exec: async (sql) => {
      await db.exec(sql)
    },
    close: () => db.close(),
  }
}

let counter = 0

function rowId(prefix: string) {
  counter += 1

  return `${prefix}_${counter}`
}

/** Re-applies migration 025 (idempotence check). */
export async function reapplyMigration025(db: PgliteSearchDb, root = process.cwd()): Promise<void> {
  await db.exec(readFileSync(path.join(root, "db", "migrations", "025_search_ask.sql"), "utf8"))
}

/**
 * Seeds users, workspaces, meetings (participants, rooms, tags, speakers,
 * segments) and `meeting_chunks` built by `chunkMeeting`.
 */
export async function seedPgliteMeetings(
  db: PgliteSearchDb,
  meetings: MeetingRecord[],
  chunkMeeting: (meeting: MeetingRecord) => ChunkDraft[]
): Promise<void> {
  const q = db.client.query
  const workspaces = new Set(meetings.map((meeting) => meeting.workspaceId ?? "ws_default"))
  const users = new Set(meetings.map((meeting) => meeting.ownerUserId).filter((id): id is string => Boolean(id)))

  for (const id of users) await q("insert into users (id, email) values ($1, $2) on conflict do nothing", [id, `${id}@example.com`])
  for (const id of workspaces) {
    await q("insert into workspaces (id, name, slug) values ($1, $1, $1) on conflict do nothing", [id])
  }

  for (const meeting of meetings) {
    const workspaceId = meeting.workspaceId ?? "ws_default"

    await q(
      `insert into meetings (id, title, source, language, status, started_at, workspace_id, owner_user_id, visibility,
         meeting_type, transcript_version, duration_ms, search_index_state, search_index_mode)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'ready', 'lexical')`,
      [
        meeting.id,
        meeting.title,
        meeting.source,
        meeting.language,
        meeting.status,
        meeting.startedAt,
        workspaceId,
        meeting.ownerUserId ?? null,
        meeting.visibility ?? "workspace",
        meeting.intelligence?.meetingType ?? null,
        meeting.transcriptVersion ?? 0,
        meeting.durationMs ?? null,
      ]
    )

    const people = meeting.participantDetails?.length
      ? meeting.participantDetails.map((participant) => ({ name: participant.name, email: participant.email ?? null }))
      : meeting.participants.map((name) => ({ name, email: name.includes("@") ? name : null }))

    for (const person of people) {
      await q("insert into meeting_participants (id, meeting_id, name, email) values ($1, $2, $3, $4)", [
        rowId("mp"),
        meeting.id,
        person.name,
        person.email,
      ])
    }

    for (const context of meeting.contexts ?? []) {
      await q("insert into contexts (id, name, workspace_id) values ($1, $2, $3) on conflict do nothing", [
        context.id,
        context.name,
        workspaceId,
      ])
      await q("insert into meeting_contexts (meeting_id, context_id) values ($1, $2) on conflict do nothing", [meeting.id, context.id])
    }

    for (const tag of meeting.tags ?? []) {
      const tagId = `tag_${workspaceId}_${createHash("sha1").update(String(tag)).digest("hex").slice(0, 8)}`

      await q("insert into tags (id, name, workspace_id) values ($1, $2, $3) on conflict do nothing", [tagId, tag, workspaceId])
      await q("insert into meeting_tags (meeting_id, tag_id) values ($1, $2) on conflict do nothing", [meeting.id, tagId])
    }

    for (const speaker of meeting.speakers ?? []) {
      await q("insert into speakers (id, meeting_id, label, display_name, workspace_id) values ($1, $2, $3, $4, $5)", [
        speaker.id,
        meeting.id,
        speaker.label,
        speaker.displayName ?? null,
        workspaceId,
      ])
    }

    for (const segment of meeting.transcript ?? []) {
      await q(
        "insert into transcript_segments (id, meeting_id, speaker_id, start_ms, end_ms, text, turn_index) values ($1, $2, $3, $4, $5, $6, $7)",
        [segment.id, meeting.id, segment.speakerId ?? null, segment.startMs, segment.endMs, segment.text, segment.turnIndex ?? null]
      )
    }

    for (const chunk of chunkMeeting(meeting)) {
      await q(
        `insert into meeting_chunks (id, workspace_id, meeting_id, kind, chunk_index, source_id, segment_ids, segment_start_ms,
           segment_offsets, overlap_count, speaker_ids, start_ms, end_ms, language, text, text_norm, text_stem,
           token_estimate, content_hash, transcript_version)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
        [
          `${meeting.id}:${chunk.kind}:${chunk.chunkIndex}`,
          workspaceId,
          meeting.id,
          chunk.kind,
          chunk.chunkIndex,
          chunk.sourceId ?? null,
          chunk.segmentIds,
          chunk.segmentStartMs,
          chunk.segmentOffsets,
          chunk.overlapCount,
          chunk.speakerIds,
          chunk.startMs ?? null,
          chunk.endMs ?? null,
          chunk.language ?? null,
          chunk.text,
          chunk.textNorm,
          chunk.textStem,
          chunk.tokenEstimate,
          chunk.contentHash,
          meeting.transcriptVersion ?? 0,
        ]
      )
    }
  }
}
