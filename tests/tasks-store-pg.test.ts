import { describe, expect, it } from "vitest"

import type { RepoScope } from "@/lib/meetings/repository"
import {
  buildTaskListSql,
  decodeTaskCursor,
  encodeTaskCursor,
  InvalidTaskCursorError,
  listTasksPostgres,
} from "@/lib/tasks/store"

/**
 * Tasks SQL (docs/parity/m5.md B6): every query joins `meetings` under the
 * M2 visibility predicate and filters `action_items.workspace_id`.
 */

const WS = "ws_a"
const member: RepoScope = {
  kind: "member",
  workspaceId: WS,
  userId: "user_me",
  email: "Me@Example.com",
  role: "member",
}
const apiKey: RepoScope = { kind: "api_key", workspaceId: WS, ownerUserId: "user_key" }
const system: RepoScope = { kind: "system", workspaceId: WS }
const NOW = new Date("2026-10-15T21:30:00Z") // Fri 16.10 in Jerusalem

function bound(sql: { text: string; values: unknown[] }, pattern: RegExp): unknown[] {
  return [...sql.text.matchAll(pattern)].map((match) => sql.values[Number(match[1]) - 1])
}

describe("buildTaskListSql", () => {
  it("puts the visibility predicate first and filters the task workspace", () => {
    const sql = buildTaskListSql(member, { scope: "all", status: "all" })
    const where = sql.text.replace(/\s+/g, " ")

    expect(where).toContain("from action_items ai join meetings m on m.id = ai.meeting_id")
    expect(where).toMatch(/where \(m\.workspace_id = \$1 and \(m\.visibility in \('workspace', 'link'\)/)
    expect(where).toContain("lower(mp_scope.email) = $")
    expect(bound(sql, /m\.workspace_id = \$(\d+)/g)).toEqual([WS])
    expect(bound(sql, /ai\.workspace_id = \$(\d+)/g)).toEqual([WS])
    expect(bound(sql, /m\.owner_user_id = \$(\d+)/g)).toEqual(["user_me"])
  })

  it("applies the API-key and system scopes", () => {
    const keySql = buildTaskListSql(apiKey, { scope: "all", status: "all" })

    expect(keySql.text).toContain("m.visibility = 'private' and m.owner_user_id = $")
    expect(keySql.values).toContain("user_key")

    const systemSql = buildTaskListSql(system, { scope: "all", status: "all" })

    expect(systemSql.text.replace(/\s+/g, " ")).toMatch(/where \(m\.workspace_id = \$1\)/)
  })

  it("'mine' = assigned to me, my participant email, or created by me with no owner", () => {
    const sql = buildTaskListSql(member, { scope: "mine", status: "open" })
    const text = sql.text.replace(/\s+/g, " ")

    expect(text).toContain("(ai.owner_user_id = $")
    expect(text).toContain(
      "exists (select 1 from meeting_participants mp_owner where mp_owner.id = ai.owner_participant_id and mp_owner.meeting_id = ai.meeting_id and lower(mp_owner.email) = $"
    )
    expect(text).toContain(
      "ai.created_by_user_id = $"
    )
    expect(text).toContain("ai.owner_user_id is null and ai.owner_participant_id is null and coalesce(ai.owner_text, '') = ''")
    expect(bound(sql, /ai\.owner_user_id = \$(\d+)/g)).toEqual(["user_me"])
    expect(bound(sql, /lower\(mp_owner\.email\) = \$(\d+)/g)).toEqual(["me@example.com"])
    expect(text).toContain("ai.status = 'open'")

    expect(buildTaskListSql(system, { scope: "mine", status: "all" }).text).toContain("and false")
    expect(buildTaskListSql(apiKey, { scope: "mine", status: "all" }).values).toContain("user_key")
  })

  it("'overdue' compares due_on with today in the task time zone", () => {
    const sql = buildTaskListSql(member, { scope: "all", status: "overdue" }, { now: NOW })

    expect(sql.text).toMatch(/ai\.status = 'open' and ai\.due_on < \$\d+::date/)
    expect(bound(sql, /ai\.due_on < \$(\d+)/g)).toEqual(["2026-10-16"])
  })

  it("filters by room (workspace contexts), meeting, owner, due range and title", () => {
    const sql = buildTaskListSql(member, {
      scope: "all",
      status: "all",
      roomId: "ctx_1",
      meetingId: "meet_1",
      ownerUserId: "user_dana",
      dueFrom: "2026-10-01",
      dueTo: "2026-10-31",
      q: "50%_off",
    })
    const text = sql.text.replace(/\s+/g, " ")

    expect(text).toContain(
      "exists (select 1 from meeting_contexts mc join contexts c on c.id = mc.context_id where mc.meeting_id = m.id and mc.context_id = $"
    )
    expect(bound(sql, /c\.workspace_id = \$(\d+)/g)).toEqual([WS])
    expect(bound(sql, /mc\.context_id = \$(\d+)/g)).toEqual(["ctx_1"])
    expect(bound(sql, /ai\.meeting_id = \$(\d+)/g)).toEqual(["meet_1"])
    expect(bound(sql, /ai\.title ilike \$(\d+)/g)).toEqual(["%50\\%\\_off%"])
    expect(bound(sql, /ai\.due_on >= \$(\d+)/g)).toEqual(["2026-10-01"])
    expect(bound(sql, /ai\.due_on <= \$(\d+)/g)).toEqual(["2026-10-31"])
  })

  it("sorts by due asc nulls last then newest, with a keyset cursor", () => {
    const first = buildTaskListSql(member, { scope: "all", status: "all", limit: 500 })

    expect(first.text).toContain("order by ai.due_on asc nulls last, ai.created_at desc, ai.id desc")
    expect(first.limit).toBe(100)
    expect(first.values.at(-1)).toBe(101)

    const dated = buildTaskListSql(member, {
      scope: "all",
      status: "all",
      cursor: encodeTaskCursor({ d: "2026-10-18", c: "2026-10-15 09:00:00.123456+00", i: "act_9" }),
    })
    const datedText = dated.text.replace(/\s+/g, " ")

    expect(datedText).toMatch(
      /\(ai\.due_on > \$\d+::date or \(ai\.due_on = \$\d+::date and \(ai\.created_at < \$\d+::timestamptz or \(ai\.created_at = \$\d+::timestamptz and ai\.id < \$\d+\)\)\) or ai\.due_on is null\)/
    )
    expect(dated.values).toEqual(
      expect.arrayContaining(["2026-10-18", "2026-10-15 09:00:00.123456+00", "act_9"])
    )

    const undated = buildTaskListSql(member, {
      scope: "all",
      status: "all",
      cursor: encodeTaskCursor({ d: null, c: "2026-10-15 09:00:00+00", i: "act_1" }),
    })

    expect(undated.text.replace(/\s+/g, " ")).toContain("(ai.due_on is null and (ai.created_at <")

    const created = buildTaskListSql(member, { scope: "all", status: "all", sort: "created" })

    expect(created.text).toContain("order by ai.created_at desc, ai.id desc")
  })

  it("rejects a tampered cursor", () => {
    expect(() => decodeTaskCursor("not-a-cursor")).toThrow(InvalidTaskCursorError)
    expect(() =>
      buildTaskListSql(member, { scope: "all", status: "all", cursor: "eyJ4IjoxfQ" })
    ).toThrow(InvalidTaskCursorError)
  })
})

describe("listTasksPostgres", () => {
  it("maps rows to tasks with their meeting and returns a next cursor", async () => {
    const rows = [0, 1, 2].map((index) => ({
      id: `act_${index}`,
      title: `Task ${index}`,
      status: "open",
      priority: "normal",
      kind: "explicit",
      meeting_id: "meet_1",
      workspace_id: WS,
      due_on: index === 2 ? null : `2026-10-1${index + 6}`,
      owner_user_id: "user_me",
      created_at: "2026-10-15T09:00:00.000Z",
      cursor_created_at: "2026-10-15 09:00:00+00",
      meeting_title: "סנכרון",
      meeting_started_at: new Date("2026-10-15T09:00:00Z"),
    }))
    const statements: Array<{ text: string; values: unknown[] }> = []
    const page = await listTasksPostgres(
      {
        async query(text: string, values: unknown[] = []) {
          statements.push({ text, values })
          return { rows }
        },
      },
      member,
      { scope: "mine", status: "open", limit: 2 }
    )

    expect(statements).toHaveLength(1)
    expect(page.tasks.map((task) => task.id)).toEqual(["act_0", "act_1"])
    expect(page.tasks[0]).toMatchObject({
      dueOn: "2026-10-16",
      ownerUserId: "user_me",
      meeting: { id: "meet_1", title: "סנכרון", startedAt: "2026-10-15T09:00:00.000Z" },
    })
    expect(decodeTaskCursor(page.nextCursor!)).toEqual({
      d: "2026-10-17",
      c: "2026-10-15 09:00:00+00",
      i: "act_1",
    })
  })
})
