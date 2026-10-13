import { describe, expect, it } from "vitest"

import type { RepoScope } from "@/lib/meetings/repository"
import { meetingScopeSql } from "@/lib/meetings/visibility"
import {
  assertEmbeddingKey,
  buildFacetQueries,
  buildFtsLegQuery,
  buildHydrateQuery,
  buildMeetingListQuery,
  buildPendingCountQuery,
  buildSegmentTextsQuery,
  buildTrgmLegQuery,
  buildVectorLegQuery,
  trgmSetLocal,
  vectorSetLocal,
  type SqlQuery,
} from "@/lib/search/sql"

const member: RepoScope = { kind: "member", workspaceId: "ws_1", userId: "u_1", email: "Me@Example.com", role: "admin" }
const viewer: RepoScope = { kind: "member", workspaceId: "ws_1", userId: "u_2", email: "v@example.com", role: "viewer" }
const apiKeyOwned: RepoScope = { kind: "api_key", workspaceId: "ws_1", ownerUserId: "u_1" }
const apiKeyOrphan: RepoScope = { kind: "api_key", workspaceId: "ws_1" }
const key = { model: "gemini-embedding-001", dimensions: 3 }

function whereClause(query: SqlQuery) {
  const marker = "\n  where "

  return query.text.slice(query.text.indexOf(marker) + marker.length)
}

function allLegs(scope: RepoScope, filters = {}) {
  const base = { scope, workspaceId: "ws_1", filters, limit: 50 }

  return {
    fts: buildFtsLegQuery({ ...base, tsquery: "('x')" }),
    trgm: buildTrgmLegQuery({ ...base, trgm: "תקציב" }),
    vector: buildVectorLegQuery({ ...base, key, vector: [0.1, 0.2, 0.3] }),
    hydrate: buildHydrateQuery({ scope, workspaceId: "ws_1", ids: ["c1"] }),
    list: buildMeetingListQuery({ scope, workspaceId: "ws_1", filters, limit: 10, offset: 0 }),
    pending: buildPendingCountQuery({ scope, workspaceId: "ws_1", filters }),
    segments: buildSegmentTextsQuery({ scope, workspaceId: "ws_1", segmentIds: ["s1"] }),
    ...buildFacetQueries({ scope, workspaceId: "ws_1" }),
  }
}

describe("search SQL: visibility before ranking", () => {
  it("every statement starts its WHERE with the workspace match and the scope predicate", () => {
    for (const scope of [member, viewer, apiKeyOwned, apiKeyOrphan]) {
      for (const [name, query] of Object.entries(allLegs(scope, { tags: ["x"], kinds: ["transcript"] }))) {
        const clause = whereClause(query)

        expect(clause, name).toMatch(/^(c|m|e)\.workspace_id = \$1 (and c\.workspace_id = \$1 )?and \(m\.workspace_id = \$2 /)
        expect(query.values[0], name).toBe("ws_1")
        expect(query.values[1], name).toBe("ws_1")

        const scopeValues: unknown[] = ["ws_1"]
        const scopeSql = meetingScopeSql(scope, "m", scopeValues)
        const workspace = clause.slice(0, clause.indexOf(" and (m.workspace_id"))
        const prefix = `${workspace} and ${scopeSql}`

        // The whole scope predicate comes first, then filters, ranking and limit.
        expect(clause.startsWith(prefix), name).toBe(true)
        expect(query.values.slice(0, scopeValues.length), name).toEqual(scopeValues)

        const rest = clause.slice(prefix.length)

        expect(rest.trim() === "" || rest.startsWith("\n    and ") || rest.startsWith("\n  "), name).toBe(true)
        expect(clause.indexOf("order by"), name).not.toBe(0)
      }
    }
  })

  it("a member scope adds the owner/participant clause", () => {
    const { fts } = allLegs(member)

    expect(fts.text).toContain("m.visibility in ('workspace', 'link') or m.owner_user_id = $3 or exists (select 1 from meeting_participants mp_scope")
    expect(fts.values.slice(0, 4)).toEqual(["ws_1", "ws_1", "u_1", "me@example.com"])
  })

  it("an API key adds the owner-private clause, or shared-only without an owner", () => {
    expect(allLegs(apiKeyOwned).fts.text).toContain("(m.visibility = 'private' and m.owner_user_id = $3)")
    expect(allLegs(apiKeyOrphan).fts.text).toContain("(m.workspace_id = $2 and m.visibility in ('workspace', 'link'))")
    expect(allLegs(apiKeyOrphan).fts.text).not.toContain("private")
  })

  it("hydration re-applies the scope", () => {
    const { hydrate } = allLegs(viewer)

    expect(whereClause(hydrate)).toMatch(/^c\.workspace_id = \$1 and \(m\.workspace_id = \$2 and \(m\.visibility/)
    expect(hydrate.text).toContain("c.id = any($")
  })

  it("rejects a scope from another workspace", () => {
    expect(() => buildFtsLegQuery({ scope: { ...member, workspaceId: "ws_2" }, workspaceId: "ws_1", filters: {}, limit: 5, tsquery: "x" })).toThrow()
  })
})

describe("search SQL: filters are bound parameters", () => {
  const filters = {
    from: "2026-01-01",
    to: "2026-01-31",
    participants: ["Dana@X.com", "דנה"],
    speakerIds: ["spk_1"],
    roomIds: ["room_1"],
    tags: ["Budget"],
    languages: ["he" as const],
    meetingTypes: ["board"],
    sources: ["upload"],
    kinds: ["transcript" as const],
    meetingIds: ["m_1"],
  }

  it("emits one clause per filter, never interpolating values", () => {
    const { text, values } = buildFtsLegQuery({ scope: apiKeyOrphan, workspaceId: "ws_1", filters, limit: 10, tsquery: "('q')" })

    expect(text).toContain("m.started_at >= $3::date")
    expect(text).toContain("m.started_at < ($4::date + interval '1 day')")
    expect(text).toContain("lower(p.email) = any($5::text[]) or lower(p.name) = any($5::text[])")
    expect(text).toContain("c.speaker_ids && $6::text[]")
    expect(text).toContain("mc.context_id = any($7::text[])")
    expect(text).toContain("x.workspace_id = m.workspace_id")
    expect(text).toContain("lower(t.name) = any($8::text[])")
    expect(text).toContain("t.workspace_id = m.workspace_id")
    expect(text).toContain("coalesce(c.language, m.language) = any($9::text[])")
    expect(text).toContain("m.meeting_type = any($10::text[])")
    expect(text).toContain("m.source = any($11::text[])")
    expect(text).toContain("c.kind = any($12::text[])")
    expect(text).toContain("m.id = any($13::text[])")
    expect(text).toContain("to_tsquery('simple', $14)")
    expect(values.slice(2)).toEqual([
      "2026-01-01",
      "2026-01-31",
      ["dana@x.com", "דנה"],
      ["spk_1"],
      ["room_1"],
      ["budget"],
      ["he"],
      ["board"],
      ["upload"],
      ["transcript"],
      ["m_1"],
      "('q')",
    ])
    for (const value of ["Dana", "Budget", "board", "upload", "room_1"]) {
      expect(text).not.toContain(value)
    }
  })

  it("meeting-level statements map chunk filters to meeting predicates", () => {
    const { text } = buildMeetingListQuery({ scope: apiKeyOrphan, workspaceId: "ws_1", filters, limit: 10, offset: 0 })

    expect(text).not.toContain("c.kind")
    expect(text).toContain("exists (select 1 from speakers s where s.meeting_id = m.id and s.id = any(")
    expect(text).toContain("m.language = any(")
  })
})

describe("search SQL: vector leg", () => {
  it("uses literal, validated model and dimensions with the index cast", () => {
    const { text, values } = buildVectorLegQuery({ scope: member, workspaceId: "ws_1", filters: {}, limit: 100, key, vector: [0.1, 0.2, 0.3] })

    expect(text).toContain("e.model = 'gemini-embedding-001'")
    expect(text).toContain("e.dimensions = 3")
    expect(text).toContain("order by (e.embedding::vector(3)) <=> $5::vector(3)")
    expect(text).toContain("join meeting_chunks c on c.meeting_id = e.meeting_id and c.content_hash = e.content_hash")
    expect(values[4]).toBe("[0.1,0.2,0.3]")
  })

  it("rejects hostile keys and malformed vectors", () => {
    expect(() => assertEmbeddingKey({ model: "x'; drop table meetings; --", dimensions: 3 })).toThrow()
    expect(() => assertEmbeddingKey({ model: "ok", dimensions: 2001 })).toThrow()
    expect(() => assertEmbeddingKey({ model: "ok", dimensions: 1.5 })).toThrow()
    expect(() =>
      buildVectorLegQuery({ scope: member, workspaceId: "ws_1", filters: {}, limit: 5, key, vector: [0.1, Number.NaN, 0.3] })
    ).toThrow()
    expect(() => buildVectorLegQuery({ scope: member, workspaceId: "ws_1", filters: {}, limit: 5, key, vector: [0.1] })).toThrow()
  })

  it("set local statements are validated literals", () => {
    expect(vectorSetLocal(100)).toEqual(["set local hnsw.ef_search = 100", "set local hnsw.iterative_scan = relaxed_order"])
    expect(trgmSetLocal(0.45)).toBe("set local pg_trgm.word_similarity_threshold = 0.45")
    expect(() => vectorSetLocal(0)).toThrow()
    expect(() => trgmSetLocal(2)).toThrow()
  })
})
