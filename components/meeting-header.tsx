"use client"

import { useState } from "react"
import {
  CalendarIcon,
  ClockIcon,
  EllipsisIcon,
  PencilIcon,
  Share2Icon,
  StarIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react"

import { MeetingVisibilityControl } from "@/components/meeting-visibility-control"
import { directionForLanguage } from "@/components/speaker-display"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { formatMessage, type Dictionary } from "@/lib/i18n/dictionaries"
import type { SupportedLocale } from "@/lib/i18n/locales"
import type { MeetingRecord, MeetingVisibility } from "@/lib/meetings/repository"
import { formatDurationShort, meetingDurationMs } from "@/lib/player/time-format"

function sourceLabel(source: MeetingRecord["source"]) {
  if (source === "google_meet") return "Google Meet"
  if (source === "pwa_recorder") return "Recorder"
  if (source === "desktop_recorder") return "Desktop recorder"
  if (source === "upload") return "Upload"
  return source.replaceAll("_", " ")
}

const TITLE_MAX = 200

export function MeetingHeader({
  meeting,
  locale,
  onShare,
  onToggleFavorite,
  onShowParticipants,
  onAddToRoom,
  dictionary,
  onVisibilityChanged,
  canWrite = false,
  canManage = false,
  onRename,
  onDelete,
}: {
  meeting: MeetingRecord
  dictionary?: Dictionary
  onVisibilityChanged?: (visibility: MeetingVisibility) => void
  locale: SupportedLocale
  onShare?: () => void
  onToggleFavorite?: () => void
  onShowParticipants?: () => void
  onAddToRoom?: () => void
  /** `meeting:write`: rename. */
  canWrite?: boolean
  /** `canManageMeeting`: delete. */
  canManage?: boolean
  onRename?: (title: string) => Promise<boolean>
  onDelete?: () => Promise<boolean>
}) {
  const [renameOpen, setRenameOpen] = useState(false)
  const [titleDraft, setTitleDraft] = useState(meeting.title)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const formatter = new Intl.DateTimeFormat(locale === "he" ? "he-IL" : locale, {
    dateStyle: "medium",
    timeStyle: "short",
  })
  const room = meeting.contexts?.[0]?.name ?? "No room"
  const participantCount =
    meeting.participantDetails?.length || meeting.participants.length || 0
  const durationMs = meetingDurationMs(meeting)
  const titleDir = directionForLanguage(meeting.language) ?? "auto"
  const showMenu = Boolean(dictionary && ((canWrite && onRename) || (canManage && onDelete)))
  const trimmedTitle = titleDraft.trim()

  const submitRename = async () => {
    if (!onRename || !trimmedTitle || trimmedTitle.length > TITLE_MAX) return
    if (trimmedTitle === meeting.title) {
      setRenameOpen(false)
      return
    }
    setBusy(true)
    const ok = await onRename(trimmedTitle)

    setBusy(false)
    if (ok) setRenameOpen(false)
  }

  const confirmDelete = async () => {
    if (!onDelete) return
    setBusy(true)
    const ok = await onDelete()

    setBusy(false)
    if (ok) setDeleteOpen(false)
  }

  return (
    <header className="border-b border-line bg-surface px-5 py-4 md:px-7">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary" className="rounded-md bg-brand-soft text-brand-text">
              {sourceLabel(meeting.source)}
            </Badge>
            {dictionary && onVisibilityChanged ? (
              <MeetingVisibilityControl
                meeting={meeting}
                dictionary={dictionary}
                onChanged={onVisibilityChanged}
                onRequestShare={() => onShare?.()}
              />
            ) : null}
            <h1
              dir={titleDir}
              className="break-words text-lg font-semibold tracking-tight text-foreground md:text-xl"
            >
              {meeting.title}
            </h1>
            <button
              className="rounded p-0.5 text-warn hover:bg-surface-2"
              onClick={onToggleFavorite}
              title={meeting.isFavorite ? "Remove favorite" : "Add favorite"}
              aria-label={meeting.isFavorite ? "Remove favorite" : "Add favorite"}
              aria-pressed={Boolean(meeting.isFavorite)}
              type="button"
            >
              <StarIcon
                aria-hidden="true"
                className={meeting.isFavorite ? "size-4 fill-current" : "size-4"}
              />
            </button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
            <span className="flex items-center gap-2">
              <CalendarIcon aria-hidden="true" className="size-4" />
              {formatter.format(new Date(meeting.startedAt))}
            </span>
            <span className="flex items-center gap-2">
              <ClockIcon aria-hidden="true" className="size-4" />
              <span className="[unicode-bidi:isolate]">{formatDurationShort(durationMs, locale)}</span>
            </span>
            <div className="group relative">
              <button
                className="flex items-center gap-2 rounded text-start hover:text-foreground"
                onClick={onShowParticipants}
                type="button"
              >
                <UsersIcon aria-hidden="true" className="size-4" />
                {participantCount || 0} participants
              </button>
              {meeting.participantDetails?.length ? (
                <div className="pointer-events-none absolute start-0 top-full z-50 mt-2 hidden min-w-60 max-w-sm rounded-lg border border-line bg-surface p-3 shadow-lg group-hover:pointer-events-auto group-hover:block">
                  <div className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground">
                    Participants
                  </div>
                  <div className="grid gap-1.5">
                    {meeting.participantDetails.slice(0, 12).map((p) => (
                      <div key={p.id} className="flex items-center justify-between gap-2 text-xs">
                        <div className="min-w-0">
                          <bdi className="font-medium text-foreground">{p.name}</bdi>
                          {p.email ? (
                            <bdi className="ms-1 text-muted-foreground">{p.email}</bdi>
                          ) : null}
                        </div>
                        <span className={`shrink-0 rounded-sm px-1.5 py-0.5 text-2xs ${
                          p.role === "organizer"
                            ? "bg-brand/10 text-brand-text"
                            : p.attendanceStatus === "accepted"
                              ? "bg-ok/10 text-ok-text"
                              : p.attendanceStatus === "declined"
                                ? "bg-destructive/10 text-destructive"
                                : "bg-surface-2/50 text-muted-foreground"
                        }`}>
                          {p.role === "organizer" ? "organizer" : p.attendanceStatus}
                        </span>
                      </div>
                    ))}
                    {meeting.participantDetails.length > 12 ? (
                      <div className="text-xs text-muted-foreground">
                        +{meeting.participantDetails.length - 12} more
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2.5 text-sm">
            <span className="flex items-center gap-2 text-muted-foreground">
              <span className="size-2 rounded-full bg-ok" />
              <bdi>{room}</bdi>
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-7 rounded-md border-line bg-brand-soft text-brand-text"
              onClick={onAddToRoom}
            >
              Add to room
            </Button>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" className="h-8" onClick={onShare}>
            <Share2Icon data-icon="inline-start" />
            Share
          </Button>
          {showMenu && dictionary ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="secondary"
                    size="icon-sm"
                    className="size-8"
                    aria-label={dictionary.meetingActions}
                    title={dictionary.meetingActions}
                  />
                }
              >
                <EllipsisIcon aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-48">
                {canWrite && onRename ? (
                  <DropdownMenuItem
                    onClick={() => {
                      setTitleDraft(meeting.title)
                      setRenameOpen(true)
                    }}
                  >
                    <PencilIcon />
                    {dictionary.meetingRename}
                  </DropdownMenuItem>
                ) : null}
                {canManage && onDelete ? (
                  <>
                    {canWrite && onRename ? <DropdownMenuSeparator /> : null}
                    <DropdownMenuItem variant="destructive" onClick={() => setDeleteOpen(true)}>
                      <Trash2Icon />
                      {dictionary.meetingDelete}
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>

      {dictionary ? (
        <>
          <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
            <DialogContent>
              <form
                className="grid gap-4"
                onSubmit={(event) => {
                  event.preventDefault()
                  void submitRename()
                }}
              >
                <DialogHeader>
                  <DialogTitle>{dictionary.meetingRenameTitle}</DialogTitle>
                </DialogHeader>
                <label className="grid gap-1.5 text-sm font-medium">
                  {dictionary.meetingRenameLabel}
                  <Input
                    dir="auto"
                    autoFocus
                    value={titleDraft}
                    maxLength={TITLE_MAX}
                    onChange={(event) => setTitleDraft(event.target.value)}
                  />
                </label>
                <DialogFooter>
                  <Button type="submit" disabled={busy || !trimmedTitle}>
                    {dictionary.meetingRenameSave}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
          <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {formatMessage(dictionary.meetingDeleteTitle, { title: meeting.title })}
                </AlertDialogTitle>
                <AlertDialogDescription>{dictionary.meetingDeleteDescription}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{dictionary.cancel}</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  disabled={busy}
                  onClick={() => void confirmDelete()}
                >
                  {dictionary.meetingDeleteConfirm}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      ) : null}
    </header>
  )
}
