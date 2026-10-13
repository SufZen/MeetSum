/**
 * Slack routes for the dev/e2e fake provider server (docs/parity/m8.md,
 * "Fake mode"). Owner: Package A. Keys are `"<METHOD> /<host><path>"`, the
 * shape `rewriteForFakeMode` produces. Fake tokens only; the authorize page
 * auto-approves.
 */
import type { FakeProviderHandlers, FakeProviderRequest } from "@/lib/integrations/core/types"

const CHANNELS = Array.from({ length: 450 }, (_, index) => ({
  id: `C${String(index + 1).padStart(6, "0")}`,
  name: index === 0 ? "general" : index === 1 ? "meetings" : `channel-${index + 1}`,
  is_private: false,
  is_member: index < 2,
  is_archived: false,
}))

function authorized(request: FakeProviderRequest): boolean {
  return /^Bearer fake-slack-/.test(request.headers.authorization ?? "")
}

function field(request: FakeProviderRequest, name: string): string | undefined {
  const body = (request.body ?? {}) as Record<string, unknown>
  const value = body[name] ?? request.query[name]

  return value === undefined || value === null ? undefined : String(value)
}

export function createSlackFakeHandlers(): FakeProviderHandlers {
  let counter = 0
  const messages = new Map<string, { channel: string; text: string; metadata?: unknown }>()
  const unauthorized = { status: 200, body: { ok: false, error: "invalid_auth" } }

  return {
    "GET /slack.com/oauth/v2/authorize": (request) => {
      const target = new URL(request.query.redirect_uri ?? "http://127.0.0.1/")

      target.searchParams.set("code", "fake-slack-code")
      target.searchParams.set("state", request.query.state ?? "")
      return { redirect: target.toString() }
    },
    "POST /slack.com/api/oauth.v2.access": (request) => {
      const grant = field(request, "grant_type")

      if (grant === "refresh_token") {
        return { body: { ok: true, access_token: `fake-slack-bot-${Date.now()}`, refresh_token: "fake-slack-refresh", expires_in: 43_200, scope: "chat:write,chat:write.public,channels:read,channels:history" } }
      }
      if (field(request, "code") !== "fake-slack-code") return { body: { ok: false, error: "invalid_code" } }
      return {
        body: {
          ok: true,
          access_token: "fake-slack-bot-token",
          token_type: "bot",
          scope: "chat:write,chat:write.public,channels:read",
          bot_user_id: "UFAKEBOT",
          team: { id: "TFAKE001", name: "MeetSum Test Workspace" },
          enterprise: null,
        },
      }
    },
    "POST /slack.com/api/auth.test": (request) =>
      authorized(request) ? { body: { ok: true, team_id: "TFAKE001", user_id: "UFAKEBOT" } } : unauthorized,
    "POST /slack.com/api/auth.revoke": () => ({ body: { ok: true, revoked: true } }),
    "POST /slack.com/api/conversations.list": (request) => {
      if (!authorized(request)) return unauthorized

      const start = Number(field(request, "cursor")?.replace("page-", "") ?? 0) || 0
      const limit = Math.min(Number(field(request, "limit") ?? 200) || 200, 200)
      const page = CHANNELS.slice(start, start + limit)
      const next = start + limit < CHANNELS.length ? `page-${start + limit}` : ""

      return { body: { ok: true, channels: page, response_metadata: { next_cursor: next } } }
    },
    "POST /slack.com/api/conversations.info": (request) => {
      const channel = CHANNELS.find((candidate) => candidate.id === field(request, "channel"))

      return channel ? { body: { ok: true, channel } } : { body: { ok: false, error: "channel_not_found" } }
    },
    "POST /slack.com/api/chat.postMessage": (request) => {
      if (!authorized(request)) return unauthorized

      const channel = field(request, "channel") ?? ""

      if (!CHANNELS.some((candidate) => candidate.id === channel)) return { body: { ok: false, error: "channel_not_found" } }

      counter += 1
      const ts = `1700000000.${String(counter).padStart(6, "0")}`

      messages.set(ts, { channel, text: field(request, "text") ?? "", metadata: (request.body as { metadata?: unknown } | undefined)?.metadata })
      return { body: { ok: true, channel, ts } }
    },
    "POST /slack.com/api/chat.update": (request) => {
      if (!authorized(request)) return unauthorized

      const ts = field(request, "ts") ?? ""

      if (!messages.has(ts)) return { body: { ok: false, error: "message_not_found" } }
      return { body: { ok: true, channel: field(request, "channel"), ts } }
    },
    "POST /slack.com/api/conversations.history": (request) => {
      if (!authorized(request)) return unauthorized

      const channel = field(request, "channel")
      const withMetadata = field(request, "include_all_metadata") === "true"
      const found = [...messages.entries()]
        .filter(([, message]) => message.channel === channel)
        .reverse()
        .map(([ts, message]) => ({ type: "message", ts, ...(withMetadata && message.metadata ? { metadata: message.metadata } : {}) }))

      return { body: { ok: true, messages: found, has_more: false } }
    },
    "POST /slack.com/api/chat.getPermalink": (request) => ({
      body: {
        ok: true,
        permalink: `https://meetsum-test.slack.com/archives/${field(request, "channel")}/p${(field(request, "message_ts") ?? "").replace(".", "")}`,
      },
    }),
  }
}

export const slackFakeHandlers: FakeProviderHandlers = createSlackFakeHandlers()
