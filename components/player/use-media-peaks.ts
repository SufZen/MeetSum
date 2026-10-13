"use client"

import { useEffect, useState } from "react"

import { parsePeaksFile, type PeaksFile } from "@/lib/media/peaks"

const cache = new Map<string, PeaksFile | null>()

/**
 * Waveform peaks for the playable asset (`${base}/media/peaks`). Returns
 * `null` while loading, when the meeting has none, or on any error: the
 * waveform then draws its flat fallback.
 */
export function useMediaPeaks(mediaBaseUrl: string | undefined, enabled: boolean): PeaksFile | null {
  const url = enabled && mediaBaseUrl ? `${mediaBaseUrl}/media/peaks` : undefined
  const [loaded, setLoaded] = useState<{ url: string; peaks: PeaksFile | null } | null>(null)

  useEffect(() => {
    if (!url || cache.has(url)) return

    const controller = new AbortController()

    fetch(url, { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((json: unknown) => {
        const peaks = json ? parsePeaksFile(json) : null

        cache.set(url, peaks)
        setLoaded({ url, peaks })
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoaded({ url, peaks: null })
      })

    return () => controller.abort()
  }, [url])

  if (!url) return null
  if (cache.has(url)) return cache.get(url) ?? null

  return loaded?.url === url ? loaded.peaks : null
}
