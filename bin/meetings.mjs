#!/usr/bin/env node
import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { basename } from "node:path"
import { Command } from "commander"

const program = new Command()
const defaultAppUrl = process.env.MEETINGS_APP_URL ?? "http://127.0.0.1:3000"

async function request(path, init) {
  const appUrl = program.opts().url ?? defaultAppUrl
  const response = await fetch(`${appUrl}${path}`, init)
  const body = await response.json()

  if (!response.ok) {
    throw new Error(body.error ?? `Request failed with ${response.status}`)
  }

  return body
}

program
  .name("meetings")
  .description("CLI for the self-hosted meeting intelligence app")
  .option("--url <url>", "App URL", defaultAppUrl)

program
  .command("sync")
  .argument("<source>", "google")
  .option("--subject <email>", "Workspace subject email", "admin@example.com")
  .action(async (source, options) => {
    if (source !== "google") {
      throw new Error("Only google sync is implemented in this scaffold")
    }

    const results = []
    for (const googleSource of ["calendar", "gmail", "drive"]) {
      results.push(
        await request(`/api/google/sync/${googleSource}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ subject: options.subject }),
        }),
      )
    }

    console.log(JSON.stringify(results, null, 2))
  })

program
  .command("ingest")
  .argument("<file>", "Audio or video file")
  .option("--meeting <id>", "Meeting id", "meet_google_workspace")
  .action(async (file, options) => {
    const formData = new FormData()
    const fileStat = await stat(file)
    const stream = createReadStream(file)
    const blob = new Blob([await new Response(stream).arrayBuffer()])
    formData.set("file", blob, basename(file))
    formData.set("size", String(fileStat.size))

    console.log(
      JSON.stringify(
        await request(`/api/meetings/${options.meeting}/upload`, {
          method: "POST",
          body: formData,
        }),
        null,
        2,
      ),
    )
  })

program
  .command("ask")
  .argument("<question>", "Question for meeting memory")
  .option("--meeting <id>", "Meeting id", "meet_google_workspace")
  .action(async (question, options) => {
    console.log(
      JSON.stringify(
        await request(`/api/meetings/${options.meeting}/ask`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ question }),
        }),
        null,
        2,
      ),
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
          .map((meeting) => `# ${meeting.title}\n\n${meeting.summary?.overview ?? ""}`)
          .join("\n\n"),
      )
      return
    }

    console.log(JSON.stringify({ target: options.target, meetings }, null, 2))
  })

program.parseAsync()
