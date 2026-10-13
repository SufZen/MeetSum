import { Skeleton } from "@/components/ui/skeleton"

/** Skeleton matching the dashboard layout: header, filters, KPI row, charts. */
export default function AnalyticsLoading() {
  return (
    <main className="min-h-svh bg-canvas" aria-busy="true">
      <div className="mx-auto grid w-full max-w-6xl gap-5 px-4 py-4">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-7 w-64" />
        <div className="flex flex-wrap gap-3">
          <Skeleton className="h-8 w-72" />
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-8 w-40" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-24 w-full" />
          ))}
        </div>
        <Skeleton className="h-72 w-full" />
        <div className="grid gap-5 lg:grid-cols-2">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    </main>
  )
}
