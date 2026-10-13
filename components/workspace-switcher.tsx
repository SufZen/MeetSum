"use client"

import {
  CheckIcon,
  ChevronsUpDownIcon,
  Loader2Icon,
  PlusIcon,
  RefreshCwIcon,
} from "lucide-react"
import { useRouter } from "next/navigation"
import { useState, type FormEvent } from "react"
import { toast } from "sonner"

import { createWorkspace } from "@/components/admin/api"
import { adminErrorMessage, roleLabel } from "@/components/admin/labels"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useWorkspace } from "@/components/workspace-context"
import { formatMessage, type Dictionary } from "@/lib/i18n/dictionaries"

export function WorkspaceSwitcher({
  dictionary: t,
}: {
  dictionary: Dictionary
}) {
  const router = useRouter()
  const { status, me, activeWorkspace, refresh, switchWorkspace } =
    useWorkspace()
  const [switchingId, setSwitchingId] = useState<string>()
  const [createOpen, setCreateOpen] = useState(false)
  const [workspaceName, setWorkspaceName] = useState("")
  const [creating, setCreating] = useState(false)

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

  async function handleSwitch(workspaceId: string, name: string) {
    if (workspaceId === me?.activeWorkspaceId) return

    setSwitchingId(workspaceId)
    try {
      await switchWorkspace(workspaceId)
      toast.success(formatMessage(t.workspaceSwitched, { name }))
      router.refresh()
    } catch (switchError) {
      toast.error(adminErrorMessage(switchError, t, t.workspaceSwitchFailed))
    } finally {
      setSwitchingId(undefined)
    }
  }

  async function handleCreate(event: FormEvent) {
    event.preventDefault()

    const name = workspaceName.trim()

    if (!name) return

    setCreating(true)
    try {
      const workspace = await createWorkspace(name)

      toast.success(t.workspaceCreated)
      setCreateOpen(false)
      setWorkspaceName("")

      if (workspace.id) {
        await switchWorkspace(workspace.id)
        router.refresh()
      } else {
        await refresh()
      }
    } catch (createError) {
      toast.error(adminErrorMessage(createError, t, t.workspaceCreateFailed))
    } finally {
      setCreating(false)
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label={t.workspaceSwitchAction}
              className="mt-2 flex w-full min-w-0 items-center gap-2 rounded-md border border-line bg-surface px-2 py-1.5 text-start hover:bg-surface-3"
            />
          }
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
          {switchingId ? (
            <Loader2Icon
              aria-hidden="true"
              className="size-4 shrink-0 animate-spin text-muted-foreground"
            />
          ) : (
            <ChevronsUpDownIcon
              aria-hidden="true"
              className="size-4 shrink-0 text-muted-foreground"
            />
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-60">
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t.workspaceSwitchAction}</DropdownMenuLabel>
            {me.workspaces.map((workspace) => (
              <DropdownMenuItem
                key={workspace.id}
                disabled={Boolean(switchingId)}
                onClick={() => void handleSwitch(workspace.id, workspace.name)}
              >
                <span className="min-w-0 flex-1">
                  <bdi className="block truncate">{workspace.name}</bdi>
                  <span className="block text-xs text-muted-foreground">
                    {roleLabel(t, workspace.role)}
                  </span>
                </span>
                {workspace.id === me.activeWorkspaceId ? (
                  <CheckIcon aria-hidden="true" className="ms-2 size-4" />
                ) : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setCreateOpen(true)}>
            <PlusIcon aria-hidden="true" className="size-4" />
            {t.workspaceCreate}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <form onSubmit={handleCreate} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>{t.workspaceCreate}</DialogTitle>
              <DialogDescription>
                {t.workspaceCreateDescription}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor="workspace-name">{t.workspaceNameLabel}</Label>
              <Input
                id="workspace-name"
                dir="auto"
                autoFocus
                maxLength={80}
                value={workspaceName}
                onChange={(event) => setWorkspaceName(event.target.value)}
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setCreateOpen(false)}
              >
                {t.cancel}
              </Button>
              <Button
                type="submit"
                disabled={creating || !workspaceName.trim()}
              >
                {creating ? t.workspaceCreating : t.workspaceCreate}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
