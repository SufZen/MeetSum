/**
 * M10 B1: request and job ids reach every line through withLogContext
 * (AsyncLocalStorage), across awaits, nested contexts and child loggers.
 */
import { afterEach, describe, expect, it } from "vitest"

import { getLogger, logger, withLogContext } from "@/lib/log"
import packageJson from "@/package.json"
import { captureLogs, restoreLogs } from "@/tests/helpers/capture-logs"

afterEach(() => restoreLogs())

describe("log context", () => {
  it("adds the context to lines logged inside, across awaits", async () => {
    const logs = captureLogs()

    await withLogContext({ reqId: "req-abcdef12", route: "meetings/[id]", method: "GET", principal: "session" }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1))
      getLogger({ component: "test" }).info("inside")
    })
    logger.info("outside")

    expect(logs[0]).toMatchObject({
      msg: "inside",
      reqId: "req-abcdef12",
      route: "meetings/[id]",
      method: "GET",
      principal: "session",
      component: "test",
      version: packageJson.version,
    })
    expect(logs[1].reqId).toBeUndefined()
  })

  it("nests contexts (job inside a request) and isolates concurrent ones", async () => {
    const logs = captureLogs()

    await Promise.all([
      withLogContext({ jobId: "1", queue: "meetsum" }, async () => {
        await withLogContext({ jobName: "summary.generate", workspaceId: "ws_1" }, async () => {
          await new Promise((resolve) => setTimeout(resolve, 2))
          logger.info("job a")
        })
      }),
      withLogContext({ jobId: "2", queue: "meetsum-bot" }, async () => logger.info("job b")),
    ])

    const a = logs.find((line) => line.msg === "job a")!
    const b = logs.find((line) => line.msg === "job b")!

    expect(a).toMatchObject({ jobId: "1", queue: "meetsum", jobName: "summary.generate", workspaceId: "ws_1" })
    expect(b).toMatchObject({ jobId: "2", queue: "meetsum-bot" })
    expect(b.jobName).toBeUndefined()
  })

  it("writes one JSON object per line with level, time, service and version", () => {
    const logs = captureLogs()

    logger.warn("shape")
    expect(logs[0]).toMatchObject({ level: "warn", msg: "shape", version: packageJson.version })
    expect(["app", "worker", "migrate"]).toContain(logs[0].service)
    expect(typeof logs[0].time).toBe("string")
  })
})
