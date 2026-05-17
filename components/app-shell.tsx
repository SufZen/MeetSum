import { CommandCenterShell } from "@/components/command-center-shell"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { SupportedLocale } from "@/lib/i18n/locales"
import type { MeetingRecord } from "@/lib/meetings/repository"

export function AppShell({
  dictionary,
  locale,
  meetings,
}: {
  dictionary: Dictionary
  locale: SupportedLocale
  meetings: MeetingRecord[]
}) {
  return (
    <CommandCenterShell
      dictionary={dictionary}
      locale={locale}
      meetings={meetings}
    />
  )
}
