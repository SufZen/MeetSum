import { describe, expect, it } from "vitest"

import { buildMeetingIntelligence } from "@/lib/intelligence"
import {
  createPostgresMeetingRepository,
  createPostgresShareLookup,
} from "@/lib/meetings/postgres-repository"
import type { MeetingRepository, RepoScope } from "@/lib/meetings/repository"

/**
 * Cross-tenant leak defence (docs/parity/m2.md, Package B): a recording
 * Queryable captures every SQL statement each repository method issues and
 * asserts that statements touching `meetings` carry the scope predicate with
 * the scope's own values, that meeting-id methods check the meeting before
 * touching child tables, and that workspace-owned tables are filtered.
 */

type Statement = { text: string; values: unknown[] }

const WS = "ws_a"
const scopes: Record<RepoScope["kind"], RepoScope> = {
  member: {
    kind: "member",
    workspaceId: WS,
    userId: "user_me",
    email: "me@example.com",
    role: "member",
  },
  api_key: { kind: "api_key", workspaceId: WS, ownerUserId: "user_key_owner" },
  system: { kind: "system", workspaceId: WS },
}

const UNIVERSAL_ROW = {
  id: "meet_1",
  meeting_id: "meet_1",
  title: "Sync",
  source: "upload",
  language: "en",
  status: "completed",
  retention: "audio",
  started_at: "2026-05-01T09:00:00.000Z",
  participants: "[]",
  workspace_id: WS,
  meeting_workspace_id: WS,
  owner_user_id: "user_me",
  visibility: "link",
  name: "Dana",
  email: "dana@example.com",
  role: "attendee",
  attendance_status: "unknown",
  token: "tok_1",
  revoked: false,
  included_sections: "[]",
  storage_key: "k",
  content_type: "audio/mp4",
  size_bytes: 1,
  target: "n8n",
  payload: {},
  attempts: 0,
  max_attempts: 3,
  format: "markdown",
  label: "Speaker 1",
  mapping_status: "unmapped",
  provider: "local",
  task: "summary",
  total: 1,
  created_at: "2026-05-01T09:00:00.000Z",
  updated_at: "2026-05-01T09:00:00.000Z",
}

type Responder = (text: string) => unknown[] | undefined

function recordingClient(override?: Responder) {
  const statements: Statement[] = []
  const client = {
    async query(text: string, values: unknown[] = []) {
      const normalized = text.replace(/\s+/g, " ").trim()

      statements.push({ text: normalized, values })

      const custom = override?.(normalized)

      if (custom) return { rows: custom }
      if (/^(begin|commit|rollback)$/.test(normalized)) return { rows: [] }
      if (/^select count\(\*\)/.test(normalized)) return { rows: [{ total: 1 }] }
      if (/^select m\./.test(normalized)) return { rows: [UNIVERSAL_ROW] }
      // M4: the (locked) segment of a transcript edit / undo.
      if (/^select ts\.id, ts\.speaker_id\b.* where ts\.id = \$1/.test(normalized)) {
        return {
          rows: [{ ...UNIVERSAL_ROW, id: "seg_1", text: "hi", start_ms: 0, end_ms: 1000, revision: 0 }],
        }
      }
      // M5: a user task insert validates its segment via a subquery.
      if (/^insert into action_items\b/.test(normalized)) return { rows: [UNIVERSAL_ROW] }
      if (/from (intelligence_runs|summaries|transcript_segments)\b/.test(normalized)) {
        return { rows: [] }
      }
      if (/^insert into summaries/.test(normalized)) return { rows: [{ id: "summary_1" }] }

      return { rows: [UNIVERSAL_ROW] }
    },
  }

  return { client, statements }
}

const intelligence = {
  ...buildMeetingIntelligence({
    id: "meet_1",
    title: "Sync",
    source: "upload",
    language: "en",
    status: "completed",
    retention: "audio",
    startedAt: "2026-05-01T09:00:00.000Z",
    participants: [],
  }),
  tags: ["finance"],
} as Parameters<MeetingRepository["upsertMeetingIntelligence"]>[1]

/** One invocation per repository method (kept exhaustive by a test below). */
const invocations: Record<
  keyof MeetingRepository,
  (repo: MeetingRepository) => Promise<unknown>
> = {
  listMeetings: (repo) => repo.listMeetings({ query: "x", status: "favorites" }),
  listMeetingsPage: (repo) => repo.listMeetingsPage({ status: "usable" }),
  getMeeting: (repo) => repo.getMeeting("meet_1"),
  createMeeting: (repo) =>
    repo.createMeeting({
      title: "New",
      source: "upload",
      language: "en",
      startedAt: "2026-05-01T09:00:00.000Z",
      participants: ["dana@example.com"],
    }),
  updateMeetingStatus: (repo) => repo.updateMeetingStatus("meet_1", "indexing"),
  createMediaAsset: (repo) =>
    repo.createMediaAsset({
      meetingId: "meet_1",
      storageKey: "k",
      contentType: "audio/mp4",
      sizeBytes: 1,
    }),
  findMediaAssetBySourceFile: (repo) =>
    repo.findMediaAssetBySourceFile!("drive", "file_1", { meetingId: "meet_1" }),
  findMeetingByExternalId: (repo) => repo.findMeetingByExternalId("calendar", "evt_1"),
  createMeetingIfAbsent: (repo) =>
    repo.createMeetingIfAbsent({
      title: "Cal",
      source: "google_meet",
      language: "en",
      startedAt: "2026-05-01T09:00:00.000Z",
      externalSource: "calendar",
      externalId: "evt_1",
    }),
  discardMeeting: (repo) => repo.discardMeeting("meet_1"),
  replaceTranscriptSegments: (repo) =>
    repo.replaceTranscriptSegments("meet_1", [
      { id: "seg_1", speaker: "A", startMs: 0, endMs: 1, text: "hi" },
    ]),
  replaceTranscript: (repo) =>
    repo.replaceTranscript("meet_1", {
      segments: [
        {
          id: "seg_1",
          speaker: "Speaker 1",
          startMs: 0,
          endMs: 1,
          text: "hi",
          words: [{ startMs: 0, endMs: 1, text: "hi", confidence: 0.9 }],
        },
      ],
      speakers: [{ label: "Speaker 1", talkTimeMs: 1, wordCount: 1, segmentCount: 1 }],
      asrRunId: "airun_1",
    }),
  listMeetingSpeakers: (repo) => repo.listMeetingSpeakers("meet_1"),
  updateMeetingSpeaker: (repo) =>
    repo.updateMeetingSpeaker("meet_1", "speaker_1", {
      mappingStatus: "confirmed",
      participantId: "participant_1",
      profileId: "profile_1",
    }),
  mergeMeetingSpeakers: (repo) =>
    repo.mergeMeetingSpeakers("meet_1", "meet_1", "speaker_2").catch((error: Error) => error),
  setSpeakerSuggestions: (repo) =>
    repo.setSpeakerSuggestions("meet_1", [
      { speakerId: "speaker_1", suggestion: null, participantId: "participant_1" },
    ]),
  listSpeakerProfiles: (repo) => repo.listSpeakerProfiles(),
  recordConfirmedSpeaker: (repo) =>
    repo.recordConfirmedSpeaker({
      meetingId: "meet_1",
      speakerId: "speaker_1",
      participant: { name: "Dana" },
      aliases: ["דנה"],
    }),
  // M4: transcript, edits/undo, rename, delete, media preparation, duration.
  getMeetingTranscript: (repo) => repo.getMeetingTranscript("meet_1"),
  getTranscriptVersion: (repo) => repo.getTranscriptVersion("meet_1"),
  updateTranscriptSegment: (repo) =>
    repo.updateTranscriptSegment("meet_1", "seg_1", {
      expectedRevision: 0,
      text: "hello",
      newSpeakerName: "Dana",
      scope: "turn",
      actorUserId: "user_me",
    }),
  undoTranscriptSegment: (repo) =>
    repo.undoTranscriptSegment("meet_1", "seg_1", {
      expectedRevision: 0,
      actorUserId: "user_me",
    }),
  listTranscriptRevisions: (repo) => repo.listTranscriptRevisions("meet_1", "seg_1"),
  renameMeeting: (repo) => repo.renameMeeting("meet_1", "Renamed"),
  deleteMeeting: (repo) => repo.deleteMeeting("meet_1"),
  updateMediaAssetPreparation: (repo) =>
    repo.updateMediaAssetPreparation("asset_1", {
      durationMs: 1000,
      preparedAt: "2026-05-01T09:00:00.000Z",
    }),
  setMeetingDurationMs: (repo) => repo.setMeetingDurationMs("meet_1", 1000, "transcript"),
  upsertMeetingIntelligence: (repo) =>
    repo.upsertMeetingIntelligence("meet_1", intelligence),
  updateActionItem: (repo) => repo.updateActionItem("act_1", { status: "done" }),
  // M5 (Package B): user tasks, owner/due edits, template and titles.
  createActionItem: (repo) =>
    repo.createActionItem(
      "meet_1",
      {
        title: "Send the deck",
        dueText: "עד יום ראשון",
        ownerParticipantId: "participant_1",
        ownerUserId: "user_dana",
        sourceSegmentId: "seg_1",
      },
      { userId: "user_me" }
    ),
  deleteActionItem: (repo) => repo.deleteActionItem("act_1"),
  getActionItem: (repo) => repo.getActionItem("act_1"),
  setMeetingTemplate: (repo) => repo.setMeetingTemplate("meet_1", "hebrew_business"),
  applyAiTitle: (repo) => repo.applyAiTitle("meet_1", "Budget sync"),
  setMeetingTitle: (repo) => repo.setMeetingTitle("meet_1", "Budget sync", "user"),
  createJob: (repo) =>
    repo.createJob({ name: "media.ingest", meetingId: "meet_1", payload: {} }),
  updateJob: (repo) => repo.updateJob("job_1", { status: "active" }),
  getJob: (repo) => repo.getJob("job_1"),
  listJobs: (repo) => repo.listJobs({ meetingId: "meet_1", status: "failed" }),
  searchMeetings: (repo) => repo.searchMeetings("budget"),
  askMeetingMemory: (repo) => repo.askMeetingMemory("meet_1", "what about budget"),
  getMeetingIntelligence: (repo) => repo.getMeetingIntelligence("meet_1"),
  runMeetingIntelligence: (repo) => repo.runMeetingIntelligence("meet_1"),
  listContexts: (repo) => repo.listContexts(),
  createContext: (repo) => repo.createContext({ name: "Room" }),
  linkMeetingContext: (repo) => repo.linkMeetingContext("meet_1", "ctx_1"),
  listRooms: (repo) => repo.listRooms(),
  listMeetingsByContext: (repo) => repo.listMeetingsByContext("ctx_1"),
  updateMeetingTags: (repo) => repo.updateMeetingTags("meet_1", ["budget"]),
  updateMeetingFavorite: (repo) =>
    repo.updateMeetingFavorite("meet_1", true).catch((error: Error) => error),
  createMeetingShare: (repo) => repo.createMeetingShare({ meetingId: "meet_1" }),
  updateMeetingShare: (repo) =>
    repo.updateMeetingShare("meet_1", { includedSections: ["summary"] }),
  getShareByToken: (repo) => repo.getShareByToken("tok_1"),
  updateMeetingVisibility: (repo) =>
    repo.updateMeetingVisibility("meet_1", "workspace"),
  listMeetingParticipants: (repo) => repo.listMeetingParticipants("meet_1"),
  updateMeetingParticipant: (repo) =>
    repo.updateMeetingParticipant("meet_1", { name: "Dana" }),
  assignSpeakerToParticipant: (repo) =>
    repo.assignSpeakerToParticipant("meet_1", "A", "meet_1"),
  createExportRecord: (repo) =>
    repo.createExportRecord({ meetingId: "meet_1", format: "markdown" }),
  approveAgentRun: (repo) => repo.approveAgentRun("run_1"),
  createSuggestedAgentRun: (repo) =>
    repo.createSuggestedAgentRun({ meetingId: "meet_1", target: "n8n", payload: {} }),
}

const MEETINGS_TABLE = /\bmeetings\b/
const CHILD_TABLES =
  /\b(transcript_segments|transcript_segment_revisions|speakers|action_items|intelligence_runs|summaries|summary_sections|meeting_tags|meeting_participants|export_records|suggested_agent_runs|meeting_shares|meeting_contexts|media_assets|meeting_favorites|ai_runs)\b/
const WORKSPACE_TABLES =
  /\b(?:from|into|update|join) (jobs|contexts|tags|media_assets|speaker_profiles|transcript_segment_revisions)\b/

/** Value bound to the first placeholder matched by `pattern` in `statement`. */
function boundValues(statement: Statement, pattern: RegExp): unknown[] {
  return [...statement.text.matchAll(pattern)].map(
    (match) => statement.values[Number(match[1]) - 1]
  )
}

function carriesWorkspace(statement: Statement) {
  return boundValues(statement, /workspace_id = \$(\d+)/g).includes(WS)
}

/** True when the statement filters `meetings` by the full scope predicate. */
function carriesScope(statement: Statement, scope: RepoScope) {
  if (!carriesWorkspace(statement)) return false
  if (scope.kind === "system") return true

  if (!statement.text.includes("visibility in ('workspace', 'link')")) return false

  if (scope.kind === "api_key") {
    return boundValues(statement, /owner_user_id = \$(\d+)/g).includes(
      scope.ownerUserId
    )
  }

  return (
    boundValues(statement, /owner_user_id = \$(\d+)/g).includes(scope.userId) &&
    boundValues(statement, /lower\(mp_scope\.email\) = \$(\d+)/g).includes(
      scope.email
    )
  )
}

function assertScoped(statements: Statement[], scope: RepoScope, method: string) {
  let meetingChecked = false

  for (const statement of statements) {
    const label = `${method} [${scope.kind}]: ${statement.text}`

    if (/^insert into meetings\b/.test(statement.text)) {
      expect(statement.text, label).toContain("workspace_id")
      expect(statement.values, label).toContain(WS)
      meetingChecked = true
      continue
    }

    if (MEETINGS_TABLE.test(statement.text)) {
      expect(carriesScope(statement, scope), label).toBe(true)
      meetingChecked = true
    } else if (CHILD_TABLES.test(statement.text) && !/^insert into (jobs|contexts)/.test(statement.text)) {
      // Child rows are only touched after a scoped meetings statement.
      expect(meetingChecked, `${label} ran before any scope check`).toBe(true)
    }

    if (WORKSPACE_TABLES.test(statement.text)) {
      expect(statement.text, label).toContain("workspace_id")
      expect(statement.values, label).toContain(WS)
    }
  }
}

describe("postgres meeting repository workspace scoping", () => {
  it("has an invocation for every repository method", () => {
    const { client } = recordingClient()
    const repository = createPostgresMeetingRepository(client, scopes.system)

    expect(Object.keys(invocations).sort()).toEqual(Object.keys(repository).sort())
  })

  for (const scope of Object.values(scopes)) {
    describe(`${scope.kind} scope`, () => {
      for (const [method, invoke] of Object.entries(invocations)) {
        it(`scopes ${method}`, async () => {
          const { client, statements } = recordingClient()
          const repository = createPostgresMeetingRepository(client, scope)

          await invoke(repository)

          assertScoped(statements, scope, method)
        })
      }
    })
  }

  it("puts the scope predicate first in every meeting list query", async () => {
    const { client, statements } = recordingClient()

    await createPostgresMeetingRepository(client, scopes.member).listMeetingsPage({
      query: "budget",
      status: "processing",
    })

    const lists = statements.filter((statement) => /from meetings m\b/.test(statement.text))

    expect(lists).toHaveLength(2)
    for (const list of lists) {
      expect(list.text).toMatch(/where \(m\.workspace_id = \$1 and/)
      expect(list.values[0]).toBe(WS)
    }
  })

  it("stamps new meetings with workspace, owner and default visibility", async () => {
    const { client, statements } = recordingClient()

    await createPostgresMeetingRepository(client, scopes.member).createMeeting({
      title: "New",
      source: "upload",
      language: "en",
      startedAt: "2026-05-01T09:00:00.000Z",
    })

    const insert = statements.find((statement) =>
      statement.text.startsWith("insert into meetings")
    )!

    expect(insert.values.slice(8)).toEqual([WS, "user_me", "workspace"])
  })

  it("dedupes external meetings per workspace", async () => {
    const { client, statements } = recordingClient()

    await invocations.createMeetingIfAbsent(
      createPostgresMeetingRepository(client, scopes.system)
    )

    expect(statements[0].text).toContain(
      "on conflict (workspace_id, external_source, external_id) where external_id is not null do nothing"
    )
  })

  it("keys tags by workspace", async () => {
    const { client, statements } = recordingClient()

    await createPostgresMeetingRepository(client, scopes.member).updateMeetingTags(
      "meet_1",
      ["budget"]
    )

    const tagInsert = statements.find((statement) =>
      statement.text.startsWith("insert into tags")
    )!

    expect(tagInsert.text).toContain("on conflict (workspace_id, name) do nothing")
    expect(tagInsert.values).toEqual([expect.stringMatching(/^tag_/), "budget", WS])
  })

  it("joins child ids back to a visible meeting (IDOR)", async () => {
    for (const method of [
      "updateActionItem",
      "updateMeetingParticipant",
      "approveAgentRun",
    ] as const) {
      const { client, statements } = recordingClient()

      await invocations[method](createPostgresMeetingRepository(client, scopes.member))

      expect(statements[0].text, method).toMatch(/^update \w+ set /)
      expect(statements[0].text, method).toContain("exists ( select 1 from meetings m")
      expect(carriesScope(statements[0], scopes.member), method).toBe(true)
    }
  })

  it("scopes every child-id lookup by a join to a visible meeting", async () => {
    // Jobs and media assets: the child statement itself carries the
    // workspace filter plus the full meeting scope predicate.
    for (const method of [
      "getJob",
      "updateJob",
      "listJobs",
      "findMediaAssetBySourceFile",
    ] as const) {
      for (const scope of Object.values(scopes)) {
        const { client, statements } = recordingClient()

        await invocations[method](createPostgresMeetingRepository(client, scope))

        expect(statements, method).toHaveLength(1)
        expect(statements[0].text, method).toContain("select 1 from meetings m")
        expect(carriesScope(statements[0], scope), `${method} [${scope.kind}]`).toBe(true)
      }
    }
  })

  it("requires (meetingId, childId) pairs to match in the same statement", async () => {
    const { client, statements } = recordingClient()

    await createPostgresMeetingRepository(client, scopes.member).assignSpeakerToParticipant(
      "meet_1",
      "A",
      "participant_9"
    )

    const update = statements.find((statement) =>
      statement.text.startsWith("update meeting_participants")
    )!

    expect(
      boundValues(update, /meeting_participants\.meeting_id = \$(\d+)/g)
    ).toEqual(["meet_1"])
    expect(update.values[0]).toBe("participant_9")
    expect(carriesScope(update, scopes.member)).toBe(true)
  })

  it("scopes M3 speaker statements: meeting lock first, (meeting, speaker) pairs, workspace profiles", async () => {
    for (const scope of Object.values(scopes)) {
      for (const method of [
        "replaceTranscript",
        "updateMeetingSpeaker",
        "mergeMeetingSpeakers",
        "setSpeakerSuggestions",
        "recordConfirmedSpeaker",
        "listMeetingSpeakers",
      ] as const) {
        const { client, statements } = recordingClient()

        await invocations[method](createPostgresMeetingRepository(client, scope))

        const label = `${method} [${scope.kind}]`
        const firstSpeakerStatement = statements.findIndex((statement) =>
          /\b(speakers|speaker_profiles|transcript_segments)\b/.test(statement.text)
        )
        const scopeCheck = statements.findIndex((statement) =>
          /^select m\.id from meetings m where m\.id = \$1 and/.test(statement.text)
        )

        expect(scopeCheck, label).toBeGreaterThanOrEqual(0)
        expect(carriesScope(statements[scopeCheck], scope), label).toBe(true)
        expect(scopeCheck, label).toBeLessThan(firstSpeakerStatement)

        for (const statement of statements) {
          if (/^(update|delete from) speakers\b/.test(statement.text)) {
            expect(statement.text, label).toMatch(/meeting_id = \$\d/)
            expect(statement.values, label).toContain("meet_1")
          }
          if (/\bspeaker_profiles\b/.test(statement.text)) {
            expect(carriesWorkspace(statement), label).toBe(true)
          }
          // Speaker mapping never creates participants for labels.
          expect(statement.text, label).not.toMatch(/^insert into meeting_participants/)
        }
      }
    }
  })

  it("throws not-found (never writes) when a (meetingId, childId) pair does not match", async () => {
    const { client, statements } = recordingClient((text) =>
      text.startsWith("update meeting_participants") ? [] : undefined
    )

    await expect(
      createPostgresMeetingRepository(client, scopes.member).assignSpeakerToParticipant(
        "meet_1",
        "A",
        "participant_of_other_meeting"
      )
    ).rejects.toThrow("Participant not found")
    expect(statements.some((statement) => statement.text.startsWith("update speakers"))).toBe(
      false
    )
  })

  it("treats foreign or invisible meetings as missing and never writes child rows", async () => {
    const noMeetings: Responder = (text) =>
      MEETINGS_TABLE.test(text) && !text.startsWith("insert into meetings")
        ? []
        : undefined

    for (const [method, invoke] of Object.entries(invocations)) {
      if (
        [
          "createMeeting",
          "createMeetingIfAbsent",
          "listMeetings",
          "listMeetingsPage",
          "searchMeetings",
          "listContexts",
          "createContext",
          "listRooms",
          "listMeetingsByContext",
          "getJob",
          "listJobs",
          "updateJob",
          "createJob",
          "findMediaAssetBySourceFile",
          // Workspace-level speaker memory: no meeting involved.
          "listSpeakerProfiles",
        ].includes(method)
      ) {
        continue
      }

      const { client, statements } = recordingClient(noMeetings)
      const result = await invoke(createPostgresMeetingRepository(client, scopes.member)).then(
        (value) => value,
        (error: Error) => error
      )

      expect(
        result === undefined || result === false || result instanceof Error,
        `${method} returned ${JSON.stringify(result)}`
      ).toBe(true)

      const childWrites = statements.filter(
        (statement) =>
          /^(insert into|delete from|update) /.test(statement.text) &&
          !MEETINGS_TABLE.test(statement.text)
      )

      expect(childWrites.map((statement) => statement.text), method).toEqual([])
    }
  })

  it("requires link visibility for scoped and cross-workspace share lookups", async () => {
    const scoped = recordingClient()

    await createPostgresMeetingRepository(scoped.client, scopes.member).getShareByToken(
      "tok_1"
    )
    expect(scoped.statements[0].text).toContain("m.visibility = 'link'")
    expect(scoped.statements[0].text).toContain("s.revoked = false")

    const lookup = recordingClient()
    const result = await createPostgresShareLookup(lookup.client).getShareByToken("tok_1")
    const [first, ...rest] = lookup.statements

    expect(first.text).toContain("m.visibility = 'link'")
    expect(first.text).toContain("s.revoked = false")
    expect(first.text).toContain("(s.expires_at is null or s.expires_at > now())")
    // The meeting is then loaded through a system repo of its own workspace.
    expect(rest.filter((statement) => MEETINGS_TABLE.test(statement.text))[0].values).toContain(WS)
    expect(result?.meeting.workspaceId).toBe(WS)
  })

  it("share media lookup loads only the share and media rows (no hydration)", async () => {
    const lookup = recordingClient()
    const result = await createPostgresShareLookup(lookup.client).getShareMediaByToken("tok_1")
    const [first, second, ...rest] = lookup.statements

    expect(first.text).toContain("m.visibility = 'link'")
    expect(first.text).toContain("s.revoked = false")
    expect(first.text).toContain("(s.expires_at is null or s.expires_at > now())")
    expect(second.text).toMatch(/from media_assets where meeting_id = \$1 and workspace_id = \$2/)
    expect(second.values).toEqual(["meet_1", WS])
    expect(rest).toHaveLength(0)
    expect(result?.meeting).toMatchObject({ id: "meet_1", workspaceId: WS })
    expect(result?.mediaAssets).toHaveLength(1)
  })

  it("M5: scopes user task create/edit/delete by a visible meeting and stamps workspace_id", async () => {
    for (const scope of Object.values(scopes)) {
      const label = scope.kind
      const created = recordingClient()

      await invocations.createActionItem(createPostgresMeetingRepository(created.client, scope))

      const [lookup, insert] = created.statements

      expect(lookup.text, label).toMatch(/^select m\.id, .* from meetings m where m\.id = \$1 and/)
      expect(carriesScope(lookup, scope), label).toBe(true)
      expect(insert.text, label).toMatch(/^insert into action_items/)
      // workspace_id ($3) is the scope's workspace; origin user, edited.
      expect(insert.values[2], label).toBe(WS)
      expect(insert.text, label).toContain("'explicit', 'user', $4, true")
      // Owner ids are re-validated against the meeting / workspace members.
      expect(insert.text, label).toContain(
        "(select mp.id from meeting_participants mp where mp.id = $6 and mp.meeting_id = $2)"
      )
      expect(insert.text, label).toContain(
        "(select mb.user_id from memberships mb where mb.user_id = $9 and mb.workspace_id = $3)"
      )
      // "עד יום ראשון" parsed against the meeting start (Fri 1 May 2026 -> Sun 3 May).
      expect(insert.values[9], label).toBe("2026-05-03")
      expect(insert.values[11], label).toBe("user")

      const deleted = recordingClient()

      expect(
        await invocations.deleteActionItem(createPostgresMeetingRepository(deleted.client, scope))
      ).toBe(true)
      expect(deleted.statements).toHaveLength(1)
      expect(deleted.statements[0].text, label).toMatch(/^delete from action_items where id = \$1/)
      expect(deleted.statements[0].text, label).toContain("exists ( select 1 from meetings m")
      expect(carriesScope(deleted.statements[0], scope), label).toBe(true)
    }
  })

  it("M5: owner edits join a visible meeting in the same statement", async () => {
    const { client, statements } = recordingClient()

    await createPostgresMeetingRepository(client, scopes.member).updateActionItem("act_1", {
      ownerParticipantId: "participant_9",
      ownerUserId: "user_x",
      dueOn: "2026-05-10",
    })

    expect(statements).toHaveLength(1)
    expect(statements[0].text).toMatch(/^update action_items set /)
    expect(statements[0].text).toContain("mp.meeting_id = action_items.meeting_id")
    expect(statements[0].text).toContain("mb.workspace_id = $")
    expect(statements[0].values).toContain(WS)
    expect(carriesScope(statements[0], scopes.member)).toBe(true)
  })

  it("M5: AI titles never overwrite a user title; titles record their source", async () => {
    const ai = recordingClient()

    await invocations.applyAiTitle(createPostgresMeetingRepository(ai.client, scopes.member))
    expect(ai.statements[0].text).toContain("set title = $2, title_source = 'ai'")
    expect(ai.statements[0].text).toContain("m.title_source <> 'user'")
    expect(carriesScope(ai.statements[0], scopes.member)).toBe(true)

    const user = recordingClient()

    await invocations.setMeetingTitle(createPostgresMeetingRepository(user.client, scopes.member))
    expect(user.statements[0].text).toContain("set title = $2, title_source = $3")
    expect(user.statements[0].values.slice(0, 3)).toEqual(["meet_1", "Budget sync", "user"])

    const rename = recordingClient()

    await invocations.renameMeeting(createPostgresMeetingRepository(rename.client, scopes.member)).catch(() => {})
    expect(rename.statements[0].text).toContain("set title = $2, title_source = 'user'")

    const template = recordingClient()

    await invocations.setMeetingTemplate(
      createPostgresMeetingRepository(template.client, scopes.member)
    )
    expect(template.statements[0].text).toContain("set template_key = $2")
    expect(template.statements[0].values[1]).toBe("hebrew_business")
  })

  it("M5: hydrates template_key and title_source", async () => {
    const { client } = recordingClient((text) =>
      /^select m\./.test(text)
        ? [{ ...UNIVERSAL_ROW, template_key: "sales", title_source: "user" }]
        : undefined
    )
    const meeting = await createPostgresMeetingRepository(client, scopes.member).getMeeting("meet_1")

    expect(meeting).toMatchObject({ templateKey: "sales", titleSource: "user" })
  })

  it("M5: share lookups and link reuse only consider meeting-scope shares", async () => {
    const scoped = recordingClient()

    await createPostgresMeetingRepository(scoped.client, scopes.member).getShareByToken("tok_1")
    expect(scoped.statements[0].text).toContain("s.scope = 'meeting'")

    for (const method of ["getShareByToken", "getShareMediaByToken"] as const) {
      const lookup = recordingClient()

      await createPostgresShareLookup(lookup.client)[method]("tok_1")
      expect(lookup.statements[0].text, method).toContain("s.scope = 'meeting'")
    }

    const create = recordingClient((text) =>
      /from meeting_shares where meeting_id = \$1/.test(text) ? [] : undefined
    )

    await createPostgresMeetingRepository(create.client, scopes.member).createMeetingShare({
      meetingId: "meet_1",
    })
    const latest = create.statements.find((statement) =>
      /from meeting_shares where meeting_id = \$1/.test(statement.text)
    )!

    expect(latest.text).toContain("scope = 'meeting'")
  })

  it("M5: leaving link revokes meeting shares; going private also revokes clip shares", async () => {
    const toWorkspace = recordingClient()

    await createPostgresMeetingRepository(toWorkspace.client, scopes.member).updateMeetingVisibility(
      "meet_1",
      "workspace"
    )
    const workspaceRevoke = toWorkspace.statements.find((statement) =>
      statement.text.startsWith("update meeting_shares")
    )!

    expect(workspaceRevoke.text).toContain("and scope = 'meeting'")

    const toPrivate = recordingClient()

    await createPostgresMeetingRepository(toPrivate.client, scopes.member).updateMeetingVisibility(
      "meet_1",
      "private"
    )
    const privateRevoke = toPrivate.statements.find((statement) =>
      statement.text.startsWith("update meeting_shares")
    )!

    expect(privateRevoke.text).not.toContain("scope")
  })

  it("revokes active shares only when leaving link visibility", async () => {
    const leaving = recordingClient()

    await createPostgresMeetingRepository(leaving.client, scopes.member).updateMeetingVisibility(
      "meet_1",
      "private"
    )
    expect(
      leaving.statements.some((statement) =>
        statement.text.startsWith("update meeting_shares set revoked = true")
      )
    ).toBe(true)

    const staying = recordingClient()

    await createPostgresMeetingRepository(staying.client, scopes.member).updateMeetingVisibility(
      "meet_1",
      "link"
    )
    expect(
      staying.statements.some((statement) => statement.text.includes("meeting_shares"))
    ).toBe(false)
  })

  it("sets link visibility when a share is created", async () => {
    const { client, statements } = recordingClient()

    await createPostgresMeetingRepository(client, scopes.member).createMeetingShare({
      meetingId: "meet_1",
    })

    expect(
      statements.some((statement) =>
        /^update meetings m set visibility = 'link'/.test(statement.text)
      )
    ).toBe(true)
  })

  it("keeps favorites per user and refuses them for API keys and system scope", async () => {
    const { client, statements } = recordingClient()

    await createPostgresMeetingRepository(client, scopes.member).updateMeetingFavorite(
      "meet_1",
      true
    )

    const insert = statements.find((statement) =>
      statement.text.startsWith("insert into meeting_favorites")
    )!

    expect(insert.values).toEqual(["user_me", "meet_1"])

    for (const scope of [scopes.api_key, scopes.system]) {
      const other = recordingClient()

      await expect(
        createPostgresMeetingRepository(other.client, scope).updateMeetingFavorite(
          "meet_1",
          true
        )
      ).rejects.toMatchObject({ status: 400 })
      expect(other.statements).toEqual([])
    }
  })

  it("never adopts a job id owned by another workspace", async () => {
    const { client, statements } = recordingClient((text) =>
      text.startsWith("insert into jobs") ? [] : undefined
    )

    await expect(
      createPostgresMeetingRepository(client, scopes.system).createJob({
        id: "job_foreign",
        name: "media.ingest",
      })
    ).rejects.toThrow("Job id already in use")
    expect(statements[0].text).toContain("where jobs.workspace_id = excluded.workspace_id")
  })
})
