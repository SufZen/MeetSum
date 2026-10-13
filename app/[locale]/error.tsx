"use client"

import { SegmentError } from "@/components/segment-states"

/** [locale]: localized error state; never the error message in production (M9 D3). */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <SegmentError error={error} reset={reset} />
}
