import { redirect } from "next/navigation"
import { AlertCircleIcon, LockIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { SigmaMark } from "@/components/ui/sigma-mark"
import { getCurrentSession } from "@/lib/auth/server"
import { getDictionary } from "@/lib/i18n/dictionaries"
import { isSupportedLocale, type SupportedLocale } from "@/lib/i18n/locales"

/** Only same-app invitation pages may be used as a post-login target. */
const SAFE_RETURN_TO = /^\/[a-z]{2}\/invite\/[A-Za-z0-9_-]+$/

export default async function LoginPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const { locale } = await params
  const query = await searchParams
  const supportedLocale: SupportedLocale = isSupportedLocale(locale)
    ? locale
    : "en"
  const requestedReturnTo =
    typeof query.returnTo === "string" ? query.returnTo : ""
  const returnTo = SAFE_RETURN_TO.test(requestedReturnTo)
    ? requestedReturnTo
    : `/${supportedLocale}`
  const session = await getCurrentSession().catch(() => undefined)

  // A signed-in user who was denied access stays here to read the error.
  if (session && typeof query.error !== "string") {
    redirect(returnTo)
  }

  const dictionary = getDictionary(supportedLocale)
  const errorCode = typeof query.error === "string" ? query.error : undefined
  const errorMessage =
    errorCode === "no_access"
      ? dictionary.loginErrorNoAccess
      : errorCode === "email_mismatch"
        ? dictionary.inviteEmailMismatch
        : errorCode
          ? dictionary.loginErrorGeneric
          : undefined

  return (
    <main className="flex min-h-svh items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md rounded-md shadow-sm">
        <CardContent className="grid gap-6 p-6">
          <div className="flex items-center gap-3">
            <SigmaMark className="size-10" />
            <div>
              <h1 className="text-xl font-semibold">MeetSum</h1>
              <p className="text-sm text-muted-foreground">
                {dictionary.appSubtitle}
              </p>
            </div>
          </div>

          <div className="grid gap-2">
            <h2 className="text-2xl font-semibold tracking-tight">
              {dictionary.signInTitle}
            </h2>
            <p className="text-sm leading-6 text-muted-foreground">
              {dictionary.signInDescription}
            </p>
          </div>

          {errorMessage ? (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm leading-6 text-destructive"
            >
              <AlertCircleIcon
                aria-hidden="true"
                className="mt-1 size-4 shrink-0"
              />
              <span>{errorMessage}</span>
            </div>
          ) : null}

          <a
            href={`/api/auth/google/start?returnTo=${encodeURIComponent(returnTo)}`}
          >
            <Button className="h-11 w-full">
              <LockIcon data-icon="inline-start" />
              {dictionary.signInWithGoogle}
            </Button>
          </a>

          <p className="text-xs leading-5 text-muted-foreground">
            {dictionary.signInRestricted}
          </p>
        </CardContent>
      </Card>
    </main>
  )
}
