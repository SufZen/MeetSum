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
      // M4 media proxy (viewers can play).
      "meetings/[id]/media GET": "meeting:read",
      "meetings/[id]/media HEAD": "meeting:read",
      "meetings/[id]/media/peaks GET": "meeting:read",
      // M4 meeting detail / rename / delete (delete also checks canManageMeeting).
      "meetings/[id] GET": "meeting:read",
      "meetings/[id] PATCH": "meeting:write",
      "meetings/[id] DELETE": "meeting:read",
      // M4 transcript read, edit, undo, revisions.
      "meetings/[id]/transcript GET": "meeting:read",
      "meetings/[id]/transcript/segments/[segmentId] PATCH": "meeting:write",
      "meetings/[id]/transcript/segments/[segmentId]/undo POST": "meeting:write",
      "meetings/[id]/transcript/segments/[segmentId]/revisions GET": "meeting:read",
      // M7 meeting bot.
      "meetings/bot POST": "meeting:create",
      "meetings/[id]/bot GET": "meeting:read",
      "meetings/[id]/bot POST": "meeting:write",
      "meetings/[id]/bot DELETE": "meeting:write",
      "meetings/[id]/bot/live GET": "meeting:read",
      "bot/sessions GET": "meeting:read",
      "bot/status GET": "ops:read",
      "settings/bot GET": "workspace:read",
      "settings/bot PUT": "settings:write",
      // M5 C clips (rename/delete/share also check author / canManageMeeting).
      "meetings/[id]/clips GET": "meeting:read",
      "meetings/[id]/clips POST": "meeting:write",
      "clips/[id] GET": "meeting:read",
      "clips/[id] PATCH": "meeting:write",
      "clips/[id] DELETE": "meeting:write",
      "clips/[id]/share POST": "meeting:read",
      // M5 C comments and reactions (viewers and up; user principals only).
      "meetings/[id]/comments GET": "meeting:read",
      "meetings/[id]/comments POST": "comments:write",
      "comments/[id] PATCH": "comments:write",
      "comments/[id] DELETE": "comments:write",
      "reactions POST": "comments:write",
      // M5 action items and the cross-meeting Tasks view.
      "action-items/[id] PATCH": "meeting:write",
      "action-items/[id] DELETE": "meeting:write",
      "meetings/[id]/action-items GET": "meeting:read",
      "meetings/[id]/action-items POST": "meeting:write",
      "tasks GET": "meeting:read",
      "tasks/bulk POST": "meeting:write",
      // M5 Package D: analytics, prep, follow-up, templates, intelligence runs.
      "meetings/[id]/analytics GET": "meeting:read",
      "meetings/[id]/analytics/sentiment POST": "meeting:write",
      "meetings/[id]/prep GET": "meeting:read",
      "meetings/[id]/prep POST": "meeting:read",
      "meetings/[id]/follow-up GET": "meeting:read",
      "meetings/[id]/follow-up POST": "meeting:read",
      "meetings/[id]/template PATCH": "meeting:write",
      "meetings/[id]/intelligence GET": "meeting:read",
      "meetings/[id]/intelligence/run POST": "meeting:write",
      "templates GET": "workspace:read",
      "templates POST": "settings:write",
      "templates/[id] GET": "workspace:read",
      "templates/[id] PATCH": "settings:write",
      "templates/[id] DELETE": "settings:write",
      // M6 search
      "search GET": "meeting:read",
      "search/facets GET": "meeting:read",
      "meetings/search GET": "meeting:read",
      "memory/search GET": "meeting:read",
      // M6 ask (threads also require a user principal)
      "ask POST": "meeting:read",
      "ask/threads GET": "meeting:read",
      "ask/threads POST": "meeting:read",
      "ask/threads/[id] GET": "meeting:read",
      "ask/threads/[id] PATCH": "meeting:read",
      "ask/threads/[id] DELETE": "meeting:read",
      "ask/messages/[id]/feedback POST": "meeting:read",
      "meetings/[id]/ask POST": "meeting:read",
      "rooms/[id]/ask POST": "meeting:read", // was workspace:read
      "memory/ask POST": "meeting:read",
      // M6 admin
      "admin/search/status GET": "ops:read",
      "admin/search/reindex POST": "settings:write",
      // M8 integrations
      "integrations/providers GET": "workspace:read",
      "integrations/[provider]/oauth/start GET": "integrations:connect",
      "integrations/connections GET": "integrations:connect",
      "integrations/connections/[id] PATCH": "integrations:connect",
      "integrations/connections/[id] DELETE": "integrations:connect",
      "integrations/connections/[id]/test POST": "integrations:connect",
      "integrations/connections/[id]/options/[picker] GET": "meeting:write",
      "integrations/rules GET": "integrations:manage",
      "integrations/rules POST": "integrations:manage",
      "integrations/rules/[id] PATCH": "integrations:manage",
      "integrations/rules/[id] DELETE": "integrations:manage",
      "integrations/deliveries GET": "integrations:manage",
      "integrations/deliveries/[id] GET": "meeting:write",
      "integrations/deliveries/[id]/retry POST": "integrations:manage",
      "meetings/[id]/integrations/send POST": "meeting:write",
      "meetings/[id]/integration-prefs GET": "meeting:read",
      "meetings/[id]/integration-prefs PUT": "meeting:write",
      // The Notion token comes only from the workspace connection (no admin check).
      "meetings/[id]/export/notion POST": "meeting:write",
      "meetings/[id]/export/google-docs POST": "meeting:read",
      "meetings/[id]/export/docx POST": "meeting:read",
      "webhooks/catalog GET": "webhooks:manage",
      // M9 (docs/parity/m9.md, "Route → permission map"); user principal checked in the handler.
      "notifications GET": "workspace:read",
      "notifications/unread-count GET": "workspace:read",
      "notifications/read POST": "workspace:read",
      "analytics/overview GET": "meeting:read",
      "onboarding GET": "workspace:read",
      "onboarding POST": "workspace:read",
      // M4 guard (+ canManageMeeting in the handler). The M9 map says meeting:write for the
      // password PATCH; Package B flips the route and this row together (orchestrator-approved).
      "meetings/[id]/share PATCH": "meeting:read",
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
    // DELETE needs owner/admin on top of meeting:read.
    const detail = routes.find((route) => route.route === "meetings/[id]")
    expect(detail?.source).toMatch(/canManageMeeting\(ctx, meeting\)[\s\S]*permission: "meeting:manage"/)
  })

  it("gates the public share media routes and never presigns media (M4)", () => {
    for (const route of ["share/[token]/media", "share/[token]/media/peaks"]) {
      const source = routes.find((candidate) => candidate.route === route)?.source ?? ""

      expect(source, route).toMatch(/authorizeShareMediaRequest\(request, token\)/)
    }
    for (const route of [
      "meetings/[id]/media",
      "meetings/[id]/media/peaks",
      "share/[token]/media",
      "share/[token]/media/peaks",
    ]) {
      const source = routes.find((candidate) => candidate.route === route)?.source

      expect(source, route).toBeDefined()
      expect(source).not.toMatch(/Presigned|S3_PUBLIC_ENDPOINT|getSignedUrl/)
      expect(source).toMatch(/export const runtime = "nodejs"/)
      expect(source).toMatch(/export const dynamic = "force-dynamic"/)
    }
  })

  it("keeps the Vexa webhook public only behind its signature (M7)", () => {
    const webhook = routes.find((route) => route.route === "integrations/vexa/webhook")?.source

    expect(webhook).toMatch(
      /withPublicRoute\(\s*"Vexa webhook: HMAC-SHA256 signed with VEXA_WEBHOOK_SECRET"/
    )
    expect(webhook).toMatch(/export const runtime = "nodejs"/)
    expect(webhook).toMatch(/processVexaWebhook\(/)
    // The workspace never comes from the request.
    expect(webhook).not.toMatch(/workspaceId|getSystemMeetingRepository|getCaptureWorkspaceId/)

    for (const route of routes.filter(
      (candidate) => /(^|\/)bot(\/|$)/.test(candidate.route) || candidate.route === "settings/bot"
    )) {
      expect(route.source, route.route).not.toMatch(/withPublicRoute/)
    }
  })

  it("lets only user principals comment or react, and never audits comment text (M5)", () => {
    for (const route of ["meetings/[id]/comments", "comments/[id]", "reactions"]) {
      const source = routes.find((candidate) => candidate.route === route)?.source ?? ""

      expect(source, route).toMatch(/commentStoreContext\(ctx\)/)
      expect(source, route).toMatch(/if \(!store\) return userRequired\(\)/)
      for (const args of callArguments(source, "recordAuditLog")) {
        expect(args, route).not.toMatch(/comment\.body|body\.body|\bbody\s*[:,}]/)
      }
    }
  })

  it("serves clip shares through the media proxy, clip lookup first (M5)", () => {
    const source = routes.find((candidate) => candidate.route === "share/[token]/media")?.source ?? ""

    expect(source.indexOf("lookupClipShare(token)")).toBeGreaterThan(-1)
    expect(source.indexOf("lookupClipShare(token)")).toBeLessThan(
      source.indexOf("authorizeShareMediaRequest(request, token)")
    )
    expect(source).toMatch(/serveClipMedia\(/)
  })

  describe("M6 search and ask routes", () => {
    const source = (route: string) => routes.find((candidate) => candidate.route === route)?.source
    const ASK_ROUTES = ["ask", "ask/threads", "ask/threads/[id]", "ask/messages/[id]/feedback"]
    const THREAD_ROUTES = ["ask/threads", "ask/threads/[id]", "ask/messages/[id]/feedback"]
    const M6_ROUTES = [
      "search",
      "search/facets",
      ...ASK_ROUTES,
      "admin/search/status",
      "admin/search/reindex",
      "meetings/search",
      "memory/search",
      "meetings/[id]/ask",
      "rooms/[id]/ask",
      "memory/ask",
    ]

    it("runs the ask routes on node and never caches them", () => {
      for (const route of ASK_ROUTES) {
        const text = source(route)

        expect(text, route).toBeDefined()
        expect(text, route).toMatch(/export const runtime = "nodejs"/)
        expect(text, route).toMatch(/export const dynamic = "force-dynamic"/)
      }
    })

    it("serves threads to user principals only", () => {
      for (const route of THREAD_ROUTES) {
        const text = source(route) ?? ""
        const handlerCount = handlersOf(routes.find((candidate) => candidate.route === route)!).length

        expect(text.match(/createThreadStore\(ctx\)/g)?.length ?? 0, route).toBe(handlerCount)
        expect(text.match(/if \(!store\) return userRequired\(\)/g)?.length ?? 0, route).toBe(handlerCount)
      }
    })

    it("rate-limits search and ask with their presets", () => {
      // Search routes may pass a per-principal limiter key as the third argument.
      for (const route of ["search", "search/facets", "meetings/search", "memory/search"]) {
        expect(source(route), route).toMatch(/rateLimitRequest\(request, RATE_LIMIT_PRESETS\.search[,)]/)
      }
      expect(source("ask")).toMatch(/rateLimitRequest\(request, RATE_LIMIT_PRESETS\.ask[,)]/)
    })

    it("rate-limits meetings/[id]/ask, rooms/[id]/ask and memory/ask with RATE_LIMIT_PRESETS.ask", () => {
      for (const route of ["meetings/[id]/ask", "rooms/[id]/ask", "memory/ask"]) {
        const text = source(route)

        expect(text, route).toBeDefined()
        expect(text, route).toMatch(/rateLimitRequest\(request, RATE_LIMIT_PRESETS\.ask[,)]/)
        expect(text, route).not.toMatch(/RATE_LIMIT_PRESETS\.(search|ai|default)/)
      }
    })

    it("never audits question or answer text", () => {
      for (const route of M6_ROUTES) {
        for (const args of callArguments(source(route) ?? "", "recordAuditLog")) {
          expect(args, route).not.toMatch(/\b(question|q|content|body)\b/)
        }
      }
    })

    it("keeps search and ask routes off the database pool and the system repository", () => {
      for (const route of routes.filter((candidate) => /^(search|ask)(\/|$)/.test(candidate.route))) {
        expect(route.source, route.route).not.toMatch(/@\/lib\/db\/client|\bgetSystemMeetingRepository\b/)
        expect(SYSTEM_REPOSITORY_ROUTES.has(route.route), route.route).toBe(false)
      }
    })
  })

  describe("M9 routes", () => {
    const source = (route: string) => routes.find((candidate) => candidate.route === route)?.source ?? ""

    it("guards the per-user routes with withSession (API keys rejected)", () => {
      for (const route of ["me/preferences", "me/invitations", "me/invitations/[id]/accept"]) {
        const found = routes.find((candidate) => candidate.route === route)

        expect(found, route).toBeDefined()
        for (const handler of handlersOf(found!)) expect(handler.wrapper, `${route} ${handler.method}`).toBe("withSession")
      }
    })

    it("refuses API keys on notifications, analytics and onboarding (user principal)", () => {
      for (const route of ["notifications", "notifications/unread-count", "notifications/read", "analytics/overview", "onboarding"]) {
        const found = routes.find((candidate) => candidate.route === route)
        const text = source(route)

        expect(found, route).toBeDefined()
        expect(text.match(/if \(!isUserPrincipal\(ctx\)\) return userRequiredResponse\(\)/g)?.length ?? 0, route).toBe(
          handlersOf(found!).length
        )
      }
    })

    it("keeps the public allowlist unchanged", () => {
      for (const route of ["me/preferences", "me/invitations", "notifications", "analytics/overview", "onboarding"]) {
        expect(source(route), route).not.toMatch(/withPublicRoute/)
      }
    })
  })

  describe("M8 integrations routes", () => {
    const source = (route: string) => routes.find((candidate) => candidate.route === route)?.source
    const M8_ROUTES = routes.filter(
      (route) =>
        (/^integrations\//.test(route.route) && !/^integrations\/(teams|vexa)\//.test(route.route)) ||
        /^meetings\/\[id\]\/(integrations\/send|integration-prefs|export\/(notion|google-docs))$/.test(route.route) ||
        route.route === "email/unsubscribe"
    )

    it("finds the M8 routes", () => {
      expect(M8_ROUTES.length).toBeGreaterThanOrEqual(17)
    })

    it("guards the OAuth callback with withSession (membership re-checked in the handler)", () => {
      const callback = handlersOf(routes.find((route) => route.route === "integrations/[provider]/oauth/callback")!)

      expect(callback).toEqual([{ route: "integrations/[provider]/oauth/callback", method: "GET", wrapper: "withSession" }])
    })

    it("never touches token columns or the token module from a route", () => {
      for (const route of M8_ROUTES) {
        expect(route.source, route.route).not.toMatch(/access_token_enc|refresh_token_enc/)
        expect(route.source, route.route).not.toMatch(/@\/lib\/integrations\/core\/tokens/)
      }
    })

    it("never audits titles, content, addresses, tokens or provider messages", () => {
      for (const route of M8_ROUTES) {
        for (const args of callArguments(route.source, "recordAuditLog")) {
          expect(args, route.route).not.toMatch(/(title|summary|email|token|message|body)/)
        }
      }
    })

    it("takes the Notion token only from the connection (no body token, env token or admin check)", () => {
      const notion = source("meetings/[id]/export/notion")

      expect(notion).toBeDefined()
      expect(notion).not.toMatch(/body\.token/)
      expect(notion).not.toMatch(/process\.env\.NOTION_TOKEN/)
      expect(notion).not.toMatch(/can\(ctx\.role, "integrations:manage"\)/)
    })

    it("never builds an OAuth redirect from the host or x-forwarded-host header", () => {
      for (const route of ["integrations/[provider]/oauth/start", "integrations/[provider]/oauth/callback"]) {
        expect(source(route), route).toBeDefined()
        expect(source(route), route).not.toMatch(/["'](x-forwarded-host|host)["']/i)
      }
    })

    it("verifies the unsubscribe token before anything else (or is still the Step 0 stub)", () => {
      const text = source("email/unsubscribe") ?? ""

      if (/not_implemented/.test(text)) return
      expect(text).toMatch(/verifyUnsubscribeToken\(/)
    })
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
