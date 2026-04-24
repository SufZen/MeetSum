import { CalendarSyncIcon, CloudIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

export type WorkspaceStatusView = {
  google: {
    subject: string
    strategy: "json-key" | "key-file" | "missing"
    serviceAccountEmailConfigured: boolean
    serviceAccountKeyConfigured: boolean
    keyFileConfigured: boolean
  }
  sync: Array<{
    source: string
    status: string
    updatedAt?: string
    lastSyncedAt?: string
    lastError?: string
  }>
  jobs: {
    queued: number
    active: number
    failed: number
  }
}

export function WorkspaceSyncPanel({
  status,
  syncing,
  onSyncAll,
}: {
  status?: WorkspaceStatusView
  syncing?: boolean
  onSyncAll: () => void
}) {
  return (
    <section className="grid gap-3 rounded-md border bg-card p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <CloudIcon aria-hidden="true" className="size-4 text-primary" />
          <h3 className="text-sm font-semibold">Google Workspace</h3>
        </div>
        <Badge
          variant={status?.google.strategy === "missing" ? "outline" : "secondary"}
          className="rounded-sm"
        >
          {status?.google.strategy ?? "checking"}
        </Badge>
      </div>
      <div className="text-xs leading-5 text-muted-foreground">
        Subject:{" "}
        <span className="font-mono text-foreground">
          {status?.google.subject ?? "info@realization.co.il"}
        </span>
      </div>
      <Button
        variant="outline"
        className="h-9 w-full"
        disabled={syncing}
        onClick={onSyncAll}
      >
        <CalendarSyncIcon data-icon="inline-start" />
        {syncing ? "Sync queued..." : "Sync Calendar + Drive"}
      </Button>
      <div className="grid gap-2">
        {(status?.sync.length ? status.sync : []).map((item) => (
          <div key={item.source} className="rounded-md border bg-background p-2">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-medium capitalize">{item.source}</span>
              <span className="text-muted-foreground">{item.status}</span>
            </div>
            {item.lastError && (
              <p className="mt-1 break-words text-xs leading-5 text-destructive">
                {item.lastError}
              </p>
            )}
          </div>
        ))}
        {!status?.sync.length && (
          <div className="rounded-md border border-dashed p-3 text-xs leading-5 text-muted-foreground">
            No sync runs recorded yet.
          </div>
        )}
      </div>
    </section>
  )
}
