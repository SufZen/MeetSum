import { describe, expect, it } from "vitest"

import {
  handlers,
  handlersOf,
  HTTP_METHODS,
  PUBLIC_ALLOWLIST,
  routes,
  WRAPPERS,
} from "./helpers/api-routes"

/**
 * M2 Integration guard (docs/parity/m2.md, "Integration step"): every API
 * route handler is wrapped by an authz wrapper, the public surface is exactly
 * the documented allowlist, routes never reach around the scoped repository,
 * and every audit entry written by a route names its workspace.
 */

/** Signed webhooks resolve their workspace themselves (system scope). */
const SYSTEM_REPOSITORY_ROUTES = new Set(["webhooks/zoom", "webhooks/teams"])

/** Text of each `name(...)` call's arguments (balanced parentheses). */
function callArguments(source: string, name: string): string[] {
  const calls: string[] = []
  let index = source.indexOf(`${name}(`)

  while (index !== -1) {
    const start = index + name.length + 1
    let depth = 1
    let cursor = start

    while (cursor < source.length && depth > 0) {
      const char = source[cursor]

      if (char === "(") depth += 1
      else if (char === ")") depth -= 1
      cursor += 1
    }

    calls.push(source.slice(start, cursor - 1))
    index = source.indexOf(`${name}(`, cursor)
  }

  return calls
}

describe("API route authz coverage", () => {
  it("finds the API routes", () => {
    expect(routes.length).toBeGreaterThan(50)
    expect(handlers.length).toBeGreaterThanOrEqual(routes.length)
  })

  it("exports at least one handler from every route file", () => {
    const empty = routes
      .filter((route) => handlersOf(route).length === 0)
      .map((route) => route.route)

    expect(empty).toEqual([])
  })

  it("never re-exports handlers (they would bypass the wrapper check)", () => {
    const reexports = routes
      .filter((route) =>
        new RegExp(`export\\s*\\{[^}]*\\b(${HTTP_METHODS.join("|")})\\b`).test(
          route.source
        )
      )
      .map((route) => route.route)

    expect(reexports).toEqual([])
  })

  it("wraps every handler in withAuthz / withSession / withPublicRoute", () => {
    const unwrapped = handlers
      .filter(
        (handler) =>
          !WRAPPERS.includes(handler.wrapper as (typeof WRAPPERS)[number])
      )
      .map((handler) => `${handler.route} ${handler.method}`)

    expect(unwrapped).toEqual([])
  })

  it("exposes exactly the documented public routes", () => {
    const publicHandlers = handlers
      .filter((handler) => handler.wrapper === "withPublicRoute")
      .map((handler) => `${handler.route} ${handler.method}`)
      .sort()

    expect(publicHandlers).toEqual(PUBLIC_ALLOWLIST)
  })

  it("never reaches around the scoped repository", () => {
    const offenders = routes.flatMap((route) => {
      const found: string[] = []

      if (/\bgetDatabasePool\b|@\/lib\/db\/client/.test(route.source)) {
        found.push(`${route.route}: database pool`)
      }
      if (/\bmeetingRepository\b|\bgetMeetingRepository\b/.test(route.source)) {
        found.push(`${route.route}: deprecated meetingRepository`)
      }
      if (
        /\bgetSystemMeetingRepository\b/.test(route.source) &&
        !SYSTEM_REPOSITORY_ROUTES.has(route.route)
      ) {
        found.push(`${route.route}: system repository`)
      }

      return found
    })

    expect(offenders).toEqual([])
  })

  it("guards sensitive routes with the documented permission", () => {
    /** `<route> <METHOD>` -> permission passed to `withAuthz`. */
    const REQUIRED: Record<string, string> = {
      // Live conference records of the subject mailbox (security review M2).
      "google/meet/artifacts GET": "integrations:manage",
      // Writes meeting content to an external workspace; the route also
      // checks `integrations:manage` in its body.
      "meetings/[id]/export/notion POST": "meeting:write",
      "storage/media-assets GET": "storage:manage",
      "storage/media-assets/[id] DELETE": "storage:manage",
      "webhooks/test POST": "webhooks:manage",
      // M3 speaker mapping and ASR configuration.
      "meetings/[id]/speakers GET": "meeting:read",
      "meetings/[id]/speakers POST": "meeting:write",
      "meetings/[id]/speakers/assign POST": "meeting:write",
      "meetings/[id]/speakers/[speakerId] PATCH": "meeting:write",
      "meetings/[id]/speakers/suggest POST": "meeting:write",
      "meetings/[id]/speakers/merge POST": "meeting:write",
      "asr/glossary GET": "workspace:read",
      "asr/glossary PUT": "settings:write",
      "asr/status GET": "ops:read",
    }
    const permissionPattern = (method: string) =>
      new RegExp(
        `export\\s+const\\s+${method}\\s*=\\s*withAuthz(?:<[^>]*>)?\\(\\s*"([^"]+)"`
      )
    const actual = Object.fromEntries(
      Object.keys(REQUIRED).map((key) => {
        const [route, method] = key.split(" ")
        const file = routes.find((candidate) => candidate.route === route)

        return [key, file?.source.match(permissionPattern(method))?.[1]]
      })
    )

    expect(actual).toEqual(REQUIRED)
    const notion = routes.find((route) => route.route === "meetings/[id]/export/notion")
    expect(notion?.source).toMatch(/can\(ctx\.role, "integrations:manage"\)/)
    expect(notion?.source).not.toMatch(/process\.env\.NOTION_TOKEN/)
  })

  it("passes a workspace to every recordAuditLog call", () => {
    const missing = routes.flatMap((route) =>
      callArguments(route.source, "recordAuditLog")
        .filter(
          (args) =>
            !/\bworkspaceId\b|\.\.\.ctx\.audit\b|\.\.\.auditActor\(/.test(args)
        )
        .map((args) => `${route.route}: ${args.replace(/\s+/g, " ").slice(0, 80)}`)
    )

    expect(missing).toEqual([])
  })
})
