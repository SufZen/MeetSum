import { CommandCenterShell } from "@/components/command-center-shell"
import type { SidebarRoom, SidebarUser } from "@/components/main-sidebar"
import { WorkspaceProvider } from "@/components/workspace-context"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { SupportedLocale } from "@/lib/i18n/locales"
import type { MeetingListItem } from "@/lib/meetings/repository"

export function AppShell({
  dictionary,
  locale,
  meetings,
  rooms,
  user,
}: {
  dictionary: Dictionary
  locale: SupportedLocale
  meetings: MeetingListItem[]
  rooms: SidebarRoom[]
  user?: SidebarUser
}) {
  return (
    <WorkspaceProvider>
      <CommandCenterShell
        dictionary={dictionary}
        locale={locale}
        meetings={meetings}
        rooms={rooms}
        user={user}
      />
    </WorkspaceProvider>
  )
}
