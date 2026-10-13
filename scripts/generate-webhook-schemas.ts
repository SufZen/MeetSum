/**
 * Writes the webhook catalog v2 JSON Schemas (docs/parity/m8.md, C4).
 *
 *   npm run webhooks:schemas
 *
 * One file per event, docs/webhooks/schemas/v2/<event>.schema.json, from the
 * zod schemas in lib/platform/event-schemas.ts (`z.toJSONSchema`). A test
 * (tests/webhook-event-schemas.test.ts) fails when the files are stale.
 */
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import { WEBHOOK_EVENTS_V2 } from "@/lib/platform/event-catalog"
import { webhookJsonSchema, webhookSchemaPath } from "@/lib/platform/event-schemas"

async function main() {
  for (const name of WEBHOOK_EVENTS_V2) {
    const file = path.join(process.cwd(), webhookSchemaPath(name))

    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, `${JSON.stringify(webhookJsonSchema(name), null, 2)}\n`, "utf8")
    console.log(`wrote ${path.relative(process.cwd(), file)}`)
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
