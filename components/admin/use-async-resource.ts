"use client"

import { useCallback, useEffect, useRef, useState } from "react"

/**
 * Loads data on mount and exposes loading / error / reload. `describeError`
 * turns a failure into the localized text shown to the user.
 */
export function useAsyncResource<T>(
  loader: () => Promise<T>,
  initial: T,
  describeError: (error: unknown) => string
) {
  const loaderRef = useRef(loader)
  const describeRef = useRef(describeError)
  const [data, setData] = useState<T>(initial)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()

  useEffect(() => {
    loaderRef.current = loader
    describeRef.current = describeError
  })

  const reload = useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      setData(await loaderRef.current())
    } catch (loadError) {
      setError(describeRef.current(loadError))
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial load (state already starts as loading).
  useEffect(() => {
    let cancelled = false

    loaderRef.current().then(
      (value) => {
        if (cancelled) return
        setData(value)
        setLoading(false)
      },
      (loadError: unknown) => {
        if (cancelled) return
        setError(describeRef.current(loadError))
        setLoading(false)
      }
    )

    return () => {
      cancelled = true
    }
  }, [])

  return { data, setData, loading, error, reload }
}
