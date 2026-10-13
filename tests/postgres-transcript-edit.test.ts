import { describe, expect, it } from "vitest"

import { createPostgresMeetingRepository } from "@/lib/meetings/postgres-repository"
import {
  NothingToUndoError,
  SegmentNotFoundError,
  TranscriptConflictError,
  TranscriptSpeakerNotFoundError,
  type RepoScope,
} from "@/lib/meetings/repository"

/**
 * Transcript edits on Postgres (M4 B5/B6/B8) against a recording Queryable:
 * transaction order, revision rows, version bump, turn/stat recompute, and
 * the workspace/visibility scope of every statement.
 */

type Statement = { text: string; values: unknown[] }

const WS = "ws_a"
const SCOPE: RepoScope = {
  kind: "member",
  workspaceId: WS,
  userId: "user_me",
  email: "me@example.com",
  role: "member",
}

const SEGMENT = {
  id: "seg_1",
  speaker_id: "spk_1",
  speaker_label: "Speaker 1",
  start_ms: 1000,
  end_ms: 3000,
  text: "שלום לכולם",
  confidence: 0.9,
  language: "he",
  words: [
    [1000, 1900, "שלום", 0.9],
    [2000, 3000, "לכולם", 0.8],
  ],
  turn_index: 2,
  source: "asr",
  revision: 0,
  edited_at: null,
}

type Responder = (text: string, values: unknown[]) => unknown[] | undefined

function recordingPool(override?: Responder) {
  const statements: Statement[] = []
  const query = async (text: string, values: unknown[] = []) => {
    const normalized = text.replace(/\s+/g, " ").trim()

    statements.push({ text: normalized, values })

    const custom = override?.(normalized, values)

    if (custom) return { rows: custom }
    if (/^(begin|commit|rollback)$/.test(normalized)) return { rows: [] }
    if (/^select m\.id from meetings m/.test(normalized)) return { rows: [{ id: "meet_1" }] }
    if (/^select m\.id, m\.transcript_version from meetings m/.test(normalized)) {
      return { rows: [{ id: "meet_1", transcript_version: 7 }] }
    }
    if (/^select ts\.id, ts\.speaker_id\b.* where (ts\.id = \$1|ts\.meeting_id = \$1 and ts\.id = any)/.test(normalized)) {
      return { rows: [SEGMENT] }
    }
    if (/^select id from speakers where id = \$1/.test(normalized)) return { rows: [{ id: values[0] }] }
    if (/^select id from speakers where meeting_id = \$1 and id = any/.test(normalized)) {
      return { rows: (values[1] as string[]).map((id) => ({ id })) }
    }
    if (/^update meetings m set transcript_version/.test(normalized)) {
      return { rows: [{ transcript_version: 8 }] }
    }
    if (/^select label from speakers/.test(normalized)) {
      return { rows: [{ label: "Speaker 1" }, { label: "Speaker 2" }] }
    }
    if (/^select id from transcript_segments where meeting_id = \$1 and turn_index/.test(normalized)) {
      return { rows: [{ id: "seg_1" }, { id: "seg_2" }] }
    }
    if (/from transcript_segment_revisions/.test(normalized) && /^select/.test(normalized)) {
      return {
        rows: [
          {
            id: "rev_1",
            meeting_id: "meet_1",
            segment_id: "seg_1",
            revision: 0,
            text: "שלום",
            words: [[1000, 3000, "שלום", 0.9]],
            speaker_id: "spk_2",
            source: "asr",
            created_by_user_id: "user_me",
            created_at: "2026-10-13T00:00:00.000Z",
            reverted_at: null,
          },
        ],
      }
    }
    return { rows: [] }
  }
  const pool = {
    query,
    async connect() {
      return { query, release() {} }
    },
  }

  return { pool, statements }
}

function texts(statements: Statement[]) {
  return statements.map((statement) => statement.text)
}

function find(statements: Statement[], pattern: RegExp) {
  const statement = statements.find((candidate) => pattern.test(candidate.text))

  expect(statement, String(pattern)).toBeDefined()
  return statement as Statement
}

function expectScoped(statement: Statement) {
  expect(statement.text).toContain("visibility in ('workspace', 'link')")
  expect(statement.values).toContain(WS)
  expect(statement.values).toContain("user_me")
}

describe("postgres updateTranscriptSegment", () => {
  it("edits text in one transaction: lock, revision, update, prune, version", async () => {
    const { pool, statements } = recordingPool()
    const repo = createPostgresMeetingRepository(pool, SCOPE)

    const result = await repo.updateTranscriptSegment("meet_1", "seg_1", {
      expectedRevision: 0,
      text: "שלום לכולם וברוכים הבאים",
      actorUserId: "user_me",
    })
    const order = texts(statements).map((text) => text.slice(0, 48))

    expect(order[0]).toBe("begin")
    expect(order[order.length - 1]).toBe("commit")
    expect(statements[1].text).toMatch(/^select m\.id, m\.transcript_version from meetings m .* for update of m$/)
    expectScoped(statements[1])
    expect(statements[2].text).toMatch(/for update of ts$/)

    const revision = find(statements, /^insert into transcript_segment_revisions/)
    const update = find(statements, /^update transcript_segments set text/)
    const prune = find(statements, /^delete from transcript_segment_revisions/)
    const bump = find(statements, /^update meetings m set transcript_version = m\.transcript_version \+ 1/)

    expect(revision.values.slice(0, 3)).toEqual([WS, "meet_1", "user_me"])
    expect(revision.values[4]).toEqual(["seg_1"])
    expect(update.values[0]).toBe("meet_1")
    expect(update.values[1]).toEqual(["seg_1"])
    expect(update.values[4]).toBe("שלום לכולם וברוכים הבאים")
    expect(JSON.parse(update.values[5] as string).slice(0, 2)).toEqual([
      [1000, 1900, "שלום", 0.9],
      [2000, 3000, "לכולם", 0.8],
    ])
    expect(update.values[6]).toBeNull()
    expect(prune.values).toEqual(["meet_1", WS, ["seg_1"], 50])
    expectScoped(bump)
    // Text-only edit: no turn/stat recompute.
    expect(texts(statements).some((text) => text.startsWith("update speakers s set talk_time_ms"))).toBe(false)
    expect(
      texts(statements).indexOf(revision.text) < texts(statements).indexOf(update.text)
    ).toBe(true)
    expect(result.version).toBe(8)
    expect(result.speakers).toBeUndefined()
  })

  it("reassigns a turn to a new manual speaker and recomputes turns and stats", async () => {
    const { pool, statements } = recordingPool()
    const repo = createPostgresMeetingRepository(pool, SCOPE)

    const result = await repo.updateTranscriptSegment("meet_1", "seg_1", {
      expectedRevision: 0,
      newSpeakerName: "דנה",
      scope: "turn",
      actorUserId: "user_me",
    })
    const insertSpeaker = find(statements, /^insert into speakers/)
    const update = find(statements, /^update transcript_segments set text/)

    expect(insertSpeaker.text).toContain("'manual'")
    expect(insertSpeaker.text).toContain("'confirmed'")
    expect(insertSpeaker.values.slice(1)).toEqual(["meet_1", "Speaker 3", WS, "דנה", "user_me"])
    expect(update.values[1]).toEqual(["seg_1", "seg_2"])
    expect(update.values[3]).toBe(false)
    expect(update.values[6]).toBe(insertSpeaker.values[0])
    find(statements, /^update transcript_segments ts set turn_index = ordered\.turn_index/)
    find(statements, /^update speakers s set talk_time_ms/)
    expect(find(statements, /^insert into transcript_segment_revisions/).values[4]).toEqual([
      "seg_1",
      "seg_2",
    ])
    expect(result.speakers).toBeDefined()
  })

  it("rolls back with the current segment on a stale revision", async () => {
    const { pool, statements } = recordingPool()
    const repo = createPostgresMeetingRepository(pool, SCOPE)

    await expect(
      repo.updateTranscriptSegment("meet_1", "seg_1", { expectedRevision: 3, text: "x" })
    ).rejects.toBeInstanceOf(TranscriptConflictError)
    expect(texts(statements)).toContain("rollback")
    expect(texts(statements).some((text) => text.startsWith("update transcript_segments"))).toBe(false)
  })

  it("reads an invisible meeting or missing segment as not found", async () => {
    const invisible = recordingPool((text) => (/^select m\.id, m\.transcript_version/.test(text) ? [] : undefined))

    await expect(
      createPostgresMeetingRepository(invisible.pool, SCOPE).updateTranscriptSegment("meet_x", "seg_1", {
        expectedRevision: 0,
        text: "x",
      })
    ).rejects.toBeInstanceOf(SegmentNotFoundError)
    expect(texts(invisible.statements).some((text) => /transcript_segments/.test(text))).toBe(false)

    const missing = recordingPool((text) => (/for update of ts$/.test(text) ? [] : undefined))

    await expect(
      createPostgresMeetingRepository(missing.pool, SCOPE).updateTranscriptSegment("meet_1", "nope", {
        expectedRevision: 0,
        text: "x",
      })
    ).rejects.toBeInstanceOf(SegmentNotFoundError)
  })

  it("rejects a speaker of another meeting", async () => {
    const { pool } = recordingPool((text) => (/^select id from speakers where id = \$1/.test(text) ? [] : undefined))

    await expect(
      createPostgresMeetingRepository(pool, SCOPE).updateTranscriptSegment("meet_1", "seg_1", {
        expectedRevision: 0,
        speakerId: "spk_foreign",
      })
    ).rejects.toBeInstanceOf(TranscriptSpeakerNotFoundError)
  })

  it("is a no-op without changes (no revision, no version bump)", async () => {
    const { pool, statements } = recordingPool()

    const result = await createPostgresMeetingRepository(pool, SCOPE).updateTranscriptSegment(
      "meet_1",
      "seg_1",
      { expectedRevision: 0, text: "שלום לכולם", speakerId: "spk_1" }
    )

    expect(result.version).toBe(7)
    expect(texts(statements).some((text) => text.startsWith("insert into transcript_segment_revisions"))).toBe(false)
  })
})

describe("postgres undoTranscriptSegment", () => {
  it("restores the latest revision, marks it reverted and bumps the version", async () => {
    const { pool, statements } = recordingPool()
    const result = await createPostgresMeetingRepository(pool, SCOPE).undoTranscriptSegment(
      "meet_1",
      "seg_1",
      { expectedRevision: 0, actorUserId: "user_me" }
    )
    const select = find(statements, /^select .* from transcript_segment_revisions/)
    const restore = find(statements, /^update transcript_segments ts set text = u\.text/)
    const reverted = find(statements, /^update transcript_segment_revisions set reverted_at/)

    expect(select.text).toContain("reverted_at is null")
    expect(select.values).toEqual(["meet_1", WS, "seg_1"])
    // A pre-030 revision (no edit_group_id) is a group of one.
    expect(restore.values).toEqual(["meet_1", "user_me", ["seg_1"], ["שלום"], [JSON.stringify([[1000, 3000, "שלום", 0.9]])], ["spk_2"], ["asr"]])
    expect(reverted.values).toEqual([["rev_1"], "meet_1", WS])
    expect(result.segments?.map((segment) => segment.id)).toEqual(["seg_1"])
    // Speaker changed back: turns and stats recomputed.
    find(statements, /^update transcript_segments ts set turn_index/)
    expect(result.version).toBe(8)
  })

  it("throws NothingToUndoError without a revision", async () => {
    const { pool } = recordingPool((text) =>
      /^select .* from transcript_segment_revisions/.test(text) ? [] : undefined
    )

    await expect(
      createPostgresMeetingRepository(pool, SCOPE).undoTranscriptSegment("meet_1", "seg_1", {
        expectedRevision: 0,
      })
    ).rejects.toBeInstanceOf(NothingToUndoError)
  })
})

describe("postgres replaceTranscript({ preserveEdited })", () => {
  const edited = {
    ...SEGMENT,
    id: "seg_edited",
    text: "טקסט שתוקן ידנית",
    words: null,
    source: "edited",
    revision: 2,
    edited_at: "2026-10-13T00:00:00.000Z",
  }

  function responder(text: string) {
    if (/^select s\.id, s\.meeting_id, s\.label/.test(text)) {
      return [
        {
          id: "spk_1",
          meeting_id: "meet_1",
          label: "Speaker 1",
          source: "asr",
          mapping_status: "confirmed",
          participant_name: "Dana",
          display_name: null,
        },
      ]
    }
    if (/where ts\.meeting_id = \$1 and ts\.source = 'edited'/.test(text)) return [edited]
    return undefined
  }

  it("keeps matching edited rows (and so their revisions) and confirmed mappings", async () => {
    const { pool, statements } = recordingPool(responder)

    const result = await createPostgresMeetingRepository(pool, SCOPE).replaceTranscript(
      "meet_1",
      {
        segments: [
          { id: "seg_edited", speaker: "Speaker 1", startMs: 1000, endMs: 3000, text: "cleaned" },
          { id: "seg_new", speaker: "Speaker 1", startMs: 3000, endMs: 4000, text: "עוד" },
        ],
        speakers: [{ label: "Speaker 1", talkTimeMs: 3000, wordCount: 3, segmentCount: 2 }],
      },
      { preserveEdited: true }
    )
    const deleteSegments = find(statements, /^delete from transcript_segments/)
    const insert = find(statements, /^insert into transcript_segments/)
    const repoint = find(statements, /^update transcript_segments ts set speaker_id = u\.speaker_id/)
    const speakerUpdate = find(statements, /^update speakers set workspace_id/)

    expect(deleteSegments.text).toContain("not (id = any($2::text[]))")
    expect(deleteSegments.values).toEqual(["meet_1", ["seg_edited"]])
    expect(insert.values[2]).toEqual(["seg_new"])
    expect(repoint.values[1]).toEqual(["seg_edited"])
    // Confirmed diarized mapping survives the cleanup re-write.
    expect(speakerUpdate.text).not.toContain("mapping_status = 'unmapped'")
    expect(result.segments.find((segment) => segment.id === "seg_edited")?.text).toBe(
      "טקסט שתוקן ידנית"
    )
    expectScoped(find(statements, /^update meetings m set transcript_version/))
  })

  it("re-ASR without preserveEdited deletes every segment and resets diarized mappings", async () => {
    const { pool, statements } = recordingPool(responder)

    await createPostgresMeetingRepository(pool, SCOPE).replaceTranscript("meet_1", {
      segments: [{ id: "seg_x", speaker: "Speaker 1", startMs: 0, endMs: 1000, text: "x" }],
      speakers: [{ label: "Speaker 1", talkTimeMs: 1000, wordCount: 1, segmentCount: 1 }],
    })

    expect(find(statements, /^delete from transcript_segments/).text).toBe(
      "delete from transcript_segments where meeting_id = $1"
    )
    expect(find(statements, /^update speakers set workspace_id/).text).toContain(
      "mapping_status = 'unmapped'"
    )
    // Transcript duration only when no media duration exists.
    const bump = find(statements, /^update meetings m set transcript_version/)

    expect(bump.text).toContain("a.duration_ms is not null")
    expect(bump.values).toContain(1000)
  })
})
