/**
 * M9 C2 security check 1 (docs/parity/m9.md): every analytics statement is
 * built on the `visible` CTE from `meetingScopeSql`, and no statement reads
 * `meetings`, `meeting_analytics`, `action_items` or `meeting_tags` outside
 * it. Checked on the statement builder and on a recording Queryable around
 * the real service, for every role (no admin bypass).
 */
import { describe, expect, it } from "vitest"

import { buildAnalyticsStatements } from "@/lib/analytics/dashboard/sql"
import { getAnalyticsOverview } from "@/lib/analytics/dashboard/service"
import type { AnalyticsQuery } from "@/lib/analytics/dashboard/types"
import type { RepoScope } from "@/lib/meetings/repository"
import { meetingScopeSql } from "@/lib/meetings/visibility"

const QUERY: AnalyticsQuery = {
  from: "2026-09-30T21:00:00.000Z",
  to: "2026-10-31T22:00:00.000Z",
  interval: "week",
  scope: "workspace",
  timeZone: "Asia/Jerusalem",
}

const flat = (sql: string) => sql.replace(/\s+/g, " ").toLowerCase()

/** Splits `with visible as (...)` (balanced parentheses) from the rest. */
function splitCte(text: string): { cte: string; rest: string } {
  const sql = flat(text)
  const start = sql.indexOf("with visible as (")

  expect(start, "statement starts with the visible CTE").toBe(0)

  let depth = 0
  let index = "with visible as ".length

  for (; index < sql.length; index += 1) {
    if (sql[index] === "(") depth += 1
    if (sql[index] === ")") {
      depth -= 1
      if (depth === 0) break
    }
  }

  return { cte: sql.slice(0, index + 1), rest: sql.slice(index + 1) }
}

function assertScoped(text: string, scopeSql: string) {
  const { cte, rest } = splitCte(text)

  expect(cte).toContain(flat(scopeSql))
  expect(cte).toContain("from meetings m")
  expect(cte).toMatch(/date_trunc\(\$\d+, m\.started_at at time zone \$\d+\)/)
  expect(rest, "meetings is read only inside the CTE").not.toMatch(/\b(from|join)\s+meetings\b/)

  for (const table of ["meeting_analytics", "action_items", "meeting_tags"]) {
    if (rest.includes(table)) {
      expect(rest, `${table} joins visible`).toMatch(/\b(from|join) visible v\b/)
      expect(rest).toMatch(new RegExp(`join ${table} \\w+ on \\w+\\.meeting_id = v\\.id`))
    }
  }
}

const SCOPES: RepoScope[] = (["owner", "admin", "member", "viewer"] as const).map((role) => ({
  kind: "member",
  workspaceId: "ws_1",
  userId: `usr_${role}`,
  email: `${role}@w1.example`,
  role,
}))

describe("analytics statements", () => {
  it("all six use the visible CTE with the member scope predicate", () => {
    for (const scope of SCOPES) {
      const statements = buildAnalyticsStatements(scope, QUERY, { userId: "usr_x", email: "x@w1.example" })

      expect(statements.map((statement) => statement.name)).toEqual([
        "series",
        "coverage",
        "talk",
        "topics",
        "actionSeries",
        "actionSummary",
      ])

      for (const statement of statements) {
        const expected = meetingScopeSql(scope, "m", [])

        assertScoped(statement.text, expected)
        // Admins get the same private rule: owner or participant only.
        expect(flat(statement.text)).toContain("m.visibility in ('workspace', 'link')")
        expect(flat(statement.text)).toContain("mp_scope")
      }
    }
  })

  it("binds every placeholder it uses and nothing else", () => {
    for (const statement of buildAnalyticsStatements(SCOPES[1]!, { ...QUERY, scope: "me", roomId: "ctx_1" }, {
      userId: "usr_admin",
      email: "Admin@W1.example",
    })) {
      const used = new Set([...statement.text.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])))

      expect([...used].sort((a, b) => a - b), statement.name).toEqual(statement.values.map((_, index) => index + 1))
      expect(statement.values).toContain("Asia/Jerusalem")
      expect(statement.values).toContain("week")
    }
  })

  it("filters by workspace, room and (scope=me) the caller", () => {
    const [series] = buildAnalyticsStatements(SCOPES[2]!, { ...QUERY, scope: "me", roomId: "ctx_1" }, {
      userId: "usr_member",
      email: "member@w1.example",
    })
    const { cte } = splitCte(series!.text)

    expect(series!.values).toContain("ws_1")
    expect(cte).toContain("mc_room.context_id")
    expect(cte).toContain("m.owner_user_id = $")
    expect(cte).toContain("mp_mine")
  })

  it("the service sends only scoped statements to the database", async () => {
    const sent: Array<{ text: string; values: unknown[] }> = []
    const db = {
      async query(text: string, values: unknown[] = []) {
        sent.push({ text, values })
        return { rows: text.startsWith("select 1 from contexts") ? [{ "?column?": 1 }] : [] }
      },
    }

    const result = await getAnalyticsOverview(
      { workspaceId: "ws_1", userId: "usr_admin", email: "admin@w1.example", role: "admin" },
      { ...QUERY, roomId: "ctx_1" },
      { db }
    )

    expect(result.ok).toBe(true)

    const [roomCheck, ...analytics] = sent

    expect(flat(roomCheck!.text)).toBe("select 1 from contexts where id = $1 and workspace_id = $2")
    expect(roomCheck!.values).toEqual(["ctx_1", "ws_1"])
    expect(analytics).toHaveLength(6)
    for (const statement of analytics) {
      assertScoped(statement.text, meetingScopeSql(SCOPES[1]!, "m", []))
    }
  })
})
