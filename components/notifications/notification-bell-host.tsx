"use client"

/**
 * The always-mounted half of the notifications bell (M10 C bundle diet):
 * polls `/api/notifications/unread-count` with its weak ETag via
 * `nextPollDelay` (no polling while the tab is hidden; 60 s otherwise),
 * refetches on focus, announces a count increase once in a polite live
 * region, and renders the bell button. The popover (`NotificationBell`, with
 * the list, mark-read and the floating-ui stack) loads on intent.
 */
import { BellIcon } from "lucide-react"
import { lazy, useCallback, useEffect, useRef, useState, type ComponentProps } from "react"

import { useI18n } from "@/components/i18n-provider"
import { Button } from "@/components/ui/button"
import { Deferred } from "@/components/ui/deferred"
import { nextPollDelay } from "@/lib/client/polling"

const loadBell = () => import("@/components/notifications/notification-bell")
const NotificationBell = lazy(() => loadBell().then((mod) => ({ default: mod.NotificationBell })))

/** The bell icon plus the unread badge (count capped at "9+", with a dot: never colour alone). */
export function BellFace({ unread, visibleCount }: { unread: number; visibleCount: string }) {
  return (
    <>
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
    </>
  )
}

/** Props shared by the static and the real bell button. */
export function bellButtonProps(label: string): Partial<ComponentProps<typeof Button>> & { "data-testid": string } {
  return {
    variant: "ghost",
    size: "icon",
    className: "relative rounded-full",
    "aria-label": label,
    title: label,
    "data-testid": "notification-bell",
  }
}

export function NotificationBellHost({ locale }: { locale: string }) {
  const i18n = useI18n()
  const [count, setCount] = useState<number | null>(null)
  const [announcement, setAnnouncement] = useState("")
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

  /** A mark-read answer: the server's unread count, no announcement. */
  const onUnreadChange = useCallback((next: number) => {
    countRef.current = next
    setCount(next)
    etagRef.current = null
  }, [])

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

  const unread = count ?? 0
  const label = unread > 0 ? i18n.plural("notifBellUnread", unread, { count: i18n.fmt.number(unread) }) : i18n.t("notifBellLabel")
  const visibleCount = unread > 9 ? i18n.t("notifBellOverflow") : i18n.fmt.number(unread)
  const face = <BellFace unread={unread} visibleCount={visibleCount} />

  return (
    <>
      <Deferred
        popup="dialog"
        preload={loadBell}
        placeholder={(props) => (
          <Button {...bellButtonProps(label)} aria-busy={props ? undefined : true} {...props}>
            {face}
          </Button>
        )}
      >
        {({ defaultOpen }) => (
          <NotificationBell
            locale={locale}
            unread={unread}
            label={label}
            face={face}
            defaultOpen={defaultOpen}
            onUnreadChange={onUnreadChange}
          />
        )}
      </Deferred>
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </>
  )
}
