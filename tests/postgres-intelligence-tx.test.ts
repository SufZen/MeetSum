import { describe, expect, it, vi } from "vitest"

import { buildMeetingIntelligence, type SmartTask } from "@/lib/intelligence"
import { createPostgresMeetingRepository } from "@/lib/meetings/postgres-repository"

type Responder = (text: string, values: unknown[]) => { rows: unknown[] }

function createFakePool(responder: Responder) {
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
    const repository = createPostgresMeetingRepository(pool)

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
    expect(statements[1]).toMatch(/for update$/)

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
    const repository = createPostgresMeetingRepository(pool)

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
  it("marks content edits as user-edited and tracks completion", async () => {
    const calls: Array<{ text: string; values: unknown[] }> = []
    const repository = createPostgresMeetingRepository({
      query: async (text, values = []) => {
        calls.push({ text, values })
        return {
          rows: [actionRow({ id: "act_1", title: "Renamed", edited_by_user: true })],
        }
      },
    })

    const item = await repository.updateActionItem("act_1", { title: "Renamed" })
    await repository.updateActionItem("act_1", { status: "done" })

    expect(calls[0].text).toContain("edited_by_user = edited_by_user or $7")
    expect(calls[0].text).toContain("completed_at")
    expect(calls[0].values[6]).toBe(true)
    expect(calls[1].values[6]).toBe(false)
    expect(calls[1].values[3]).toBe("done")
    expect(item).toMatchObject({ id: "act_1", editedByUser: true, origin: "ai" })
  })
})
