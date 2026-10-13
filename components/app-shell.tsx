import { CommandCenterShell, type ShellDetailEntry } from "@/components/command-center-shell"
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
  workspaceId,
  initialDetail,
  unavailableMeetingId,
}: {
  dictionary: Dictionary
  locale: SupportedLocale
  meetings: MeetingListItem[]
  rooms: SidebarRoom[]
  user?: SidebarUser
  /** The session's workspace (server truth; partitions the offline queue). */
  workspaceId?: string
  /** A `?meeting=` deep link outside the first page, read server-side. */
  initialDetail?: ShellDetailEntry
  /** A `?meeting=` deep link the user cannot see (inbox + notice). */
  unavailableMeetingId?: string
}) {
  return (
    <WorkspaceProvider>
      <CommandCenterShell
        dictionary={dictionary}
        locale={locale}
        meetings={meetings}
        rooms={rooms}
        user={user}
        workspaceId={workspaceId}
        initialDetail={initialDetail}
        unavailableMeetingId={unavailableMeetingId}
      />
    </WorkspaceProvider>
  )
}
