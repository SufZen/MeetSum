#!/usr/bin/env node
import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { basename } from "node:path"
import { Command } from "commander"

// M2: API keys are bound to one workspace and carry a scope
// (admin ⊃ write ⊃ read). Map the server's 401/403 to actionable messages.
const READ_PERMISSIONS = ["workspace:read", "meeting:read", "jobs:read"]
const WRITE_PERMISSIONS = [
  "meeting:write",
  "meeting:create",
  "contexts:write",
  "jobs:write",
]

function requiredScope(permission) {
  if (READ_PERMISSIONS.includes(permission)) return "read"
  if (WRITE_PERMISSIONS.includes(permission)) return "write"
  return "admin"
}

function describeApiError(status, body) {
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

  if (status === 404) {
    return body?.error
      ? `${body.error} (or not visible to this API key's workspace)`
      : "Not found (or not visible to this API key's workspace)"
  }

  return body?.error ?? `Request failed with ${status}`
}

const program = new Command()
const defaultAppUrl = process.env.MEETINGS_APP_URL ?? "http://127.0.0.1:3000"

async function request(path, init) {
  const appUrl = program.opts().url ?? defaultAppUrl
  const apiKey = program.opts().apiKey ?? process.env.MEETSUM_API_KEY
  const headers = new Headers(init?.headers)

  if (apiKey) {
    headers.set("authorization", `Bearer ${apiKey}`)
  }

  const response = await fetch(`${appUrl}${path}`, {
    ...init,
    headers,
  })
  const body = await response.json().catch(() => ({}))

  if (!response.ok) {
    throw new Error(describeApiError(response.status, body))
  }

  return body
}

program
  .name("meetings")
  .description(
    "CLI for the self-hosted meeting intelligence app.\n" +
      "Auth: --api-key / MEETSUM_API_KEY (Admin → API keys). Keys act on one\n" +
      "workspace. Scopes: read (list/search/export), write (upload, process),\n" +
      "admin (Google sync and other workspace administration)."
  )
  .option("--url <url>", "App URL", defaultAppUrl)
  .option("--api-key <key>", "MeetSum API key", process.env.MEETSUM_API_KEY)

program
  .command("sync")
  .argument("<source>", "google")
  .option(
    "--subject <email>",
    "Workspace subject email (defaults to GOOGLE_WORKSPACE_SUBJECT, else the server resolves it)",
    process.env.GOOGLE_WORKSPACE_SUBJECT
  )
  .action(async (source, options) => {
    if (source !== "google") {
      throw new Error("Only google sync is implemented in this scaffold")
    }

    const results = []
    // Drive auto-import is disabled server-side (manual review/import only).
    for (const googleSource of ["calendar", "gmail"]) {
      results.push(
        await request(`/api/google/sync/${googleSource}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            options.subject ? { subject: options.subject } : {}
          ),
        })
      )
    }

    console.log(JSON.stringify(results, null, 2))
  })

program
  .command("ingest")
  .argument("<file>", "Audio or video file")
  .option("--meeting <id>", "Existing meeting id")
  .action(async (file, options) => {
    let meetingId = options.meeting
    if (!meetingId) {
      const created = await request("/api/meetings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: basename(file).replace(/\.[^.]+$/, "") || "CLI upload",
          source: "upload",
          language: "mixed",
          startedAt: new Date().toISOString(),
          participants: [],
        }),
      })
      meetingId = created.meeting.id
    }
    const formData = new FormData()
    const fileStat = await stat(file)
    const stream = createReadStream(file)
    const blob = new Blob([await new Response(stream).arrayBuffer()])
    formData.set("file", blob, basename(file))
    formData.set("size", String(fileStat.size))

    console.log(
      JSON.stringify(
        await request(`/api/meetings/${encodeURIComponent(meetingId)}/upload`, {
          method: "POST",
          body: formData,
        }),
        null,
        2
      )
    )
  })

program
  .command("search")
  .argument("<query>", "Search text (Hebrew-aware)")
  .option("--room <id>", "Room (context) id")
  .option("--from <date>", "From date (YYYY-MM-DD, inclusive)")
  .option("--to <date>", "To date (YYYY-MM-DD, inclusive)")
  .option("--type <meetingType>", "Meeting type")
  .option("--chunks", "Return passages instead of meetings")
  .option("--limit <n>", "Results per page")
  .option("--cursor <cursor>", "Next page cursor from a previous result")
  .action(async (query, options) => {
    const params = new URLSearchParams({ q: query, group: options.chunks ? "chunk" : "meeting" })

    for (const [key, value] of [
      ["room", options.room],
      ["from", options.from],
      ["to", options.to],
      ["type", options.type],
      ["limit", options.limit],
      ["cursor", options.cursor],
    ]) {
      if (value) params.set(key, value)
    }

    console.log(JSON.stringify(await request(`/api/search?${params}`), null, 2))
  })

program
  .command("ask")
  .argument("<question>", "Question answered from meeting content, with citations")
  .option("--meeting <id>", "Ask about one meeting")
  .option("--room <id>", "Ask across one room's meetings")
  .action(async (question, options) => {
    if (options.meeting && options.room) {
      throw new Error("Use either --meeting or --room, not both")
    }

    const scope = options.meeting
      ? { kind: "meeting", meetingId: options.meeting }
      : options.room
        ? { kind: "room", roomId: options.room }
        : { kind: "workspace" }

    console.log(
      JSON.stringify(
        await request("/api/ask", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ question, scope }),
        }),
        null,
        2
      )
    )
  })

program
  .command("export")
  .option("--target <target>", "realizeos|json|markdown", "json")
  .action(async (options) => {
    const { meetings: items } = await request("/api/meetings")
    // M4: list items are lightweight; summaries come from the meeting detail.
    const meetings = await Promise.all(
      items.map((item) =>
        request(`/api/meetings/${encodeURIComponent(item.id)}`).then(
          (body) => body.meeting
        )
      )
    )

    if (options.target === "markdown") {
      console.log(
        meetings
          .map(
            (meeting) =>
              `# ${meeting.title}\n\n${meeting.summary?.overview ?? ""}`
          )
          .join("\n\n")
      )
      return
    }

    console.log(JSON.stringify({ target: options.target, meetings }, null, 2))
  })

program.parseAsync()
