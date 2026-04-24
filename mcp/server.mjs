#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

const appUrl = process.env.MEETINGS_APP_URL ?? "http://127.0.0.1:3000"

async function request(path, init) {
  const headers = new Headers(init?.headers)

  if (process.env.MEETSUM_API_KEY) {
    headers.set("authorization", `Bearer ${process.env.MEETSUM_API_KEY}`)
  }

  const response = await fetch(`${appUrl}${path}`, { ...init, headers })
  const body = await response.json()

  if (!response.ok) {
    throw new Error(body.error ?? `Request failed with ${response.status}`)
  }

  return body
}

const server = new McpServer({
  name: "meeting-intelligence",
  version: "0.1.0",
})

server.registerTool(
  "search_meetings",
  {
    title: "Search meetings",
    description: "Search meeting titles, summaries, action items, and transcripts.",
    inputSchema: { query: z.string() },
  },
  async ({ query }) => {
    const { meetings } = await request("/api/meetings")
    const normalized = query.toLowerCase()
    const matches = meetings.filter((meeting) =>
      JSON.stringify(meeting).toLowerCase().includes(normalized),
    )

    return {
      content: [{ type: "text", text: JSON.stringify(matches, null, 2) }],
    }
  },
)

server.registerTool(
  "get_meeting_summary",
  {
    title: "Get meeting summary",
    description: "Fetch the summary for one meeting.",
    inputSchema: { meetingId: z.string() },
  },
  async ({ meetingId }) => {
    const { meeting } = await request(`/api/meetings/${meetingId}`)

    return {
      content: [
        { type: "text", text: JSON.stringify(meeting.summary ?? null, null, 2) },
      ],
    }
  },
)

server.registerTool(
  "get_transcript_segments",
  {
    title: "Get transcript segments",
    description: "Fetch transcript segments for one meeting.",
    inputSchema: { meetingId: z.string() },
  },
  async ({ meetingId }) => {
    const { meeting } = await request(`/api/meetings/${meetingId}`)

    return {
      content: [
        { type: "text", text: JSON.stringify(meeting.transcript ?? [], null, 2) },
      ],
    }
  },
)

server.registerTool(
  "ask_meeting_memory",
  {
    title: "Ask meeting memory",
    description: "Ask a question against one meeting's transcript and summary.",
    inputSchema: { meetingId: z.string(), question: z.string() },
  },
  async ({ meetingId, question }) => {
    const answer = await request(`/api/meetings/${meetingId}/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question }),
    })

    return {
      content: [{ type: "text", text: JSON.stringify(answer, null, 2) }],
    }
  },
)

server.registerTool(
  "list_action_items",
  {
    title: "List action items",
    description: "List action items across all meetings.",
    inputSchema: {},
  },
  async () => {
    const { meetings } = await request("/api/meetings")
    const actionItems = meetings.flatMap((meeting) =>
      (meeting.summary?.actionItems ?? []).map((item) => ({
        ...item,
        meetingId: meeting.id,
        meetingTitle: meeting.title,
      })),
    )

    return {
      content: [{ type: "text", text: JSON.stringify(actionItems, null, 2) }],
    }
  },
)

server.registerTool(
  "create_followup_draft",
  {
    title: "Create follow-up draft",
    description: "Create a follow-up draft payload from a meeting summary.",
    inputSchema: { meetingId: z.string() },
  },
  async ({ meetingId }) => {
    const { meeting } = await request(`/api/meetings/${meetingId}`)
    const draft = {
      subject: `Follow-up: ${meeting.title}`,
      body: [
        meeting.summary?.overview,
        ...(meeting.summary?.decisions ?? []).map((decision) => `Decision: ${decision}`),
      ]
        .filter(Boolean)
        .join("\n\n"),
    }

    return {
      content: [{ type: "text", text: JSON.stringify(draft, null, 2) }],
    }
  },
)

server.registerTool(
  "send_context_to_realizeos",
  {
    title: "Send context to RealizeOS",
    description: "Queue an agent run that sends meeting context to RealizeOS.",
    inputSchema: { meetingId: z.string() },
  },
  async ({ meetingId }) => {
    const run = await request("/api/agents/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "realizeos-context", meetingId }),
    })

    return {
      content: [{ type: "text", text: JSON.stringify(run, null, 2) }],
    }
  },
)

await server.connect(new StdioServerTransport())
