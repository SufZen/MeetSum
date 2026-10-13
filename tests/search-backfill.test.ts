import { describe, expect, it, vi } from "vitest"

import { estimateBackfill, parseBackfillArgs, selectBackfillMeetings } from "@/lib/search/index-sweep"

const flat = (sql: string) => sql.replace(/\s+/g, " ").trim()

describe("search backfill plan", () => {
  it("parses the CLI flags", () => {
    expect(parseBackfillArgs(["--all", "--dry-run"])).toEqual({
      all: true,
      force: false,
      inline: false,
      concurrency: 2,
      dryRun: true,
    })
    expect(
      parseBackfillArgs(["--workspace", "ws_1", "--since", "2026-01-01", "--force", "--inline", "--concurrency", "4"])
    ).toEqual({
      workspaceId: "ws_1",
      all: false,
      since: "2026-01-01T00:00:00.000Z",
      force: true,
      inline: true,
      concurrency: 4,
      dryRun: false,
    })
    expect(() => parseBackfillArgs([])).toThrow(/--workspace <id> or --all/)
    expect(() => parseBackfillArgs(["--all", "--workspace", "ws_1"])).toThrow(/not both/)
    expect(() => parseBackfillArgs(["--all", "--since", "yesterday-ish"])).toThrow(/Invalid --since/)
  })

  it("selects stale usable meetings by default and everything with --force", async () => {
    const calls: { text: string; values: unknown[] }[] = []
    const db = {
      query: vi.fn(async (text: string, values: unknown[] = []) => {
        calls.push({ text: flat(text), values })
        return { rows: [{ id: "m1", workspace_id: "ws_1", transcript_chars: "36000", summary_chars: 900 }] }
      }),
    }

    const stale = await selectBackfillMeetings(db, {
      workspaceId: "ws_1",
      since: "2026-01-01T00:00:00.000Z",
      force: false,
      activeKey: { model: "gemini-embedding-001", dimensions: 1536 },
      vectorCapable: true,
    })

    expect(stale).toEqual([{ meetingId: "m1", workspaceId: "ws_1", transcriptChars: 36_000, summaryChars: 900 }])
    expect(calls[0].text).toContain("where m.workspace_id = $1 and (exists")
    expect(calls[0].text).toContain("m.started_at >= $2")
    expect(calls[0].text).toContain("m.search_index_state = 'failed' or")
    expect(calls[0].text).toContain("m.search_embedding_key is distinct from $3")
    expect(calls[0].values).toEqual(["ws_1", "2026-01-01T00:00:00.000Z", "gemini-embedding-001:1536"])

    await selectBackfillMeetings(db, { force: true, activeKey: null, vectorCapable: false })
    expect(calls[1].text).not.toContain("search_index_state")
    expect(calls[1].text).not.toContain("m.workspace_id = $")
    expect(calls[1].values).toEqual([])
  })

  it("estimates tokens and USD for a dry run (about $0.006 per Hebrew meeting-hour)", () => {
    // ~35k transcript tokens per meeting-hour (105k chars) plus ~3k intelligence tokens.
    const plan = estimateBackfill(
      [
        { meetingId: "m1", workspaceId: "ws_1", transcriptChars: 105_000, summaryChars: 2_250 },
        { meetingId: "m2", workspaceId: "ws_2", transcriptChars: 0, summaryChars: 0 },
      ],
      0.15
    )

    expect(plan.meetings).toBe(2)
    expect(plan.workspaces).toBe(2)
    expect(plan.tokens).toBe(38_500 + 3_000 + 100 + 100)
    expect(plan.usd).toBeCloseTo(0.006, 3)
    expect(plan.usd).toBeLessThan(0.01)
  })
})
