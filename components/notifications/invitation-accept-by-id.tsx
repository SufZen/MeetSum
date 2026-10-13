"use client"

/**
 * Accepts an invitation by id for the signed-in user (M9 C1; the page only
 * renders it for a pending invitation addressed to the session email). Joins
 * through `POST /api/me/invitations/[id]/accept`, then does a full
 * navigation so the server picks up the new active workspace. A 404 (used,
 * revoked or expired meanwhile) shows the unavailable state.
 */
import { AlertCircleIcon, Loader2Icon, MailCheckIcon } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

import { useI18n } from "@/components/i18n-provider"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import type { SupportedLocale } from "@/lib/i18n/locales"

export function InvitationAcceptById({
  id,
  locale,
  workspaceName,
  inviterName,
}: {
  id: string
  locale: SupportedLocale
  workspaceName: string
  inviterName: string | null
}) {
  const { t } = useI18n()
  const [state, setState] = useState<"ready" | "accepting" | "unavailable">("ready")

  async function accept() {
    setState("accepting")
    try {
      const response = await fetch(`/api/me/invitations/${encodeURIComponent(id)}/accept`, { method: "POST" })

      if (response.status === 404) {
        setState("unavailable")
        return
      }
      if (!response.ok) throw new Error(`accept_failed_${response.status}`) // i18n-allow: internal, never shown

      toast.success(t("notifInvitationAccepted", { workspace: workspaceName }))
      window.location.assign(`/${locale}`)
    } catch {
      toast.error(t("actionFailed"))
      setState("ready")
    }
  }

  return (
    <main className="flex min-h-svh items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md rounded-md shadow-sm">
        <CardContent className="grid gap-5 p-6">
          <div className="flex size-10 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <MailCheckIcon aria-hidden="true" className="size-5" />
          </div>
          {state === "unavailable" ? (
            <div className="grid gap-4">
              <p className="flex items-start gap-2 text-sm leading-6 text-muted-foreground">
                <AlertCircleIcon aria-hidden="true" className="mt-1 size-4 shrink-0" />
                {t("notifInvitationUnavailable")}
              </p>
              <Button render={<a href={`/${locale}`} />} variant="outline">
                {t("inviteOpenApp")}
              </Button>
            </div>
          ) : (
            <>
              <h1 className="text-2xl font-semibold tracking-tight">
                {t("notifKindInvited", { workspace: "⁨" + workspaceName + "⁩" })}
              </h1>
              {inviterName ? (
                <p className="text-sm text-muted-foreground">
                  {t("notifInvitedBy", { name: "⁨" + inviterName + "⁩" })}
                </p>
              ) : null}
              <Button onClick={() => void accept()} disabled={state === "accepting"}>
                {state === "accepting" ? (
                  <Loader2Icon data-icon="inline-start" aria-hidden="true" className="size-4 animate-spin" />
                ) : null}
                {state === "accepting" ? t("inviteAccepting") : t("notifAcceptInvitation")}
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </main>
  )
}
