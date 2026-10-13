"use client"

/**
 * Per-kind notification mutes, a Settings section (docs/parity/m9.md C1).
 * Reads and writes `notifications.muted` through `GET/PATCH /api/me/preferences`
 * (Package A's route; body `{ notifications: { muted } }`). A switch that is
 * on means the kind appears in the bell.
 */
import { useEffect, useId, useState } from "react"
import { toast } from "sonner"

import { useI18n } from "@/components/i18n-provider"
import { Switch } from "@/components/ui/switch"
import { NOTIFICATION_KINDS, isNotificationKind, type NotificationKind } from "@/lib/notifications/types"

const LABELS: Record<NotificationKind, string> = {
  mention: "notifPrefMention",
  reply: "notifPrefReply",
  task_assigned: "notifPrefTaskAssigned",
  integration_reauth: "notifPrefIntegrationReauth",
  invited: "notifPrefInvited",
  meeting_processed: "notifPrefMeetingProcessed",
  meeting_failed: "notifPrefMeetingFailed",
  bot_blocked: "notifPrefBotBlocked",
}

/** Accepts `{ notifications }` or `{ preferences: { notifications } }`. */
export function mutedFromPreferences(body: unknown): NotificationKind[] {
  const source =
    typeof body === "object" && body !== null && "preferences" in body
      ? (body as { preferences: unknown }).preferences
      : body
  const muted = (source as { notifications?: { muted?: unknown } } | null)?.notifications?.muted

  return Array.isArray(muted) ? muted.filter(isNotificationKind) : []
}

export function NotificationPreferences() {
  const i18n = useI18n()
  const headingId = useId()
  const [muted, setMuted] = useState<NotificationKind[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false

    void fetch("/api/me/preferences", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status))
        return mutedFromPreferences(await response.json())
      })
      .then((value) => {
        if (!cancelled) setMuted(value)
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true)
          setMuted([])
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  const toggle = async (kind: NotificationKind, enabled: boolean) => {
    if (!muted) return

    const previous = muted
    const next = enabled ? muted.filter((item) => item !== kind) : [...muted, kind]

    setMuted(next)
    setSaving(true)
    try {
      const response = await fetch("/api/me/preferences", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ notifications: { muted: next } }),
      })

      if (!response.ok) throw new Error(String(response.status))
      toast.success(i18n.t("notifPrefsSaved"))
    } catch {
      setMuted(previous)
      toast.error(i18n.t("notifPrefsFailed"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section aria-labelledby={headingId} className="ms-card grid gap-4 p-4">
      <div className="grid gap-1">
        <h3 id={headingId} className="text-base font-semibold text-fg">
          {i18n.t("notifPrefsTitle")}
        </h3>
        <p className="text-sm text-fg-2">{i18n.t("notifPrefsDescription")}</p>
        {failed ? (
          <p role="status" className="text-sm text-warn-text">
            {i18n.t("notifPrefsLoadFailed")}
          </p>
        ) : null}
      </div>
      <ul className="grid gap-3">
        {NOTIFICATION_KINDS.map((kind) => {
          const id = `${headingId}-${kind}`

          return (
            <li key={kind} className="flex items-center justify-between gap-3">
              <label htmlFor={id} className="text-sm text-fg">
                {i18n.t(LABELS[kind])}
              </label>
              <Switch
                id={id}
                checked={muted ? !muted.includes(kind) : true}
                disabled={muted === null || saving || failed}
                onCheckedChange={(checked) => void toggle(kind, checked)}
              />
            </li>
          )
        })}
      </ul>
    </section>
  )
}
