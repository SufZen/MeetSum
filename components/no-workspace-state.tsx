import { LogOutIcon, UsersIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { formatMessage, type Dictionary } from "@/lib/i18n/dictionaries"
import type { SupportedLocale } from "@/lib/i18n/locales"

/** Signed in, but not a member of any workspace (M2 D2). */
export function NoWorkspaceState({
  dictionary: t,
  locale,
  email,
}: {
  dictionary: Dictionary
  locale: SupportedLocale
  email: string
}) {
  const [before, after] = t.noWorkspaceDescription.split("{email}")

  return (
    <main className="flex min-h-svh items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md rounded-md shadow-sm">
        <CardContent className="grid gap-5 p-6">
          <div className="flex size-10 items-center justify-center rounded-md bg-primary/10 text-primary">
            <UsersIcon aria-hidden="true" className="size-5" />
          </div>
          <div className="grid gap-2">
            <h1 className="text-xl font-semibold tracking-tight">
              {t.noWorkspaceTitle}
            </h1>
            <p className="text-sm leading-6 text-muted-foreground">
              {after === undefined ? (
                formatMessage(t.noWorkspaceDescription, { email })
              ) : (
                <>
                  {before}
                  <bdi dir="ltr" className="font-medium text-foreground">
                    {email}
                  </bdi>
                  {after}
                </>
              )}
            </p>
          </div>
          <form action={`/api/auth/logout?locale=${locale}`} method="post">
            <Button type="submit" variant="outline" className="w-full">
              <LogOutIcon data-icon="inline-start" />
              {t.logOut}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}
