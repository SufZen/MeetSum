import { CalendarSyncIcon, CloudIcon } from "lucide-react"
import Link from "next/link"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

export type WorkspaceStatusView = {
  google: {
    subject: string
    strategy: "user-oauth" | "keyless-iam-signjwt" | "json-key" | "key-file" | "missing"
    configured: boolean
    detail: string
    serviceAccountEmail?: string
    serviceAccountEmailConfigured: boolean
    serviceAccountKeyConfigured: boolean
    keyFileConfigured: boolean
    userOAuthConnected?: boolean
  }
  sync: Array<{
    source: string
    status: string
    updatedAt?: string
    lastSyncedAt?: string
    nextPollAt?: string
    lastError?: string
    stats?: Record<string, unknown>
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
    <section className="ms-card grid gap-4 p-4">
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
      <div className="rounded-lg border border-[var(--divider)] bg-[var(--surface-subtle)] p-3 text-xs leading-5 text-muted-foreground">
        <div>
          Auth:{" "}
          <span className="font-medium text-foreground">
            {status?.google.detail ?? "Checking Workspace credentials"}
          </span>
        </div>
        {status?.google.serviceAccountEmail && (
          <div className="break-all font-mono">
            {status.google.serviceAccountEmail}
          </div>
        )}
        {(!status?.google.configured || status.google.strategy === "missing") && (
          <p className="mt-1 text-amber-700">
            Google sync needs a connected Workspace account.
          </p>
        )}
      </div>
      {status && !status.google.configured && (
        <Link
          href="/api/auth/google/start?returnTo=/en"
          className="inline-flex h-9 w-full items-center justify-center rounded-lg bg-[var(--primary)] px-3 text-sm font-medium text-[var(--primary-foreground)] hover:bg-[var(--primary)]/90"
        >
          Reconnect Google
        </Link>
      )}
      <Button
        variant="outline"
        className="h-9 w-full"
        disabled={syncing}
        onClick={onSyncAll}
      >
        <CalendarSyncIcon data-icon="inline-start" />
        {syncing ? "Sync queued..." : "Sync Calendar"}
      </Button>
      <div className="grid gap-2">
        {(status?.sync.length ? status.sync : []).map((item) => (
            <div key={item.source} className="rounded-lg border border-[var(--divider)] bg-[var(--surface-subtle)] p-3">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-medium capitalize">{item.source}</span>
              <span className="text-muted-foreground">{item.status}</span>
            </div>
            {item.stats && Object.keys(item.stats).length > 0 && (
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {Object.entries(item.stats)
                  .filter(([, value]) => typeof value !== "object")
                  .map(([key, value]) => `${key}: ${String(value)}`)
                  .join(" · ")}
              </p>
            )}
            {item.nextPollAt && (
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Next poll: {new Date(item.nextPollAt).toLocaleString()}
              </p>
            )}
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
