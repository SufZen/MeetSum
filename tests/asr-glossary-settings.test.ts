import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ query: vi.fn() }))

vi.mock("@/lib/db/client", () => ({
  getDatabasePool: () => ({ query: mocks.query }),
}))

const { DEFAULT_ASR_GLOSSARY } = await import("@/lib/ai/asr")
const {
  AsrGlossaryValidationError,
  getAsrGlossary,
  getWorkspaceAsrGlossary,
  mergeWorkspaceGlossary,
  updateAsrGlossary,
} = await import("@/lib/settings/asr-glossary")

const WORKSPACE = {
  version: 1 as const,
  terms: [
    { term: "MeetSum", aliases: ["מיטסאם"], hotword: true },
    { term: "supabase", aliases: ["סופאבייס", "סופרבייס"], hotword: false },
  ],
}

beforeEach(() => {
  mocks.query.mockReset().mockResolvedValue({ rows: [] })
})

afterEach(() => {
  delete process.env.MEETSUM_STORAGE
})

describe("mergeWorkspaceGlossary", () => {
  it("keeps defaults, replaces same-term defaults in place and appends new terms", () => {
    const merged = mergeWorkspaceGlossary(DEFAULT_ASR_GLOSSARY, WORKSPACE)

    expect(merged.terms).toHaveLength(DEFAULT_ASR_GLOSSARY.terms.length + 1)
    expect(merged.terms[0]).toEqual(WORKSPACE.terms[1])
    expect(merged.terms.at(-1)).toEqual(WORKSPACE.terms[0])
    // Defaults are never mutated.
    expect(DEFAULT_ASR_GLOSSARY.terms[0].term).toBe("Supabase")
  })
})

describe("glossary storage (memory)", () => {
  it("returns the defaults for a workspace without a setting", async () => {
    expect(await getAsrGlossary("ws_empty")).toEqual(DEFAULT_ASR_GLOSSARY)
    expect(await getWorkspaceAsrGlossary("ws_empty")).toEqual({ version: 1, terms: [] })
  })

  it("stores per workspace and merges over the defaults", async () => {
    await updateAsrGlossary("ws_mem", WORKSPACE)

    const effective = await getAsrGlossary("ws_mem")

    expect(effective.terms.map((term) => term.term)).toContain("MeetSum")
    expect(await getAsrGlossary("ws_other")).toEqual(DEFAULT_ASR_GLOSSARY)
  })

  it("rejects invalid payloads with field errors and stores nothing", async () => {
    const error = await updateAsrGlossary("ws_bad", {
      version: 1,
      terms: [{ term: "x".repeat(65), aliases: [] }],
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AsrGlossaryValidationError)
    expect((error as InstanceType<typeof AsrGlossaryValidationError>).errors[0].path).toBe(
      "terms.0.term"
    )
    expect(await getWorkspaceAsrGlossary("ws_bad")).toEqual({ version: 1, terms: [] })
  })
})

describe("glossary storage (postgres)", () => {
  beforeEach(() => {
    process.env.MEETSUM_STORAGE = "postgres"
  })

  it("upserts workspace_settings.asrGlossary with the normalized glossary", async () => {
    const stored = await updateAsrGlossary("ws_pg", {
      terms: [{ term: "  Meet   Sum ", aliases: ["מיט סאם", "מיט סאם"] }],
    })

    expect(stored).toEqual({
      version: 1,
      terms: [{ term: "Meet Sum", aliases: ["מיט סאם"], hotword: true }],
    })
    const [sql, values] = mocks.query.mock.calls[0]

    expect(sql).toContain("insert into workspace_settings")
    expect(sql).toContain("on conflict (workspace_id, key) do update")
    expect(values.slice(0, 2)).toEqual(["ws_pg", "asrGlossary"])
    expect(JSON.parse(values[2])).toEqual(stored)
  })

  it("reads the workspace setting and merges it over the defaults", async () => {
    mocks.query.mockResolvedValue({ rows: [{ value: WORKSPACE }] })

    const effective = await getAsrGlossary("ws_pg")

    expect(mocks.query.mock.calls[0][1]).toEqual(["ws_pg", "asrGlossary"])
    expect(effective).toEqual(mergeWorkspaceGlossary(DEFAULT_ASR_GLOSSARY, WORKSPACE))
  })

  it("ignores a stored value that no longer validates", async () => {
    mocks.query.mockResolvedValue({ rows: [{ value: { version: 7, terms: "nope" } }] })

    expect(await getAsrGlossary("ws_pg")).toEqual(DEFAULT_ASR_GLOSSARY)
  })
})
