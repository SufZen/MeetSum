"use client"

/**
 * Notifications bell (docs/parity/m9.md C1), mounted in `top-command-bar`.
 * An icon button labelled with the unread count ("3 התראות שלא נקראו"), a
 * visible count capped at "9+" plus a dot (never colour alone). Polls
 * `/api/notifications/unread-count` with its weak ETag via `nextPollDelay`
 * (no polling while the tab is hidden; 60 s otherwise) and refetches on focus.
 * A polite live region announces a count increase once. The popover lists
 * the latest notifications, marks one read on open and offers "mark all read".
 */
import { BellIcon } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { useI18n } from "@/components/i18n-provider"
import { NotificationItem } from "@/components/notifications/notification-item"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { nextPollDelay } from "@/lib/client/polling"
import type { NotificationDTO } from "@/lib/notifications/types"

type ListResponse = { notifications: NotificationDTO[]; nextCursor: string | null }

const PAGE = 20

export function NotificationBell({ locale }: { locale: string }) {
  const i18n = useI18n()
  const [count, setCount] = useState<number | null>(null)
  const [announcement, setAnnouncement] = useState("")
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<NotificationDTO[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle")
  const [accepting, setAccepting] = useState<string | null>(null)
  const etagRef = useRef<string | null>(null)
  const countRef = useRef<number | null>(null)

  const applyCount = useCallback(
    (next: number) => {
      const previous = countRef.current

      countRef.current = next
      setCount(next)
      if (previous !== null && next > previous) {
        setAnnouncement(i18n.plural("notifNew", next - previous, { count: i18n.fmt.number(next - previous) }))
      }
    },
    [i18n]
  )

  const refreshCount = useCallback(async () => {
    try {
      const response = await fetch("/api/notifications/unread-count", {
        headers: etagRef.current ? { "if-none-match": etagRef.current } : {},
        cache: "no-store",
      })

      if (response.status === 304 || !response.ok) return
      etagRef.current = response.headers.get("etag")
      applyCount(((await response.json()) as { count: number }).count)
    } catch {
      // Offline or signed out: keep the last count.
    }
  }, [applyCount])

  useEffect(() => {
    let timer: number | undefined
    let cancelled = false

    const schedule = () => {
      window.clearTimeout(timer)
      const delay = nextPollDelay({ activeJobs: 0, selectedProcessing: false, hidden: document.visibilityState === "hidden" })

      if (delay !== null && !cancelled) {
        timer = window.setTimeout(() => {
          void refreshCount().finally(schedule)
        }, delay)
      }
    }
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshCount().finally(schedule)
      else window.clearTimeout(timer)
    }
    const onFocus = () => void refreshCount()

    void refreshCount().finally(schedule)
    document.addEventListener("visibilitychange", onVisible)
    window.addEventListener("focus", onFocus)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
      document.removeEventListener("visibilitychange", onVisible)
      window.removeEventListener("focus", onFocus)
    }
  }, [refreshCount])

  const load = useCallback(
    async (after: string | null) => {
      setStatus("loading")
      try {
        const params = new URLSearchParams({ limit: String(PAGE), locale })

        if (after) params.set("cursor", after)

        const response = await fetch(`/api/notifications?${params.toString()}`, { cache: "no-store" })

        if (!response.ok) throw new Error(String(response.status))

        const body = (await response.json()) as ListResponse

        setItems((current) => (after ? [...current, ...body.notifications] : body.notifications))
        setCursor(body.nextCursor)
        setStatus("idle")
      } catch {
        setStatus("error")
      }
    },
    [locale]
  )

  const onOpenChange = (next: boolean) => {
    setOpen(next)
    if (next) void load(null)
  }

  const markRead = useCallback(
    async (body: { ids: string[] } | { all: true }) => {
      const response = await fetch("/api/notifications/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => undefined)

      if (response?.ok) {
        const result = (await response.json()) as { unread: number }

        countRef.current = result.unread
        setCount(result.unread)
        etagRef.current = null
      }
    },
    []
  )

  const markAllRead = async () => {
    const stamp = new Date().toISOString()

    setItems((current) => current.map((item) => ({ ...item, readAt: item.readAt ?? stamp })))
    await markRead({ all: true })
  }

  const onOpenItem = (notification: NotificationDTO) => {
    if (!notification.readAt) void markRead({ ids: [notification.id] })
  }

  const onAcceptInvitation = async (notification: NotificationDTO) => {
    const invitationId = String(notification.payload.invitationId ?? "")

    setAccepting(notification.id)
    try {
      const response = await fetch(`/api/me/invitations/${encodeURIComponent(invitationId)}/accept`, { method: "POST" })

      if (response.ok) {
        const body = (await response.json()) as { workspace: { name: string } }

        toast.success(i18n.t("notifInvitationAccepted", { workspace: body.workspace.name }))
        await markRead({ ids: [notification.id] })
        window.location.assign(`/${locale}`)
      } else {
        toast.error(i18n.t("notifInvitationUnavailable"))
        await markRead({ ids: [notification.id] })
      }
    } finally {
      setAccepting(null)
    }
  }

  const unread = count ?? 0
  const label = unread > 0 ? i18n.plural("notifBellUnread", unread, { count: i18n.fmt.number(unread) }) : i18n.t("notifBellLabel")
  const visibleCount = unread > 9 ? i18n.t("notifBellOverflow") : i18n.fmt.number(unread)

  return (
    <>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="relative rounded-full"
              aria-label={label}
              title={label}
              data-testid="notification-bell"
            />
          }
        >
          <BellIcon aria-hidden className="size-5" />
          {unread > 0 ? (
            <span
              aria-hidden
              className="absolute -end-1 -top-1 flex h-4 min-w-4 items-center justify-center gap-0.5 rounded-full border border-line bg-surface px-1 font-mono text-xs leading-none text-fg tabular-nums"
            >
              <span className="size-1.5 rounded-full bg-brand" />
              <span dir="ltr">{visibleCount}</span>
            </span>
          ) : null}
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80 gap-2 p-2">
          <div className="flex items-center justify-between gap-2 px-1">
            <h2 className="text-sm font-semibold text-fg">{i18n.t("notifTitle")}</h2>
            <Button variant="ghost" size="sm" disabled={unread === 0} onClick={() => void markAllRead()}>
              {i18n.t("notifMarkAllRead")}
            </Button>
          </div>
          {status === "error" ? (
            <div className="grid justify-items-start gap-2 p-2 text-sm text-fg-2">
              <p>{i18n.t("notifLoadFailed")}</p>
              <Button variant="outline" size="sm" onClick={() => void load(null)}>
                {i18n.t("notifRetry")}
              </Button>
            </div>
          ) : items.length === 0 && status !== "loading" ? (
            <p className="p-3 text-center text-sm text-fg-3">{i18n.t("notifEmpty")}</p>
          ) : (
            <ul className="grid max-h-96 gap-0.5 overflow-y-auto" aria-busy={status === "loading"}>
              {items.map((notification) => (
                <NotificationItem
                  key={notification.id}
                  notification={notification}
                  onOpen={onOpenItem}
                  onAcceptInvitation={(item) => void onAcceptInvitation(item)}
                  accepting={accepting === notification.id}
                />
              ))}
            </ul>
          )}
          {cursor && status !== "error" ? (
            <Button variant="ghost" size="sm" disabled={status === "loading"} onClick={() => void load(cursor)}>
              {i18n.t("notifLoadMore")}
            </Button>
          ) : null}
        </PopoverContent>
      </Popover>
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </>
  )
}
