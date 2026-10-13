"use client"

/**
 * The shell's meeting dialogs (docs/parity/m9.md D2): RealizeOS payload
 * preview, participants and tags. They replace the shell's hand-built full-screen
 * overlays with the shadcn Dialog (focus trap, Esc, focus back to the
 * opener) and load on first open (`next/dynamic` in the shell).
 */
import { useId } from "react"

import { localizeSpeakerLabel } from "@/components/speaker-display"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { MeetingParticipant, MeetingRecord } from "@/lib/meetings/repository"

type ShellDialogDictionary = Pick<
  Dictionary,
  | "shellClose"
  | "shellSave"
  | "shellLoading"
  | "shellPromptCancel"
  | "shellPayloadTitle"
  | "shellPayloadDescription"
  | "shellPayloadCopy"
  | "shellPayloadSend"
  | "shellParticipantsTitle"
  | "shellParticipantsDescription"
  | "shellParticipantName"
  | "shellParticipantEmail"
  | "shellParticipantsEmpty"
  | "shellTagsTitle"
  | "shellTagsDescription"
  | "shellTagsLabel"
  | "shellTagsSave"
  | "speakersTitle"
  | "speakersGenericLabel"
>

export function PayloadPreviewDialog({
  dictionary,
  open,
  onOpenChange,
  payload,
  loading,
  exporting,
  onCopy,
  onSend,
}: {
  dictionary: ShellDialogDictionary
  open: boolean
  onOpenChange: (open: boolean) => void
  payload: string
  loading: boolean
  exporting: boolean
  onCopy: () => void
  onSend: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{dictionary.shellPayloadTitle}</DialogTitle>
          <DialogDescription>{dictionary.shellPayloadDescription}</DialogDescription>
        </DialogHeader>
        <div className="ms-scrollbar min-h-0 flex-1 overflow-auto rounded-md border border-line bg-surface-2 p-3">
          {loading ? (
            <p className="text-sm text-muted-foreground">{dictionary.shellLoading}</p>
          ) : (
            <pre dir="ltr" className="whitespace-pre-wrap text-start font-mono text-xs leading-5 text-fg-2">
              {payload}
            </pre>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCopy} disabled={loading}>
            {dictionary.shellPayloadCopy}
          </Button>
          <Button onClick={onSend} disabled={exporting || loading}>
            {dictionary.shellPayloadSend}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ParticipantsDialog({
  dictionary,
  open,
  onOpenChange,
  meeting,
  participants,
  onChange,
  onSave,
}: {
  dictionary: ShellDialogDictionary
  open: boolean
  onOpenChange: (open: boolean) => void
  meeting: MeetingRecord | null
  participants: MeetingParticipant[]
  onChange: (participant: MeetingParticipant) => void
  onSave: (participant: MeetingParticipant) => void
}) {
  const baseId = useId()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{dictionary.shellParticipantsTitle}</DialogTitle>
          <DialogDescription>{dictionary.shellParticipantsDescription}</DialogDescription>
        </DialogHeader>
        <div className="ms-scrollbar grid max-h-[55vh] gap-3 overflow-y-auto">
          {participants.length ? (
            participants.map((participant) => {
              const nameId = `${baseId}-${participant.id}-name`
              const emailId = `${baseId}-${participant.id}-email`
              const mapped = (meeting?.speakers ?? []).filter(
                (speaker) => speaker.participantId === participant.id && speaker.mappingStatus === "confirmed"
              )

              return (
                <div
                  key={participant.id}
                  className="grid gap-2 rounded-md border border-line p-3 md:grid-cols-[1fr_1fr_110px_auto]"
                >
                  <div className="grid gap-1">
                    <Label htmlFor={nameId} className="text-xs text-muted-foreground">
                      {dictionary.shellParticipantName}
                    </Label>
                    <Input
                      id={nameId}
                      dir="auto"
                      value={participant.name}
                      onChange={(event) => onChange({ ...participant, name: event.target.value })}
                    />
                  </div>
                  <div className="grid gap-1">
                    <Label htmlFor={emailId} className="text-xs text-muted-foreground">
                      {dictionary.shellParticipantEmail}
                    </Label>
                    <Input
                      id={emailId}
                      type="email"
                      dir="ltr"
                      value={participant.email ?? ""}
                      onChange={(event) => onChange({ ...participant, email: event.target.value })}
                    />
                  </div>
                  <div className="grid gap-1 text-xs font-medium text-muted-foreground">
                    {dictionary.speakersTitle}
                    <span className="flex min-h-9 items-center rounded-md border border-dashed border-line px-3 text-sm text-foreground">
                      {mapped.length ? (
                        <bdi>
                          {mapped
                            .map((speaker) => localizeSpeakerLabel(speaker.label, dictionary.speakersGenericLabel))
                            .join(", ")}
                        </bdi>
                      ) : (
                        "—"
                      )}
                    </span>
                  </div>
                  <Button variant="outline" className="self-end" onClick={() => onSave(participant)}>
                    {dictionary.shellSave}
                  </Button>
                </div>
              )
            })
          ) : (
            <div className="rounded-md border border-dashed border-line p-4 text-sm text-muted-foreground">
              {dictionary.shellParticipantsEmpty}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function TagsDialog({
  dictionary,
  open,
  onOpenChange,
  value,
  onValueChange,
  onSave,
}: {
  dictionary: ShellDialogDictionary
  open: boolean
  onOpenChange: (open: boolean) => void
  value: string
  onValueChange: (value: string) => void
  onSave: () => void
}) {
  const fieldId = useId()
  const hintId = useId()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            onSave()
          }}
        >
          <DialogHeader>
            <DialogTitle>{dictionary.shellTagsTitle}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor={fieldId}>{dictionary.shellTagsLabel}</Label>
            <Textarea
              id={fieldId}
              dir="auto"
              autoFocus
              aria-describedby={hintId}
              className="min-h-28"
              value={value}
              onChange={(event) => onValueChange(event.target.value)}
            />
            <p id={hintId} className="text-sm text-muted-foreground">
              {dictionary.shellTagsDescription}
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {dictionary.shellPromptCancel}
            </Button>
            <Button type="submit">{dictionary.shellTagsSave}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
