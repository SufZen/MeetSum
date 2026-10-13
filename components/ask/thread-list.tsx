"use client"

/**
 * The caller's private Ask conversations for the current scope: open,
 * rename, archive, delete (AlertDialog).
 */
import { useState } from "react"
import { ArchiveIcon, MoreHorizontalIcon, PencilIcon, Trash2Icon } from "lucide-react"

import type { ThreadsState } from "@/components/ask/use-threads"
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
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import type { ThreadSummary } from "@/lib/ask/types"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import { cn } from "@/lib/utils"

export function ThreadList({
  state,
  activeThreadId,
  dictionary: t,
  onOpen,
  onRename,
  onArchive,
  onDelete,
}: {
  state: ThreadsState
  activeThreadId: string | null
  dictionary: Dictionary
  onOpen: (thread: ThreadSummary) => void
  onRename: (id: string, title: string) => Promise<boolean>
  onArchive: (id: string) => Promise<boolean>
  onDelete: (id: string) => Promise<boolean>
}) {
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null)
  const [deleting, setDeleting] = useState<ThreadSummary | null>(null)
  const [busy, setBusy] = useState(false)

  if (state.status === "unavailable") return null

  return (
    <nav aria-label={t.askThreads} className="grid gap-1.5">
      <p className="text-xs text-fg-3">{t.askThreadsPrivate}</p>
      {state.status === "error" ? <p className="text-sm text-danger-text">{t.askThreadsLoadError}</p> : null}
      {state.status === "ready" && !state.threads.length ? (
        <p className="text-sm text-fg-3">{t.askThreadsEmpty}</p>
      ) : null}
      {state.status === "loading" ? (
        <div aria-busy="true" className="grid gap-1.5">
          <div className="h-8 animate-pulse rounded-md bg-surface-2" />
          <div className="h-8 animate-pulse rounded-md bg-surface-2" />
        </div>
      ) : null}
      <ul className="grid gap-0.5">
        {state.threads.map((thread) => {
          const active = thread.id === activeThreadId

          if (renaming?.id === thread.id) {
            return (
              <li key={thread.id}>
                <form
                  className="flex items-center gap-1"
                  onSubmit={(event) => {
                    event.preventDefault()
                    const title = renaming.title.trim()

                    if (!title) return
                    setBusy(true)
                    void onRename(thread.id, title).finally(() => {
                      setBusy(false)
                      setRenaming(null)
                    })
                  }}
                >
                  <Input
                    dir="auto"
                    autoFocus
                    aria-label={t.askThreadRenameLabel}
                    value={renaming.title}
                    maxLength={120}
                    onChange={(event) => setRenaming({ id: thread.id, title: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setRenaming(null)
                    }}
                    className="h-8"
                  />
                  <Button type="submit" size="sm" variant="secondary" disabled={busy}>
                    {t.askSave}
                  </Button>
                </form>
              </li>
            )
          }

          return (
            <li key={thread.id} className="group/thread flex items-center gap-1">
              <button
                type="button"
                aria-current={active ? "true" : undefined}
                onClick={() => onOpen(thread)}
                className={cn(
                  "min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-start text-sm transition-colors duration-(--dur-1) focus-visible:shadow-focus focus-visible:outline-2 focus-visible:outline-transparent",
                  active ? "bg-brand-soft font-medium text-brand-text" : "text-fg-2 hover:bg-surface-3"
                )}
              >
                <bdi>{thread.title?.trim() || t.askThreadUntitled}</bdi>
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={<Button size="icon-xs" variant="ghost" aria-label={t.askThreadMenu} />}
                >
                  <MoreHorizontalIcon />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => setRenaming({ id: thread.id, title: thread.title ?? "" })}>
                    <PencilIcon aria-hidden />
                    {t.askThreadRename}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void onArchive(thread.id)}>
                    <ArchiveIcon aria-hidden />
                    {t.askThreadArchive}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => setDeleting(thread)}>
                    <Trash2Icon aria-hidden />
                    {t.askThreadDelete}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          )
        })}
      </ul>

      <AlertDialog open={Boolean(deleting)} onOpenChange={(open) => !busy && !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t.askThreadDeleteTitle}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting ? (
                <>
                  <bdi className="font-medium text-fg">{deleting.title?.trim() || t.askThreadUntitled}</bdi>
                  {" — "}
                </>
              ) : null}
              {t.askThreadDeleteBody}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t.askCancel}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={() => {
                if (!deleting) return
                setBusy(true)
                void onDelete(deleting.id).finally(() => {
                  setBusy(false)
                  setDeleting(null)
                })
              }}
            >
              {t.askThreadDeleteConfirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </nav>
  )
}
