import { describe, expect, it, vi } from "vitest"

import { buildMeetingIntelligence, type SmartTask } from "@/lib/intelligence"
import { createPostgresMeetingRepository } from "@/lib/meetings/postgres-repository"
import type { RepoScope } from "@/lib/meetings/repository"

const scope: RepoScope = { kind: "system", workspaceId: "ws_default" }

type Responder = (text: string, values: unknown[]) => { rows: unknown[] }

function createFakePool(baseResponder: Responder) {
  // The scope check (assertMeetingInScope) finds the meeting.
  const responder: Responder = (text, values) =>
    /select m\.id from meetings m/.test(text)
      ? { rows: [{ id: "meet_1" }] }
      : baseResponder(text, values)
  const statements: string[] = []
  const release = vi.fn()
  const connection = {
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      statements.push(text.replace(/\s+/g, " ").trim())
      return responder(text, values)
    }),
    release,
  }
  const pool = {
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      statements.push(text.replace(/\s+/g, " ").trim())
      return responder(text, values)
    }),
    connect: vi.fn(async () => connection),
  }

  return { pool, connection, statements, release }
}

const intelligenceBase = buildMeetingIntelligence({
  id: "meet_1",
  title: "Tx",
  source: "upload",
  language: "en",
  status: "completed",
  retention: "audio",
  startedAt: "2026-04-23T09:00:00.000Z",
  participants: [],
})

function task(id: string, title: string): SmartTask {
  return {
    id,
    title,
    status: "open",
    priority: "normal",
    confidence: 0.8,
    sourceQuote: title,
    sourceStartMs: 0,
    kind: "explicit",
  }
}

function actionRow(partial: Record<string, unknown>) {
  return {
    owner: null,
    status: "open",
    due_date: null,
    priority: "normal",
    confidence: 0.8,
    source_quote: null,
    source_start_ms: 0,
    kind: "explicit",
    edited_by_user: false,
    origin: "ai",
    original_title: partial.title,
    completed_at: null,
    ...partial,
  }
}

describe("Postgres upsertMeetingIntelligence transaction", () => {
  it("merges action items inside begin/commit and returns the persisted list", async () => {
    const existing = [
      actionRow({ id: "act_edit", title: "Send signed proposal", original_title: "Send proposal", edited_by_user: true }),
      actionRow({ id: "act_stale", title: "Old idea" }),
      actionRow({ id: "act_same", title: "Prepare budget" }),
    ]
    let selects = 0
    const { pool, connection, statements, release } = createFakePool((text) => {
      if (/from action_items/.test(text) && /select/.test(text)) {
        selects += 1
        return selects === 1
          ? { rows: existing }
          : {
              rows: [
                existing[0],
                actionRow({ id: "act_same", title: "Prepare budget" }),
                actionRow({ id: "task_new", title: "New thing" }),
              ],
            }
      }
      if (/insert into summaries/.test(text)) return { rows: [{ id: "summary_1" }] }
      return { rows: [] }
    })
    const repository = createPostgresMeetingRepository(pool, scope)

    const result = await repository.upsertMeetingIntelligence("meet_1", {
      ...intelligenceBase,
      tags: [],
      actionItems: [
        task("task_a", "Send proposal"),
        task("task_b", "Prepare budget"),
        task("task_new", "New thing"),
      ],
    })

    expect(pool.connect).toHaveBeenCalledTimes(1)
    expect(pool.query).not.toHaveBeenCalled()
    expect(statements[0]).toBe("begin")
    expect(statements.at(-1)).toBe("commit")
    expect(release).toHaveBeenCalledTimes(1)
    expect(statements[1]).toMatch(/^select m\.id from meetings m where m\.id = \$1/)
    expect(statements.find((text) => /from action_items/.test(text))).toMatch(
      /for update$/
    )

    const deleteCall = connection.query.mock.calls.find(([text]) =>
      /delete from action_items/.test(text)
    )
    expect(deleteCall?.[1]).toEqual(["meet_1", ["act_stale"]])

    const updateCalls = connection.query.mock.calls.filter(([text]) =>
      /update action_items/.test(text)
    )
    expect(updateCalls.map(([, values]) => (values as unknown[])[0])).toEqual(["act_same"])

    const insertCalls = connection.query.mock.calls.filter(([text]) =>
      /insert into action_items/.test(text)
    )
    expect(insertCalls).toHaveLength(1)
    expect(insertCalls[0][0]).toMatch(/'ai', \$3, false/)
    expect((insertCalls[0][1] as unknown[])[0]).toBe("task_new")

    expect(result.actionItems.map((item) => item.id)).toEqual([
      "act_edit",
      "act_same",
      "task_new",
    ])
    expect(result.actionItems[0]).toMatchObject({ editedByUser: true })
  })

  it("rolls back when a write fails mid-transaction", async () => {
    const { pool, statements, release } = createFakePool((text) => {
      if (/insert into summary_sections/.test(text)) {
        throw new Error("disk full")
      }
      if (/insert into summaries/.test(text)) return { rows: [{ id: "summary_1" }] }
      return { rows: [] }
    })
    const repository = createPostgresMeetingRepository(pool, scope)

    await expect(
      repository.upsertMeetingIntelligence("meet_1", {
        ...intelligenceBase,
        actionItems: [task("task_a", "Something")],
      })
    ).rejects.toThrow("disk full")

    expect(statements[0]).toBe("begin")
    expect(statements).toContain("rollback")
    expect(statements).not.toContain("commit")
    expect(release).toHaveBeenCalledTimes(1)
  })
})

describe("Postgres updateActionItem", () => {
  function recordingRepository(row: Record<string, unknown>) {
    const calls: Array<{ text: string; values: unknown[] }> = []
    const repository = createPostgresMeetingRepository(
      {
        query: async (text, values = []) => {
          calls.push({ text: text.replace(/\s+/g, " ").trim(), values })
          if (/select m\.started_at/.test(text)) {
            return { rows: [{ started_at: "2026-10-15T09:00:00.000Z" }] }
          }
          return { rows: [actionRow(row)] }
        },
      },
      scope
    )

    return { calls, repository }
  }

  /** Value bound to the placeholder assigned to `column` in the SET list. */
  function setValue(call: { text: string; values: unknown[] }, column: string) {
    const match = new RegExp(`${column} = \\$(\\d+)`).exec(call.text)

    return match ? call.values[Number(match[1]) - 1] : undefined
  }

  it("marks content edits as user-edited and tracks completion", async () => {
    const { calls, repository } = recordingRepository({
      id: "act_1",
      title: "Renamed",
      edited_by_user: true,
    })

    const item = await repository.updateActionItem("act_1", { title: "Renamed" })
    await repository.updateActionItem("act_1", { status: "done" })

    expect(calls[0].text).toMatch(/edited_by_user = edited_by_user or \$\d+/)
    expect(calls[0].values).toContain(true)
    expect(calls[1].text).toContain("completed_at = case when")
    expect(setValue(calls[1], "status")).toBe("done")
    expect(calls[1].values).toContain(false)
    expect(calls[1].values).not.toContain(true)
    expect(item).toMatchObject({ id: "act_1", editedByUser: true, origin: "ai" })
  })

  it("parses a due phrase against the meeting start and marks it user-set", async () => {
    const { calls, repository } = recordingRepository({
      id: "act_1",
      title: "Send",
      due_on: "2026-10-18",
      due_text: "עד יום ראשון",
      due_source: "user",
    })

    const item = await repository.updateActionItem("act_1", { dueText: "עד יום ראשון" })

    // Scoped lookup of the meeting's started_at first, then the update.
    expect(calls[0].text).toMatch(/^select m\.started_at from action_items ai join meetings m/)
    const update = calls[1]

    expect(update.text).toMatch(/^update action_items set/)
    expect(setValue(update, "due_on")).toBe("2026-10-18")
    expect(setValue(update, "due_text")).toBe("עד יום ראשון")
    expect(setValue(update, "due_source")).toBe("user")
    expect(setValue(update, "due_date")).toBe("2026-10-18T12:00:00.000Z")
    expect(update.values).toContain(true)
    expect(item).toMatchObject({ dueOn: "2026-10-18", dueText: "עד יום ראשון", dueSource: "user" })
  })

  it("re-validates owner ids in SQL (meeting participant, workspace member)", async () => {
    const { calls, repository } = recordingRepository({ id: "act_1", title: "Send" })

    await repository.updateActionItem("act_1", {
      ownerText: "דנה",
      ownerParticipantId: "participant_1",
      ownerUserId: "user_dana",
    })

    const update = calls[0]

    expect(update.text).toContain(
      "owner_participant_id = (select mp.id from meeting_participants mp where mp.id = $"
    )
    expect(update.text).toContain("mp.meeting_id = action_items.meeting_id")
    expect(update.text).toContain("from memberships mb where mb.user_id = $")
    expect(update.values).toEqual(
      expect.arrayContaining(["דנה", "participant_1", "user_dana", "ws_default"])
    )
    // A due edit was not requested, so the due columns are untouched.
    expect(update.text).not.toContain("due_on =")
  })

  it("clears the due date with dueOn null", async () => {
    const { calls, repository } = recordingRepository({ id: "act_1", title: "Send" })

    await repository.updateActionItem("act_1", { dueOn: null })

    expect(setValue(calls[0], "due_on")).toBeNull()
    expect(setValue(calls[0], "due_source")).toBeNull()
    expect(setValue(calls[0], "due_date")).toBeNull()
  })
})

describe("Postgres upsertMeetingIntelligence M5 columns", () => {
  it("writes workspace, owner linkage, due fields and the template/prompt version", async () => {
    const { pool, connection } = createFakePool((text) => {
      if (/insert into summaries/.test(text)) return { rows: [{ id: "summary_1" }] }
      return { rows: [] }
    })
    const repository = createPostgresMeetingRepository(pool, scope)

    await repository.upsertMeetingIntelligence("meet_1", {
      ...intelligenceBase,
      tags: [],
      generation: { provider: "anthropic", templateKey: "hebrew_business", promptVersion: "m5.1" },
      actionItems: [
        {
          ...task("task_1", "לשלוח הצעה"),
          ownerText: "דנה",
          ownerParticipantId: "participant_1",
          ownerSpeakerId: "speaker_1",
          ownerUserId: "user_dana",
          dueOn: "2026-10-18",
          dueText: "עד יום ראשון",
          dueSource: "parser",
          sourceSegmentId: "seg_1",
        },
      ],
    })

    const insert = connection.query.mock.calls.find(([text]) =>
      /insert into action_items/.test(text)
    )!
    const values = insert[1] as unknown[]

    expect(insert[0]).toContain("workspace_id, owner_text, owner_participant_id")
    expect(values.slice(11)).toEqual([
      "ws_default",
      "דנה",
      "participant_1",
      "speaker_1",
      "user_dana",
      "2026-10-18",
      "עד יום ראשון",
      "parser",
      "seg_1",
    ])

    const summary = connection.query.mock.calls.find(([text]) =>
      /insert into summaries/.test(text)
    )!

    expect(summary[0]).toContain("template_key, prompt_version")
    expect((summary[1] as unknown[]).slice(-2)).toEqual(["hebrew_business", "m5.1"])
  })

  it("never writes an invalid due_on", async () => {
    const { pool, connection } = createFakePool((text) =>
      /insert into summaries/.test(text) ? { rows: [{ id: "summary_1" }] } : { rows: [] }
    )

    await createPostgresMeetingRepository(pool, scope).upsertMeetingIntelligence("meet_1", {
      ...intelligenceBase,
      tags: [],
      actionItems: [{ ...task("task_1", "x"), dueOn: "next week" }],
    })

    const insert = connection.query.mock.calls.find(([text]) =>
      /insert into action_items/.test(text)
    )!

    expect((insert[1] as unknown[])[16]).toBeNull()
  })
})
