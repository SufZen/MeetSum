/**
 * Export a recap to Google Docs: create a document, or replace the body of
 * the tracked one (docs/parity/m8.md, C2 and "External object links").
 * Owner: Package C.
 *
 * Re-export uses the `google_doc` link of the user's connection: read the
 * body's end index, then one `batchUpdate` with `deleteContentRange` over
 * the old body followed by the new requests. `forceNew` (`?new=1`) always
 * creates a new document and moves the link. A tracked document that is
 * gone (404) is replaced by a new one. Without a link store (DWD path, no
 * connection row) every export creates a new document.
 */
import { ProviderError, type LinkStore } from "@/lib/integrations/core/types"
import { buildGoogleDocRequests, googleDocsLocaleFor, type GoogleDocRequest } from "@/lib/integrations/google-docs/builder"
import {
  batchUpdateGoogleDocument,
  createGoogleDocument,
  googleDocumentEndIndex,
  googleDocumentUrl,
  renameGoogleFile,
  type GoogleDocsClientContext,
} from "@/lib/integrations/google-docs/client"
import type { MeetingRecap } from "@/lib/integrations/recap"

export type GoogleDocsExportResult = { documentId: string; url: string; updated: boolean }

const LINK_KEY = { objectKind: "google_doc" as const, destinationKey: "" }

export async function exportRecapToGoogleDocs(input: {
  recap: MeetingRecap
  client: GoogleDocsClientContext
  links?: LinkStore
  forceNew?: boolean
  env?: NodeJS.ProcessEnv
}): Promise<GoogleDocsExportResult> {
  const { title, requests } = buildGoogleDocRequests(input.recap, googleDocsLocaleFor(input.recap.language), {
    ...(input.env ? { env: input.env } : {}),
  })
  let token: Promise<string> | undefined
  const client: GoogleDocsClientContext = {
    fetch: input.client.fetch,
    getAccessToken: () => (token ??= input.client.getAccessToken()),
  }
  const link = input.forceNew ? undefined : await input.links?.get(LINK_KEY)

  if (link) {
    try {
      const endIndex = await googleDocumentEndIndex(client, link.externalId)
      // The final newline of the body can never be deleted.
      const clear: GoogleDocRequest[] =
        endIndex - 1 > 1 ? [{ deleteContentRange: { range: { startIndex: 1, endIndex: endIndex - 1 } } }] : []

      await batchUpdateGoogleDocument(client, link.externalId, [...clear, ...requests])
      await renameGoogleFile(client, link.externalId, title).catch((error: unknown) => {
        if (error instanceof ProviderError && error.kind === "auth") throw error
      })

      const url = googleDocumentUrl(link.externalId)

      await input.links?.upsert({ ...LINK_KEY, externalId: link.externalId, externalUrl: url })

      return { documentId: link.externalId, url, updated: true }
    } catch (error) {
      if (!(error instanceof ProviderError && error.kind === "not_found")) throw error
    }
  }

  const { documentId } = await createGoogleDocument(client, title)

  await batchUpdateGoogleDocument(client, documentId, requests)

  const url = googleDocumentUrl(documentId)

  await input.links?.upsert({ ...LINK_KEY, externalId: documentId, externalUrl: url })

  return { documentId, url, updated: false }
}
