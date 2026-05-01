import { RefreshCwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import type { JobRecord } from "@/lib/meetings/repository"

const progressByStatus = {
  queued: 16,
  active: 58,
  completed: 100,
  failed: 100,
} as const

export function JobActivityCenter({
  jobs,
  onRetry,
}: {
  jobs: JobRecord[]
  onRetry: (job: JobRecord) => void
}) {
  return (
    <section className="ms-card grid gap-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Job activity</h3>
        <span className="font-mono text-xs text-muted-foreground">
          {jobs.length}
        </span>
      </div>
      <div className="ms-scrollbar grid max-h-72 gap-2 overflow-y-auto">
        {jobs.length ? (
          jobs.map((job) => (
            <article key={job.id} className="grid gap-2 rounded-lg border border-[var(--divider)] bg-[var(--surface-subtle)] p-3">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate font-medium">{job.name}</span>
                <span className="capitalize text-muted-foreground">
                  {job.status}
                </span>
              </div>
              <Progress value={progressByStatus[job.status]} />
              {job.error && (
                <p className="break-words text-xs leading-5 text-destructive">
                  {job.error}
                </p>
              )}
              {job.status === "failed" && job.retryable !== false && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 w-fit"
                  onClick={() => onRetry(job)}
                >
                  <RefreshCwIcon data-icon="inline-start" />
                  Retry
                </Button>
              )}
            </article>
          ))
        ) : (
          <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            No jobs yet. Upload, record, or sync Google Workspace to start the
            pipeline.
          </div>
        )}
      </div>
    </section>
  )
}
