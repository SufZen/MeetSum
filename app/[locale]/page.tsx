import { redirect } from "next/navigation"

import { AppShell } from "@/components/app-shell"
import { getCurrentSession } from "@/lib/auth/server"
import { getDictionary } from "@/lib/i18n/dictionaries"
import { isSupportedLocale, type SupportedLocale } from "@/lib/i18n/locales"
import { buildMeetingIntelligence } from "@/lib/intelligence"
import { meetingRepository } from "@/lib/meetings/store"

export default async function Page({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  const supportedLocale: SupportedLocale = isSupportedLocale(locale)
    ? locale
    : "en"
  const session = await getCurrentSession()

  if (!session) {
    redirect(`/${supportedLocale}/login`)
  }

  const dictionary = getDictionary(supportedLocale)
  const meetings = (await meetingRepository.listMeetings({ limit: 5 })).map((meeting) => {
    const intelligence = meeting.intelligence ?? buildMeetingIntelligence(meeting)

    return {
      ...meeting,
      tags: meeting.tags ?? intelligence.tags,
      intelligence,
      languageMetadata: meeting.languageMetadata ?? intelligence.languageMetadata,
    }
  })

  return (
    <AppShell
      dictionary={dictionary}
      locale={supportedLocale}
      meetings={meetings}
    />
  )
}
