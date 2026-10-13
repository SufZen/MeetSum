import { createRequire } from "node:module"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { signWebhookPayloadV2 } from "@/lib/platform/events"

/**
 * M8 C4: the n8n templates read the real envelope (`$json.body.data.*`,
 * never `$json.payload`), and every webhook-triggered template verifies
 * `x-meetsum-signature-v2` in a Code node before doing anything. The Code
 * node is executed here against signed, tampered and stale requests.
 */
const DIR = path.join(process.cwd(), "docs", "n8n-templates")
const nodeRequire = createRequire(import.meta.url)

type N8nNode = { name: string; type: string; parameters: Record<string, unknown> }
type Workflow = {
  name: string
  nodes: N8nNode[]
  connections: Record<string, { main: { node: string }[][] }>
  _meta: { description: string; setup: string[]; events?: string[] }
}

const files = readdirSync(DIR).filter((file) => file.endsWith(".json"))
const load = (file: string) => JSON.parse(readFileSync(path.join(DIR, file), "utf8")) as Workflow
const isWebhookTemplate = (workflow: Workflow) => workflow.nodes.some((node) => node.type === "n8n-nodes-base.webhook")

function verifyCode(workflow: Workflow): string {
  const node = workflow.nodes.find((candidate) => candidate.name === "Verify MeetSum signature")

  return String(node?.parameters.jsCode ?? "")
}

/** Runs a Code node body like n8n does (`$input`, `$env`, `require`). */
function runCodeNode(code: string, item: Record<string, unknown>, secret: string) {
  const items = [item]
  const run = new Function("require", "$input", "$env", code) as (...args: unknown[]) => unknown

  return run(nodeRequire, { all: () => items, first: () => items[0] }, { MEETSUM_WEBHOOK_SECRET: secret })
}

function signedItem(body: Record<string, unknown>, secret: string, timestamp = Math.floor(Date.now() / 1000)) {
  const raw = JSON.stringify(body)

  return {
    json: {
      headers: { "x-meetsum-signature-v2": signWebhookPayloadV2(raw, secret, timestamp).header },
      body,
    },
    binary: { data: { data: Buffer.from(raw).toString("base64") } },
  }
}

describe("n8n templates", () => {
  it("ships the fixed templates and the two new ones", () => {
    expect(files).toEqual(
      expect.arrayContaining([
        "meeting-completed-slack.json",
        "action-item-todoist.json",
        "weekly-digest-email.json",
        "meeting-completed-notion.json",
        "action-item-hubspot-task.json",
      ])
    )
  })

  for (const file of files) {
    it(`${file} parses, is wired, and never reads $json.payload`, () => {
      const text = readFileSync(path.join(DIR, file), "utf8")
      const workflow = load(file)

      expect(workflow.name).toBeTruthy()
      expect(workflow.nodes.length).toBeGreaterThan(0)
      expect(workflow._meta.description).toBeTruthy()
      expect(workflow._meta.setup.length).toBeGreaterThan(0)
      expect(text).not.toMatch(/\$json\.payload/)
      for (const [from, outputs] of Object.entries(workflow.connections)) {
        expect(workflow.nodes.some((node) => node.name === from), from).toBe(true)
        for (const target of outputs.main.flat()) {
          expect(workflow.nodes.some((node) => node.name === target.node), target.node).toBe(true)
        }
      }
    })
  }

  for (const file of files.filter((candidate) => isWebhookTemplate(load(candidate)))) {
    it(`${file} verifies the v2 signature right after the Webhook node, on the raw body`, () => {
      const workflow = load(file)
      const webhook = workflow.nodes.find((node) => node.type === "n8n-nodes-base.webhook")!

      expect((webhook.parameters.options as Record<string, unknown>).rawBody).toBe(true)
      expect(workflow.connections.Webhook.main[0][0].node).toBe("Verify MeetSum signature")
      expect(verifyCode(workflow)).toMatch(/x-meetsum-signature-v2/)
      expect(JSON.stringify(workflow)).toMatch(/\$json\.body\.data\./)
      expect(workflow._meta.setup.join(" ")).toMatch(/payloadVersion: 2/)
    })

    it(`${file}: the Code node accepts a signed request and stops on tamper, wrong secret or skew`, () => {
      const code = verifyCode(load(file))
      const secret = "whsec_n8n_template_secret"
      const body = { id: "evt_1", name: "meeting.completed", version: 2, data: { title: "סנכרון" } }

      expect(runCodeNode(code, signedItem(body, secret), secret)).toHaveLength(1)

      const tampered = signedItem(body, secret)
      tampered.binary.data.data = Buffer.from(JSON.stringify({ ...body, data: { title: "x" } })).toString("base64")
      expect(() => runCodeNode(code, tampered, secret)).toThrow(/mismatch/)
      expect(() => runCodeNode(code, signedItem(body, "whsec_other"), secret)).toThrow(/mismatch/)
      expect(() => runCodeNode(code, signedItem(body, secret, Math.floor(Date.now() / 1000) - 600), secret)).toThrow(
        /window/
      )
      expect(() => runCodeNode(code, { json: { headers: {}, body } }, secret)).toThrow()
    })
  }
})
