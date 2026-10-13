/**
 * Eval meeting loading (M5 D8): the committed synthetic fixtures plus, for
 * live runs, up to 20 consented real meetings listed in the manifest
 * (`MEETSUM_EVAL_MANIFEST`, default `.secrets/llm-eval/manifest.json`).
 */
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"

import type { EvalMeetingFixture } from "@/lib/ai/llm-eval/types"

export const DEFAULT_FIXTURES_DIR = "tests/fixtures/llm-eval/meetings"
export const DEFAULT_MANIFEST = ".secrets/llm-eval/manifest.json"
export const MAX_REAL_MEETINGS = 20

function assertFixture(value: unknown, source: string): EvalMeetingFixture {
  const fixture = value as Partial<EvalMeetingFixture>

  if (
    !fixture ||
    typeof fixture.id !== "string" ||
    !Array.isArray(fixture.segments) ||
    !fixture.reference ||
    !Array.isArray(fixture.reference.actionItems)
  ) {
    throw new Error(`Invalid eval meeting: ${source}`)
  }

  return {
    ...fixture,
    _synthetic: fixture._synthetic === true,
    reference: {
      actionItems: fixture.reference.actionItems,
      decisions: fixture.reference.decisions ?? [],
      keyTopics: fixture.reference.keyTopics ?? [],
    },
  } as EvalMeetingFixture
}

export type LoadedFixtures = {
  meetings: EvalMeetingFixture[]
  /** SHA-256 over the committed fixture files (names and bytes). */
  sha256: string
}

export async function loadFixtures(dir = DEFAULT_FIXTURES_DIR): Promise<LoadedFixtures> {
  const files = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort()
  const hash = createHash("sha256")
  const meetings: EvalMeetingFixture[] = []

  for (const file of files) {
    const raw = await readFile(path.join(dir, file), "utf8")

    hash.update(file)
    hash.update("\u0000")
    hash.update(raw.replace(/\r\n/g, "\n"))
    meetings.push(assertFixture(JSON.parse(raw), file))
  }

  return { meetings, sha256: hash.digest("hex") }
}

type ManifestFile = { meetings?: Array<{ path?: string; consent?: boolean }> }

/**
 * Real meetings from the manifest: only entries with `consent: true`, at
 * most 20, paths relative to the manifest. Missing manifest → none.
 */
export async function loadManifestMeetings(manifestPath: string): Promise<EvalMeetingFixture[]> {
  if (!existsSync(manifestPath)) return []

  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ManifestFile
  const base = path.dirname(manifestPath)
  const meetings: EvalMeetingFixture[] = []

  for (const entry of (manifest.meetings ?? []).slice(0, MAX_REAL_MEETINGS)) {
    if (entry.consent !== true || !entry.path) continue

    const raw = await readFile(path.resolve(base, entry.path), "utf8")

    meetings.push({ ...assertFixture(JSON.parse(raw), entry.path), _synthetic: false })
  }

  return meetings
}
