import { describe, expect, it } from "vitest"
import { z } from "zod"

import { stripNulls, toProviderSchema, zodToProviderSchema } from "@/lib/ai/llm/schema"
import { completeWithRepair, parseStructured } from "@/lib/ai/llm/structured"
import { LlmError } from "@/lib/ai/llm/types"

describe("provider JSON schema", () => {
  const schema = z.object({
    title: z.string().max(60),
    priority: z.enum(["low", "high"]).optional(),
    count: z.number().min(0).optional(),
    items: z.array(z.object({ text: z.string(), note: z.string().optional() })).max(5),
  })

  it("closes objects, requires every property and makes optional ones nullable", () => {
    type Node = {
      type?: unknown
      anyOf?: unknown
      required?: string[]
      additionalProperties?: boolean
      properties: Record<string, Node>
      items: Node
    }
    const json = zodToProviderSchema(schema) as unknown as Node

    expect(json.additionalProperties).toBe(false)
    expect(json.required).toEqual(["title", "priority", "count", "items"])
    expect(json.properties.count.type).toEqual(["number", "null"])
    expect(json.properties.priority.anyOf).toEqual([
      expect.objectContaining({ enum: ["low", "high"] }),
      { type: "null" },
    ])
    expect(json.properties.items.items.additionalProperties).toBe(false)
    expect(json.properties.items.items.required).toEqual(["text", "note"])
  })

  it("strips keywords providers reject", () => {
    const text = JSON.stringify(zodToProviderSchema(schema))

    for (const keyword of ["maxLength", "minimum", "maxItems", "$schema"]) {
      expect(text).not.toContain(`"${keyword}"`)
    }
  })

  it("converts oneOf to anyOf", () => {
    expect(toProviderSchema({ oneOf: [{ type: "string" }, { type: "number" }] })).toEqual({
      anyOf: [{ type: "string" }, { type: "number" }],
    })
  })

  it("strips nulls so optional fields validate", () => {
    expect(stripNulls({ a: null, b: [{ c: null, d: 1 }] })).toEqual({ b: [{ d: 1 }] })
    expect(
      parseStructured({ schema: { name: "s", zod: schema } }, JSON.stringify({
        title: "x",
        priority: null,
        count: null,
        items: [{ text: "t", note: null }],
      }))
    ).toEqual({ ok: true, value: { title: "x", items: [{ text: "t" }] } })
  })

  it("reports zod and validate() errors", () => {
    const result = parseStructured(
      { schema: { name: "s", zod: schema }, validate: () => ["semantic"] },
      JSON.stringify({ title: "x", items: [] })
    )

    expect(result).toMatchObject({ ok: false, errors: ["semantic"] })
    expect(parseStructured({ schema: { name: "s", zod: schema } }, "{\"items\": []}")).toMatchObject({
      ok: false,
      errors: [expect.stringContaining("title")],
    })
  })
})

describe("structured output errors never carry model or transcript text", () => {
  const schema = z.object({ title: z.string() })
  const SECRET = "מחיר רצפה סודי 4.2M"
  const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }

  it("reports the JSON parse error name and position only", () => {
    const result = parseStructured({ schema: { name: "s", zod: schema } }, `{"title": "${SECRET}" oops}`)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.logSummary).toMatch(/^invalid JSON \(SyntaxError at position \d+\)$/)
    expect(result.errors.join(" ")).not.toContain(SECRET)
  })

  it("throws an LlmError whose message has no model text after a failed repair", async () => {
    const parseFailure = completeWithRepair({ schema: { name: "s", zod: schema } }, "gemini", async () => ({
      text: `Sure! ${SECRET} {"title": `,
      usage,
    }))

    await expect(parseFailure).rejects.toBeInstanceOf(LlmError)
    const parseError = (await parseFailure.catch((error) => error)) as Error

    expect(parseError.message).not.toContain(SECRET)
    expect(parseError.message).toMatch(/SyntaxError/)

    const semantic = await completeWithRepair(
      { schema: { name: "s", zod: schema }, validate: (value) => [`unknown meeting id ${value.title}`] },
      "gemini",
      async () => ({ text: JSON.stringify({ title: SECRET }), usage })
    ).catch((error) => error as Error)

    expect(semantic.message).not.toContain(SECRET)
    expect(semantic.message).toContain("1 rule violation")
  })
})
