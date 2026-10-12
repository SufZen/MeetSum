import { describe, expect, it, vi } from "vitest"

import { getGoogleSyncScheduleConfig } from "@/lib/jobs/scheduler-config"
import {
  enqueueWorkspaceGooglePolls,
  enqueueWorkspaceRetention,
  listGoogleSyncWorkspaces,
} from "@/lib/jobs/workspace-schedules"

describe("Google sync scheduler config", () => {
  it("schedules Calendar and Meet metadata polling by default", () => {
    const config = getGoogleSyncScheduleConfig({})

    expect(config.enabled).toBe(true)
    expect(config.calendar).toMatchObject({
      enabled: true,
      minutes: 15,
      payload: { source: "calendar", scheduled: true },
    })
    expect(config.meet).toMatchObject({
      enabled: true,
      minutes: 30,
      payload: { source: "meet", scheduled: true, limit: 10 },
    })
    expect(config.drive.enabled).toBe(false)
  })

  it("allows Meet artifact polling to be disabled independently", () => {
    const config = getGoogleSyncScheduleConfig({
      MEETSUM_SCHEDULE_MEET_SYNC: "false",
      MEETSUM_MEET_POLL_MINUTES: "5",
      MEETSUM_MEET_POLL_LIMIT: "20",
    })

    expect(config.meet).toMatchObject({
      enabled: false,
      minutes: 5,
      payload: { source: "meet", scheduled: true, limit: 20 },
    })
  })
})

describe("per-workspace Google schedules", () => {
  const postgres = { MEETSUM_STORAGE: "postgres" } as unknown as NodeJS.ProcessEnv

  function workspacesDb(rows: Array<{ id: string; google_subject: string | null }>) {
    return {
      query: vi.fn(async (sql: string) => {
        void sql
        return { rows }
      }),
    }
  }

  it("enqueues one poll per live workspace with its own subject and id", async () => {
    const db = workspacesDb([
      { id: "ws_default", google_subject: "owner@default.test" },
      { id: "ws_2", google_subject: "Owner@W2.test" },
      { id: "ws_3", google_subject: null },
    ])
    const enqueue = vi.fn(async () => ({}))

    const queued = await enqueueWorkspaceGooglePolls(
      "google.calendar.poll",
      { source: "calendar", scheduled: true },
      { env: postgres, db, enqueue }
    )

    expect(queued).toBe(2)
    expect(enqueue.mock.calls).toEqual([
      [
        "google.calendar.poll",
        {
          source: "calendar",
          scheduled: true,
          workspaceId: "ws_default",
          subject: "owner@default.test",
        },
      ],
      [
        "google.calendar.poll",
        { source: "calendar", scheduled: true, workspaceId: "ws_2", subject: "owner@w2.test" },
      ],
    ])
    expect(db.query.mock.calls[0][0]).toMatch(/deleted_at is null/)
  })

  it("only lends the env subject to the default workspace", async () => {
    const env = {
      MEETSUM_STORAGE: "postgres",
      GOOGLE_WORKSPACE_SUBJECT: "boot@example.test",
    } as unknown as NodeJS.ProcessEnv
    const db = workspacesDb([
      { id: "ws_default", google_subject: null },
      { id: "ws_2", google_subject: null },
    ])

    await expect(listGoogleSyncWorkspaces({ env, db })).resolves.toEqual([
      { workspaceId: "ws_default", subject: "boot@example.test" },
    ])
  })

  it("keeps polling other workspaces when one enqueue fails", async () => {
    const db = workspacesDb([
      { id: "ws_a", google_subject: "a@a.test" },
      { id: "ws_b", google_subject: "b@b.test" },
    ])
    const enqueue = vi
      .fn()
      .mockRejectedValueOnce(new Error("redis down"))
      .mockResolvedValueOnce({})
    const log = { error: vi.fn(), warn: vi.fn() }

    await expect(
      enqueueWorkspaceGooglePolls("google.meet.poll", {}, { env: postgres, db, enqueue, log })
    ).resolves.toBe(1)
    expect(log.error).toHaveBeenCalledTimes(1)
  })

  it("schedules media.retention per live workspace", async () => {
    const db = workspacesDb([
      { id: "ws_a", google_subject: null },
      { id: "ws_b", google_subject: null },
    ])
    const enqueue = vi.fn(async () => ({}))

    await expect(enqueueWorkspaceRetention({ db, enqueue })).resolves.toBe(2)
    expect(enqueue.mock.calls).toEqual([
      ["media.retention", { workspaceId: "ws_a", scheduled: true }],
      ["media.retention", { workspaceId: "ws_b", scheduled: true }],
    ])
  })
})
