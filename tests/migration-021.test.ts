import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

const migration = readFileSync("db/migrations/021_player_transcript_ux.sql", "utf8")

describe("migration 021 (static)", () => {
  it("adds media kind / derived / duration / peaks / prepare columns", () => {
    for (const column of [
      "kind text not null default 'original'",
      "derived_from_asset_id text references media_assets(id) on delete cascade",
      "duration_ms integer",
      "peaks_storage_key text",
      "prepared_at timestamptz",
      "prepare_error text",
    ]) {
      expect(migration).toContain(`add column if not exists ${column}`)
    }
    expect(migration).toContain("check (kind in ('original','playback'))")
    expect(migration).toContain("idx_media_assets_meeting_kind on media_assets(meeting_id, kind, created_at desc)")
  })

  it("backfills durations from media metadata, then transcript ends", () => {
    expect(migration).toMatch(/update media_assets set duration_ms = round\(\(metadata->>'durationMs'\)/)
    expect(migration).toMatch(/\(metadata->>'durationSeconds'\)::numeric \* 1000/)
    expect(migration).toMatch(/update meetings m set duration_ms = coalesce\([\s\S]*max\(a\.duration_ms\)[\s\S]*max\(s\.end_ms\)/)
  })

  it("adds the transcript version, segment revision columns and the revisions table", () => {
    expect(migration).toContain("add column if not exists transcript_version integer not null default 0")
    expect(migration).toContain("add column if not exists revision integer not null default 0")
    expect(migration).toContain("add column if not exists edited_by_user_id text references users(id) on delete set null")
    expect(migration).toContain("create table if not exists transcript_segment_revisions")
    expect(migration).toMatch(/workspace_id text not null references workspaces\(id\) on delete cascade/)
    expect(migration).toMatch(/segment_id text not null references transcript_segments\(id\) on delete cascade/)
    expect(migration).toContain("on transcript_segment_revisions(segment_id, revision desc)")
  })

  it("rewrites no-action meeting FKs to cascade (ai_runs set null) and summary sections", () => {
    expect(migration).toContain(
      "in ('media_assets','speakers','transcript_segments','summaries','action_items','ai_runs','agent_runs')"
    )
    expect(migration).toContain("case when r.tbl = 'ai_runs' then 'set null' else 'cascade' end")
    expect(migration).toMatch(/summary_sections add constraint %I foreign key \(summary_id\) references summaries\(id\) on delete cascade/)
  })
})
