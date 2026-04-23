import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { createMigrationPlan, listMigrationFiles } from "@/lib/db/migrations"
import { createPostgresMeetingRepository } from "@/lib/meetings/postgres-repository"

describe("database migrations", () => {
  it("loads numbered SQL migrations in version order and plans unapplied files", () => {
    const dir = mkdtempSync(join(tmpdir(), "meetsum-migrations-"))

    try {
      writeFileSync(join(dir, "002_indexes.sql"), "select 2;")
      writeFileSync(join(dir, "001_initial.sql"), "select 1;")
      writeFileSync(join(dir, "README.md"), "ignore me")

      const files = listMigrationFiles(dir)

      expect(files.map((file) => file.version)).toEqual(["001", "002"])
      expect(
        createMigrationPlan(["001"], files).map((file) => file.name)
      ).toEqual(["002_indexes.sql"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("Postgres meeting repository", () => {
  it("persists meetings with JSON participants and maps database rows to records", async () => {
    const queries: Array<{ text: string; values: unknown[] }> = []
    const repository = createPostgresMeetingRepository({
      query: async (text, values = []) => {
        queries.push({ text, values })

        return {
          rows: [
            {
              id: "meet_1",
              title: values[0],
              source: values[1],
              language: values[2],
              status: "created",
              retention: "audio",
              started_at: values[3],
              participants: values[4],
            },
          ],
        }
      },
    })

    const meeting = await repository.createMeeting({
      title: "Workspace sync review",
      source: "google_meet",
      language: "he",
      startedAt: "2026-04-23T09:00:00.000Z",
      participants: ["Ran", "Maya"],
    })

    expect(meeting).toMatchObject({
      title: "Workspace sync review",
      participants: ["Ran", "Maya"],
      status: "created",
    })
    expect(queries[0].text).toContain("insert into meetings")
    expect(queries[0].values[4]).toBe(JSON.stringify(["Ran", "Maya"]))
  })
})
