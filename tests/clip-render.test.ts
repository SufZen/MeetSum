import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { UnrecoverableError } from "bullmq"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createCollabMemoryDb, type CollabMemoryDb } from "@/lib/clips/db"
import { clipFfmpegArgs, clipStorageKey, renderClipJob } from "@/lib/clips/render"
import type { StoredClip } from "@/lib/clips/db"
import type { MediaAsset, MeetingRecord } from "@/lib/meetings/repository"

import { testMeeting } from "./helpers/route-ctx"

/**
 * M5 C1 `clip.render`: ffmpeg through the injectable execFile with
 * `-protocol_whitelist file,pipe` before `-i`, `-ss/-to` from the clip, AAC
 * 64k m4a, only temp-dir paths, the clip-only storage key, temp cleanup on
 * success and failure, and permanent errors for bad ranges.
 */

const ORIGINAL: MediaAsset = {
  id: "asset_1",
  meetingId: "m_a",
  storageKey: "meetings/ws_a/m_a/1700000000-uuid-../../etc/passwd.mp3",
  filename: "../../etc/passwd.mp3",
  contentType: "audio/mpeg",
  sizeBytes: 1000,
  retention: "audio",
  kind: "original",
  durationMs: 60_000,
  createdAt: "2026-10-01T10:00:00.000Z",
} as MediaAsset

function clip(overrides: Partial<StoredClip> = {}): StoredClip {
  return {
    id: "clip_1",
    workspaceId: "ws_a",
    meetingId: "m_a",
    title: "t",
    startMs: 4000,
    endMs: 9500,
    segmentIds: [],
    renderStatus: "pending",
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:00:00.000Z",
    ...overrides,
  }
}

describe("clip.render", () => {
  let collab: CollabMemoryDb
  let tmpRoot: string
  const meeting: MeetingRecord = testMeeting({ id: "m_a", mediaAssets: [ORIGINAL], durationMs: 60_000 })

  beforeEach(async () => {
    collab = createCollabMemoryDb()
    tmpRoot = await mkdtemp(path.join(tmpdir(), "clip-render-test-"))
  })

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true })
  })

  function deps(execImpl?: (file: string, args: string[]) => Promise<void>) {
    const exec = vi.fn(async (file: string, args: string[]) => {
      if (execImpl) await execImpl(file, args)
      else await writeFile(args[args.length - 1], Buffer.from("m4a-bytes"))
      return { stdout: "", stderr: "" }
    })
    const storage = {
      download: vi.fn(async (_key: string, destination: string) => {
        await writeFile(destination, "source")
      }),
      putFile: vi.fn(async (options: { key: string; path: string; contentType: string }) => ({ key: options.key })),
    }

    return {
      exec,
      storage,
      value: {
        exec,
        storage,
        env: { FFMPEG_PATH: "ffmpeg" },
        backend: { kind: "memory" as const, db: collab },
        loadMeeting: async () => meeting,
        tmpRoot,
      },
    }
  }

  it("cuts the range into an AAC 64k m4a at the clip-only key", async () => {
    collab.clips.set("clip_1", clip())
    const { exec, storage, value } = deps()

    const result = await renderClipJob({ workspaceId: "ws_a", clipId: "clip_1" }, value)

    expect(result).toMatchObject({ clipId: "clip_1", status: "ready" })

    const [binary, args] = exec.mock.calls[0]

    expect(binary).toBe("ffmpeg")
    expect(args.indexOf("-protocol_whitelist")).toBeLessThan(args.indexOf("-i"))
    expect(args[args.indexOf("-protocol_whitelist") + 1]).toBe("file,pipe")
    expect(args[args.indexOf("-ss") + 1]).toBe("4.000")
    expect(args[args.indexOf("-to") + 1]).toBe("9.500")
    expect(args).toEqual(expect.arrayContaining(["-c:a", "aac", "-b:a", "64k", "-vn"]))

    // Only generated temp paths reach ffmpeg — never the stored filename.
    const input = args[args.indexOf("-i") + 1]

    expect(path.basename(input)).toBe("source.mp3")
    expect(input.startsWith(tmpRoot)).toBe(true)
    expect(args.join(" ")).not.toContain("passwd")

    const put = storage.putFile.mock.calls[0][0]

    expect(put.key).toBe("clips/ws_a/clip_1.m4a")
    expect(put.key).not.toBe(ORIGINAL.storageKey)
    expect(put.contentType).toBe("audio/mp4")
    expect(collab.clips.get("clip_1")).toMatchObject({
      renderStatus: "ready",
      storageKey: "clips/ws_a/clip_1.m4a",
    })
    expect(await readdir(tmpRoot)).toEqual([])
  })

  it("marks the clip failed, cleans up and rethrows when ffmpeg fails", async () => {
    collab.clips.set("clip_1", clip())
    const { value } = deps(async () => {
      throw Object.assign(new Error("ffmpeg exploded with /secret/path"), { name: "ExecError" })
    })

    await expect(renderClipJob({ workspaceId: "ws_a", clipId: "clip_1" }, value)).rejects.toThrow()
    expect(collab.clips.get("clip_1")).toMatchObject({ renderStatus: "failed" })
    expect(collab.clips.get("clip_1")?.renderError).not.toContain("/secret/path")
    expect(await readdir(tmpRoot)).toEqual([])
  })

  it("fails permanently for a range outside the recording", async () => {
    collab.clips.set("clip_1", clip({ startMs: 70_000, endMs: 75_000 }))
    const { exec, value } = deps()

    await expect(renderClipJob({ workspaceId: "ws_a", clipId: "clip_1" }, value)).rejects.toBeInstanceOf(
      UnrecoverableError
    )
    expect(exec).not.toHaveBeenCalled()
    expect(collab.clips.get("clip_1")?.renderStatus).toBe("failed")
  })

  it("fails permanently without a recording", async () => {
    collab.clips.set("clip_1", clip())
    const { value } = deps()

    await expect(
      renderClipJob(
        { workspaceId: "ws_a", clipId: "clip_1" },
        { ...value, loadMeeting: async () => testMeeting({ id: "m_a", mediaAssets: [] }) }
      )
    ).rejects.toBeInstanceOf(UnrecoverableError)
  })

  it("skips a deleted clip or one of another workspace", async () => {
    collab.clips.set("clip_1", clip({ deletedAt: "2026-10-02T00:00:00.000Z" }))
    collab.clips.set("clip_2", clip({ id: "clip_2", workspaceId: "ws_b" }))
    const { exec, value } = deps()

    expect(await renderClipJob({ workspaceId: "ws_a", clipId: "clip_1" }, value)).toMatchObject({ skipped: true })
    expect(await renderClipJob({ workspaceId: "ws_a", clipId: "clip_2" }, value)).toMatchObject({ skipped: true })
    expect(exec).not.toHaveBeenCalled()
  })

  it("builds keys only from safe ids", () => {
    expect(clipStorageKey("ws_a", "clip_1")).toBe("clips/ws_a/clip_1.m4a")
    expect(() => clipStorageKey("ws_a", "../x")).toThrow()
    expect(clipFfmpegArgs("in", "out", { startMs: 0, endMs: 2000 }).slice(-1)).toEqual(["out"])
  })
})
