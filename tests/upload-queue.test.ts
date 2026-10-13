/**
 * M9 D5: the offline recording queue over the in-memory storage adapter.
 */
import { describe, expect, it, vi } from "vitest"

import { createMemoryStorage } from "@/lib/client/upload-queue/memory-storage"
import { BACKOFF_MS, backoffDelay, classifyUploadResponse, createUploadQueue } from "@/lib/client/upload-queue/queue"
import type { StoredItem, UploadResult } from "@/lib/client/upload-queue/types"

const START = "2026-10-13T10:00:00.000Z"

function setup(
  responses: Array<UploadResult | Error>,
  userId = "u_1",
  storage = createMemoryStorage(),
  workspaceId = "ws_1"
) {
  let clock = 1_000_000
  const calls: StoredItem[] = []
  const upload = vi.fn(async (item: StoredItem) => {
    calls.push(item)
    const next = responses.shift()

    if (!next) throw new Error("no response scripted")
    if (next instanceof Error) throw next
    return next
  })
  const queue = createUploadQueue({ storage, userId, workspaceId, upload, now: () => clock, random: () => 0.5 })

  return {
    storage,
    queue,
    upload,
    calls,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

async function record(queue: ReturnType<typeof setup>["queue"], captureId = "cap_1", parts = ["aa", "bb"]) {
  for (const [seq, part] of parts.entries()) {
    await queue.recordChunk({ captureId, seq, blob: new Blob([part], { type: "audio/webm" }), startedAt: START, mime: "audio/webm" })
  }

  return queue.finalize({ captureId, title: "Recording", startedAt: START, mime: "audio/webm" })
}

const ok = (id = "m_1"): UploadResult => ({ status: 202, body: { meeting: { id } } })

describe("classifyUploadResponse", () => {
  it.each([
    [{ status: 200, body: { meeting: { id: "m" } } }, "done"],
    [{ status: 202, body: { meetingId: "m" } }, "done"],
    [{ status: 200, body: {} }, "retry"],
    [{ status: 401, body: {} }, "auth"],
    [{ status: 400, body: {} }, "permanent"],
    [{ status: 409, body: {} }, "permanent"],
    [{ status: 413, body: {} }, "permanent"],
    [{ status: 415, body: {} }, "permanent"],
    [{ status: 429, body: {} }, "retry"],
    [{ status: 503, body: {} }, "retry"],
  ])("%j → %s", (result, kind) => {
    expect(classifyUploadResponse(result).kind).toBe(kind)
  })
})

describe("backoffDelay", () => {
  it("steps 5 s, 30 s, 2 min, 10 min with ±20% jitter", () => {
    expect([1, 2, 3, 4, 9].map((n) => backoffDelay(n, () => 0.5))).toEqual([...BACKOFF_MS, 600_000])
    expect(backoffDelay(1, () => 0)).toBe(4_000)
    expect(backoffDelay(1, () => 0.999999)).toBeLessThanOrEqual(6_000)
  })
})

describe("upload queue", () => {
  it("assembles chunks in order on stop and drops them", async () => {
    const { queue, storage } = setup([])
    const item = await record(queue, "cap_1", ["aa", "bb", "cc"])

    expect(item).toMatchObject({ captureId: "cap_1", status: "pending", size: 6, attempts: 0, startedAt: START })
    expect(storage.chunkCount()).toBe(0)
    expect(await (await queue.blobOf("cap_1"))?.text()).toBe("aabbcc")
  })

  it("deletes local data only after a 2xx that names a meeting", async () => {
    const { queue, storage } = setup([{ status: 200, body: {} }, ok()])

    await record(queue)
    let snapshot = await queue.flush()

    expect(snapshot.pending).toBe(1)
    expect(await storage.getItem("u_1|ws_1", "cap_1")).toMatchObject({ status: "pending", attempts: 1 })

    snapshot = await queue.flush({ force: true })
    expect(snapshot.pending).toBe(0)
    expect(await storage.listItems("u_1|ws_1")).toEqual([])
  })

  it("backs off on network errors and 5xx, honouring nextAttemptAt", async () => {
    const { queue, storage, upload, advance } = setup([new TypeError("offline"), { status: 503, body: {} }, ok()])

    await record(queue)
    await queue.flush()
    expect(await storage.getItem("u_1|ws_1", "cap_1")).toMatchObject({ attempts: 1, lastStatus: 0, nextAttemptAt: 1_005_000 })

    await queue.flush()
    expect(upload).toHaveBeenCalledTimes(1)

    advance(5_000)
    await queue.flush()
    expect(await storage.getItem("u_1|ws_1", "cap_1")).toMatchObject({ attempts: 2, lastStatus: 503, nextAttemptAt: 1_035_000 })

    advance(30_000)
    expect((await queue.flush()).pending).toBe(0)
    expect(upload).toHaveBeenCalledTimes(3)
  })

  it("pauses the whole queue on 401 until a forced flush", async () => {
    const { queue, upload } = setup([{ status: 401, body: {} }, ok("m_1"), ok("m_2")])

    await record(queue, "cap_1")
    await record(queue, "cap_2")

    let snapshot = await queue.flush()

    expect(snapshot.pausedForAuth).toBe(true)
    expect(upload).toHaveBeenCalledTimes(1)

    await queue.flush()
    expect(upload).toHaveBeenCalledTimes(1)

    snapshot = await queue.flush({ force: true })
    expect(snapshot.pending).toBe(0)
    expect(upload).toHaveBeenCalledTimes(3)
  })

  it("keeps the blob of a permanent failure and never retries it", async () => {
    const { queue, upload } = setup([{ status: 413, body: {} }])

    await record(queue)

    const snapshot = await queue.flush()

    expect(snapshot).toMatchObject({ pending: 1, permanentFailures: 1 })
    expect(snapshot.items[0]).toMatchObject({ status: "failed-permanent", lastStatus: 413 })
    expect(await (await queue.blobOf("cap_1"))?.text()).toBe("aabb")

    await queue.flush({ force: true })
    expect(upload).toHaveBeenCalledTimes(1)
  })

  it("shares one in-flight flush and uploads a captureId once", async () => {
    const { queue, upload } = setup([ok()])

    await record(queue)
    await Promise.all([queue.flush(), queue.flush(), queue.flush()])
    expect(upload).toHaveBeenCalledTimes(1)
  })

  it("re-reads the item under the lock so a second tab does not re-upload it", async () => {
    const storage = createMemoryStorage()
    const tabA = setup([ok()], "u_1", storage)
    const tabB = setup([ok()], "u_1", storage)

    await record(tabA.queue)
    await tabA.queue.flush()
    await tabB.queue.flush()

    expect(tabA.upload).toHaveBeenCalledTimes(1)
    expect(tabB.upload).not.toHaveBeenCalled()
  })

  it("sends the same captureId on every retry", async () => {
    const { queue, calls } = setup([{ status: 500, body: {} }, ok()])

    await record(queue, "cap_x")
    await queue.flush()
    await queue.flush({ force: true })
    expect(calls.map((item) => item.captureId)).toEqual(["cap_x", "cap_x"])
  })

  it("recovers unfinished chunks as a recording, except active captures", async () => {
    const { queue } = setup([])

    await queue.recordChunk({ captureId: "cap_old", seq: 0, blob: new Blob(["x"]), startedAt: START, mime: "audio/webm" })
    await queue.recordChunk({ captureId: "cap_live", seq: 0, blob: new Blob(["y"]) })

    const recovered = await queue.recover({ title: "Recovered recording", activeCaptureIds: ["cap_live"] })

    expect(recovered).toEqual([expect.objectContaining({ captureId: "cap_old", recovered: true, title: "Recovered recording", startedAt: START })])
    expect((await queue.snapshot()).items.map((item) => item.captureId)).toEqual(["cap_old"])
  })

  it("keys everything by user: another user never sees or uploads it", async () => {
    const storage = createMemoryStorage()
    const alice = setup([], "u_alice", storage)
    const bob = setup([ok()], "u_bob", storage)

    await record(alice.queue)
    await alice.queue.recordChunk({ captureId: "cap_2", seq: 0, blob: new Blob(["z"]) })

    expect((await bob.queue.snapshot()).pending).toBe(0)
    expect(await bob.queue.recover({ title: "R" })).toEqual([])
    await bob.queue.flush()
    expect(bob.upload).not.toHaveBeenCalled()

    await bob.queue.clear()
    expect((await alice.queue.snapshot()).pending).toBe(1)
    await alice.queue.clear()
    expect((await alice.queue.snapshot()).pending).toBe(0)
    expect(storage.chunkCount()).toBe(0)
  })

  it("builds the ingest form with captureMetadata before the file", async () => {
    const { ingestFormData } = await import("@/lib/client/upload-queue/browser")
    const form = ingestFormData({
      owner: "u_1|ws_1",
      userId: "u_1",
      workspaceId: "ws_1",
      captureId: "cap_1",
      title: "Recording",
      startedAt: START,
      mime: "audio/webm",
      size: 2,
      status: "pending",
      attempts: 0,
      nextAttemptAt: null,
      blob: new Blob(["aa"], { type: "audio/webm" }),
    })

    expect([...form.keys()]).toEqual(["meeting", "captureMetadata", "file"])
    expect(JSON.parse(String(form.get("captureMetadata")))).toEqual({
      captureId: "cap_1",
      appVersion: "pwa",
      platform: "web",
      uploadStatus: "uploaded",
    })
    expect(JSON.parse(String(form.get("meeting")))).toMatchObject({ title: "Recording", startedAt: START })
    expect((form.get("file") as File).name).toBe("meetsum-recording-cap_1.webm")
  })

  it("gates recording on free storage and the queue cap", async () => {
    const { storageGate, offlineQueueMaxBytes } = await import("@/lib/client/upload-queue/browser")
    const MB = 1024 * 1024

    expect(offlineQueueMaxBytes(undefined)).toBe(2048 * MB)
    expect(offlineQueueMaxBytes("10")).toBe(10 * MB)
    expect(offlineQueueMaxBytes("nope")).toBe(2048 * MB)
    expect(storageGate(null, 0, 100 * MB)).toBe("ok")
    expect(storageGate(1000 * MB, 0, 100 * MB)).toBe("ok")
    expect(storageGate(150 * MB, 0, 100 * MB)).toBe("low")
    expect(storageGate(10 * MB, 0, 100 * MB)).toBe("refuse")
    expect(storageGate(1000 * MB, 100 * MB, 100 * MB)).toBe("refuse")
  })

  it("A enqueues, B signs in on the same device: nothing uploads and B sees nothing", async () => {
    const storage = createMemoryStorage()
    const alice = setup([], "u_alice", storage)

    await record(alice.queue)
    await alice.queue.recordChunk({ captureId: "cap_crash", seq: 0, blob: new Blob(["z"]) })

    const bob = setup([ok()], "u_bob", storage)

    expect((await bob.queue.snapshot()).items).toEqual([])
    expect(await bob.queue.recover({ title: "R" })).toEqual([])
    await bob.queue.flush({ force: true })
    expect(bob.upload).not.toHaveBeenCalled()

    // A signs back in: A's items flush to A's workspace.
    const aliceAgain = setup([ok("m_a"), ok("m_b")], "u_alice", storage)

    await aliceAgain.queue.recover({ title: "R" })
    expect((await aliceAgain.queue.flush()).pending).toBe(0)
    expect(aliceAgain.calls.map((item) => [item.userId, item.workspaceId])).toEqual([
      ["u_alice", "ws_1"],
      ["u_alice", "ws_1"],
    ])
  })

  it("a workspace switch never uploads into the other workspace", async () => {
    const storage = createMemoryStorage()
    const inW1 = setup([], "u_1", storage, "ws_1")

    await record(inW1.queue)

    const inW2 = setup([ok()], "u_1", storage, "ws_2")

    expect((await inW2.queue.snapshot()).pending).toBe(0)
    await inW2.queue.flush({ force: true })
    expect(inW2.upload).not.toHaveBeenCalled()

    // Back in ws_1 it uploads, carrying ws_1.
    const back = setup([ok()], "u_1", storage, "ws_1")

    await back.queue.flush()
    expect(back.calls.map((item) => item.workspaceId)).toEqual(["ws_1"])
  })

  it("pauses instead of retrying when the server reports a workspace mismatch", async () => {
    const { queue, upload } = setup([{ status: 409, body: { error: "workspace_mismatch" } }])

    await record(queue)
    expect((await queue.flush()).pausedForAuth).toBe(true)
    await queue.flush()
    expect(upload).toHaveBeenCalledTimes(1)
  })

  it("clear() is exact per workspace; clearUser() purges every workspace of the user only", async () => {
    const storage = createMemoryStorage()
    const w1 = setup([], "u_1", storage, "w1")
    const w10 = setup([], "u_1", storage, "w10")
    const other = setup([], "u_2", storage, "w1")

    await record(w1.queue)
    await record(w10.queue)
    await record(other.queue)
    await w1.queue.clear()
    expect((await w10.queue.snapshot()).pending).toBe(1)

    await w1.queue.clearUser()
    expect((await w10.queue.snapshot()).pending).toBe(0)
    expect((await other.queue.snapshot()).pending).toBe(1)
  })

  it("never uploads a stored record whose owner fields disagree with the session", async () => {
    const storage = createMemoryStorage()
    const { queue, upload } = setup([ok()], "u_1", storage)

    await storage.putItem({
      owner: "u_1|ws_1",
      userId: "u_2",
      workspaceId: "ws_9",
      captureId: "forged",
      title: "x",
      startedAt: START,
      mime: "audio/webm",
      size: 1,
      status: "pending",
      attempts: 0,
      nextAttemptAt: null,
      blob: new Blob(["x"]),
    })
    await queue.flush({ force: true })
    expect(upload).not.toHaveBeenCalled()
  })

  it("notifies subscribers with snapshots", async () => {
    const { queue } = setup([ok()])
    const seen: number[] = []

    queue.subscribe((snapshot) => seen.push(snapshot.pending))
    await record(queue)
    await queue.flush()
    expect(seen.at(0)).toBe(1)
    expect(seen.at(-1)).toBe(0)
  })
})
