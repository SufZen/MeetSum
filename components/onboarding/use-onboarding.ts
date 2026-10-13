"use client"

/**
 * Client state for onboarding (docs/parity/m9.md C3): the live steps from
 * `GET /api/onboarding` and the `POST` actions (skip, unskip, dismiss,
 * complete). Returns null state until loaded unless an initial state is given.
 */
import { useCallback, useEffect, useState } from "react"

import type { OnboardingAction, OnboardingState } from "@/lib/onboarding/types"

export type OnboardingClientState = OnboardingState & { enabled?: boolean }

export function useOnboarding(initial: OnboardingClientState | null = null) {
  const [state, setState] = useState<OnboardingClientState | null>(initial)
  const [failed, setFailed] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/onboarding", { cache: "no-store" })

      if (!response.ok) throw new Error(String(response.status))
      setState((await response.json()) as OnboardingClientState)
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [])

  const act = useCallback(async (action: OnboardingAction): Promise<boolean> => {
    try {
      const response = await fetch("/api/onboarding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(action),
      })

      if (!response.ok) throw new Error(String(response.status))
      setState((await response.json()) as OnboardingClientState)
      return true
    } catch {
      return false
    }
  }, [])

  useEffect(() => {
    if (initial) return

    let cancelled = false

    fetch("/api/onboarding", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status))
        return (await response.json()) as OnboardingClientState
      })
      .then((value) => {
        if (!cancelled) setState(value)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })

    return () => {
      cancelled = true
    }
  }, [initial])

  return { state, failed, refresh, act }
}
