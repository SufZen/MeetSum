import { z } from "zod"

/**
 * MeetSum MCP tools (pure: no env, no transport; mcp/server.mjs wires them).
 *
 * Auth: requests carry `MEETSUM_API_KEY`, a workspace-scoped MeetSum API key
 * (Admin → API keys). Every tool acts on that key's workspace and sees only
 * what the key may see there (workspace/link meetings plus private meetings
 * owned by the key creator). Scopes (admin ⊃ write ⊃ read):
 *   read  — search_meetings, search_transcripts, ask, ask_meeting_memory,
 *           list_meetings, get_meeting, get_meeting_summary,
 *           get_transcript_segments, list_action_items, create_followup_draft
 *   write — send_context_to_realizeos
 *
 * Path ids are always encodeURIComponent-ed; responses are truncated to
 * `maxChars` (MEETSUM_MCP_MAX_CHARS) with `truncated: true`.
 */

export const MCP_SERVER_VERSION = "0.2.0"
export const DEFAULT_MAX_CHARS = 50_000

// M2: API keys are bound to one workspace and carry a scope
// (admin ⊃ write ⊃ read). Map the server's 401/403 to actionable messages.
const READ_PERMISSIONS = ["workspace:read", "meeting:read", "jobs:read"]
const WRITE_PERMISSIONS = ["meeting:write", "meeting:create", "contexts:write", "jobs:write"]

function requiredScope(permission) {
  if (READ_PERMISSIONS.includes(permission)) return "read"
  if (WRITE_PERMISSIONS.includes(permission)) return "write"
  return "admin"
}

/** Error text for an API failure; never echoes server details about other workspaces. */
export function describeApiError(status, body) {
  if (status === 401) {
    return "Unauthorized: set MEETSUM_API_KEY to a key created in MeetSum (Admin → API keys)."
  }

  if (status === 403 && body?.permission) {
    const scope = requiredScope(body.permission)

    return `Forbidden: this API key cannot use "${body.permission}". It needs the "${scope}" scope; create a ${scope} key in Admin → API keys.`
  }

  if (status === 403 && body?.reason === "meeting_manage_required") {
    return "Forbidden: sharing or changing visibility needs an admin-scope key (or the meeting owner)."
  }

  if (status === 403) return "Forbidden for this API key."

  if (status === 404) return "Not found (or not visible to this API key's workspace)."

  if (status === 429) return "Rate limited: try again shortly."

  if (status === 400 && typeof body?.error === "string") return `Bad request: ${body.error}`

  return `Request failed with ${status}`
}

/** `request(path, init)` → parsed JSON; throws with `describeApiError` text. */
export function createRequest({ fetch, appUrl, apiKey }) {
  const base = appUrl.replace(/\/+$/, "")

  return async function request(path, init = {}) {
    const headers = new Headers(init.headers)

    if (apiKey) headers.set("authorization", `Bearer ${apiKey}`)
    if (!headers.has("accept")) headers.set("accept", "application/json")

    const response = await fetch(`${base}${path}`, { ...init, headers })
    const body = await response.json().catch(() => ({}))

    if (!response.ok) throw new Error(describeApiError(response.status, body))

    return body
  }
}

const id = (value) => encodeURIComponent(value)

/** Query string from defined values; arrays repeat the key. */
export function queryString(params) {
  const search = new URLSearchParams()

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue
    for (const item of Array.isArray(value) ? value : [value]) search.append(key, String(item))
  }

  const text = search.toString()

  return text ? `?${text}` : ""
}

/** JSON text content, truncated to `maxChars`. */
export function textResult(value, maxChars = DEFAULT_MAX_CHARS) {
  const text = JSON.stringify(value, null, 2) ?? "null"

  if (text.length <= maxChars) return { content: [{ type: "text", text }] }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ truncated: true, maxChars, partial: text.slice(0, Math.max(0, maxChars - 200)) }),
      },
    ],
  }
}

/** Segment without word timings (compact tool output). */
function segmentText({ words, ...segment }) {
  void words
  return segment
}

const filterShape = {
  from: z.string().optional().describe("ISO date, inclusive"),
  to: z.string().optional().describe("ISO date, inclusive"),
  participant: z.string().optional(),
  room: z.string().optional().describe("Room (context) id"),
  tag: z.string().optional(),
  language: z.enum(["he", "en", "mixed"]).optional(),
  meetingType: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
  cursor: z.string().optional(),
}

function searchParams(group, input) {
  return queryString({
    q: input.query,
    group,
    from: input.from,
    to: input.to,
    participant: input.participant,
    room: input.room,
    tag: input.tag,
    language: input.language,
    type: input.meetingType,
    limit: input.limit === undefined ? undefined : Math.min(input.limit, group === "meeting" ? 25 : 50),
    cursor: input.cursor,
  })
}

export const askInputSchema = z
  .object({
    question: z.string().min(1).max(2000),
    scope: z.enum(["meeting", "room", "workspace"]),
    meetingId: z.string().optional(),
    roomId: z.string().optional(),
  })
  .refine((input) => input.scope !== "meeting" || Boolean(input.meetingId), {
    message: "meetingId is required for scope=meeting",
    path: ["meetingId"],
  })
  .refine((input) => input.scope !== "room" || Boolean(input.roomId), {
    message: "roomId is required for scope=room",
    path: ["roomId"],
  })

function askBody(input) {
  const scope =
    input.scope === "meeting"
      ? { kind: "meeting", meetingId: input.meetingId }
      : input.scope === "room"
        ? { kind: "room", roomId: input.roomId }
        : { kind: "workspace" }

  return JSON.stringify({ question: input.question, scope })
}

/** Registers every MeetSum tool on `server` (an McpServer or a test fake). */
export function registerMeetSumTools(server, request, options = {}) {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS
  const result = (value) => textResult(value, maxChars)
  const ask = async (input) => {
    const parsed = askInputSchema.safeParse(input)

    if (!parsed.success) throw new Error(parsed.error.issues.map((issue) => issue.message).join("; "))

    return result(
      await request("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: askBody(parsed.data),
      })
    )
  }

  server.registerTool(
    "search_meetings",
    {
      title: "Search meetings",
      description:
        "Hybrid search (Hebrew-aware) over visible meetings, grouped by meeting. Returns {groups, nextCursor, mode}; pass nextCursor back as cursor.",
      inputSchema: { query: z.string().max(300).optional(), ...filterShape },
    },
    async (input) => {
      const body = await request(`/api/search${searchParams("meeting", input)}`)

      return result({ groups: body.groups ?? [], nextCursor: body.nextCursor ?? null, mode: body.mode })
    }
  )

  server.registerTool(
    "search_transcripts",
    {
      title: "Search transcripts",
      description: "Hybrid search returning individual passages (chunks) with snippets and timestamps.",
      inputSchema: { query: z.string().min(1).max(300), ...filterShape },
    },
    async (input) => {
      const body = await request(`/api/search${searchParams("chunk", input)}`)

      return result({ hits: body.hits ?? [], nextCursor: body.nextCursor ?? null, mode: body.mode })
    }
  )

  server.registerTool(
    "ask",
    {
      title: "Ask MeetSum",
      description:
        "Ask a question answered only from meeting content, with citations. scope=meeting needs meetingId; scope=room needs roomId.",
      inputSchema: {
        question: z.string().min(1).max(2000),
        scope: z.enum(["meeting", "room", "workspace"]),
        meetingId: z.string().optional(),
        roomId: z.string().optional(),
      },
    },
    ask
  )

  server.registerTool(
    "ask_meeting_memory",
    {
      title: "Ask meeting memory",
      description: "Alias of ask with scope=meeting.",
      inputSchema: { meetingId: z.string(), question: z.string().min(1).max(2000) },
    },
    async ({ meetingId, question }) => ask({ question, scope: "meeting", meetingId })
  )

  server.registerTool(
    "list_meetings",
    {
      title: "List meetings",
      description: "List visible meetings, newest first. Pass nextCursor back as cursor.",
      inputSchema: { cursor: z.string().regex(/^\d+$/).optional(), limit: z.number().int().min(1).max(100).optional() },
    },
    async ({ cursor, limit }) => {
      const body = await request(`/api/meetings${queryString({ sort: "recent", limit: limit ?? 20, offset: cursor })}`)
      const page = body.page ?? {}

      return result({
        meetings: body.meetings ?? [],
        nextCursor: page.hasMore ? String((page.offset ?? 0) + (body.meetings?.length ?? 0)) : null,
      })
    }
  )

  server.registerTool(
    "get_meeting",
    {
      title: "Get meeting",
      description: "Fetch one meeting with its summary and transcript segments.",
      inputSchema: { meetingId: z.string() },
    },
    async ({ meetingId }) => {
      const { meeting } = await request(`/api/meetings/${id(meetingId)}?include=transcript`)

      return result({ ...meeting, transcript: (meeting?.transcript ?? []).map(segmentText) })
    }
  )

  server.registerTool(
    "get_meeting_summary",
    {
      title: "Get meeting summary",
      description: "Fetch the summary for one meeting.",
      inputSchema: { meetingId: z.string() },
    },
    async ({ meetingId }) => {
      const { meeting } = await request(`/api/meetings/${id(meetingId)}`)

      return result(meeting?.summary ?? null)
    }
  )

  server.registerTool(
    "get_transcript_segments",
    {
      title: "Get transcript segments",
      description: "Fetch a slice of one meeting's transcript segments (without word timings).",
      inputSchema: {
        meetingId: z.string(),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(1000).optional(),
      },
    },
    async ({ meetingId, offset = 0, limit = 200 }) => {
      const { segments } = await request(`/api/meetings/${id(meetingId)}/transcript`)
      const all = segments ?? []

      return result({ total: all.length, offset, segments: all.slice(offset, offset + limit).map(segmentText) })
    }
  )

  server.registerTool(
    "list_action_items",
    {
      title: "List action items",
      description: "Action items across visible meetings (one paginated request). Pass nextCursor back as cursor.",
      inputSchema: {
        status: z.enum(["open", "done", "overdue", "all"]).optional(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ status, cursor, limit }) =>
      result(await request(`/api/tasks${queryString({ scope: "all", status, cursor, limit })}`))
  )

  server.registerTool(
    "create_followup_draft",
    {
      title: "Create follow-up draft",
      description: "Create a follow-up draft payload from a meeting summary.",
      inputSchema: { meetingId: z.string() },
    },
    async ({ meetingId }) => {
      const { meeting } = await request(`/api/meetings/${id(meetingId)}`)

      return result({
        subject: `Follow-up: ${meeting.title}`,
        body: [meeting.summary?.overview, ...(meeting.summary?.decisions ?? []).map((decision) => `Decision: ${decision}`)]
          .filter(Boolean)
          .join("\n\n"),
      })
    }
  )

  server.registerTool(
    "send_context_to_realizeos",
    {
      title: "Send context to RealizeOS",
      description: "Queue an agent run that sends meeting context to RealizeOS (needs a write key).",
      inputSchema: { meetingId: z.string() },
    },
    async ({ meetingId }) =>
      result(
        await request("/api/agents/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agent: "realizeos-context", meetingId }),
        })
      )
  )
}
