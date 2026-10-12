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
        await request(`/api/meetings/${meetingId}/upload`, {
          method: "POST",
          body: formData,
        }),
        null,
        2
      )
    )
  })

program
  .command("ask")
  .argument("<question>", "Question for meeting memory")
  .requiredOption("--meeting <id>", "Meeting id")
  .action(async (question, options) => {
    console.log(
      JSON.stringify(
        await request(`/api/meetings/${options.meeting}/ask`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ question }),
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
    const { meetings } = await request("/api/meetings")

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
