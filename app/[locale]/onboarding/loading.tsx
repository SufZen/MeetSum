import { Skeleton } from "@/components/ui/skeleton"

/** Skeleton matching the wizard: header, four-step stepper, step card, nav. */
export default function OnboardingLoading() {
  return (
    <main className="min-h-svh bg-canvas" aria-busy="true">
      <div className="mx-auto grid w-full max-w-3xl gap-6 px-4 py-8">
        <div className="grid gap-2">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-4 w-72" />
        </div>
        <div className="grid gap-2 sm:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-14 w-full" />
          ))}
        </div>
        <Skeleton className="h-48 w-full" />
        <div className="flex justify-between">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-40" />
        </div>
      </div>
    </main>
  )
}
