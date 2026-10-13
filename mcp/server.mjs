#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"

import { DEFAULT_MAX_CHARS, MCP_SERVER_VERSION, createRequest, registerMeetSumTools } from "./tools.mjs"

/**
 * MeetSum MCP server (stdio). Tools, auth and scopes are documented in
 * mcp/tools.mjs. Env:
 *   MEETINGS_APP_URL       app URL (default http://127.0.0.1:3000)
 *   MEETSUM_API_KEY        workspace-scoped API key (read; write for RealizeOS)
 *   MEETSUM_MCP_MAX_CHARS  response truncation (default 50000)
 */
const maxChars = Number(process.env.MEETSUM_MCP_MAX_CHARS) > 0 ? Number(process.env.MEETSUM_MCP_MAX_CHARS) : DEFAULT_MAX_CHARS
const request = createRequest({
  fetch: globalThis.fetch,
  appUrl: process.env.MEETINGS_APP_URL ?? "http://127.0.0.1:3000",
  apiKey: process.env.MEETSUM_API_KEY,
})
const server = new McpServer({ name: "meeting-intelligence", version: MCP_SERVER_VERSION })

registerMeetSumTools(server, request, { maxChars })

await server.connect(new StdioServerTransport())
