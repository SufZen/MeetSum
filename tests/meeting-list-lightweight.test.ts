import { describe, expect, it } from "vitest"

import { createPostgresMeetingRepository } from "@/lib/meetings/postgres-repository"
import {
  createInMemoryMeetingDatabase,
  createInMemoryMeetingRepository,
  type RepoScope,
} from "@/lib/meetings/repository"

/**
 * M4 B1: the inbox list is hydrated in batches (one statement per relation
 * for the whole page), so its query count does not grow with the page size,
 * and it never carries transcripts, words, summaries or media metadata.
 */

const WS = "ws_a"
const SCOPE: RepoScope = {
  kind: "member",
  workspaceId: WS,
  userId: "user_me",
  email: "me@example.com",
  role: "member",
}

function meetingRow(index: number) {
  return {
    id: `meet_${index}`,
    title: `Meeting ${index}`,
    source: "upload",
    language: "he",
    status: "completed",
    retention: "audio",
    started_at: "2026-10-01T10:00:00.000Z",
    participants: "[]",
    workspace_id: WS,
    owner_user_id: "user_me",
    visibility: "workspace",
    duration_ms: 60_000 * index,
    transcript_version: 3,
  }
}

function recordingClient(pageSize: number) {
  const statements: Array<{ text: string; values: unknown[] }> = []
  const ids = Array.from({ length: pageSize }, (_, index) => `meet_${index}`)
  const client = {
    async query(text: string, values: unknown[] = []) {
      const normalized = text.replace(/\s+/g, " ").trim()

      statements.push({ text: normalized, values })

      if (/^select count\(\*\)::int as total from meetings m/.test(normalized)) {
        return { rows: [{ total: 100 }] }
      }
      if (/^select m\.id, m\.title/.test(normalized)) {
        return { rows: ids.map((_, index) => meetingRow(index)) }
      }
      if (/from media_assets/.test(normalized)) {
        return {
          rows: [
            {
              id: "asset_0",
              meeting_id: "meet_0",
              storage_key: "k",
              content_type: "audio/webm",
              size_bytes: 1,
              retention: "audio",
              kind: "original",
              created_at: "2026-10-01T10:00:00.000Z",
            },
          ],
        }
      }
      if (/from action_items/.test(normalized)) return { rows: [{ meeting_id: "meet_1", count: 4 }] }
      if (/from transcript_segments/.test(normalized)) {
        return { rows: ids.map((id) => ({ meeting_id: id, count: 12 })) }
      }
      if (/from meeting_tags/.test(normalized)) return { rows: [{ meeting_id: "meet_0", name: "finance" }] }
      if (/from meeting_participants/.test(normalized)) {
        return {
          rows: [
            {
              id: "p1",
              meeting_id: "meet_0",
              name: "Dana",
              email: null,
              role: "organizer",
              source: "calendar",
              attendance_status: "unknown",
              speaker_label: null,
              confidence: 0.6,
              created_at: "2026-10-01T10:00:00.000Z",
              updated_at: "2026-10-01T10:00:00.000Z",
            },
          ],
        }
      }
      if (/from meeting_favorites/.test(normalized)) return { rows: [{ meeting_id: "meet_2" }] }
      return { rows: [] }
    },
  }

  return { client, statements }
}

describe("lightweight meeting list (Postgres)", () => {
  it("issues the same number of statements for 5 and 20 meetings", async () => {
    const small = recordingClient(5)
    const large = recordingClient(20)

    await createPostgresMeetingRepository(small.client, SCOPE).listMeetingsPage({ limit: 5 })
    await createPostgresMeetingRepository(large.client, SCOPE).listMeetingsPage({ limit: 20 })

    expect(large.statements.length).toBe(small.statements.length)
    // count + page + participants, tags, contexts, media, action items, segments, favorites
    expect(small.statements).toHaveLength(9)
  })

  it("never reads transcript text, words, summaries or media metadata", async () => {
    const { client, statements } = recordingClient(5)

    await createPostgresMeetingRepository(client, SCOPE).listMeetingsPage({ limit: 5 })

    for (const statement of statements) {
      expect(statement.text).not.toMatch(/\bts\.text\b|\bwords\b|from summaries|intelligence_runs|\bmetadata\b/)
    }

    const batched = statements.slice(2)

    for (const statement of batched) {
      expect(statement.text).toMatch(/meeting_id = any\(\$\d::text\[\]\)/)
    }
    for (const statement of batched.filter((item) => /media_assets|join tags|join contexts/.test(item.text))) {
      expect(statement.text).toContain("workspace_id = $2")
      expect(statement.values[1]).toBe(WS)
    }
  })

  it("maps counts, media, tags, favorites and duration onto list items", async () => {
    const { client } = recordingClient(5)
    const page = await createPostgresMeetingRepository(client, SCOPE).listMeetingsPage({ limit: 5 })
    const [first, second, third] = page.meetings

    expect(page.page).toEqual({ limit: 5, offset: 0, total: 100, hasMore: true })
    expect(first).toMatchObject({
      hasMedia: true,
      transcriptSegmentCount: 12,
      actionItemCount: 0,
      tags: ["finance"],
      durationMs: 0,
      transcriptVersion: 3,
    })
    expect(first.mediaAssets?.[0]).not.toHaveProperty("metadata")
    expect(first.participantDetails?.map((participant) => participant.name)).toEqual(["Dana"])
    expect(second).toMatchObject({ actionItemCount: 4, hasMedia: false, durationMs: 60_000 })
    expect(third.isFavorite).toBe(true)
    for (const meeting of page.meetings) {
      expect(meeting).not.toHaveProperty("transcript")
      expect(meeting).not.toHaveProperty("summary")
      expect(meeting).not.toHaveProperty("intelligence")
    }
  })

  it("skips the batched queries for an empty page", async () => {
    const statements: string[] = []
    const client = {
      async query(text: string) {
        statements.push(text)
        return { rows: /count\(\*\)/.test(text) ? [{ total: 0 }] : [] }
      },
    }

    const page = await createPostgresMeetingRepository(client, SCOPE).listMeetingsPage({})

    expect(page.meetings).toEqual([])
    expect(statements).toHaveLength(2)
  })
})

describe("lightweight meeting list (in memory)", () => {
  it("drops transcript, summary and media metadata but keeps counts", async () => {
    const repo = createInMemoryMeetingRepository(createInMemoryMeetingDatabase(), {
      kind: "system",
      workspaceId: "ws_default",
    })
    const meeting = await repo.createMeeting({
      title: "Sync",
      source: "upload",
      language: "he",
      startedAt: "2026-10-01T10:00:00.000Z",
    })

    await repo.createMediaAsset({
      meetingId: meeting.id,
      storageKey: "k",
      contentType: "audio/webm",
      sizeBytes: 1,
      metadata: { durationMs: 1000 },
    })
    await repo.replaceTranscript(meeting.id, {
      segments: [{ id: "s1", speaker: "Speaker 1", startMs: 0, endMs: 1000, text: "שלום" }],
      speakers: [{ label: "Speaker 1", talkTimeMs: 1000, wordCount: 1, segmentCount: 1 }],
    })
    await repo.runMeetingIntelligence(meeting.id)

    const [item] = (await repo.listMeetingsPage()).meetings

    expect(item).not.toHaveProperty("transcript")
    expect(item).not.toHaveProperty("summary")
    expect(item).not.toHaveProperty("speakers")
    expect(item.mediaAssets?.[0]).not.toHaveProperty("metadata")
    expect(item).toMatchObject({ transcriptSegmentCount: 1, hasMedia: true })
    expect(item.actionItemCount).toBeGreaterThanOrEqual(0)
    // searchMeetings keeps full records (memory/ask reads transcripts).
    expect((await repo.searchMeetings("שלום"))[0].transcript).toHaveLength(1)
  })
})
