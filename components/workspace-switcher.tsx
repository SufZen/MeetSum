"use client"

import { ChevronsUpDownIcon, Loader2Icon, RefreshCwIcon } from "lucide-react"
import { lazy } from "react"

import { Button } from "@/components/ui/button"
import { Deferred } from "@/components/ui/deferred"
import { useWorkspace } from "@/components/workspace-context"
import type { Dictionary } from "@/lib/i18n/dictionaries"

// M10 C: the menu, the create dialog and their primitives load on intent.
const loadMenu = () => import("@/components/workspace-switcher-menu")
const WorkspaceSwitcherMenu = lazy(() => loadMenu().then((mod) => ({ default: mod.WorkspaceSwitcherMenu })))

export function WorkspaceSwitcher({
  dictionary: t,
}: {
  dictionary: Dictionary
}) {
  const { status, me, activeWorkspace, refresh } = useWorkspace()

  if (status === "error" && !me) {
    return (
      <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-line px-2 py-1.5 text-xs text-muted-foreground">
        <span className="truncate">{t.workspaceLoadFailed}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => void refresh()}
          aria-label={t.retry}
          title={t.retry}
        >
          <RefreshCwIcon aria-hidden="true" />
        </Button>
      </div>
    )
  }

  if (!me) {
    return (
      <div
        className="mt-2 flex h-9 items-center gap-2 rounded-md border border-line px-2 text-xs text-muted-foreground"
        aria-busy="true"
      >
        <Loader2Icon aria-hidden="true" className="size-3.5 animate-spin" />
        {t.workspaceLoading}
      </div>
    )
  }

  return (
    <Deferred
      preload={loadMenu}
      placeholder={(props) => (
        <button
          type="button"
          aria-label={t.workspaceSwitchAction}
          aria-busy={props ? undefined : true}
          className="mt-2 flex w-full min-w-0 items-center gap-2 rounded-md border border-line bg-surface px-2 py-1.5 text-start hover:bg-surface-3"
          {...props}
        >
          <span className="grid size-6 shrink-0 place-items-center rounded bg-brand/10 text-xs font-semibold text-brand-text">
            {(activeWorkspace?.name ?? "?").slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
              {t.workspaceSwitcherLabel}
            </span>
            <bdi className="block truncate text-sm font-medium text-foreground">
              {activeWorkspace?.name ?? "—"}
            </bdi>
          </span>
          <ChevronsUpDownIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        </button>
      )}
    >
      {({ defaultOpen }) => <WorkspaceSwitcherMenu dictionary={t} defaultOpen={defaultOpen} />}
    </Deferred>
  )
}
