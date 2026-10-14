import { Skeleton } from "@/components/ui/skeleton"

/** Placeholder rows while the transcript (or its lazy chunk) loads. */
export function TranscriptSkeleton({ label }: { label?: string }) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className="grid gap-4 p-2">
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-3">
          <Skeleton className="size-6.5 rounded-full" />
          <div className="grid gap-2">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-4/5" />
          </div>
        </div>
      ))}
    </div>
  )
}
