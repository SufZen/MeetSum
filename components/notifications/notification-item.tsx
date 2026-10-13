"use client"

/**
 * One notification row (docs/parity/m9.md C1): kind icon, a dictionary
 * sentence with names, titles and workspaces in <bdi> (titles typeset with
 * `text()`), a relative time inside <time> (absolute until mounted), and the
 * unread state as a dot, bold text and a screen-reader label (never colour
 * alone). Invitations get an inline accept button.
 */
import {
  AtSignIcon,
  BotIcon,
  CircleCheckIcon,
  ListTodoIcon,
  MessageSquareIcon,
  PlugIcon,
  TriangleAlertIcon,
  UserPlusIcon,
  type LucideIcon,
} from "lucide-react"

import { useI18n, useNow } from "@/components/i18n-provider"
import { Button } from "@/components/ui/button"
import { notificationSentence } from "@/lib/notifications/render"
import type { NotificationDTO, NotificationKind } from "@/lib/notifications/types"
import { cn } from "@/lib/utils"

const ICONS: Record<NotificationKind, LucideIcon> = {
  mention: AtSignIcon,
  reply: MessageSquareIcon,
  task_assigned: ListTodoIcon,
  integration_reauth: PlugIcon,
  invited: UserPlusIcon,
  meeting_processed: CircleCheckIcon,
  meeting_failed: TriangleAlertIcon,
  bot_blocked: BotIcon,
}

export function NotificationItem({
  notification,
  onOpen,
  onAcceptInvitation,
  accepting,
}: {
  notification: NotificationDTO
  onOpen: (notification: NotificationDTO) => void
  onAcceptInvitation: (notification: NotificationDTO) => void
  accepting: boolean
}) {
  const i18n = useI18n()
  const now = useNow()
  const Icon = ICONS[notification.kind]
  const unread = !notification.readAt
  const parts = notificationSentence(notification, i18n.t)
  const when = now ? i18n.fmt.relative(notification.createdAt, now) : i18n.fmt.date(notification.createdAt, "dateTime")
  const sentence = (
    <span className={cn("min-w-0 text-sm leading-snug text-fg", unread ? "font-semibold" : "font-normal")}>
      {parts.map((part, index) =>
        "text" in part ? (
          <span key={index}>{part.text}</span>
        ) : (
          <bdi key={index} lang={part.slot === "meeting" ? part.lang ?? undefined : undefined}>
            {part.slot === "meeting" ? i18n.text(part.value, part.lang) : part.value}
          </bdi>
        )
      )}
    </span>
  )
  const body = (
    <>
      <span className="relative mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-surface-3 text-fg-2">
        <Icon aria-hidden className="size-3.5" />
        {unread ? <span aria-hidden className="absolute -end-0.5 -top-0.5 size-2 rounded-full bg-brand" /> : null}
      </span>
      <span className="grid min-w-0 flex-1 gap-0.5">
        {unread ? <span className="sr-only">{i18n.t("notifUnread")}</span> : null}
        {sentence}
        <time dateTime={notification.createdAt} className="text-xs text-fg-3">
          {when}
        </time>
      </span>
    </>
  )

  return (
    <li className="grid gap-1.5">
      {notification.href ? (
        <a
          href={notification.href}
          onClick={() => onOpen(notification)}
          className="flex items-start gap-2.5 rounded-md p-2 hover:bg-surface-2 focus-visible:shadow-focus focus-visible:outline-2 focus-visible:outline-transparent"
        >
          {body}
        </a>
      ) : (
        <div className="flex items-start gap-2.5 rounded-md p-2">{body}</div>
      )}
      {notification.kind === "invited" && typeof notification.payload.invitationId === "string" ? (
        <div className="ps-11">
          <Button size="sm" variant="outline" disabled={accepting} onClick={() => onAcceptInvitation(notification)}>
            {i18n.t("notifAcceptInvitation")}
          </Button>
        </div>
      ) : null}
    </li>
  )
}
