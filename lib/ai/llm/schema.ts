/**
 * Zod -> provider JSON schema (A1/A2). Structured-output endpoints accept a
 * JSON-schema subset, so `toProviderSchema`:
 * - sets `additionalProperties: false` on every object,
 * - marks every property required, turning optional ones nullable through a
 *   type union (`["string","null"]`) or `anyOf [..., {type:"null"}]`,
 * - strips keywords providers reject (length/range/pattern/format limits,
 *   `$schema`, defaults, examples).
 *
 * The matching parse step is `stripNulls`: a `null` the model returns for an
 * optional property is removed before zod validation, so schemas only need
 * `.optional()`.
 */
import { z, type ZodType } from "zod"

type JsonSchema = Record<string, unknown>

const UNSUPPORTED_KEYWORDS = new Set([
  "$schema",
  "$id",
  "default",
  "examples",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "propertyNames",
  "patternProperties",
])

function isRecord(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nullable(schema: JsonSchema): JsonSchema {
  const type = schema.type

  if (Array.isArray(schema.enum) || "const" in schema) {
    return { anyOf: [schema, { type: "null" }] }
  }
  if (typeof type === "string") {
    return type === "null" ? schema : { ...schema, type: [type, "null"] }
  }
  if (Array.isArray(type)) {
    return type.includes("null") ? schema : { ...schema, type: [...type, "null"] }
  }
  if (Array.isArray(schema.anyOf)) {
    const anyOf = schema.anyOf as JsonSchema[]

    return anyOf.some((entry) => entry.type === "null")
      ? schema
      : { ...schema, anyOf: [...anyOf, { type: "null" }] }
  }
  return { anyOf: [schema, { type: "null" }] }
}

function convert(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(convert)
  if (!isRecord(node)) return node

  const out: JsonSchema = {}

  for (const [key, value] of Object.entries(node)) {
    if (UNSUPPORTED_KEYWORDS.has(key)) continue

    if (key === "properties" && isRecord(value)) {
      out.properties = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [name, convert(child)])
      )
    } else if (key === "items" || key === "additionalProperties") {
      out[key] = isRecord(value) || Array.isArray(value) ? convert(value) : value
    } else if (key === "anyOf" || key === "oneOf" || key === "allOf") {
      out[key === "oneOf" ? "anyOf" : key] = (value as unknown[]).map(convert)
    } else if (key === "$defs" || key === "definitions") {
      out[key] = Object.fromEntries(
        Object.entries(value as JsonSchema).map(([name, child]) => [name, convert(child)])
      )
    } else {
      out[key] = value
    }
  }

  if (out.type === "object" || isRecord(out.properties)) {
    const properties = (isRecord(out.properties) ? out.properties : {}) as Record<
      string,
      JsonSchema
    >
    const required = new Set(Array.isArray(out.required) ? (out.required as string[]) : [])

    out.properties = Object.fromEntries(
      Object.entries(properties).map(([name, child]) => [
        name,
        required.has(name) ? child : nullable(child),
      ])
    )
    out.required = Object.keys(properties)
    out.additionalProperties = false
  }

  return out
}

/** Converts a JSON schema (e.g. from `z.toJSONSchema`) for structured output. */
export function toProviderSchema(jsonSchema: JsonSchema): JsonSchema {
  return convert(jsonSchema) as JsonSchema
}

/** Provider JSON schema of a zod schema. */
export function zodToProviderSchema(schema: ZodType): JsonSchema {
  return toProviderSchema(z.toJSONSchema(schema, { io: "input" }) as JsonSchema)
}

/** Removes `null` object properties recursively (optional fields). */
export function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls)
  if (!isRecord(value)) return value

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== null)
      .map(([key, child]) => [key, stripNulls(child)])
  )
}
