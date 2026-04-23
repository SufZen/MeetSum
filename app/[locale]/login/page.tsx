import { redirect } from "next/navigation"
import { LockIcon, SparklesIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { getCurrentSession } from "@/lib/auth/server"
import { getDictionary } from "@/lib/i18n/dictionaries"
import { isSupportedLocale, type SupportedLocale } from "@/lib/i18n/locales"

export default async function LoginPage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  const supportedLocale: SupportedLocale = isSupportedLocale(locale)
    ? locale
    : "en"
  const session = await getCurrentSession()

  if (session) {
    redirect(`/${supportedLocale}`)
  }

  const dictionary = getDictionary(supportedLocale)
  const returnTo = `/${supportedLocale}`

  return (
    <main className="flex min-h-svh items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md rounded-md shadow-sm">
        <CardContent className="grid gap-6 p-6">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <SparklesIcon aria-hidden="true" className="size-5" />
            </div>
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

          <a href={`/api/auth/google/start?returnTo=${encodeURIComponent(returnTo)}`}>
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
