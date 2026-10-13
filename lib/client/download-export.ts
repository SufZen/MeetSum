import { toast } from "sonner"

import { exportFileBaseName, filenameFromContentDisposition } from "@/lib/http/content-disposition"
import { getExportsMessages, type ExportsMessages } from "@/lib/i18n/m8/exports"
import { formatMessage } from "@/lib/i18n/workspace-messages"

/**
 * Client-side meeting exports (owner: Package C; docs/parity/m8.md, C3).
 *
 * - `downloadExport`: PDF, Markdown or DOCX. The filename comes from the
 *   response's Content-Disposition (`filename*` first), so Hebrew titles are
 *   kept; nothing is stripped on the client.
 * - `exportToGoogleDocs`: create/update the requester's Google Doc, or report
 *   the connect URL when Google Drive is not connected.
 * - `listSendTargets` / `sendToIntegration`: the "Send to…" actions (manual
 *   sends with an `Idempotency-Key`, then polling the delivery).
 */
export type DownloadExportFormat = "pdf" | "markdown" | "docx"

const EXTENSIONS: Record<DownloadExportFormat, string> = { pdf: "pdf", markdown: "md", docx: "docx" }

/** How long a download's blob URL stays alive after the click. */
export const DOWNLOAD_URL_TTL_MS = 30_000

type ExportOptions = {
  locale?: string
  messages?: ExportsMessages
  /** Injected in tests. */
  fetchImpl?: typeof fetch
}

function formatLabel(t: ExportsMessages, format: DownloadExportFormat): string {
  return format === "pdf" ? t.exportDownloadPdf : format === "markdown" ? t.exportDownloadMarkdown : t.exportDownloadDocx
}

/** The name a download gets: the server's header, else the title (Unicode kept). */
export function downloadFilename(header: string | null, title: string, format: DownloadExportFormat): string {
  return filenameFromContentDisposition(header) ?? `${exportFileBaseName(title)}.${EXTENSIONS[format]}`
}

export async function downloadExport(
  meeting: { id: string; title: string },
  format: DownloadExportFormat,
  options: ExportOptions = {}
): Promise<boolean> {
  const t = options.messages ?? getExportsMessages(options.locale)
  const label = formatLabel(t, format)
  const query = options.locale ? `?locale=${encodeURIComponent(options.locale)}` : ""
  const response = await (options.fetchImpl ?? fetch)(
    `/api/meetings/${encodeURIComponent(meeting.id)}/export/${format}${query}`,
    { method: "POST" }
  ).catch(() => undefined)

  if (!response?.ok) {
    toast.error(formatMessage(t.exportDownloadFailed, { format: label }))
    return false
  }

  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")

  anchor.href = url
  anchor.download = downloadFilename(response.headers.get("content-disposition"), meeting.title, format)
  anchor.click()
  // Revoking right after click() can cancel the download in some browsers
  // (Safari, Firefox): keep the blob URL alive while the download starts.
  setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_TTL_MS)
  toast.success(formatMessage(t.exportDownloadStarted, { format: label }))

  return true
}

export type GoogleDocsExportOutcome =
  | { kind: "done"; documentId: string; url: string; updated: boolean }
  | { kind: "connect"; connectUrl: string }
  | { kind: "error" }

/** Only same-origin OAuth start paths are followed (never a URL from elsewhere). */
function safeConnectUrl(value: unknown): string | undefined {
  return typeof value === "string" && value.startsWith("/api/integrations/google_drive/oauth/start") ? value : undefined
}

export async function exportToGoogleDocs(
  meetingId: string,
  options: { forceNew?: boolean; includeTranscript?: boolean; fetchImpl?: typeof fetch } = {}
): Promise<GoogleDocsExportOutcome> {
  const response = await (options.fetchImpl ?? fetch)(
    `/api/meetings/${encodeURIComponent(meetingId)}/export/google-docs${options.forceNew ? "?new=1" : ""}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ includeTranscript: options.includeTranscript === true }),
    }
  ).catch(() => undefined)
  const body = (await response?.json().catch(() => ({}))) as Record<string, unknown> | undefined

  if (response?.ok && typeof body?.documentId === "string" && typeof body.url === "string") {
    return { kind: "done", documentId: body.documentId, url: body.url, updated: body.updated === true }
  }

  const connectUrl = response?.status === 409 ? safeConnectUrl(body?.connectUrl) : undefined

  return connectUrl ? { kind: "connect", connectUrl } : { kind: "error" }
}

export type SendTargetProvider = "slack" | "notion" | "hubspot"

/**
 * `needsDefault`: Slack / Notion have no default channel / database yet, so a
 * send without a destination would fail with `destination_required`.
 */
export type SendTarget = { connectionId: string; provider: SendTargetProvider; accountLabel: string; needsDefault?: true }

const DEFAULT_ID_KEYS: Partial<Record<SendTargetProvider, string>> = { slack: "defaultChannelId", notion: "defaultDatabaseId" }

const SEND_PROVIDERS: readonly SendTargetProvider[] = ["slack", "notion", "hubspot"]

/** Active Slack/Notion/HubSpot connections that allow manual sends. */
export function sendTargetsFrom(payload: unknown): SendTarget[] {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { connections?: unknown })?.connections)
      ? (payload as { connections: unknown[] }).connections
      : []

  return list.flatMap((entry) => {
    const connection = entry as {
      id?: unknown
      provider?: unknown
      status?: unknown
      accountLabel?: unknown
      config?: Record<string, unknown> & { allowManualSend?: unknown }
    }

    if (
      typeof connection.id !== "string" ||
      !SEND_PROVIDERS.includes(connection.provider as SendTargetProvider) ||
      connection.status !== "active" ||
      connection.config?.allowManualSend === false
    ) {
      return []
    }

    const provider = connection.provider as SendTargetProvider
    const idKey = DEFAULT_ID_KEYS[provider]
    const defaultId = idKey ? connection.config?.[idKey] : undefined
    const needsDefault = Boolean(idKey) && !(typeof defaultId === "string" && defaultId)

    return [
      {
        connectionId: connection.id,
        provider,
        accountLabel: typeof connection.accountLabel === "string" ? connection.accountLabel : "",
        ...(needsDefault ? { needsDefault: true as const } : {}),
      },
    ]
  })
}

export async function listSendTargets(fetchImpl: typeof fetch = fetch): Promise<SendTarget[]> {
  const response = await fetchImpl("/api/integrations/connections").catch(() => undefined)

  if (!response?.ok) return []

  return sendTargetsFrom(await response.json().catch(() => ({})))
}

export type SendOutcome = "sent" | "skipped" | "failed" | "queued"

const TERMINAL = new Set(["sent", "partial", "skipped", "failed", "cancelled"])

/**
 * `POST /api/meetings/[id]/integrations/send {connectionId}` with an
 * `Idempotency-Key`, then polls `GET /api/integrations/deliveries/[id]`
 * until the delivery settles (or gives up and reports `queued`).
 */
export async function sendToIntegration(
  meetingId: string,
  connectionId: string,
  options: { fetchImpl?: typeof fetch; pollMs?: number; maxPolls?: number; idempotencyKey?: string } = {}
): Promise<SendOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch
  const response = await fetchImpl(`/api/meetings/${encodeURIComponent(meetingId)}/integrations/send`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": options.idempotencyKey ?? crypto.randomUUID(),
    },
    body: JSON.stringify({ connectionId }),
  }).catch(() => undefined)
  const body = (await response?.json().catch(() => ({}))) as { deliveryId?: unknown } | undefined

  if (!response?.ok || typeof body?.deliveryId !== "string") return "failed"

  const deliveryId = body.deliveryId

  for (let poll = 0; poll < (options.maxPolls ?? 20); poll += 1) {
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 1500))

    const status = await fetchImpl(`/api/integrations/deliveries/${encodeURIComponent(deliveryId)}`)
      .then(async (result) => (result.ok ? ((await result.json()) as { delivery?: { status?: string } }) : undefined))
      .catch(() => undefined)
    const value = status?.delivery?.status

    if (value && TERMINAL.has(value)) {
      return value === "sent" || value === "partial" ? "sent" : value === "skipped" ? "skipped" : "failed"
    }
  }

  return "queued"
}
