import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

/**
 * M4 decision: media is proxied through Node routes, never presigned to the
 * browser, and MinIO/S3 is never exposed. Only the M3 ASR handoff
 * (`lib/ai/asr/handoff.ts`) may mint presigned URLs (for the remote ASR
 * worker), on top of their definition in `lib/storage/object-storage.ts`.
 */

const ROOT = process.cwd()
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs)$/

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry)

    if (statSync(full).isDirectory()) return entry === "node_modules" ? [] : walk(full)
    return SOURCE.test(entry) ? [full] : []
  })
}

function relative(file: string) {
  return path.relative(ROOT, file).split(path.sep).join("/")
}

/** Identifiers that expose storage directly or mint presigned URLs. */
const PRESIGN = [
  /S3_PUBLIC_ENDPOINT/,
  /getMeetingObjectPresignedUrl/,
  /\bgetSignedUrl\b/,
  /@aws-sdk\/s3-request-presigner/,
  /@\/lib\/ai\/asr\/handoff/,
]

function offenders(files: string[]) {
  return files
    .filter((file) => PRESIGN.some((pattern) => pattern.test(readFileSync(file, "utf8"))))
    .map(relative)
}

describe("media is never presigned to the browser", () => {
  it("no route or component references S3_PUBLIC_ENDPOINT or presign helpers", () => {
    const files = [...walk(path.join(ROOT, "app")), ...walk(path.join(ROOT, "components"))]

    expect(files.length).toBeGreaterThan(50)
    expect(offenders(files)).toEqual([])
  })

  it("within lib/, only the storage module and the ASR handoff mint presigned URLs", () => {
    const allowed = new Set([
      "lib/storage/object-storage.ts",
      "lib/ai/asr/handoff.ts",
    ])
    const presigners = walk(path.join(ROOT, "lib"))
      .filter((file) =>
        /getMeetingObjectPresignedUrl|\bgetSignedUrl\b|s3-request-presigner/.test(
          readFileSync(file, "utf8")
        )
      )
      .map(relative)

    expect(presigners.filter((file) => !allowed.has(file))).toEqual([])
  })

  it("the media and sharing modules never touch the public endpoint", () => {
    const files = [
      ...walk(path.join(ROOT, "lib/media")),
      ...walk(path.join(ROOT, "lib/sharing")),
    ]

    expect(offenders(files)).toEqual([])
  })
})
