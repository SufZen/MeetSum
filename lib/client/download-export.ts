import { toast } from "sonner"

/**
 * Client-side meeting export download (owner: Package C). Moved verbatim
 * from `components/command-center-shell.tsx` in M8 Step 0; Package C adds
 * DOCX and takes the filename from the response's Content-Disposition.
 */
export type DownloadExportFormat = "pdf" | "markdown"

export async function downloadExport(
  meeting: { id: string; title: string },
  format: DownloadExportFormat
): Promise<void> {
  const response = await fetch(`/api/meetings/${meeting.id}/export/${format}`, { method: "POST" })

  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    toast.error(body.error ?? `Unable to export ${format}`)
    return
  }

  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  const extension = format === "pdf" ? "pdf" : "md"

  anchor.href = url
  anchor.download = `${meeting.title.replace(/[^a-z0-9_-]+/gi, "-")}.${extension}`
  anchor.click()
  URL.revokeObjectURL(url)
  toast.success(`${format.toUpperCase()} exported`)
}
