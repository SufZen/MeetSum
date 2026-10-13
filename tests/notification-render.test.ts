/**
 * M9 C1 notification rendering (docs/parity/m9.md): one he/en sentence per
 * kind from the dictionary, names/titles/workspaces in <bdi>, no gendered
 * actor verbs in Hebrew, and a hidden meeting never shows a title.
 */
import { createElement } from "react"
import { describe, expect, it } from "vitest"

import { NotificationItem } from "@/components/notifications/notification-item"
import { mutedFromPreferences } from "@/components/notifications/notification-preferences"
import { m9NotificationsMessages } from "@/lib/i18n/m9/notifications"
import { translate } from "@/lib/i18n/messages"
import { notificationTemplateKey, notificationText } from "@/lib/notifications/render"
import { NOTIFICATION_KINDS, type NotificationDTO, type NotificationKind } from "@/lib/notifications/types"

import { renderWithI18n } from "./helpers/render-i18n"

function dto(kind: NotificationKind, extra: Partial<NotificationDTO> = {}): NotificationDTO {
  return {
    id: `n_${kind}`,
    kind,
    createdAt: "2026-10-13T09:00:00.000Z",
    readAt: null,
    meeting: { id: "m1", title: "סנכרון Lisboa 12", language: "he" },
    actor: { id: "u1", name: "Dana Levi" },
    payload: { provider: "hubspot", workspaceName: "Acme", invitationId: "inv_1" },
    href: "/he?meeting=m1",
    ...extra,
  }
}

const t = (locale: "he" | "en") => (key: string) => translate(m9NotificationsMessages[locale], key)

describe("notification sentences", () => {
  it("render every kind in he and en with the slots filled", () => {
    for (const kind of NOTIFICATION_KINDS) {
      for (const locale of ["he", "en"] as const) {
        const text = notificationText(dto(kind), t(locale))

        expect(text, `${locale} ${kind}`).not.toMatch(/\{\w+\}/)
        if (locale === "he") expect(text).toMatch(/[א-ת]/)
      }
    }

    expect(notificationText(dto("mention"), t("he"))).toBe("אזכור חדש מ־Dana Levi בפגישה סנכרון Lisboa 12")
    expect(notificationText(dto("integration_reauth"), t("en"))).toBe("HubSpot needs to be reconnected")
    expect(notificationText(dto("invited"), t("he"))).toBe("הזמנה להצטרף אל Acme")
  })

  it("use the actor-less template when the actor is unknown", () => {
    expect(notificationTemplateKey(dto("reply", { actor: undefined }))).toBe("notifKindReplyNoActor")
    expect(notificationText(dto("reply", { actor: undefined }), t("he"))).toBe("תגובה חדשה בפגישה סנכרון Lisboa 12")
  })

  it("never show the title of a meeting the reader cannot see", () => {
    const hidden = dto("meeting_processed", { meeting: { id: "m1", title: null, language: null }, href: "" })

    expect(notificationText(hidden, t("he"))).toBe("הסיכום מוכן: פגישה שאינה זמינה עוד")
    expect(notificationText(hidden, t("en"))).not.toContain("Lisboa")
  })

  it("never build Hebrew sentences around a gendered actor verb", () => {
    const he = Object.values(m9NotificationsMessages.he).join(" ")

    for (const verb of ["הזכיר", "הזכירה", "הגיב", "הגיבה", "שייך", "שייכה", "הזמין", "הזמינה", "לחץ", "בחר", "הזן"]) {
      expect(he).not.toMatch(new RegExp(`(^|\\s)${verb}(\\s|$)`))
    }
  })
})

describe("NotificationItem", () => {
  const render = (notification: NotificationDTO, locale: "he" | "en" = "he") =>
    renderWithI18n(
      createElement(NotificationItem, { notification, onOpen: () => {}, onAcceptInvitation: () => {}, accepting: false }),
      locale,
      m9NotificationsMessages[locale]
    )

  it("wraps names and titles in bdi, labels unread for screen readers and links the target", () => {
    const html = render(dto("mention"))

    expect(html).toContain('<bdi dir="auto">Dana Levi</bdi>')
    expect(html).toMatch(/<bdi dir="auto" lang="he">סנכרון Lisboa‏? 12<\/bdi>/)
    expect(html).toContain('<span class="sr-only">לא נקרא</span>')
    expect(html).toContain('href="/he?meeting=m1"')
    expect(html).toContain('dateTime="2026-10-13T09:00:00.000Z"')
  })

  it("renders read rows without the unread label, and no link without an href", () => {
    const html = render(dto("meeting_failed", { readAt: "2026-10-13T10:00:00.000Z", href: "", meeting: { id: "m1", title: null, language: null } }), "en")

    expect(html).not.toContain("sr-only")
    expect(html).not.toContain("<a ")
    expect(html).toContain("A meeting you can no longer view")
  })

  it("offers accept on invitations", () => {
    expect(render(dto("invited"))).toContain("קבלת ההזמנה")
  })
})

describe("mutedFromPreferences", () => {
  it("reads either response shape and drops unknown kinds", () => {
    expect(mutedFromPreferences({ notifications: { muted: ["mention", "nope"] } })).toEqual(["mention"])
    expect(mutedFromPreferences({ preferences: { notifications: { muted: ["reply"] } } })).toEqual(["reply"])
    expect(mutedFromPreferences(null)).toEqual([])
  })
})
