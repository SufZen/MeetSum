import { recapStrings } from "@/lib/integrations/email-recap/strings"
import { verifyUnsubscribeToken } from "@/lib/integrations/email-recap/unsubscribe-token"

/**
 * Email recap unsubscribe confirmation (M8 A10). Public. The GET link only
 * lands here; the form POSTs to /api/email/unsubscribe, so link scanners
 * never unsubscribe anyone. The address is never shown.
 */
export default async function UnsubscribePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const { locale: rawLocale } = await params
  const query = await searchParams
  const locale = rawLocale === "he" ? "he" : "en"
  const strings = recapStrings(locale)
  const token = typeof query.t === "string" ? query.t : undefined
  const done = query.done === "1"
  const valid = Boolean(token && verifyUnsubscribeToken(token))

  return (
    <main dir={locale === "he" ? "rtl" : "ltr"} className="mx-auto flex min-h-svh max-w-md flex-col justify-center gap-4 px-6 py-12 text-start">
      {done ? (
        <p className="text-base">{strings.recapUnsubscribeDone}</p>
      ) : !valid ? (
        <p className="text-base text-muted-foreground">{strings.recapUnsubscribeInvalid}</p>
      ) : (
        <form method="post" action="/api/email/unsubscribe" className="flex flex-col gap-4">
          <h1 className="text-xl font-semibold">{strings.recapUnsubscribeConfirmTitle}</h1>
          <p className="text-base text-muted-foreground">{strings.recapUnsubscribeConfirmBody}</p>
          <input type="hidden" name="t" value={token} />
          <input type="hidden" name="l" value={locale} />
          <button type="submit" className="self-start rounded-md bg-primary px-4 py-2 text-primary-foreground">
            {strings.recapUnsubscribeConfirmButton}
          </button>
        </form>
      )}
    </main>
  )
}
