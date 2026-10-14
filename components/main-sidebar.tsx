"use client"

import {
  BarChart3Icon,
  BrainIcon,
  CalendarDaysIcon,
  DatabaseIcon,
  BookOpenIcon,
  FolderPlusIcon,
  ListChecksIcon,
  SettingsIcon,
  WorkflowIcon,
  ZapIcon,
  ChevronDownIcon,
  SearchIcon,
  ShieldCheckIcon,
} from "lucide-react"

import Link from "next/link"
import { lazy, useRef, type MouseEvent } from "react"

import { ADMIN_PANEL_PERMISSIONS } from "@/components/admin/permissions"
import { useUploadQueue } from "@/components/pwa/upload-queue-provider"
import { clearServiceWorkerCaches } from "@/components/pwa/service-worker-registrar"
import { Deferred } from "@/components/ui/deferred"
import { SigmaMark } from "@/components/ui/sigma-mark"
import { useWorkspace } from "@/components/workspace-context"
import { WorkspaceSwitcher } from "@/components/workspace-switcher"
import type { Dictionary } from "@/lib/i18n/dictionaries"
import type { SupportedLocale } from "@/lib/i18n/locales"
import { isPlainLeftClick } from "@/lib/client/shell-navigation"
import { buildShellUrl } from "@/lib/client/shell-url"

// M10 C: the account menu (menu + floating-ui + confirm dialog) loads on intent.
const loadUserMenu = () => import("@/components/sidebar-user-menu")
const SidebarUserMenu = lazy(() => loadUserMenu().then((mod) => ({ default: mod.SidebarUserMenu })))
const USER_TRIGGER_CLASS =
  "mt-4 flex w-full items-center gap-3 rounded-md border border-sidebar-border bg-sidebar-accent/60 p-3 text-start hover:bg-sidebar-accent lg:mt-8"

export type SidebarRoom = {
  id: string
  name: string
  color?: string
}

export type SidebarUser = {
  /** Partitions the offline recording queue (never shown). */
  id?: string
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
  const uploads = useUploadQueue()
  const { can } = useWorkspace()
  const showAdmin = ADMIN_PANEL_PERMISSIONS.some((permission) => can(permission))
  const displayName = user?.name?.trim() || user?.email.split("@")[0] || ""
  const initial = (displayName || "?").slice(0, 1).toUpperCase()
  // Logout: queued recordings belong to this user on this device; the menu
  // asks before deleting them, then the queue and the SW caches are cleared.
  async function logOut() {
    await uploads?.clearAll().catch(() => undefined)
    await clearServiceWorkerCaches()
    logoutFormRef.current?.requestSubmit()
  }

  function onNavClick(event: MouseEvent<HTMLAnchorElement>, panel: MainPanelKey) {
    if (!isPlainLeftClick(event)) return
    event.preventDefault()
    onPanelChange(panel)
  }

  const linkClass =
    "inline-flex h-9 min-w-fit items-center justify-start gap-1.5 rounded-md px-3 text-base font-medium text-sidebar-foreground transition-colors duration-(--dur-1) hover:bg-surface-3 hover:text-sidebar-accent-foreground focus-visible:shadow-focus focus-visible:outline-2 focus-visible:outline-transparent lg:min-w-0"
  const activeLinkClass =
    "inline-flex h-9 min-w-fit items-center justify-start gap-1.5 rounded-md bg-brand-soft px-3 text-base font-semibold text-brand-text transition-colors duration-(--dur-1) focus-visible:shadow-focus focus-visible:outline-2 focus-visible:outline-transparent lg:min-w-0"
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

  const userTrigger = user ? (
    <>
      {user.picture ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={user.picture}
          alt=""
          referrerPolicy="no-referrer"
          className="size-8 shrink-0 rounded-full object-cover"
        />
      ) : (
        <div className="grid size-8 shrink-0 place-items-center rounded-full bg-brand text-sm font-semibold text-white">
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
    </>
  ) : null

  return (
    <aside className="flex min-h-0 flex-col border-e border-line bg-canvas p-3 text-sidebar-foreground lg:sticky lg:top-0 lg:min-h-svh">
      <div className="flex h-11 items-center justify-center gap-3 px-1 lg:h-12 lg:justify-start">
        <SigmaMark className="size-6" />
        <div className="text-lg font-semibold tracking-tight text-foreground">MeetSum</div>
      </div>
      {user ? <WorkspaceSwitcher dictionary={dictionary} /> : null}

      <nav
        aria-label={dictionary.shellMainNavLabel}
        className="mt-2 flex gap-2 overflow-x-auto border-y border-line py-3 lg:grid lg:gap-1.5 lg:overflow-visible"
      >
        {navItems.map((label, index) => {
          const Icon = navIcons[index]
          const panel = panelKeys[index]
          const active = activePanel === panel

          if (panel === "admin" && !showAdmin) return null

          // Real links: modifier-click opens a tab; a plain click stays in-app.
          return (
            <Link
              key={panel}
              href={buildShellUrl(locale, { panel })}
              aria-current={active ? "page" : undefined}
              className={active ? activeLinkClass : linkClass}
              onClick={(event) => onNavClick(event, panel)}
            >
              <Icon aria-hidden="true" className="size-4" />
              {label}
            </Link>
          )
        })}
        {/* M6: global Search & Ask is its own page. */}
        <Link
          href={`/${locale}/search`}
          className={linkClass}
        >
          <SearchIcon aria-hidden className="size-4" />
          {dictionary.navSearchAsk}
        </Link>
        {/* M5: the cross-meeting Tasks view is its own page. */}
        <Link
          href={`/${locale}/tasks`}
          className={linkClass}
        >
          <ListChecksIcon aria-hidden className="size-4" />
          {dictionary.navTasks}
        </Link>
        {/* M9: the workspace analytics dashboard is its own page (Package C). */}
        <Link
          href={`/${locale}/analytics`}
          className={linkClass}
        >
          <BarChart3Icon aria-hidden className="size-4" />
          {dictionary.analyticsNav}
        </Link>
      </nav>

      <div className="mt-auto px-3 pb-2">
        {rooms.length ? (
          <div className="hidden lg:block">
            <div className="mb-4 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <span>{dictionary.shellRecentRooms}</span>
              <FolderPlusIcon aria-hidden="true" className="size-4 text-brand-text" />
            </div>
            <div className="grid gap-1 text-sm text-sidebar-foreground">
              {rooms.map((room) => (
                <Link
                  key={room.id}
                  href={`/${locale}/rooms/${room.id}`}
                  className="-mx-1.5 flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 hover:bg-surface-3 hover:text-sidebar-accent-foreground"
                >
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: room.color ?? "var(--brand)" }}
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
            <Deferred
              preload={loadUserMenu}
              placeholder={(props) => (
                <button type="button" className={USER_TRIGGER_CLASS} aria-busy={props ? undefined : true} {...props}>
                  {userTrigger}
                </button>
              )}
            >
              {({ defaultOpen }) => (
                <SidebarUserMenu
                  dictionary={dictionary}
                  triggerClassName={USER_TRIGGER_CLASS}
                  triggerContent={userTrigger}
                  defaultOpen={defaultOpen}
                  pendingUploads={() => uploads?.snapshot?.pending ?? 0}
                  onLogOut={logOut}
                />
              )}
            </Deferred>
          </>
        ) : null}
      </div>
    </aside>
  )
}
