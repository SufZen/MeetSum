import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import type { MeetingRecord, MeetingShare } from "@/lib/meetings/repository"
import { encodeWords } from "@/lib/meetings/transcript-words"
import { createShareAccessCookie } from "@/lib/sharing/share-access"
import {
  buildSharePayload,
  loadSharePageData,
  type SharePayload,
} from "@/lib/sharing/share-payload"
import { SHARE_SECTIONS, type ShareSection } from "@/lib/sharing/share-sections"

/**
 * The public share page serializes only `buildSharePayload` output (server
 * HTML + SharedMeetingPlayer props). Every value below that must never leave
 * the server carries a SECRET marker; section content carries a per-section
 * marker that must appear iff the section is included.
 */

const NEVER = [
  "m_SECRET_meeting",
  "ws_SECRET_workspace",
  "user_SECRET_owner",
  "seg_SECRET_internal",
  "spk_SECRET_internal",
  "part_SECRET_dana",
  "part_SECRET_yossi",
  "dana.SECRET@example.com",
  "yossi.SECRET@example.com",
  "profile_SECRET",
  "asset_SECRET_original",
  "asset_SECRET_playback",
  "meetings/SECRET/storage-key",
  "derived/SECRET.peaks",
  "SECRET_ai_run_id",
  "SECRET_fallback_reason",
  "SECRET_prompt_metadata",
  "SECRET_suggestion_reason",
  "SECRET_embedding_model",
  "SECRET_source_quote",
  "SECRET_ai_error",
  "share_SECRET_id",
  "SECRET_password_hash",
  "user_SECRET_creator",
  "SECRET_external_id",
  "SECRET_quality_warning",
  "SECRET_intelligence",
]

const SECTION_MARKERS: Record<ShareSection, string[]> = {
  summary: ["OVERVIEW_MARKER"],
  decisions: ["DECISION_MARKER"],
  action_items: ["ACTION_MARKER", "OWNER_MARKER"],
  transcript: ["TRANSCRIPT_MARKER", "WORD_MARKER", "PROVIDER_MARKER"],
  participants: ["ONLY_PARTICIPANT_MARKER"],
  media: ["audio/mp4"],
}

const PASSWORD_HASH = "SECRET_password_hash"

const meeting: MeetingRecord = {
  id: "m_SECRET_meeting",
  title: "Quarterly sync",
  source: "upload",
  language: "en",
  status: "completed",
  retention: "audio",
  startedAt: "2026-10-01T10:00:00.000Z",
  participants: ["dana.SECRET@example.com", "yossi.SECRET@example.com"],
  participantDetails: [
    {
      id: "part_SECRET_dana",
      meetingId: "m_SECRET_meeting",
      name: "SPEAKER_NAME_MARKER Dana",
      email: "dana.SECRET@example.com",
      role: "organizer",
      source: "calendar",
      attendanceStatus: "accepted",
      speakerLabel: "Speaker 1",
      createdAt: "2026-10-01T10:00:00.000Z",
      updatedAt: "2026-10-01T10:00:00.000Z",
    },
    {
      id: "part_SECRET_yossi",
      meetingId: "m_SECRET_meeting",
      name: "ONLY_PARTICIPANT_MARKER Yossi",
      email: "yossi.SECRET@example.com",
      role: "attendee",
      source: "calendar",
      attendanceStatus: "accepted",
      createdAt: "2026-10-01T10:00:00.000Z",
      updatedAt: "2026-10-01T10:00:00.000Z",
    },
  ],
  summary: {
    overview: "OVERVIEW_MARKER of the meeting",
    decisions: ["DECISION_MARKER ship it"],
    actionItems: [
      {
        id: "SECRET_ai_run_id_action",
        title: "ACTION_MARKER send deck",
        owner: "OWNER_MARKER",
        status: "open",
        sourceQuote: "SECRET_source_quote",
        sourceStartMs: 1000,
        confidence: 0.9,
      },
    ],
  },
  transcript: [
    {
      id: "seg_SECRET_internal",
      speaker: "Speaker 1",
      speakerId: "spk_SECRET_internal",
      startMs: 0,
      endMs: 2000,
      text: "TRANSCRIPT_MARKER hello",
      language: "en",
      turnIndex: 0,
      source: "edited",
      revision: 3,
      editedAt: "2026-10-02T10:00:00.000Z",
      confidence: 0.8,
      words: [
        { text: "WORD_MARKER", startMs: 0, endMs: 900, confidence: 0.9 },
        { text: "hello", startMs: 1000, endMs: 2000 },
      ],
    },
  ],
  speakers: [
    {
      id: "spk_SECRET_internal",
      meetingId: "m_SECRET_meeting",
      label: "Speaker 1",
      participantId: "part_SECRET_dana",
      profileId: "profile_SECRET",
      mappingStatus: "confirmed",
      suggestion: {
        participantId: "part_SECRET_dana",
        confidence: 0.9,
        reasons: [{ kind: "self_intro", weight: 1, detail: "SECRET_suggestion_reason" }],
      } as never,
      source: "asr",
      talkTimeMs: 2000,
      wordCount: 2,
      segmentCount: 1,
      firstStartMs: 0,
      embedding: [0.1, 0.2],
      embeddingModel: "SECRET_embedding_model",
    },
  ],
  mediaAssets: [
    {
      id: "asset_SECRET_original",
      meetingId: "m_SECRET_meeting",
      storageKey: "meetings/SECRET/storage-key.m4a",
      contentType: "audio/mp4",
      sizeBytes: 1000,
      retention: "audio",
      kind: "original",
      peaksStorageKey: "meetings/x/derived/SECRET.peaks.v1.json",
      durationMs: 2000,
      metadata: { note: "SECRET_prompt_metadata" },
      createdAt: "2026-10-01T10:00:00.000Z",
    },
    {
      id: "asset_SECRET_playback",
      meetingId: "m_SECRET_meeting",
      storageKey: "meetings/SECRET/storage-key.playback.m4a",
      contentType: "audio/mp4",
      sizeBytes: 500,
      retention: "audio",
      kind: "playback",
      derivedFromAssetId: "asset_SECRET_original",
      durationMs: 2000,
      createdAt: "2026-10-01T11:00:00.000Z",
    },
  ],
  aiRuns: [
    {
      id: "SECRET_ai_run_id",
      meetingId: "m_SECRET_meeting",
      provider: "PROVIDER_MARKER",
      task: "audio.transcribe",
      status: "completed",
      model: "model-x",
      latencyMs: 1234,
      metadata: { fallbackReason: "SECRET_fallback_reason", prompt: "SECRET_prompt_metadata" },
      startedAt: "2026-10-01T10:00:00.000Z",
    },
    {
      id: "SECRET_ai_run_id_2",
      meetingId: "m_SECRET_meeting",
      provider: "summarizer",
      task: "summary.generate",
      status: "failed",
      metadata: {},
      error: "SECRET_ai_error",
      startedAt: "2026-10-01T10:00:00.000Z",
    },
  ],
  qualityWarnings: [{ code: "SECRET_quality_warning" } as never],
  intelligence: { note: "SECRET_intelligence" } as never,
  externalId: "SECRET_external_id",
  workspaceId: "ws_SECRET_workspace",
  ownerUserId: "user_SECRET_owner",
  visibility: "link",
  durationMs: 2000,
}

function share(includedSections: string[], overrides: Partial<MeetingShare> = {}): MeetingShare {
  return {
    id: "share_SECRET_id",
    meetingId: "m_SECRET_meeting",
    token: "tok_public",
    visibility: "public",
    revoked: false,
    includedSections,
    createdBy: "user_SECRET_creator",
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:00:00.000Z",
    ...overrides,
  }
}

function combinations<T>(items: readonly T[]): T[][] {
  return items.reduce<T[][]>(
    (all, item) => [...all, ...all.map((combo) => [...combo, item])],
    [[]]
  )
}

/** What reaches the browser: the payload as JSON (props + rendered text). */
function serialized(payload: SharePayload) {
  return JSON.stringify(payload)
}

describe("buildSharePayload", () => {
  const combos = combinations(SHARE_SECTIONS)

  it("covers all 64 section combinations", () => {
    expect(combos).toHaveLength(64)
  })

  it.each(combos.map((combo) => [combo.join(",") || "(none)", combo] as const))(
    "sections %s: internal data never serialized, excluded sections absent",
    (_label, sections) => {
      const payload = buildSharePayload(share([...sections]), meeting)
      const json = serialized(payload)

      for (const secret of NEVER) {
        expect(json, `leaked ${secret}`).not.toContain(secret)
      }

      for (const section of SHARE_SECTIONS) {
        const included = sections.includes(section)

        for (const marker of SECTION_MARKERS[section]) {
          if (included) expect(json, `${section} missing ${marker}`).toContain(marker)
          else expect(json, `${section} excluded but ${marker} present`).not.toContain(marker)
        }
      }

      expect("overview" in payload).toBe(sections.includes("summary"))
      expect("decisions" in payload).toBe(sections.includes("decisions"))
      expect("actionItems" in payload).toBe(sections.includes("action_items"))
      expect("transcript" in payload).toBe(sections.includes("transcript"))
      expect("participants" in payload).toBe(sections.includes("participants"))
      expect("media" in payload).toBe(sections.includes("media"))
      // A mapped speaker's name is transcript content: it shows with the
      // transcript or the participant list, never otherwise.
      expect(json.includes("SPEAKER_NAME_MARKER")).toBe(
        sections.includes("transcript") || sections.includes("participants")
      )
    }
  )

  it("keeps transcript structure with opaque ids and server-resolved speaker names", () => {
    const payload = buildSharePayload(share(["transcript"]), meeting)
    const [segment] = payload.transcript!.segments
    const [speaker] = payload.transcript!.speakers

    expect(segment).toEqual({
      id: "seg_1",
      speaker: "Speaker 1",
      speakerId: "spk_1",
      startMs: 0,
      endMs: 2000,
      text: "TRANSCRIPT_MARKER hello",
      language: "en",
      turnIndex: 0,
      words: encodeWords(meeting.transcript![0].words!, "en"),
    })
    expect(speaker).toEqual({
      id: "spk_1",
      meetingId: "",
      label: "Speaker 1",
      displayName: "SPEAKER_NAME_MARKER Dana",
      mappingStatus: "confirmed",
      source: "share",
      talkTimeMs: 2000,
      wordCount: 2,
      segmentCount: 1,
      firstStartMs: 0,
    })
    expect(payload.transcript!.transcription).toEqual({ provider: "PROVIDER_MARKER", model: "model-x" })
  })

  it("describes media without asset ids or storage keys", () => {
    const payload = buildSharePayload(share(["media"]), meeting)

    expect(payload.media).toMatchObject({
      available: true,
      peaks: true,
      durationMs: 2000,
      audio: { assetId: "audio", kind: "playback", contentType: "audio/mp4" },
    })
  })

  it("shows participant names only, never emails, for legacy participant lists", () => {
    const payload = buildSharePayload(share(["participants"]), {
      ...meeting,
      participantDetails: undefined,
    })

    expect(payload.participants).toEqual(["dana.SECRET", "yossi.SECRET"])
    expect(serialized(payload)).not.toContain("@example.com")
  })
})

describe("loadSharePageData", () => {
  const SECRET = "share-payload-test-secret"
  const NOW = Date.parse("2026-10-13T10:00:00.000Z")
  const passwordShare = share([...SHARE_SECTIONS], { passwordHash: PASSWORD_HASH })
  const lookup = async (token: string) =>
    token === "tok_public" ? { share: passwordShare, meeting } : undefined

  it("returns not found for unknown tokens", async () => {
    expect(await loadSharePageData("nope", { lookup, secret: () => SECRET })).toBeUndefined()
  })

  it("returns nothing about the meeting before the password cookie checks out", async () => {
    for (const accessCookie of [undefined, "", "123.bad", "garbage"]) {
      const data = await loadSharePageData("tok_public", {
        lookup,
        accessCookie,
        secret: () => SECRET,
        now: () => NOW,
      })

      expect(data).toEqual({ status: "password_required" })
    }
  })

  it("returns the gated payload once the signed cookie is valid", async () => {
    const cookie = createShareAccessCookie({
      token: "tok_public",
      passwordHash: PASSWORD_HASH,
      secret: SECRET,
      now: NOW,
    })
    const data = await loadSharePageData("tok_public", {
      lookup,
      accessCookie: cookie.value,
      secret: () => SECRET,
      now: () => NOW,
    })

    expect(data?.status).toBe("ok")
    const json = JSON.stringify(data)

    for (const secret of NEVER) expect(json).not.toContain(secret)
    expect(json).toContain("TRANSCRIPT_MARKER")
  })

  it("does not need the session secret for shares without a password", async () => {
    const data = await loadSharePageData("tok_public", {
      lookup: async () => ({ share: share(["summary"]), meeting }),
      secret: () => {
        throw new Error("secret must not be read")
      },
    })

    expect(data).toMatchObject({ status: "ok", payload: { overview: "OVERVIEW_MARKER of the meeting" } })
  })
})

describe("share page wiring", () => {
  const page = readFileSync(path.join(process.cwd(), "app/share/[token]/page.tsx"), "utf8")
  const island = readFileSync(
    path.join(process.cwd(), "components/share/shared-meeting-player.tsx"),
    "utf8"
  )

  it("renders only from loadSharePageData (never the hydrated meeting)", () => {
    expect(page).toContain("loadSharePageData(")
    expect(page).not.toMatch(/meeting\.[a-zA-Z]/)
    expect(page).not.toMatch(/lookupPublicShare|describeMeetingMedia|toWireSegments|aiRuns/)
  })

  it("the client island takes no meeting id or participant details", () => {
    expect(island).not.toMatch(/meetingId[,:?]/)
    expect(island).not.toMatch(/participants[?]?:\s*MeetingParticipant/)
  })
})
