import { describe, expect, it } from "vitest"

import { createPostgresMeetingRepository } from "@/lib/meetings/postgres-repository"
import type { RepoScope, TranscriptSegment } from "@/lib/meetings/repository"

/**
 * M3 speaker data layer against a recording Queryable: transactions, the
 * speaker upsert key (meeting + label), words JSON, mapping reset rules,
 * merge without text/word rewrites, and workspace scoping of profiles.
 */

type Statement = { text: string; values: unknown[] }

const WS = "ws_a"
const scope: RepoScope = {
  kind: "member",
  workspaceId: WS,
  userId: "user_me",
  email: "me@example.com",
  role: "member",
}

type SpeakerFixture = {
  id: string
  label: string
  source: string
  mapping_status: string
  participant_id?: string | null
  display_name?: string | null
  participant_name?: string | null
  talk_time_ms?: number
  word_count?: number
  segment_count?: number
  first_start_ms?: number | null
  embedding?: number[] | null
  embedding_model?: string | null
}

function speakerRow(fixture: SpeakerFixture) {
  return {
    meeting_id: "meet_1",
    display_name: null,
    participant_name: null,
    participant_id: null,
    profile_id: null,
    suggestion: null,
    talk_time_ms: 0,
    word_count: 0,
    segment_count: 0,
    first_start_ms: 0,
    confirmed_at: null,
    ...fixture,
  }
}

function recordingPool(options: {
  speakers?: SpeakerFixture[]
  segments?: Array<{ id: string; speaker_id: string; start_ms: number }>
  profile?: Record<string, unknown>
  meetingVisible?: boolean
} = {}) {
  const statements: Statement[] = []
  let transactions = 0

  async function query(text: string, values: unknown[] = []) {
    const normalized = text.replace(/\s+/g, " ").trim()

    statements.push({ text: normalized, values })

    if (/^(begin|commit|rollback)$/.test(normalized)) return { rows: [] }
    if (/\bfrom meetings m\b/.test(normalized)) {
      return { rows: options.meetingVisible === false ? [] : [{ id: "meet_1" }] }
    }
    if (/^select .* from speakers s/.test(normalized)) {
      const ids = normalized.includes("s.id = any(")
        ? (values[values.length - 1] as string[])
        : undefined
      const rows = (options.speakers ?? [])
        .filter((speaker) => !ids || ids.includes(speaker.id))
        .map(speakerRow)

      return { rows }
    }
    if (/^select id, embedding, embedding_model from speakers/.test(normalized)) {
      const speaker = (options.speakers ?? []).find((row) => row.id === values[0])

      return { rows: speaker ? [speakerRow(speaker)] : [] }
    }
    if (/^select id, speaker_id, start_ms from transcript_segments/.test(normalized)) {
      return { rows: options.segments ?? [] }
    }
    if (/^select .* from speaker_profiles/.test(normalized)) {
      return { rows: options.profile ? [options.profile] : [] }
    }
    if (/^(insert into|update) speaker_profiles/.test(normalized)) {
      return {
        rows: [
          {
            id: (values[0] as string) ?? "profile_new",
            workspace_id: WS,
            display_name: values[2],
            email: null,
            aliases: [],
            confirmed_count: 1,
            voice_embedding: null,
            embedding_model: null,
            embedding_samples: 0,
          },
        ],
      }
    }
    if (/^update speakers s set/.test(normalized)) return { rows: [{ id: values[0] }] }

    return { rows: [] }
  }

  const pool = {
    query,
    async connect() {
      transactions += 1
      return { query, release() {} }
    },
  }

  return { pool, statements, transactions: () => transactions }
}

function statementsMatching(statements: Statement[], pattern: RegExp) {
  return statements.filter((statement) => pattern.test(statement.text))
}

const SEGMENTS: TranscriptSegment[] = [
  {
    id: "seg_1",
    speaker: "Speaker 1",
    startMs: 0,
    endMs: 2_000,
    text: "שלום, אני דנה",
    language: "he",
    confidence: 0.91,
    turnIndex: 0,
    words: [
      { startMs: 0, endMs: 500, text: "שלום,", confidence: 0.9 },
      { startMs: 600, endMs: 1_000, text: "אני", confidence: 0.95 },
      { startMs: 1_100, endMs: 2_000, text: "דנה", confidence: 0.88 },
    ],
  },
  {
    id: "seg_2",
    speaker: "Speaker 2",
    startMs: 2_500,
    endMs: 4_000,
    text: "Supabase works",
    language: "en",
    turnIndex: 1,
    words: [
      { startMs: 2_500, endMs: 3_200, text: "Supabase", confidence: 0.8 },
      { startMs: 3_300, endMs: 4_000, text: "works" },
    ],
  },
]

describe("postgres replaceTranscript", () => {
  it("writes segments and speakers in one transaction after a scoped meeting lock", async () => {
    const { pool, statements, transactions } = recordingPool()

    const result = await createPostgresMeetingRepository(pool, scope).replaceTranscript(
      "meet_1",
      {
        segments: SEGMENTS,
        speakers: [
          { label: "Speaker 1", talkTimeMs: 2_000, wordCount: 3, segmentCount: 1, firstStartMs: 0 },
          { label: "Speaker 2", talkTimeMs: 1_500, wordCount: 2, segmentCount: 1, firstStartMs: 2_500 },
        ],
        asrRunId: "airun_1",
      }
    )

    expect(transactions()).toBe(1)
    expect(statements[0].text).toBe("begin")
    expect(statements[1].text).toMatch(/^select m\.id from meetings m where m\.id = \$1 and .* for update of m$/)
    expect(statements[1].values).toContain(WS)
    expect(statements.at(-1)?.text).toBe("commit")
    expect(statementsMatching(statements, /meeting_participants/).filter((s) => /^insert/.test(s.text))).toEqual([])

    const speakerInserts = statementsMatching(statements, /^insert into speakers/)

    expect(speakerInserts).toHaveLength(2)
    for (const insert of speakerInserts) {
      expect(insert.text).toContain("'unmapped'")
      expect(insert.values[1]).toBe("meet_1")
      expect(insert.values[3]).toBe(WS)
    }
    expect(speakerInserts.map((insert) => insert.values[2])).toEqual(["Speaker 1", "Speaker 2"])

    const [segmentInsert] = statementsMatching(statements, /^insert into transcript_segments/)

    expect(segmentInsert.text).toContain("u.words::jsonb")
    expect(segmentInsert.values[0]).toBe("meet_1")
    expect(segmentInsert.values[1]).toBe("airun_1")
    const words = (segmentInsert.values[9] as string[]).map((value) => JSON.parse(value))

    // Tuples; the language is omitted when it equals the segment's.
    expect(words[0]).toEqual([
      [0, 500, "שלום,", 0.9],
      [600, 1000, "אני", 0.95],
      [1100, 2000, "דנה", 0.88],
    ])
    expect(words[1][1]).toEqual([3300, 4000, "works", null])
    expect(segmentInsert.values[10]).toEqual([0, 1])
    expect(segmentInsert.values[11]).toEqual(["asr", "asr"])
    // Segment speaker ids point at the inserted speaker rows.
    expect(segmentInsert.values[3]).toEqual(speakerInserts.map((insert) => insert.values[0]))
    expect(result.segments.map((segment) => segment.speakerId)).toEqual(
      speakerInserts.map((insert) => insert.values[0])
    )
  })

  it("upserts on (meeting, label): updates surviving labels by id and deletes speakers without segments", async () => {
    const { pool, statements } = recordingPool({
      speakers: [
        { id: "speaker_keep", label: "Speaker 1", source: "asr", mapping_status: "suggested" },
        { id: "speaker_gone", label: "Speaker 9", source: "asr", mapping_status: "unmapped" },
      ],
    })

    await createPostgresMeetingRepository(pool, scope).replaceTranscript("meet_1", {
      segments: [SEGMENTS[0]],
      speakers: [{ label: "Speaker 1", talkTimeMs: 2_000, wordCount: 3, segmentCount: 1 }],
    })

    const [update] = statementsMatching(statements, /^update speakers set workspace_id/)

    expect(update.text).toContain("where id = $1 and meeting_id = $2")
    expect(update.values.slice(0, 3)).toEqual(["speaker_keep", "meet_1", WS])
    expect(statementsMatching(statements, /^insert into speakers/)).toEqual([])

    const [deletion] = statementsMatching(statements, /^delete from speakers/)

    expect(deletion.values).toEqual(["meet_1", ["speaker_gone"]])
    // Old segments go before the speaker deletion (FK order).
    expect(statements.indexOf(deletion)).toBeGreaterThan(
      statements.findIndex((statement) => statement.text.startsWith("delete from transcript_segments"))
    )
  })

  it("re-ASR resets a confirmed diarized mapping; a Meet re-import keeps it", async () => {
    const reasr = recordingPool({
      speakers: [
        { id: "speaker_1", label: "Speaker 1", source: "asr", mapping_status: "confirmed" },
      ],
    })

    await createPostgresMeetingRepository(reasr.pool, scope).replaceTranscript("meet_1", {
      segments: [{ ...SEGMENTS[0], source: "asr" }],
      speakers: [{ label: "Speaker 1", source: "asr", talkTimeMs: 1, wordCount: 1, segmentCount: 1 }],
    })
    // Diarized labels are arbitrary per run: a re-ASR resets even with the
    // same source and label.
    const [asrUpdate] = statementsMatching(reasr.statements, /^update speakers set workspace_id/)

    expect(asrUpdate.text).toContain("mapping_status = 'unmapped'")
    expect(asrUpdate.text).toContain("participant_id = null")

    const meet = recordingPool({
      speakers: [{ id: "speaker_1", label: "Dana", source: "meet", mapping_status: "confirmed" }],
    })

    await createPostgresMeetingRepository(meet.pool, scope).replaceTranscript("meet_1", {
      segments: [{ ...SEGMENTS[0], speaker: "Dana", source: "meet" }],
      speakers: [{ label: "Dana", source: "meet", talkTimeMs: 1, wordCount: 1, segmentCount: 1 }],
    })
    expect(
      statementsMatching(meet.statements, /^update speakers set workspace_id/)[0].text
    ).not.toContain("mapping_status = 'unmapped'")

    const switched = recordingPool({
      speakers: [{ id: "speaker_1", label: "Dana", source: "meet", mapping_status: "confirmed" }],
    })

    await createPostgresMeetingRepository(switched.pool, scope).replaceTranscript("meet_1", {
      segments: [{ ...SEGMENTS[0], speaker: "Dana", source: "asr" }],
      speakers: [{ label: "Dana", source: "asr", talkTimeMs: 1, wordCount: 1, segmentCount: 1 }],
    })
    const [reset] = statementsMatching(switched.statements, /^update speakers set workspace_id/)

    expect(reset.text).toContain("mapping_status = 'unmapped'")
    expect(reset.text).toContain("participant_id = null")
  })

  it("never writes anything for an invisible meeting", async () => {
    const { pool, statements } = recordingPool({ meetingVisible: false })

    await expect(
      createPostgresMeetingRepository(pool, scope).replaceTranscript("meet_1", {
        segments: SEGMENTS,
        speakers: [],
      })
    ).rejects.toThrow("Meeting not found")
    expect(
      statements.filter((statement) => /^(insert|update|delete)/.test(statement.text))
    ).toEqual([])
  })

  it("legacy replaceTranscriptSegments keeps the stored label of read-back segments", async () => {
    const { pool, statements } = recordingPool({
      speakers: [
        {
          id: "speaker_1",
          label: "Speaker 1",
          source: "asr",
          mapping_status: "confirmed",
          participant_id: "participant_1",
          participant_name: "Dana Cohen",
        },
      ],
    })

    await createPostgresMeetingRepository(pool, scope).replaceTranscriptSegments("meet_1", [
      { ...SEGMENTS[0], speaker: "Dana Cohen", speakerId: "speaker_1" },
    ])

    const [update] = statementsMatching(statements, /^update speakers set workspace_id/)

    expect(update.values[0]).toBe("speaker_1")
    // Source unchanged → the confirmed mapping is kept.
    expect(update.text).not.toContain("mapping_status = 'unmapped'")
    expect(statementsMatching(statements, /^insert into speakers/)).toEqual([])
    expect(statementsMatching(statements, /^insert into meeting_participants/)).toEqual([])
  })
})

describe("postgres speaker mapping", () => {
  it("updates a speaker only as a (meeting, speaker) pair with an in-meeting participant", async () => {
    const { pool, statements } = recordingPool({
      speakers: [{ id: "speaker_1", label: "Speaker 1", source: "asr", mapping_status: "unmapped" }],
    })

    await createPostgresMeetingRepository(pool, scope).updateMeetingSpeaker(
      "meet_1",
      "speaker_1",
      { participantId: "participant_1", mappingStatus: "confirmed", confirmedByUserId: "user_me" }
    )

    const [update] = statementsMatching(statements, /^update speakers s set/)

    expect(update.text).toContain("where s.id = $1 and s.meeting_id = $2")
    expect(update.text).toContain(
      "exists (select 1 from meeting_participants mp where mp.id = $3 and mp.meeting_id = s.meeting_id)"
    )
    expect(update.values.slice(0, 3)).toEqual(["speaker_1", "meet_1", "participant_1"])
    expect(update.text).not.toMatch(/transcript_segments|\btext\b|\bwords\b/)
  })

  it("merges by repointing segments, summing stats and recomputing turns — never text or words", async () => {
    const { pool, statements } = recordingPool({
      speakers: [
        { id: "speaker_a", label: "Speaker 1", source: "asr", mapping_status: "unmapped", talk_time_ms: 1000, word_count: 3, segment_count: 1, first_start_ms: 0 },
        { id: "speaker_b", label: "Speaker 2", source: "asr", mapping_status: "confirmed", talk_time_ms: 2000, word_count: 5, segment_count: 2, first_start_ms: 500 },
      ],
      segments: [
        { id: "seg_1", speaker_id: "speaker_b", start_ms: 0 },
        { id: "seg_2", speaker_id: "speaker_b", start_ms: 1000 },
        { id: "seg_3", speaker_id: "speaker_c", start_ms: 2000 },
      ],
    })

    await createPostgresMeetingRepository(pool, scope).mergeMeetingSpeakers(
      "meet_1",
      "speaker_a",
      "speaker_b"
    )

    const writes = statements.filter((statement) => /^(insert|update|delete)/.test(statement.text))

    for (const write of writes) {
      expect(write.text).not.toMatch(/set (text|words)\b|, (text|words) =/)
    }
    expect(writes[0].text).toBe(
      "update transcript_segments set speaker_id = $3 where meeting_id = $1 and speaker_id = $2"
    )
    expect(writes[0].values).toEqual(["meet_1", "speaker_a", "speaker_b"])
    expect(writes[1].values).toEqual(["meet_1", "speaker_b", 1000, 3, 1, 0])
    expect(writes[2].text).toBe("delete from speakers where id = $2 and meeting_id = $1")
    expect(writes[3].text).toContain("set turn_index = u.turn_index")
    expect(writes[3].values).toEqual(["meet_1", ["seg_1", "seg_2", "seg_3"], [0, 0, 1]])
  })

  it("never lets suggestions overwrite confirmed or rejected speakers", async () => {
    const { pool, statements } = recordingPool()

    await createPostgresMeetingRepository(pool, scope).setSpeakerSuggestions("meet_1", [
      {
        speakerId: "speaker_1",
        mappingStatus: "suggested",
        suggestion: { name: "Dana", score: 0.8, reasons: [], computedAt: "2026-10-13T00:00:00.000Z" },
      },
    ])

    const [update] = statementsMatching(statements, /^update speakers s set/)

    expect(update.text).toContain("s.mapping_status not in ('confirmed', 'rejected')")
    expect(update.text).toContain("where s.id = $1 and s.meeting_id = $2")
  })
})

describe("postgres speaker profiles", () => {
  it("lists profiles of the scope's workspace only", async () => {
    const { pool, statements } = recordingPool()

    await createPostgresMeetingRepository(pool, scope).listSpeakerProfiles()

    expect(statements[0].text).toContain("from speaker_profiles where workspace_id = $1")
    expect(statements[0].values).toEqual([WS])
  })

  it("upserts a confirmed speaker's profile by email, else by normalized name", async () => {
    const byEmail = recordingPool({
      speakers: [{ id: "speaker_1", label: "Speaker 1", source: "asr", mapping_status: "confirmed" }],
    })

    await createPostgresMeetingRepository(byEmail.pool, scope).recordConfirmedSpeaker({
      meetingId: "meet_1",
      speakerId: "speaker_1",
      participant: { name: "Dana Cohen", email: "Dana@Example.com" },
      aliases: ["דנה"],
    })

    const [emailLookup] = statementsMatching(byEmail.statements, /^select .* from speaker_profiles/)

    expect(emailLookup.text).toContain("workspace_id = $1 and lower(email) = $2")
    expect(emailLookup.values).toEqual([WS, "dana@example.com"])

    const [insert] = statementsMatching(byEmail.statements, /^insert into speaker_profiles/)

    expect(insert.values.slice(1, 5)).toEqual([WS, "Dana Cohen", "dana@example.com", ["דנה"]])
    expect(statementsMatching(byEmail.statements, /^update speakers set profile_id/)[0].values).toEqual([
      insert.values[0],
      "speaker_1",
      "meet_1",
    ])

    const byName = recordingPool({
      speakers: [
        {
          id: "speaker_1",
          label: "Speaker 1",
          source: "asr",
          mapping_status: "confirmed",
          embedding: [0, 1],
          embedding_model: "pyannote",
        },
      ],
      profile: {
        id: "profile_1",
        workspace_id: WS,
        display_name: "Dana Cohen",
        email: null,
        aliases: ["Dana"],
        confirmed_count: 2,
        voice_embedding: [1, 0],
        embedding_model: "pyannote",
        embedding_samples: 1,
      },
    })

    await createPostgresMeetingRepository(byName.pool, scope).recordConfirmedSpeaker({
      meetingId: "meet_1",
      speakerId: "speaker_1",
      participant: { name: "  dana   cohen " },
      aliases: ["dana", "דנה"],
    })

    const [nameLookup] = statementsMatching(byName.statements, /^select .* from speaker_profiles/)

    expect(nameLookup.text).toContain("email is null and lower(display_name) = $2")
    expect(nameLookup.values).toEqual([WS, "dana cohen"])

    const [update] = statementsMatching(byName.statements, /^update speaker_profiles/)

    expect(update.text).toContain("confirmed_count = confirmed_count + 1")
    expect(update.values[1]).toBe(WS)
    // Aliases union case-insensitively; running mean of embeddings (same model).
    expect(update.values[3]).toEqual(["Dana", "דנה"])
    expect(update.values[5]).toEqual([0.5, 0.5])
    expect(update.values[7]).toBe(2)
  })
})
