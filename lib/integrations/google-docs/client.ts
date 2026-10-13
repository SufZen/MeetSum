/**
 * Google Docs / Drive REST calls for the Docs export (docs/parity/m8.md,
 * C2). Owner: Package C. Every call goes through the injected
 * `providerFetch("google_drive", …)`; errors become `ProviderError`s with a
 * fixed message (Google's error text is never kept or reflected).
 */
import { ProviderError, type ProviderErrorKind, type ProviderFetch } from "@/lib/integrations/core/types"
import type { GoogleDocRequest } from "@/lib/integrations/google-docs/builder"

export const DOCS_API = "https://docs.googleapis.com/v1/documents"
export const DRIVE_API = "https://www.googleapis.com/drive/v3"

export type GoogleDocsClientContext = {
  fetch: ProviderFetch
  getAccessToken(): Promise<string>
}

const SAFE_REASON = /^[A-Za-z_]{1,64}$/

export async function googleErrorFrom(response: Response): Promise<ProviderError> {
  const body = (await response.json().catch(() => ({}))) as {
    error?: { status?: unknown; errors?: { reason?: unknown }[] } | string
  }
  const detail = typeof body.error === "object" ? body.error : undefined
  const rawReason =
    (typeof detail?.errors?.[0]?.reason === "string" && detail.errors[0].reason) ||
    (typeof detail?.status === "string" && detail.status) ||
    (typeof body.error === "string" && body.error) ||
    ""
  const reason = SAFE_REASON.test(rawReason) ? rawReason : undefined
  const status = response.status
  let kind: ProviderErrorKind

  if (status === 401 || reason === "invalid_grant") kind = "auth"
  else if (status === 429 || reason === "rateLimitExceeded" || reason === "userRateLimitExceeded") kind = "rate_limited"
  else if (status === 403) kind = "forbidden"
  else if (status === 404) kind = "not_found"
  else if (status === 400 || status === 409 || status === 422) kind = "invalid"
  else kind = "retryable"

  const retryAfter = Number(response.headers.get("retry-after"))

  return new ProviderError(kind, `google_docs_${reason ?? status}`, {
    ...(kind === "rate_limited" ? { retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 30_000 } : {}),
    ...(reason ? { providerCode: reason } : {}),
  })
}

async function request<T>(context: GoogleDocsClientContext, method: string, url: string, body?: unknown): Promise<T> {
  const token = await context.getAccessToken()
  const response = await context.fetch("google_drive", url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

  if (!response.ok) throw await googleErrorFrom(response)

  return (await response.json().catch(() => ({}))) as T
}

export async function createGoogleDocument(context: GoogleDocsClientContext, title: string): Promise<{ documentId: string }> {
  const document = await request<{ documentId?: string }>(context, "POST", DOCS_API, { title })

  if (!document.documentId) throw new ProviderError("retryable", "google_docs_document_missing")

  return { documentId: document.documentId }
}

/** End index of the body (the last structural element's `endIndex`). */
export async function googleDocumentEndIndex(context: GoogleDocsClientContext, documentId: string): Promise<number> {
  const document = await request<{ body?: { content?: { endIndex?: number }[] } }>(
    context,
    "GET",
    `${DOCS_API}/${encodeURIComponent(documentId)}?fields=body.content(endIndex)`
  )
  const content = document.body?.content ?? []

  return content.reduce((max, element) => Math.max(max, element.endIndex ?? 0), 1)
}

export async function batchUpdateGoogleDocument(
  context: GoogleDocsClientContext,
  documentId: string,
  requests: GoogleDocRequest[]
): Promise<void> {
  await request(context, "POST", `${DOCS_API}/${encodeURIComponent(documentId)}:batchUpdate`, { requests })
}

/** Keeps the Drive file name in sync on re-export (best effort). */
export async function renameGoogleFile(context: GoogleDocsClientContext, documentId: string, name: string): Promise<void> {
  await request(context, "PATCH", `${DRIVE_API}/files/${encodeURIComponent(documentId)}?fields=id`, { name })
}

export function googleDocumentUrl(documentId: string): string {
  return `https://docs.google.com/document/d/${encodeURIComponent(documentId)}/edit`
}
