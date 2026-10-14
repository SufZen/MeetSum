import { readFileSync } from "node:fs"
import path from "node:path"

import { beforeEach, describe, expect, it } from "vitest"

import {
  archiveCustomTemplate,
  getCustomTemplate,
  listCustomTemplates,
  loadCustomTemplate,
  parseTemplateInput,
  resetMemoryTemplates,
  saveCustomTemplate,
  TemplateKeyConflictError,
  TemplateKeyImmutableError,
  TemplateNotFoundError,
  TemplateValidationError,
  type SaveCustomTemplateInput,
} from "@/lib/ai/templates/store"
import { getMeetingAnalytics, upsertMeetingAnalytics } from "@/lib/analytics/store"
import { listGeneratedDocs, upsertGeneratedDoc } from "@/lib/intelligence/prep/generated-docs"
import type { Queryable } from "@/lib/db/client"
import type { RepoScope } from "@/lib/meetings/repository"

const valid: SaveCustomTemplateInput = {
  key: "deal-review",
  name: "סקירת עסקה",
  description: "לפגישות עסקה",
  language: "he",
  baseTemplate: "hebrew_business",
  prompt: "התמקד/י בתנאי העסקה.",
  sections: [
    { key: "terms", title: { he: "תנאים", en: "Terms" }, kind: "bullets", instructions: "תנאי העסקה", maxItems: 8, required: true },
    { key: "risks", title: { he: "סיכונים", en: "" }, kind: "paragraph", instructions: "", required: false },
  ],
}

beforeEach(() => resetMemoryTemplates())

describe("parseTemplateInput", () => {
  it("normalizes a valid template", () => {
    const result = parseTemplateInput({ ...valid, description: "  ", prompt: "  x  " })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.input.description).toBeUndefined()
    expect(result.input.prompt).toBe("x")
    // A missing title falls back to the other language.
    expect(result.input.sections[1].title).toEqual({ he: "סיכונים", en: "סיכונים" })
  })

  it.each([
    [{ key: "A" }, "key"],
    [{ key: "x" }, "key"],
    [{ key: "a".repeat(41) }, "key"],
    [{ key: "deal_review" }, "key"],
    [{ name: "" }, "name"],
    [{ prompt: "x".repeat(4001) }, "prompt"],
    [{ baseTemplate: "nope" }, "baseTemplate"],
    [{ language: "fr" }, "language"],
    [{ sections: Array.from({ length: 13 }, (_, i) => ({ ...valid.sections[0], key: `s${i}` })) }, "sections"],
    [{ sections: [{ ...valid.sections[0], kind: "chart" }] }, "sections.0.kind"],
    [{ sections: [{ ...valid.sections[0], maxItems: 0 }] }, "sections.0.maxItems"],
    [{ sections: [{ ...valid.sections[0], title: { he: "", en: "" } }] }, "sections.0.title"],
    [{ sections: [valid.sections[0], valid.sections[0]] }, "sections.1.key"],
  ])("rejects %j", (patch, path) => {
    const result = parseTemplateInput({ ...valid, ...patch })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.map((error) => error.path)).toContain(path)
  })
})

describe("in-memory template store", () => {
  it("creates, lists, loads, updates and archives per workspace", async () => {
    const created = await saveCustomTemplate("ws_a", valid, { userId: "user_admin" })

    expect(created).toMatchObject({ workspaceId: "ws_a", key: "deal-review", createdByUserId: "user_admin" })
    expect(created.id).toMatch(/^tpl_/)
    expect(await loadCustomTemplate("ws_a", "custom:deal-review")).toMatchObject({ id: created.id })
    expect(await loadCustomTemplate("ws_a", "deal-review")).toMatchObject({ id: created.id })
    expect(await loadCustomTemplate("ws_b", "deal-review")).toBeUndefined()
    expect(await getCustomTemplate("ws_b", created.id)).toBeUndefined()

    const updated = await saveCustomTemplate("ws_a", { ...valid, id: created.id, name: "עסקאות" }, {})

    expect(updated.name).toBe("עסקאות")
    expect(updated.createdByUserId).toBe("user_admin")

    await archiveCustomTemplate("ws_a", created.id)
    expect(await loadCustomTemplate("ws_a", "deal-review")).toBeUndefined()
    expect(await listCustomTemplates("ws_a")).toEqual([])
    expect(await listCustomTemplates("ws_a", { includeArchived: true })).toHaveLength(1)
    expect(await archiveCustomTemplate("ws_b", created.id)).toBeUndefined()
  })

  it("rejects duplicate keys within a workspace only", async () => {
    await saveCustomTemplate("ws_a", valid, {})

    await expect(saveCustomTemplate("ws_a", valid, {})).rejects.toBeInstanceOf(TemplateKeyConflictError)
    await expect(saveCustomTemplate("ws_b", valid, {})).resolves.toMatchObject({ workspaceId: "ws_b" })
  })

  it("keeps the key immutable after create", async () => {
    const created = await saveCustomTemplate("ws_a", valid, {})

    await expect(
      saveCustomTemplate("ws_a", { ...valid, id: created.id, key: "deal-review-2" }, {})
    ).rejects.toBeInstanceOf(TemplateKeyImmutableError)
    expect(await loadCustomTemplate("ws_a", "deal-review")).toMatchObject({ id: created.id })
    expect(await loadCustomTemplate("ws_a", "deal-review-2")).toBeUndefined()
  })

  it("allows reusing the key of an archived template", async () => {
    const first = await saveCustomTemplate("ws_a", valid, {})

    await archiveCustomTemplate("ws_a", first.id)

    const second = await saveCustomTemplate("ws_a", { ...valid, name: "גרסה חדשה" }, {})

    expect(second.id).not.toBe(first.id)
    expect(await loadCustomTemplate("ws_a", "deal-review")).toMatchObject({ id: second.id })
    await expect(saveCustomTemplate("ws_a", valid, {})).rejects.toBeInstanceOf(TemplateKeyConflictError)
  })

  it("validates on save and 404s unknown ids", async () => {
    await expect(saveCustomTemplate("ws_a", { ...valid, key: "!" }, {})).rejects.toBeInstanceOf(TemplateValidationError)
    await expect(saveCustomTemplate("ws_a", { ...valid, id: "tpl_missing" }, {})).rejects.toBeInstanceOf(
      TemplateNotFoundError
    )
  })
})

/** Records queries; answers with `rows`. */
function recorder(rows: unknown[] = [], error?: unknown) {
  const calls: Array<{ text: string; values?: unknown[] }> = []
  const client: Queryable = {
    query: async (text, values) => {
      calls.push({ text, values })
      if (error) throw error
      return { rows }
    },
  }

  return { client, calls }
}

const member: RepoScope = { kind: "member", workspaceId: "ws_a", userId: "u1", email: "u1@x.co", role: "member" }

describe("postgres stores", () => {
  it("filters templates by workspace and maps unique violations to conflicts", async () => {
    const { client, calls } = recorder()

    await listCustomTemplates("ws_a", {}, { client })
    await loadCustomTemplate("ws_a", "custom:deal-review", { client })
    expect(calls[0].text).toMatch(/where workspace_id = \$1 and archived_at is null/)
    expect(calls[1].values).toEqual(["ws_a", "deal-review"])

    const failing = recorder([], Object.assign(new Error("dup"), { code: "23505" }))

    await expect(saveCustomTemplate("ws_a", valid, {}, { client: failing.client })).rejects.toBeInstanceOf(
      TemplateKeyConflictError
    )
  })

  it("never updates the key in Postgres and refuses a changed key", async () => {
    const row = {
      id: "tpl_1",
      workspace_id: "ws_a",
      key: "deal-review",
      name: "x",
      prompt: "p",
      sections: [],
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
    }
    const { client, calls } = recorder([row])

    await saveCustomTemplate("ws_a", { ...valid, id: "tpl_1", name: "עסקאות" }, {}, { client })
    const update = calls.find((call) => /^update summary_templates/.test(call.text.trim()))!

    expect(update.text).not.toMatch(/set key =|, key =/)
    await expect(
      saveCustomTemplate("ws_a", { ...valid, id: "tpl_1", key: "renamed" }, {}, { client })
    ).rejects.toBeInstanceOf(TemplateKeyImmutableError)
  })

  it("migration 023 enforces key uniqueness among non-archived templates only (idempotent)", () => {
    for (const file of ["db/migrations/023_m5_fixups.sql"]) {
      const sql = readFileSync(path.join(process.cwd(), file), "utf8").replace(/\s+/g, " ")

      expect(sql, file).toContain(
        "create unique index if not exists summary_templates_workspace_key_active on summary_templates (workspace_id, key) where archived_at is null"
      )
      expect(sql, file).toContain(
        "alter table summary_templates drop constraint if exists summary_templates_workspace_id_key_key"
      )
      expect(sql, file).not.toMatch(/archived_at timestamptz, created_at timestamptz not null default now\(\), updated_at timestamptz not null default now\(\), unique \(workspace_id, key\)/)
    }
  })

  it("scopes analytics and generated docs through the meeting visibility predicate", async () => {
    const reads = recorder()

    await getMeetingAnalytics(member, "m1", { client: reads.client })
    await upsertMeetingAnalytics(
      member,
      {
        meetingId: "m1",
        workspaceId: "ws_a",
        version: 1,
        transcriptHash: "h",
        metrics: { basis: "text", totalTalkTimeMs: 0, totalWords: 0, totalQuestions: 0, fillerPer100Words: 0, interruptions: 0, speakers: [] },
      },
      { client: reads.client }
    )
    await listGeneratedDocs(member, "m1", { kind: "prep_brief" }, { client: reads.client })
    await upsertGeneratedDoc(
      member,
      { meetingId: "m1", kind: "prep_brief", variant: "he", inputHash: "h", content: {}, sourceMeetingIds: [] },
      { client: reads.client }
    )

    for (const call of reads.calls) {
      expect(call.text).toMatch(/m\.workspace_id = \$\d+/)
      expect(call.text).toMatch(/mp_scope/)
      expect(call.values).toContain("ws_a")
      expect(call.values).toContain("u1")
    }
    // Metrics-only refresh keeps the stored sentiment.
    expect(reads.calls[1].text).not.toMatch(/sentiment = excluded\.sentiment/)
  })

  it("never writes analytics for another workspace", async () => {
    const { client, calls } = recorder()

    expect(
      await upsertMeetingAnalytics(
        member,
        {
          meetingId: "m1",
          workspaceId: "ws_b",
          version: 1,
          transcriptHash: "h",
          metrics: { basis: "text", totalTalkTimeMs: 0, totalWords: 0, totalQuestions: 0, fillerPer100Words: 0, interruptions: 0, speakers: [] },
        },
        { client }
      )
    ).toBeUndefined()
    expect(calls).toEqual([])
  })
})
