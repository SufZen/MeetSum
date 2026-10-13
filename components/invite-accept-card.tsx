"use client"

import {
  AlertCircleIcon,
  Loader2Icon,
  LockIcon,
  LogOutIcon,
  MailCheckIcon,
} from "lucide-react"
import { useEffect, useState } from "react"
import { toast } from "sonner"

import {
  acceptInvitation,
  ApiError,
  getPublicInvitation,
  type PublicInvitation,
} from "@/components/admin/api"
import { adminErrorMessage, roleLabel } from "@/components/admin/labels"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import { formatMessage } from "@/lib/i18n/messages"
import type { SupportedLocale } from "@/lib/i18n/locales"

type LoadState =
  | { status: "loading" }
  | { status: "invalid" }
  | { status: "used" }
  | { status: "error"; message: string }
  | { status: "ready"; invitation: PublicInvitation }

function sameEmail(left?: string, right?: string) {
  return (
    Boolean(left && right) &&
    left!.trim().toLowerCase() === right!.trim().toLowerCase()
  )
}

export function InviteAcceptCard({
  dictionary: t,
  locale,
  token,
  signedInEmail,
  error,
}: {
  dictionary: Dictionary
  locale: SupportedLocale
  token: string
  signedInEmail?: string
  error?: string
}) {
  const [state, setState] = useState<LoadState>({ status: "loading" })
  const [accepting, setAccepting] = useState(false)
  const returnTo = `/${locale}/invite/${token}`
  const signInHref = `/api/auth/google/start?returnTo=${encodeURIComponent(returnTo)}`

  useEffect(() => {
    let cancelled = false

    getPublicInvitation(token).then(
      (invitation) => {
        if (cancelled) return
        setState(
          invitation.status === "pending"
            ? { status: "ready", invitation }
            : invitation.status === "expired"
              ? { status: "invalid" }
              : { status: "used" }
        )
      },
      (loadError: unknown) => {
        if (cancelled) return
        if (
          loadError instanceof ApiError &&
          (loadError.status === 404 || loadError.status === 410)
        ) {
          setState({ status: "invalid" })
          return
        }
        setState({
          status: "error",
          message: adminErrorMessage(loadError, t, t.loadFailed),
        })
      }
    )

    return () => {
      cancelled = true
    }
  }, [token, t])

  async function accept() {
    if (state.status !== "ready") return

    setAccepting(true)
    try {
      await acceptInvitation(token)
      toast.success(
        formatMessage(t.inviteAccepted, {
          workspace: state.invitation.workspaceName,
        })
      )
      // Full navigation so the server picks up the new active workspace.
      window.location.assign(`/${locale}`)
    } catch (acceptError) {
      toast.error(
        acceptError instanceof ApiError && acceptError.status === 403
          ? t.inviteEmailMismatch
          : adminErrorMessage(acceptError, t, t.actionFailed)
      )
      setAccepting(false)
    }
  }

  const invitation = state.status === "ready" ? state.invitation : undefined
  const mismatch =
    error === "email_mismatch" ||
    Boolean(
      signedInEmail &&
      invitation?.email &&
      !sameEmail(signedInEmail, invitation.email)
    )

  return (
    <main className="flex min-h-svh items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md rounded-md shadow-sm">
        <CardContent className="grid gap-5 p-6">
          <div className="flex size-10 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <MailCheckIcon aria-hidden="true" className="size-5" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t.inviteTitle}
          </h1>

          {state.status === "loading" ? (
            <p
              aria-busy="true"
              className="flex items-center gap-2 text-sm text-muted-foreground"
            >
              <Loader2Icon aria-hidden="true" className="size-4 animate-spin" />
              {t.inviteLoading}
            </p>
          ) : null}

          {state.status === "invalid" || state.status === "used" ? (
            <div className="grid gap-4">
              <p className="flex items-start gap-2 text-sm leading-6 text-muted-foreground">
                <AlertCircleIcon
                  aria-hidden="true"
                  className="mt-1 size-4 shrink-0"
                />
                {state.status === "invalid" ? t.inviteInvalid : t.inviteUsed}
              </p>
              <a href={`/${locale}`}>
                <Button variant="outline" className="w-full">
                  {t.inviteOpenApp}
                </Button>
              </a>
            </div>
          ) : null}

          {state.status === "error" ? (
            <p role="alert" className="text-sm text-destructive">
              {state.message}
            </p>
          ) : null}

          {invitation ? (
            <div className="grid gap-4">
              <p className="text-sm leading-6 text-muted-foreground">
                {formatMessage(t.inviteJoin, {
                  workspace: "⁨" + invitation.workspaceName + "⁩",
                  role: roleLabel(t, invitation.role),
                })}
              </p>
              {invitation.email ? (
                <p className="text-sm text-muted-foreground">
                  {formatMessage(t.inviteForEmail, {
                    email: "⁨" + invitation.email + "⁩",
                  })}
                </p>
              ) : null}

              {mismatch ? (
                <div
                  role="alert"
                  className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm leading-6 text-destructive"
                >
                  {t.inviteEmailMismatch}
                </div>
              ) : null}

              {signedInEmail ? (
                <>
                  <p className="text-xs text-muted-foreground">
                    {formatMessage(t.inviteSignedInAs, {
                      email: "⁨" + signedInEmail + "⁩",
                    })}
                  </p>
                  {!mismatch ? (
                    <Button
                      className="h-11 w-full"
                      disabled={accepting}
                      onClick={() => void accept()}
                    >
                      {accepting ? (
                        <Loader2Icon
                          data-icon="inline-start"
                          className="animate-spin"
                        />
                      ) : null}
                      {accepting ? t.inviteAccepting : t.inviteAccept}
                    </Button>
                  ) : null}
                  <form
                    action={`/api/auth/logout?locale=${locale}`}
                    method="post"
                  >
                    <Button type="submit" variant="outline" className="w-full">
                      <LogOutIcon data-icon="inline-start" data-directional="" />
                      {t.inviteSwitchAccount}
                    </Button>
                  </form>
                </>
              ) : (
                <a href={signInHref}>
                  <Button className="h-11 w-full">
                    <LockIcon data-icon="inline-start" />
                    {t.inviteSignIn}
                  </Button>
                </a>
              )}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </main>
  )
}
