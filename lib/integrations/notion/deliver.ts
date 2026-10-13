/**
 * Notion page delivery: create, or update the tracked page in place
 * (docs/parity/m8.md, C1 and "External object links"). Owner: Package C.
 *
 * - Create: `POST /v1/pages` with the first ≤ 100 children, then
 *   `PATCH /v1/blocks/{pageId}/children` per further batch of 100.
 *   `progress = {mode: "create", pageId, url, appendedBatches}` makes a retry
 *   resume after the last appended batch, never duplicating the page.
 * - Re-export (an `integration_links` row `notion_page` for this database):
 *   1. unchanged content hash → no-op (`sent`, same page);
 *   2. `PATCH /v1/pages/{id}` (properties); a 404 or an archived page →
 *      create a new page and move the link;
 *   3. archive the old children (`DELETE /v1/blocks/{id}`, the page history
 *      keeps them; `progress.archivedBlockIds`);
 *   4. append the new children in batches (`progress.appendedBatches`).
 * - No second page after a lost write: before `POST /v1/pages` a pending
 *   intent `progress = {mode: "create", pendingCreate: {at}}` is written on
 *   its own, and the page id right after the create. A retry that finds the
 *   intent without a page id queries the database
 *   (`POST /v1/databases/{id}/query`) for the page: by the `MeetSum ID`
 *   property when the database has one, else by the exact title and
 *   `created_time` on or after the intent (minus 2 min: Notion rounds
 *   created_time to the minute). It creates only when nothing is found.
 * - Calls are sequential (Notion allows about 3 requests/s).
 */
import { createHash } from "node:crypto"

import { ProviderError, type DeliverInput, type DeliverResult, type DeliveryProgress } from "@/lib/integrations/core/types"
import {
  batchNotionChildren,
  buildNotionPage,
  notionLocaleFor,
  type NotionBlock,
} from "@/lib/integrations/notion/blocks"
import { notionRequest, type NotionClientContext } from "@/lib/integrations/notion/client"
import {
  buildNotionProperties,
  resolveNotionPropertyMap,
  type NotionDatabase,
} from "@/lib/integrations/notion/properties"

type NotionPage = { id: string; url?: string; archived?: boolean; in_trash?: boolean }
type NotionList = { results?: { id: string }[]; has_more?: boolean; next_cursor?: string | null }

type NotionProgress = {
  mode?: "create" | "update"
  /** A create was about to be sent at `at` (written before `POST /v1/pages`). */
  pendingCreate?: { at: string }
  pageId?: string
  url?: string
  appendedBatches?: number
  archivedBlockIds?: string[]
  archiveDone?: boolean
}

export type DeliverNotionOptions = {
  maxTranscriptBlocks?: number
  env?: NodeJS.ProcessEnv
  sleep?(ms: number): Promise<void>
}

/** Bounds the archive loop (100 blocks per listing). */
const MAX_ARCHIVE_ROUNDS = 200

function readProgress(progress: DeliveryProgress): NotionProgress {
  const value = progress as NotionProgress

  return {
    ...(value.mode === "create" || value.mode === "update" ? { mode: value.mode } : {}),
    ...(typeof value.pageId === "string" ? { pageId: value.pageId } : {}),
    ...(typeof value.url === "string" ? { url: value.url } : {}),
    ...(value.pendingCreate && typeof value.pendingCreate.at === "string" ? { pendingCreate: { at: value.pendingCreate.at } } : {}),
    appendedBatches: Number.isInteger(value.appendedBatches) ? Number(value.appendedBatches) : 0,
    archivedBlockIds: Array.isArray(value.archivedBlockIds)
      ? value.archivedBlockIds.filter((id): id is string => typeof id === "string")
      : [],
    archiveDone: value.archiveDone === true,
  }
}

function notionPageUrl(page: NotionPage): string {
  return page.url ?? `https://www.notion.so/${page.id.replace(/-/g, "")}`
}

export function notionContentHash(properties: unknown, children: NotionBlock[]): string {
  return createHash("sha256").update(JSON.stringify({ properties, children })).digest("hex")
}

export async function deliverNotionPage(
  input: DeliverInput,
  options: DeliverNotionOptions = {}
): Promise<DeliverResult> {
  if (input.destination.provider !== "notion" || !input.destination.databaseId) {
    throw new ProviderError("invalid", "notion_destination_required")
  }

  const databaseId = input.destination.databaseId
  let token: Promise<string> | undefined
  const client: NotionClientContext = {
    fetch: input.fetch,
    // One token per delivery (A refreshes it under a refresh lease when needed).
    getAccessToken: () => (token ??= input.getAccessToken()),
    ...(options.env ? { env: options.env } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
  }
  const database = await notionRequest<NotionDatabase>(client, "GET", `/v1/databases/${encodeURIComponent(databaseId)}`)

  if (database.archived || database.in_trash) throw new ProviderError("invalid", "notion_database_archived")

  const propertyMap = resolveNotionPropertyMap(database, input.destination.titleProperty)
  const properties = buildNotionProperties(input.recap, propertyMap)
  const { children } = buildNotionPage(input.recap, notionLocaleFor(input.recap.language), {
    ...(options.maxTranscriptBlocks !== undefined ? { maxTranscriptBlocks: options.maxTranscriptBlocks } : {}),
  })
  const batches = batchNotionChildren(children)
  const contentHash = notionContentHash(properties, children)
  const linkKey = { objectKind: "notion_page" as const, destinationKey: databaseId }
  const link = await input.links.get(linkKey)
  let progress = readProgress(input.progress)

  const save = async (next: NotionProgress) => {
    progress = next
    await input.saveProgress({ ...next })
  }

  const finish = async (pageId: string, url: string, updated: boolean): Promise<DeliverResult> => {
    await input.links.upsert({ ...linkKey, externalId: pageId, externalUrl: url, contentHash })

    return { status: "sent", externalRef: { pageId, url, updated }, progress: { ...progress } }
  }

  const appendRemaining = async (pageId: string, fromBatch: number) => {
    for (let index = fromBatch; index < batches.length; index += 1) {
      await notionRequest(client, "PATCH", `/v1/blocks/${encodeURIComponent(pageId)}/children`, {
        children: batches[index],
      })
      await save({ ...progress, appendedBatches: index + 1 })
    }
  }

  /** The page an interrupted create already made (see the module comment). */
  const findCreatedPage = async (intent: { at: string }): Promise<NotionPage | undefined> => {
    const since = new Date(Date.parse(intent.at) - 2 * 60_000).toISOString()
    const created = { timestamp: "created_time", created_time: { on_or_after: since } }
    const filter = propertyMap.meetsumId
      ? { and: [{ property: propertyMap.meetsumId, rich_text: { equals: input.recap.meetingId } }, created] }
      : { and: [{ property: propertyMap.title, title: { equals: (input.recap.title || "MeetSum").slice(0, 2000) } }, created] }
    const found = await notionRequest<{ results?: NotionPage[] }>(
      client,
      "POST",
      `/v1/databases/${encodeURIComponent(databaseId)}/query`,
      { filter, sorts: [{ timestamp: "created_time", direction: "ascending" }], page_size: 10 }
    )

    return (found.results ?? []).find((page) => page.id && !page.archived && !page.in_trash)
  }

  const create = async (): Promise<DeliverResult> => {
    if (progress.mode !== "create" || !progress.pageId) {
      let page = progress.mode === "create" && progress.pendingCreate ? await findCreatedPage(progress.pendingCreate) : undefined

      if (!page) {
        // 1. Intent first (its own write): no write, no page.
        await save({ mode: "create", pendingCreate: { at: new Date().toISOString() }, appendedBatches: 0 })
        // 2. The create.
        page = await notionRequest<NotionPage>(client, "POST", "/v1/pages", {
          parent: { database_id: databaseId },
          properties,
          children: batches[0] ?? [],
        })
      }

      // 3. The page id, separately (a failure here is recovered by the query).
      await save({ mode: "create", pageId: page.id, url: notionPageUrl(page), appendedBatches: 1 })
    }

    const pageId = progress.pageId as string

    await appendRemaining(pageId, progress.appendedBatches ?? 1)

    return finish(pageId, progress.url ?? notionPageUrl({ id: pageId }), false)
  }

  // A create that was interrupted resumes; it never makes a second page.
  if (progress.mode === "create" && (progress.pageId || progress.pendingCreate)) return create()
  if (!link) return create()

  const pageId = link.externalId
  const url = link.externalUrl ?? notionPageUrl({ id: pageId })

  if (progress.mode !== "update") {
    if (link.contentHash === contentHash) {
      return { status: "sent", externalRef: { pageId, url, updated: true, unchanged: true } }
    }

    try {
      const page = await notionRequest<NotionPage>(client, "PATCH", `/v1/pages/${encodeURIComponent(pageId)}`, {
        properties,
      })

      if (page.archived || page.in_trash) return create()
    } catch (error) {
      if (error instanceof ProviderError && error.kind === "not_found") return create()
      throw error
    }

    await save({ mode: "update", pageId, url, appendedBatches: 0, archivedBlockIds: [], archiveDone: false })
  }

  if (!progress.archiveDone) {
    const archived = new Set(progress.archivedBlockIds)

    for (let round = 0; round < MAX_ARCHIVE_ROUNDS; round += 1) {
      const list = await notionRequest<NotionList>(
        client,
        "GET",
        `/v1/blocks/${encodeURIComponent(pageId)}/children?page_size=100`
      )
      const remaining = (list.results ?? []).filter((block) => !archived.has(block.id))

      if (!remaining.length) break

      for (const block of remaining) {
        try {
          await notionRequest(client, "DELETE", `/v1/blocks/${encodeURIComponent(block.id)}`)
        } catch (error) {
          // Already gone: nothing to archive.
          if (!(error instanceof ProviderError && error.kind === "not_found")) throw error
        }
        archived.add(block.id)
      }
      await save({ ...progress, archivedBlockIds: [...archived] })
    }

    await save({ ...progress, archiveDone: true })
  }

  await appendRemaining(pageId, progress.appendedBatches ?? 0)

  return finish(pageId, url, true)
}
