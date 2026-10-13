import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

/**
 * Discovery of the `route.ts` handlers under app/api shared by the M2 authz
 * integration tests (route coverage + unauthenticated access).
 */

export const API_ROOT = path.resolve(__dirname, "..", "..", "app", "api")
export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]
export const WRAPPERS = ["withAuthz", "withSession", "withPublicRoute"] as const

/** `<route path> <METHOD>` pairs that may be called without credentials. */
export const PUBLIC_ALLOWLIST = [
  "auth/google/start GET",
  "auth/google/callback GET",
  "auth/logout GET",
  "auth/logout POST",
  "user/locale POST",
  "invitations/[token] GET",
  "health GET",
  "locales GET",
  "share/[token]/verify GET",
  "share/[token]/verify POST",
  // M4: shared recording + peaks, gated by share/section/password (404).
  "share/[token]/media GET",
  "share/[token]/media HEAD",
  "share/[token]/media/peaks GET",
  "webhooks/zoom POST",
  "webhooks/teams POST",
  "webhooks/teams/lifecycle POST",
  // M7: Vexa bot webhook, HMAC-signed; workspace resolved from bot_sessions.
  "integrations/vexa/webhook POST",
  // M8: email recap unsubscribe, signed token; GET never mutates.
  "email/unsubscribe GET",
  "email/unsubscribe POST",
].sort()

export type RouteFile = { route: string; file: string; source: string }

function findRouteFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)

    if (entry.isDirectory()) return findRouteFiles(full)

    return entry.name === "route.ts" ? [full] : []
  })
}

export const routes: RouteFile[] = findRouteFiles(API_ROOT)
  .map((file) => ({
    route: path.relative(API_ROOT, path.dirname(file)).split(path.sep).join("/"),
    file,
    source: readFileSync(file, "utf8"),
  }))
  .sort((a, b) => a.route.localeCompare(b.route))

export type Handler = { route: string; method: string; wrapper: string | undefined }

const handlerPattern = new RegExp(
  `export\\s+(?:const\\s+(${HTTP_METHODS.join("|")})\\b\\s*(?::[^=]+)?=\\s*([A-Za-z_$][\\w$]*)?|(?:async\\s+)?function\\s+(${HTTP_METHODS.join("|")})\\b)`,
  "g"
)

export function handlersOf(route: RouteFile): Handler[] {
  return [...route.source.matchAll(handlerPattern)].map((match) => ({
    route: route.route,
    method: match[1] ?? match[3],
    // `export async function GET` has no wrapper by construction.
    wrapper: match[1] ? match[2] : undefined,
  }))
}

export const handlers = routes.flatMap(handlersOf)

export function isPublicHandler(handler: Pick<Handler, "route" | "method">) {
  return PUBLIC_ALLOWLIST.includes(`${handler.route} ${handler.method}`)
}

/** Dummy dynamic params for a route path (`[id]` -> `{ id: "dummy_id" }`). */
export function dummyParams(route: string): Record<string, string> {
  return Object.fromEntries(
    [...route.matchAll(/\[([^\]]+)\]/g)].map(([, name]) => [name, `dummy_${name}`])
  )
}
