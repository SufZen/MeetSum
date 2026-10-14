"use client"

/**
 * Notifications popover (docs/parity/m9.md C1). Mounted on intent by
 * `NotificationBellHost` (M10 C bundle diet), which owns the unread count, its
 * polling and the live region, and renders the same button until then. The
 * popover lists the latest notifications, marks one read on open and offers
 * "mark all read"; mark-read answers report the new count to the host.
 */
import { useCallback, useEffect, useId, useState, type ReactNode } from "react"
import { toast } from "sonner"

import { useI18n } from "@/components/i18n-provider"
import { bellButtonProps } from "@/components/notifications/notification-bell-host"
import { NotificationItem } from "@/components/notifications/notification-item"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { NotificationDTO } from "@/lib/notifications/types"

type ListResponse = { notifications: NotificationDTO[]; nextCursor: string | null }

const PAGE = 20

export function NotificationBell({
  locale,
  unread,
  label,
  face,
  defaultOpen = false,
  onUnreadChange,
}: {
  locale: string
  unread: number
  /** The button's accessible name (the unread count). */
  label: string
  /** The bell icon and badge, rendered by the host. */
  face: ReactNode
  defaultOpen?: boolean
  onUnreadChange: (unread: number) => void
}) {
  const i18n = useI18n()
  const titleId = useId()
  const [open, setOpen] = useState(defaultOpen)
  const [items, setItems] = useState<NotificationDTO[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [status, setStatus] = useState<"idle" | "loading" | "error">(defaultOpen ? "loading" : "idle")
  const [accepting, setAccepting] = useState<string | null>(null)

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

        onUnreadChange(result.unread)
      }
    },
    [onUnreadChange]
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

  // Opened by the click that mounted it: load the list once.
  const openedOnMount = defaultOpen
  useEffect(() => {
    if (openedOnMount) queueMicrotask(() => void load(null))
  }, [openedOnMount, load])

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger render={<Button {...bellButtonProps(label)} />}>{face}</PopoverTrigger>
      <PopoverContent align="end" className="w-80 gap-2 p-2" aria-labelledby={titleId}>
        <div className="flex items-center justify-between gap-2 px-1">
          <h2 id={titleId} className="text-sm font-semibold text-fg">
            {i18n.t("notifTitle")}
          </h2>
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
  )
}
