"use client"

import {
  BrainIcon,
  CalendarDaysIcon,
  DatabaseIcon,
  FolderPlusIcon,
  SettingsIcon,
  WorkflowIcon,
  AudioWaveformIcon,
  ZapIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import type { Dictionary } from "@/lib/i18n/dictionaries"

const panelKeys = [
  "meetings",
  "memory",
  "workspace",
  "automations",
  "storage",
  "settings",
] as const

export type MainPanelKey = (typeof panelKeys)[number]

const navIcons = [
  CalendarDaysIcon,
  BrainIcon,
  WorkflowIcon,
  ZapIcon,
  DatabaseIcon,
  SettingsIcon,
]

export function MainSidebar({
  dictionary,
  activePanel,
  onPanelChange,
}: {
  dictionary: Dictionary
  activePanel: MainPanelKey
  onPanelChange: (panel: MainPanelKey) => void
}) {
  const navItems = [
    dictionary.navMeetings,
    dictionary.navMemory,
    dictionary.navWorkspace,
    dictionary.navAutomations,
    dictionary.navStorage,
    dictionary.navSettings,
  ]
  const rooms = [
    ["Real Estate Acquisitions", "bg-emerald-400"],
    ["Project Horizon", "bg-sky-400"],
    ["Operations", "bg-violet-400"],
    ["Finance", "bg-amber-400"],
    ["Product", "bg-slate-400"],
  ] as const

  return (
    <aside className="flex min-h-0 flex-col bg-[var(--sidebar)] p-3 text-sidebar-foreground lg:sticky lg:top-0 lg:min-h-svh lg:p-2">
      <div className="flex h-12 items-center justify-center gap-3 px-3 lg:h-16 lg:justify-start">
        <div className="grid size-8 place-items-center text-[var(--sidebar-primary)]">
          <AudioWaveformIcon aria-hidden="true" className="size-7" />
        </div>
        <div className="text-xl font-semibold tracking-tight">MeetSum</div>
      </div>

      <nav className="mt-3 flex gap-2 overflow-x-auto pb-1 lg:mt-5 lg:grid lg:overflow-visible lg:pb-0">
        {navItems.map((label, index) => {
          const Icon = navIcons[index]
          const panel = panelKeys[index]
          const active = activePanel === panel

          return (
            <Button
              key={panel}
              variant="ghost"
              className={
                active
                  ? "h-10 min-w-fit justify-start rounded-md bg-[var(--sidebar-primary)] px-3 text-[var(--sidebar-primary-foreground)] hover:bg-[var(--sidebar-primary)] hover:text-[var(--sidebar-primary-foreground)] lg:h-11 lg:min-w-0"
                  : "h-10 min-w-fit justify-start rounded-md px-3 text-sidebar-foreground/90 hover:bg-[var(--sidebar-accent)] hover:text-sidebar-accent-foreground lg:h-11 lg:min-w-0"
              }
              onClick={() => onPanelChange(panel)}
            >
              <Icon data-icon="inline-start" className="size-4" />
              {label}
            </Button>
          )
        })}
      </nav>

      <div className="mt-auto hidden px-3 pb-2 lg:block">
        <div className="mb-4 flex items-center justify-between text-xs uppercase tracking-wide text-sidebar-foreground/60">
          <span>Recent rooms</span>
          <FolderPlusIcon aria-hidden="true" className="size-4" />
        </div>
        <div className="grid gap-3 text-sm text-sidebar-foreground/85">
          {rooms.map(([room, color]) => (
            <div key={room} className="flex min-w-0 items-center gap-2">
              <span className={`size-2 rounded-full ${color}`} />
              <span className="truncate">{room}</span>
            </div>
          ))}
        </div>
        <div className="mt-10 flex items-center gap-3 rounded-md border border-sidebar-border bg-sidebar-accent/60 p-3">
          <div className="grid size-8 place-items-center rounded-full bg-blue-500 text-sm font-semibold">
            I
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold">Info</div>
            <div className="truncate text-xs text-sidebar-foreground/65">
              info@realization.co.il
            </div>
          </div>
        </div>
      </div>
    </aside>
  )
}
