"use client"

/**
 * Share-link dialog for a meeting. Moved verbatim from
 * `components/command-center-shell.tsx` in M9 Step 0 so Package B owns it
 * (docs/parity/m9.md item 8): same overlay, strings and API calls. Package B
 * turns it into a shadcn Dialog, localizes it and adds the password field.
 */
import { useEffect, useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { MeetingRecord, MeetingVisibility } from "@/lib/meetings/repository"

export type ShareMeetingDialogProps = {
  meeting: Pick<MeetingRecord, "id" | "visibility" | "mediaAssets">
  open: boolean
  onOpenChange: (open: boolean) => void
  dictionary: Dictionary
  /** False shows the "no generated summary yet" note. */
  hasSummary: boolean
  /** Creating a link makes the meeting `link`-visible; the shell updates its list. */
  onVisibilityChange?: (meetingId: string, visibility: MeetingVisibility) => void
}

/**
 * Mount it (keyed by meeting id) when the share action is used: on mount it
 * creates the link, or first asks to confirm widening a private meeting.
 */
export function ShareMeetingDialog({
  meeting,
  open,
  onOpenChange,
  dictionary,
  hasSummary,
  onVisibilityChange,
}: ShareMeetingDialogProps) {
  const [shareSections, setShareSections] = useState<string[] | null>(null)
  const [shareLink, setShareLink] = useState("")
  // A public link widens a private meeting to the workspace: confirm first.
  const [sharePrivateConfirm, setSharePrivateConfirm] = useState(meeting.visibility === "private")

  async function copyText(text: string, label: string) {
    if (!text.trim()) {
      toast.info(`${label} is empty`)
      return
    }

    await navigator.clipboard.writeText(text)
    toast.success(`${label} copied`)
  }

  async function createShareLink() {
    setSharePrivateConfirm(false)
    const meetingId = meeting.id
    const response = await fetch(`/api/meetings/${meetingId}/share`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })
    const body = await response.json()

    if (!response.ok) {
      toast.error(
        body.reason === "meeting_manage_required"
          ? dictionary.visibilityReadOnly
          : (body.error ?? "Unable to create share link")
      )
      return
    }

    setShareLink(body.url)
    setShareSections(Array.isArray(body.share?.includedSections) ? body.share.includedSections : null)
    onVisibilityChange?.(meetingId, "link")
  }

  // On open: create the link right away unless a private meeting needs confirming.
  useEffect(() => {
    if (!open || meeting.visibility === "private") return

    queueMicrotask(() => void createShareLink())
    // Runs once per mount (the shell keys the dialog by meeting id).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** "Include recording" adds or removes the opt-in `media` share section. */
  async function setShareIncludesRecording(include: boolean) {
    if (!shareSections) return

    const next = include
      ? [...shareSections.filter((section) => section !== "media"), "media"]
      : shareSections.filter((section) => section !== "media")
    const response = await fetch(`/api/meetings/${meeting.id}/share`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ includedSections: next }),
    })
    const body = await response.json().catch(() => ({}))

    if (!response.ok) {
      toast.error(body.error ?? "Unable to update share link")
      return
    }

    setShareSections(Array.isArray(body.share?.includedSections) ? body.share.includedSections : next)
  }

  async function regenerateShareLink() {
    const response = await fetch(`/api/meetings/${meeting.id}/share`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ regenerate: true }),
    })
    const body = await response.json()

    if (!response.ok) {
      toast.error(body.error ?? "Unable to regenerate share link")
      return
    }

    setShareLink(body.url)
    toast.success("Share link regenerated")
  }

  async function revokeShareLink() {
    const response = await fetch(`/api/meetings/${meeting.id}/share`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revoked: true }),
    })
    const body = await response.json()

    if (!response.ok) {
      toast.error(body.error ?? "Unable to revoke share link")
      return
    }

    setShareLink("")
    toast.success("Share link revoked")
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4">
      <section className="w-full max-w-lg rounded-lg border border-line bg-surface p-5 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Share meeting</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Public link includes summary, decisions, action items,
              participants, and transcript. The recording is included
              only when you tick it below.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
        {sharePrivateConfirm ? (
          <div className="mt-4 grid gap-3 rounded-md border border-warn/40 bg-warn-soft p-3 text-sm leading-5 text-warn-text">
            <p>{dictionary.sharePrivateWarning}</p>
            <div>
              <Button onClick={() => void createShareLink()}>
                {dictionary.visibilityConfirm}
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-4 rounded-md border border-line bg-surface-2 p-3">
            <input
              className="w-full bg-transparent text-sm outline-none"
              dir="ltr"
              readOnly
              value={shareLink || "Creating link..."}
            />
          </div>
        )}
        {!sharePrivateConfirm && meeting.mediaAssets?.length ? (
          <label className="mt-3 flex items-start gap-2.5 text-sm">
            <Checkbox
              className="mt-0.5"
              checked={Boolean(shareSections?.includes("media"))}
              disabled={!shareSections}
              onCheckedChange={(checked) => void setShareIncludesRecording(Boolean(checked))}
            />
            <span className="grid">
              <span className="font-medium">{dictionary.shareIncludeRecording}</span>
              <span className="text-xs text-fg-3">{dictionary.shareIncludeRecordingHint}</span>
            </span>
          </label>
        ) : null}
        {!hasSummary ? (
          <div className="mt-3 rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-xs leading-5 text-warn-text">
            This meeting has no generated summary yet. The public page
            will still open, but it may only show metadata, participants,
            and any transcript that exists.
          </div>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            disabled={!shareLink}
            onClick={() => copyText(shareLink, "Share link")}
          >
            Copy link
          </Button>
          <Button
            disabled={!shareLink}
            variant="outline"
            onClick={() => window.open(shareLink, "_blank")}
          >
            Open
          </Button>
          <Button
            disabled={!shareLink}
            variant="outline"
            onClick={regenerateShareLink}
            title={
              shareLink
                ? "Regenerate the public share token"
                : "Create the first share link before regenerating"
            }
          >
            Regenerate
          </Button>
          <Button
            disabled={!shareLink}
            variant="destructive"
            onClick={revokeShareLink}
            title={
              shareLink
                ? "Revoke this public share link"
                : "No active public link to revoke"
            }
          >
            Revoke
          </Button>
        </div>
      </section>
    </div>
  )
}
