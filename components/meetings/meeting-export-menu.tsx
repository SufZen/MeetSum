"use client"

import {
  ChevronDownIcon,
  DownloadIcon,
  FileTextIcon,
  FileTypeIcon,
  NotepadTextIcon,
  SendIcon,
} from "lucide-react"
import { useParams } from "next/navigation"
import { useState } from "react"
import { toast } from "sonner"

import { useOptionalI18n } from "@/components/i18n-provider"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useWorkspace } from "@/components/workspace-context"
import {
  downloadExport,
  exportToGoogleDocs,
  listSendTargets,
  sendToIntegration,
  type DownloadExportFormat,
  type SendTarget,
  type SendTargetProvider,
} from "@/lib/client/download-export"
import type { ExportsMessages } from "@/lib/i18n/m8/exports"
import { formatMessage } from "@/lib/i18n/messages"
import type { MeetingVisibility } from "@/lib/meetings/repository"

/**
 * Meeting export menu (owner: Package C; docs/parity/m8.md, C3), in the
 * right rail's export block. One keyboard-accessible menu button:
 * - Download: PDF, Markdown, DOCX (filename from the server's header);
 * - Google Docs: export to the requester's Drive (a 409 leads to the connect
 *   page by full navigation); a toast offers "Open";
 * - Send to…: Slack, Notion or HubSpot connections that allow manual sends.
 *   Shown only with `meeting:write`, and for a private meeting only when the
 *   viewer can manage it.
 * The menu's direction follows the UI locale; account labels are in <bdi>.
 */

export type ExportMenuModel = {
  download: DownloadExportFormat[]
  googleDocs: boolean
  sendTo: boolean
  /** A private meeting the viewer may write but not manage. */
  privateSendHint: boolean
}

export function exportMenuModel(input: {
  visibility: MeetingVisibility | undefined
  canManage: boolean
  canWrite: boolean
}): ExportMenuModel {
  const isPrivate = input.visibility !== "workspace" && input.visibility !== "link"

  return {
    download: ["pdf", "markdown", "docx"],
    googleDocs: true,
    sendTo: input.canWrite && (!isPrivate || input.canManage),
    privateSendHint: input.canWrite && isPrivate && !input.canManage,
  }
}

const DOWNLOAD_ICONS = { pdf: FileTextIcon, markdown: NotepadTextIcon, docx: FileTypeIcon } as const

function downloadLabel(t: ExportsMessages, format: DownloadExportFormat) {
  return format === "pdf" ? t.exportDownloadPdf : format === "markdown" ? t.exportDownloadMarkdown : t.exportDownloadDocx
}

function providerLabel(t: ExportsMessages, provider: SendTargetProvider) {
  return provider === "slack" ? t.exportSendToSlack : provider === "notion" ? t.exportSendToNotion : t.exportSendToHubspot
}

export function MeetingExportMenu({
  meetingId,
  title,
  language,
  visibility,
  canManage,
  canWrite,
  locale,
}: {
  /** Undefined while no meeting is selected (menu disabled). */
  meetingId: string | undefined
  title: string
  language: string
  visibility: MeetingVisibility | undefined
  /** `canManageMeeting`: gates "Send to…" on private meetings. */
  canManage: boolean
  /** `meeting:write`; defaults to the workspace permission. */
  canWrite?: boolean
  /** UI locale; defaults to the route's `[locale]`. */
  locale?: "he" | "en"
}) {
  void language
  const params = useParams<{ locale?: string }>()
  const i18n = useOptionalI18n()
  const uiLocale = locale ?? i18n?.locale ?? (params?.locale === "he" ? "he" : "en")
  // The route's I18nProvider carries the export keys (M10 C: no message module in client JS).
  const t = (i18n?.messages ?? {}) as unknown as ExportsMessages
  const dir = uiLocale === "he" ? "rtl" : "ltr"
  const workspace = useWorkspace()
  const model = exportMenuModel({
    visibility,
    canManage,
    canWrite: canWrite ?? workspace.can("meeting:write"),
  })
  const [targets, setTargets] = useState<SendTarget[]>()
  const [busy, setBusy] = useState(false)

  async function run(task: () => Promise<unknown>) {
    if (busy) return
    setBusy(true)
    try {
      await task()
    } finally {
      setBusy(false)
    }
  }

  function download(format: DownloadExportFormat) {
    if (!meetingId) return
    void run(() => downloadExport({ id: meetingId, title }, format, { locale: uiLocale, messages: t }))
  }

  function googleDocs(forceNew: boolean) {
    if (!meetingId) return
    void run(async () => {
      const pending = toast.loading(t.exportGoogleDocsExporting)
      const outcome = await exportToGoogleDocs(meetingId, { forceNew })

      toast.dismiss(pending)
      if (outcome.kind === "done") {
        toast.success(t.exportGoogleDocsDone, {
          action: { label: t.exportGoogleDocsOpen, onClick: () => window.open(outcome.url, "_blank", "noopener,noreferrer") },
        })
      } else if (outcome.kind === "connect") {
        toast.info(t.exportGoogleDocsConnectHint, {
          action: { label: t.exportGoogleDocsConnect, onClick: () => window.location.assign(outcome.connectUrl) },
        })
      } else {
        toast.error(t.exportGoogleDocsFailed)
      }
    })
  }

  function send(target: SendTarget) {
    if (!meetingId) return
    const name = providerLabel(t, target.provider)

    void run(async () => {
      const pending = toast.loading(formatMessage(t.exportSendQueued, { provider: name }))
      const outcome = await sendToIntegration(meetingId, target.connectionId)

      toast.dismiss(pending)
      if (outcome === "sent") toast.success(formatMessage(t.exportSendSent, { provider: name }))
      else if (outcome === "skipped") toast.info(formatMessage(t.exportSendSkipped, { provider: name }))
      else if (outcome === "queued") toast.info(formatMessage(t.exportSendQueued, { provider: name }))
      else toast.error(formatMessage(t.exportSendFailed, { provider: name }))
    })
  }

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open && model.sendTo && targets === undefined) {
          void listSendTargets().then(setTargets)
        }
      }}
    >
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-1.5"
            dir={dir}
            disabled={!meetingId || busy}
            aria-label={t.exportMenuLabel}
          />
        }
      >
        <DownloadIcon aria-hidden="true" className="size-4" />
        {t.exportMenuLabel}
        <ChevronDownIcon aria-hidden="true" className="size-3.5 opacity-70" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56" dir={dir}>
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t.exportMenuDownload}</DropdownMenuLabel>
          {model.download.map((format) => {
            const Icon = DOWNLOAD_ICONS[format]

            return (
              <DropdownMenuItem key={format} onClick={() => download(format)}>
                <Icon aria-hidden="true" />
                {downloadLabel(t, format)}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuGroup>
        {model.googleDocs ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>{t.exportGoogleDocs}</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => googleDocs(false)}>
                <FileTextIcon aria-hidden="true" />
                {t.exportGoogleDocs}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => googleDocs(true)}>
                <FileTextIcon aria-hidden="true" />
                {t.exportGoogleDocsNew}
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </>
        ) : null}
        {model.sendTo ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>{t.exportSendTo}</DropdownMenuLabel>
              {targets?.length ? (
                targets.map((target) => {
                  const hintId = `export-send-hint-${target.connectionId}`

                  return (
                    <DropdownMenuItem
                      key={target.connectionId}
                      disabled={target.needsDefault}
                      aria-describedby={target.needsDefault ? hintId : undefined}
                      className={target.needsDefault ? "flex-wrap" : undefined}
                      onClick={() => send(target)}
                    >
                      <SendIcon aria-hidden="true" />
                      <span>{providerLabel(t, target.provider)}</span>
                      {target.accountLabel ? (
                        <span className="ms-auto truncate text-xs text-muted-foreground">
                          <bdi>{target.accountLabel}</bdi>
                        </span>
                      ) : null}
                      {target.needsDefault ? (
                        <span id={hintId} className="basis-full text-xs text-muted-foreground" data-testid="send-needs-default">
                          {target.provider === "slack" ? t.exportSendNeedsDefaultChannel : t.exportSendNeedsDefaultDatabase}
                        </span>
                      ) : null}
                    </DropdownMenuItem>
                  )
                })
              ) : (
                <DropdownMenuItem disabled>{targets ? t.exportSendNone : t.exportSendChooseDestination}</DropdownMenuItem>
              )}
            </DropdownMenuGroup>
          </>
        ) : null}
        {model.privateSendHint ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">{t.exportSendPrivateHint}</p>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
