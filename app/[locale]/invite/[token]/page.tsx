import { notFound } from "next/navigation"

import { InviteAcceptCard } from "@/components/invite-accept-card"
import { getCurrentSession } from "@/lib/auth/server"
import { getDictionary } from "@/lib/i18n/dictionaries"
import { DEFAULT_LOCALE, isSupportedLocale, type SupportedLocale } from "@/lib/i18n/locales"

/** Same token shape the OAuth callback accepts as an invite return target. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/

export default async function InvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; token: string }>
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const { locale, token } = await params
  const query = await searchParams
  const supportedLocale: SupportedLocale = isSupportedLocale(locale)
    ? locale
    : DEFAULT_LOCALE

  if (!TOKEN_PATTERN.test(token)) notFound()

  const session = await getCurrentSession().catch(() => undefined)

  return (
    <InviteAcceptCard
      dictionary={getDictionary(supportedLocale)}
      locale={supportedLocale}
      token={token}
      signedInEmail={session?.email}
      error={typeof query.error === "string" ? query.error : undefined}
    />
  )
}
