"use client"

import {
  BrainIcon,
  CalendarDaysIcon,
  DatabaseIcon,
  BookOpenIcon,
  FolderPlusIcon,
  SettingsIcon,
  WorkflowIcon,
  AudioWaveformIcon,
  ZapIcon,
  ChevronDownIcon,
  LogOutIcon,
  ShieldCheckIcon,
} from "lucide-react"
import Link from "next/link"
import { useRef } from "react"

import { ADMIN_PANEL_PERMISSIONS } from "@/components/admin/admin-panel"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useWorkspace } from "@/components/workspace-context"
import { WorkspaceSwitcher } from "@/components/workspace-switcher"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { SupportedLocale } from "@/lib/i18n/locales"

export type SidebarRoom = {
  id: string
  name: string
  color?: string
}

export type SidebarUser = {
  email: string
  name?: string
  picture?: string
}

const panelKeys = [
  "meetings",
  "memory",
  "workspace",
  "automations",
  "storage",
  "manual",
  "settings",
  "admin",
] as const

export type MainPanelKey = (typeof panelKeys)[number]

const navIcons = [
  CalendarDaysIcon,
  BrainIcon,
  WorkflowIcon,
  ZapIcon,
  DatabaseIcon,
  BookOpenIcon,
  SettingsIcon,
  ShieldCheckIcon,
]

export function MainSidebar({
  dictionary,
  locale,
  activePanel,
  onPanelChange,
  rooms,
  user,
}: {
  dictionary: Dictionary
  locale: SupportedLocale
  activePanel: MainPanelKey
  onPanelChange: (panel: MainPanelKey) => void
  rooms: SidebarRoom[]
  user?: SidebarUser
}) {
  const logoutFormRef = useRef<HTMLFormElement>(null)
  const { can } = useWorkspace()
  const showAdmin = ADMIN_PANEL_PERMISSIONS.some((permission) => can(permission))
  const displayName = user?.name?.trim() || user?.email.split("@")[0] || ""
  const initial = (displayName || "?").slice(0, 1).toUpperCase()
  const navItems = [
    dictionary.navMeetings,
    dictionary.navMemory,
    dictionary.navWorkspace,
    dictionary.navAutomations,
    dictionary.navStorage,
    dictionary.navManual,
    dictionary.navSettings,
    dictionary.navAdmin,
  ]

  return (
    <aside className="flex min-h-0 flex-col border-e border-[var(--sidebar-border)] bg-[var(--sidebar)] p-3 text-sidebar-foreground lg:sticky lg:top-0 lg:min-h-svh">
      <div className="flex h-11 items-center justify-center gap-3 px-1 lg:h-12 lg:justify-start">
        <div className="grid size-7 place-items-center rounded-md bg-[var(--primary)]/10 text-[var(--primary)]">
          <AudioWaveformIcon aria-hidden="true" className="size-4" />
        </div>
        <div className="text-lg font-semibold tracking-tight text-foreground">MeetSum</div>
      </div>
      {user ? <WorkspaceSwitcher dictionary={dictionary} /> : null}

      <nav className="mt-2 flex gap-2 overflow-x-auto border-y border-[var(--divider)] py-3 lg:grid lg:gap-1.5 lg:overflow-visible">
        {navItems.map((label, index) => {
          const Icon = navIcons[index]
          const panel = panelKeys[index]
          const active = activePanel === panel

          if (panel === "admin" && !showAdmin) return null

          return (
            <Button
              key={panel}
              variant="ghost"
              className={
                active
                  ? "h-9 min-w-fit justify-start rounded-md bg-[var(--sidebar-primary)] px-3 font-semibold text-[var(--sidebar-primary-foreground)] hover:bg-[var(--sidebar-primary)] hover:text-[var(--sidebar-primary-foreground)] lg:min-w-0"
                  : "h-9 min-w-fit justify-start rounded-md px-3 text-sidebar-foreground hover:bg-[var(--sidebar-accent)] hover:text-sidebar-accent-foreground lg:min-w-0"
              }
              onClick={() => onPanelChange(panel)}
            >
              <Icon data-icon="inline-start" className="size-4" />
              {label}
            </Button>
          )
        })}
      </nav>

      <div className="mt-auto px-3 pb-2">
        {rooms.length ? (
          <div className="hidden lg:block">
            <div className="mb-4 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <span>Recent rooms</span>
              <FolderPlusIcon aria-hidden="true" className="size-4 text-[var(--primary)]" />
            </div>
            <div className="grid gap-1 text-sm text-sidebar-foreground">
              {rooms.map((room) => (
                <Link
                  key={room.id}
                  href={`/${locale}/rooms/${room.id}`}
                  className="-mx-1.5 flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 hover:bg-[var(--sidebar-accent)] hover:text-sidebar-accent-foreground"
                >
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: room.color ?? "var(--primary)" }}
                  />
                  <span className="truncate">{room.name}</span>
                </Link>
              ))}
            </div>
          </div>
        ) : null}
        {user ? (
          <>
            <form
              ref={logoutFormRef}
              action={`/api/auth/logout?locale=${locale}`}
              method="post"
              className="hidden"
            />
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    type="button"
                    className="mt-4 flex w-full items-center gap-3 rounded-md border border-sidebar-border bg-sidebar-accent/60 p-3 text-start hover:bg-sidebar-accent lg:mt-8"
                  />
                }
              >
                {user.picture ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={user.picture}
                    alt=""
                    referrerPolicy="no-referrer"
                    className="size-8 shrink-0 rounded-full object-cover"
                  />
                ) : (
                  <div className="grid size-8 shrink-0 place-items-center rounded-full bg-[var(--primary)] text-sm font-semibold text-white">
                    {initial}
                  </div>
                )}
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">
                    <bdi>{displayName}</bdi>
                  </div>
                  <div className="truncate text-xs text-muted-foreground" dir="ltr">
                    <bdi>{user.email}</bdi>
                  </div>
                </div>
                <ChevronDownIcon aria-hidden="true" className="ms-auto size-4 shrink-0 text-muted-foreground" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" side="top">
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => logoutFormRef.current?.requestSubmit()}
                >
                  <LogOutIcon aria-hidden="true" className="size-4" />
                  {dictionary.logOut}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        ) : null}
      </div>
    </aside>
  )
}
