import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createTestCtx, jsonRequest, routeParams, setRouteCtx } from "./helpers/route-ctx"

vi.mock("@/lib/auth/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/authz")>()
  const { mockAuthzModule } = await import("./helpers/route-ctx")

  return mockAuthzModule(actual)
})

const queue = vi.hoisted(() => ({
  enqueue: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
  remove: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
  getJob: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
}))

vi.mock("@/lib/audit", () => ({ recordAuditLog: vi.fn(async () => undefined) }))
vi.mock("@/lib/bot/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/bot/queue")>()),
  enqueueBotJob: queue.enqueue,
  removeBotJob: queue.remove,
  getBotJob: queue.getJob,
  defaultBotQueuePort: queue,
}))

import { POST as joinNow } from "@/app/api/meetings/bot/route"
import { openMeetingSecrets } from "@/lib/bot/dispatch"
import { setBotMeetingLinkLookup } from "@/lib/bot/service"
import { setMemoryBotSessionStore } from "@/lib/bot/store"
import { createMemoryBotSessionStore, type MemoryBotSessionStore } from "@/lib/bot/store-memory"
import { createInMemoryMeetingDatabase } from "@/lib/meetings/repository"

/**
 * Join now through the REAL dispatcher (no dispatch mock): the service must
 * call the workspace-scoped `dispatchNow(session)` overload, which enqueues
 * an immediate `bot.dispatch` job; and secrets are sealed with
 * `sealMeetingSecrets` so the Teams `context` survives for the dispatcher.
 */

let store: MemoryBotSessionStore

beforeEach(async () => {
  vi.stubEnv("MEETSUM_STORAGE", "memory")
  vi.stubEnv("MEETSUM_BOT_ENABLED", "true")
  vi.stubEnv("MEETSUM_RATE_LIMIT", "false")
  vi.stubEnv("MEETSUM_SESSION_SECRET", "test-session-secret-0123456789abcdef")
  store = createMemoryBotSessionStore()
  setMemoryBotSessionStore(store)
  setBotMeetingLinkLookup({ meetingLink: async () => undefined, attachCandidates: async () => [] })
  for (const fn of Object.values(queue)) fn.mockClear()
  setRouteCtx(
    await createTestCtx({ role: "member", workspaceId: "ws_a", database: createInMemoryMeetingDatabase([]) })
  )
})

afterEach(() => {
  setMemoryBotSessionStore(undefined)
  setBotMeetingLinkLookup(undefined)
  setRouteCtx(undefined)
  vi.unstubAllEnvs()
})

function join(payload: unknown) {
  return joinNow(jsonRequest("http://localhost/api/meetings/bot", "POST", payload), routeParams({}))
}

describe("Join now dispatch", () => {
  it("enqueues an immediate bot.dispatch job for the new session's workspace", async () => {
    const response = await join({ meetingUrl: "https://meet.google.com/abc-defg-hij" })

    expect(response.status).toBe(201)

    const [session] = [...store.sessions.values()]

    expect(session).toMatchObject({ workspaceId: "ws_a", dispatchRev: 1 })
    expect(queue.enqueue).toHaveBeenCalledTimes(1)
    expect(queue.enqueue).toHaveBeenCalledWith(
      "bot.dispatch",
      { sessionId: session.id, rev: 1, workspaceId: "ws_a" },
      expect.objectContaining({ jobId: `bot.dispatch:${session.id}:1`, delay: 0 })
    )
  })

  it("seals the Teams context (not just a passcode) so the dispatcher can rebuild the URL", async () => {
    const url =
      "https://teams.microsoft.com/l/meetup-join/19%3ameeting_NjY4YzEzMzQtZjBkZS00OTk1LWE4ZjAtMTIzNDU2Nzg5MDEy%40thread.v2/0?context=%7b%22Tid%22%3a%22tenant-1%22%7d"
    const response = await join({ meetingUrl: url })

    expect(response.status).toBe(201)
    expect(await response.text()).not.toContain("tenant-1")

    const [session] = [...store.sessions.values()]

    expect(session.passcodeEnc).toBeTruthy()
    expect(session.passcodeEnc).not.toContain("tenant-1")
    expect(openMeetingSecrets(session.passcodeEnc).teamsContext).toContain("tenant-1")
  })
})
