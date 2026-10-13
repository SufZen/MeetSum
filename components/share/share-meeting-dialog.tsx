"use client"

/**
 * Share-link dialog for a meeting (moved from the shell in M9 Step 0; M9 B4
 * made it a shadcn Dialog, localized it and added the link password).
 *
 * On open it creates the link, or first asks to confirm widening a private
 * meeting. The owner chooses the M5 sections (summary, decisions, action
 * items, transcript, participants, and the opt-in recording) and can set,
 * change or remove a password (8–128 characters, stored as scrypt; the
 * server never returns it). Errors are shown from the dictionary, never the
 * server's English message.
 */
import { useEffect, useId, useState, type FormEvent } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { MeetingRecord, MeetingVisibility } from "@/lib/meetings/repository"
import type { ShareSection } from "@/lib/sharing/share-sections"

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

type ShareResponse = {
  url?: string
  share?: { includedSections?: unknown; passwordProtected?: unknown }
  error?: string
  reason?: string
}

const TEXT_SECTIONS: ReadonlyArray<{ section: ShareSection; key: keyof Dictionary }> = [
  { section: "summary", key: "shareDialogSectionSummary" },
  { section: "decisions", key: "shareDialogSectionDecisions" },
  { section: "action_items", key: "shareDialogSectionActionItems" },
  { section: "transcript", key: "shareDialogSectionTranscript" },
  { section: "participants", key: "shareDialogSectionParticipants" },
]

const PASSWORD_ERRORS: Record<string, keyof Dictionary> = {
  password_too_short: "shareDialogPasswordTooShort",
  password_too_long: "shareDialogPasswordTooLong",
  password_invalid: "shareDialogPasswordTooShort",
}

/** What the link field shows: the link, "creating…", or the revoked notice. */
export function shareLinkFieldState(input: { shareLink: string; revoked: boolean }): "ready" | "creating" | "revoked" {
  if (input.shareLink) return "ready"

  return input.revoked ? "revoked" : "creating"
}

async function shareRequest(meetingId: string, method: "POST" | "PATCH", body: unknown) {
  const response = await fetch(`/api/meetings/${encodeURIComponent(meetingId)}/share`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => undefined)
  const json = ((await response?.json().catch(() => ({}))) ?? {}) as ShareResponse

  return { ok: Boolean(response?.ok), json }
}

export function ShareMeetingDialog({
  meeting,
  open,
  onOpenChange,
  dictionary: t,
  hasSummary,
  onVisibilityChange,
}: ShareMeetingDialogProps) {
  const ids = useId()
  const [shareSections, setShareSections] = useState<string[] | null>(null)
  const [shareLink, setShareLink] = useState("")
  const [passwordProtected, setPasswordProtected] = useState(false)
  const [editingPassword, setEditingPassword] = useState(false)
  const [password, setPassword] = useState("")
  const [passwordError, setPasswordError] = useState<keyof Dictionary | null>(null)
  const [busy, setBusy] = useState(false)
  const [revokeConfirmOpen, setRevokeConfirmOpen] = useState(false)
  const [linkRevoked, setLinkRevoked] = useState(false)
  // A public link widens a private meeting to the workspace: confirm first.
  const [sharePrivateConfirm, setSharePrivateConfirm] = useState(meeting.visibility === "private")

  function applyShare(json: ShareResponse) {
    if (typeof json.url === "string") setShareLink(json.url)
    if (Array.isArray(json.share?.includedSections)) setShareSections(json.share.includedSections as string[])
    if (typeof json.share?.passwordProtected === "boolean") setPasswordProtected(json.share.passwordProtected)
  }

  async function createShareLink() {
    setSharePrivateConfirm(false)
    setBusy(true)

    const { ok, json } = await shareRequest(meeting.id, "POST", {})

    setBusy(false)
    if (!ok) {
      toast.error(json.reason === "meeting_manage_required" ? t.visibilityReadOnly : t.shareDialogCreateFailed)
      return
    }

    applyShare(json)
    setLinkRevoked(false)
    onVisibilityChange?.(meeting.id, "link")
  }

  // On open: create the link right away unless a private meeting needs confirming.
  useEffect(() => {
    if (!open || meeting.visibility === "private") return

    queueMicrotask(() => void createShareLink())
    // Runs once per mount (the shell keys the dialog by meeting id).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function patchShare(body: Record<string, unknown>, success?: string): Promise<ShareResponse | undefined> {
    setBusy(true)
    const { ok, json } = await shareRequest(meeting.id, "PATCH", body)
    setBusy(false)

    if (!ok) {
      if (json.error && PASSWORD_ERRORS[json.error]) {
        setPasswordError(PASSWORD_ERRORS[json.error]!)
      } else {
        toast.error(t.shareDialogUpdateFailed)
      }
      return undefined
    }

    applyShare(json)
    if (success) toast.success(success)

    return json
  }

  async function toggleSection(section: string, include: boolean) {
    if (!shareSections) return

    const next = include
      ? [...shareSections.filter((candidate) => candidate !== section), section]
      : shareSections.filter((candidate) => candidate !== section)

    await patchShare({ includedSections: next })
  }

  async function savePassword(event: FormEvent) {
    event.preventDefault()
    setPasswordError(null)

    const length = [...password].length

    if (length < 8 || !password.trim()) return setPasswordError("shareDialogPasswordTooShort")
    if (length > 128) return setPasswordError("shareDialogPasswordTooLong")

    if (await patchShare({ password }, t.shareDialogPasswordSet)) {
      setPassword("")
      setEditingPassword(false)
    }
  }

  async function removePassword() {
    setPasswordError(null)

    if (await patchShare({ password: null }, t.shareDialogPasswordRemoved)) {
      setPassword("")
      setEditingPassword(false)
    }
  }

  async function regenerateShareLink() {
    const json = await patchShare({ regenerate: true }, t.shareDialogRegenerated)

    if (json && typeof json.share?.passwordProtected !== "boolean") setPasswordProtected(false)
  }

  async function revokeShareLink() {
    if (await patchShare({ revoked: true }, t.shareDialogRevoked)) {
      setShareLink("")
      setLinkRevoked(true)
      setEditingPassword(false)
      setPassword("")
    }
  }

  async function copyLink() {
    if (!shareLink) return

    await navigator.clipboard.writeText(shareLink).catch(() => undefined)
    toast.success(t.shareDialogLinkCopied)
  }

  const linkField = shareLinkFieldState({ shareLink, revoked: linkRevoked })
  const linkReady = linkField === "ready" && !sharePrivateConfirm
  const passwordOn = passwordProtected || editingPassword
  const passwordErrorId = `${ids}-password-error`

  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t.shareDialogTitle}</DialogTitle>
          <DialogDescription>{t.shareDialogDescription}</DialogDescription>
        </DialogHeader>

        {sharePrivateConfirm ? (
          <div className="grid gap-3 rounded-md border border-warn/40 bg-warn-soft p-3 text-sm leading-5 text-warn-text">
            <p>{t.sharePrivateWarning}</p>
            <div>
              <Button onClick={() => void createShareLink()}>{t.visibilityConfirm}</Button>
            </div>
          </div>
        ) : linkField === "revoked" ? (
          <div role="status" className="grid gap-3 rounded-md border border-line bg-surface-2 p-3 text-sm leading-5">
            <p>{t.shareDialogRevokedState}</p>
            <div>
              <Button disabled={busy} onClick={() => void createShareLink()}>
                {t.shareDialogCreateNew}
              </Button>
            </div>
          </div>
        ) : (
          <div className="grid gap-1.5">
            <Label htmlFor={`${ids}-link`}>{t.shareDialogLinkLabel}</Label>
            <Input
              id={`${ids}-link`}
              dir="ltr"
              readOnly
              value={shareLink || t.shareDialogCreating}
              onFocus={(event) => event.currentTarget.select()}
            />
          </div>
        )}

        {linkReady && shareSections ? (
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">{t.shareDialogSectionsLegend}</legend>
            <div className="grid grid-cols-2 gap-2">
              {TEXT_SECTIONS.map(({ section, key }) => (
                <label key={section} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={shareSections.includes(section)}
                    disabled={busy}
                    onCheckedChange={(checked) => void toggleSection(section, Boolean(checked))}
                  />
                  {t[key]}
                </label>
              ))}
            </div>
            {meeting.mediaAssets?.length ? (
              <label className="mt-1 flex items-start gap-2.5 text-sm">
                <Checkbox
                  className="mt-0.5"
                  checked={shareSections.includes("media")}
                  disabled={busy}
                  onCheckedChange={(checked) => void toggleSection("media", Boolean(checked))}
                />
                <span className="grid">
                  <span className="font-medium">{t.shareIncludeRecording}</span>
                  <span className="text-xs text-fg-3">{t.shareIncludeRecordingHint}</span>
                </span>
              </label>
            ) : null}
          </fieldset>
        ) : null}

        {linkReady ? (
          <div className="grid gap-2 rounded-md border border-line p-3">
            <label className="flex items-center justify-between gap-3 text-sm font-medium">
              {t.shareDialogPasswordToggle}
              <Switch
                checked={passwordOn}
                disabled={busy}
                onCheckedChange={(checked) => {
                  setPasswordError(null)
                  if (checked) setEditingPassword(true)
                  else if (passwordProtected) void removePassword()
                  else setEditingPassword(false)
                }}
              />
            </label>
            {passwordProtected && !editingPassword ? (
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="text-fg-2">{t.shareDialogPasswordProtected}</span>
                <span className="flex gap-2">
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditingPassword(true)}>
                    {t.shareDialogPasswordChange}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void removePassword()}>
                    {t.shareDialogPasswordRemove}
                  </Button>
                </span>
              </div>
            ) : null}
            {editingPassword ? (
              <form className="grid gap-1.5" onSubmit={(event) => void savePassword(event)}>
                <Label htmlFor={`${ids}-password`}>{t.shareDialogPasswordLabel}</Label>
                <div className="flex gap-2">
                  <Input
                    id={`${ids}-password`}
                    type="password"
                    autoComplete="new-password"
                    dir="auto"
                    autoFocus
                    value={password}
                    maxLength={256}
                    aria-invalid={passwordError ? true : undefined}
                    aria-describedby={passwordError ? passwordErrorId : `${ids}-password-hint`}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                  <Button type="submit" disabled={busy || !password}>
                    {t.shareDialogPasswordSave}
                  </Button>
                </div>
                {passwordError ? (
                  <p id={passwordErrorId} role="alert" className="text-xs text-danger-text">
                    {t[passwordError]}
                  </p>
                ) : (
                  <p id={`${ids}-password-hint`} className="text-xs text-fg-3">
                    {t.shareDialogPasswordHint}
                  </p>
                )}
              </form>
            ) : null}
          </div>
        ) : null}

        {!hasSummary ? (
          <p className="rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-xs leading-5 text-warn-text">
            {t.shareDialogNoSummary}
          </p>
        ) : null}

        <DialogFooter>
          <Button
            variant="destructive"
            disabled={!linkReady || busy}
            title={t.shareDialogRevokeHint}
            onClick={() => setRevokeConfirmOpen(true)}
          >
            {t.shareDialogRevoke}
          </Button>
          <Button
            variant="outline"
            disabled={!linkReady || busy}
            title={t.shareDialogRegenerateHint}
            onClick={() => void regenerateShareLink()}
          >
            {t.shareDialogRegenerate}
          </Button>
          <Button variant="outline" disabled={!linkReady} onClick={() => window.open(shareLink, "_blank", "noopener")}>
            {t.shareDialogOpen}
          </Button>
          <Button disabled={!linkReady} onClick={() => void copyLink()}>
            {t.shareDialogCopyLink}
          </Button>
        </DialogFooter>
        <ConfirmDialog
          open={revokeConfirmOpen}
          onOpenChange={setRevokeConfirmOpen}
          title={t.shareDialogRevokeConfirmTitle}
          description={t.shareDialogRevokeConfirmDescription}
          confirmLabel={t.shareDialogRevoke}
          destructive
          onConfirm={() => revokeShareLink()}
        />
      </DialogContent>
    </Dialog>
  )
}
