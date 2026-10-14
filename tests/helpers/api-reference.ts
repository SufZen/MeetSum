/**
 * Route inventory for docs/api-reference.md (M10 D3). Shared by
 * `npm run api:reference` and tests/api-reference-complete.test.ts; built on
 * the route discovery in ./api-routes (the route-coverage source of truth).
 */
import { ROLE_PERMISSIONS, type Permission } from "@/lib/auth/authz"

import { handlersOf, isPublicHandler, routes, type RouteFile } from "./api-routes"

export type RouteGuard =
  | { kind: "public"; reason?: string }
  | { kind: "session" }
  | { kind: "permission"; permission: string; minRole: string; apiKeyScope: string }
  | { kind: "unknown" }

export type RouteEntry = {
  /** app/api relative route, e.g. `meetings/[id]/share`. */
  route: string
  /** Documented path, e.g. `/api/meetings/:id/share`. */
  path: string
  methods: { method: string; guard: RouteGuard }[]
}

const ROLE_ORDER = ["viewer", "member", "admin", "owner"] as const
const SCOPE_FOR_ROLE: Record<string, string> = { viewer: "read", member: "write", admin: "admin", owner: "none (owner only)" }

export function apiPath(route: string): string {
  return `/api/${route.replace(/\[\.\.\.([^\]]+)\]/g, ":$1*").replace(/\[([^\]]+)\]/g, ":$1")}`
}

function minRole(permission: string): string | undefined {
  return ROLE_ORDER.find((role) => ROLE_PERMISSIONS[role].includes(permission as Permission))
}

/** Guard of one exported handler, read from its wrapper call in the source. */
export function guardOf(route: RouteFile, method: string, wrapper: string | undefined): RouteGuard {
  const start = route.source.search(new RegExp(`export\\s+(?:const|async\\s+function|function)\\s+${method}\\b`))
  const tail = start >= 0 ? route.source.slice(start, start + 600) : ""

  if (wrapper === "withPublicRoute" || isPublicHandler({ route: route.route, method })) {
    const reason = tail.match(/withPublicRoute(?:<[^>]*>)?\(\s*["'`]([^"'`]+)["'`]/)?.[1]

    return { kind: "public", ...(reason ? { reason } : {}) }
  }
  if (wrapper === "withSession") return { kind: "session" }
  if (wrapper === "withAuthz") {
    const permission = tail.match(/withAuthz(?:<[^>]*>)?\(\s*["'`]([^"'`]+)["'`]/)?.[1]
    const role = permission ? minRole(permission) : undefined

    if (permission && role) return { kind: "permission", permission, minRole: role, apiKeyScope: SCOPE_FOR_ROLE[role] }
  }

  return { kind: "unknown" }
}

export function routeInventory(): RouteEntry[] {
  return routes
    .map((route) => ({
      route: route.route,
      path: apiPath(route.route),
      methods: handlersOf(route).map((handler) => ({ method: handler.method, guard: guardOf(route, handler.method, handler.wrapper) })),
    }))
    .filter((entry) => entry.methods.length > 0)
}

export function describeGuard(guard: RouteGuard): { guard: string; apiKey: string } {
  switch (guard.kind) {
    case "public":
      return { guard: "public", apiKey: "not needed" }
    case "session":
      return { guard: "signed-in user (cookie session)", apiKey: "refused" }
    case "permission":
      return { guard: `\`${guard.permission}\` (${guard.minRole}+)`, apiKey: guard.apiKeyScope === "none (owner only)" ? "refused (owner only)" : `\`${guard.apiKeyScope}\`` }
    default:
      return { guard: "see route", apiKey: "see route" }
  }
}

export const INDEX_BEGIN = "<!-- BEGIN GENERATED ROUTE INDEX (npm run api:reference) -->"
export const INDEX_END = "<!-- END GENERATED ROUTE INDEX -->"

/**
 * Handlers that require `canManageMeeting` (the meeting owner, or admin and
 * above; an API key needs `admin`) on top of their wrapper guard, on every
 * call. Conditional checks (private meetings only, or one field) stay in the
 * prose sections. tests/api-reference-complete.test.ts keeps this list in
 * sync with the handlers.
 */
export const HANDLER_MANAGE_CHECKS: readonly string[] = [
  "DELETE /api/meetings/:id",
  "PATCH /api/meetings/:id/visibility",
  "POST /api/meetings/:id/share",
  "PATCH /api/meetings/:id/share",
  "POST /api/clips/:id/share",
]

/** The generated route-index table (one row per method). */
export function renderRouteIndex(entries: RouteEntry[] = routeInventory()): string {
  const rows = entries.flatMap((entry) =>
    entry.methods.map(({ method, guard }) => {
      const described = describeGuard(guard)
      const manage = HANDLER_MANAGE_CHECKS.includes(`${method} ${entry.path}`) ? " + `canManageMeeting` in the handler" : ""

      return `| \`${method}\` | \`${entry.path}\` | ${described.guard}${manage} | ${described.apiKey} |`
    })
  )
  const handlerCount = rows.length

  return [
    INDEX_BEGIN,
    "",
    `${entries.length} route files, ${handlerCount} handlers. Guard = the permission each handler checks (minimum workspace role); API key = the scope a Bearer key needs (\`read\` = viewer, \`write\` = member, \`admin\` = admin). Session-only routes refuse API keys. "+ \`canManageMeeting\` in the handler" means the handler also requires the meeting owner or an admin+ role (a key needs \`admin\`), else 403.`,
    "",
    "| Method | Path | Guard | API key |",
    "|---|---|---|---|",
    ...rows,
    "",
    INDEX_END,
  ].join("\n")
}

/** Replaces the generated block in the document (or appends it). */
export function withRouteIndex(doc: string, index: string = renderRouteIndex()): string {
  const begin = doc.indexOf(INDEX_BEGIN)
  const end = doc.indexOf(INDEX_END)

  if (begin === -1 || end === -1) return `${doc.trimEnd()}\n\n${index}\n`

  return `${doc.slice(0, begin)}${index}${doc.slice(end + INDEX_END.length)}`
}

/** `### ` headings that document a path, e.g. "### `GET, POST /api/meetings/:id/comments`". */
export function documentedHeadings(doc: string): { methods: string[]; path: string }[] {
  return [...doc.matchAll(/^###\s+`([A-Z, |]+)\s+(\/api\/[^`\s]*)`/gm)].map((match) => ({
    methods: match[1].split(/[,|]/).map((method) => method.trim()).filter(Boolean),
    path: match[2],
  }))
}

/** Handlers ("METHOD /api/path") with no `###` section in the document. */
export function undocumentedHandlers(doc: string, entries: RouteEntry[] = routeInventory()): string[] {
  const headings = documentedHeadings(doc)

  return entries.flatMap((entry) =>
    entry.methods
      .filter(({ method }) => !headings.some((heading) => heading.path === entry.path && heading.methods.includes(method)))
      .map(({ method }) => `${method} ${entry.path}`)
  )
}
