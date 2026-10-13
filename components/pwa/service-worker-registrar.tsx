"use client"

/**
 * Service worker registration (docs/parity/m9.md D4; mounted in the
 * `[locale]` layout). Registers `/sw.js` only in production, on a secure
 * context, unless NEXT_PUBLIC_MEETSUM_PWA="false". A waiting worker
 * activates only after the user accepts the "update available" toast; the
 * page then reloads once on `controllerchange`.
 */
import { useEffect } from "react"
import { toast } from "sonner"

import { useOptionalI18n } from "@/components/i18n-provider"

export function shouldRegisterServiceWorker(env: {
  nodeEnv: string | undefined
  pwaFlag: string | undefined
  isSecureContext: boolean
  hasServiceWorker: boolean
}): boolean {
  return env.nodeEnv === "production" && env.pwaFlag !== "false" && env.isSecureContext && env.hasServiceWorker
}

/** Asks every service worker to delete its caches (logout). */
export async function clearServiceWorkerCaches(): Promise<void> {
  try {
    const registrations = (await navigator.serviceWorker?.getRegistrations?.()) ?? []

    registrations.forEach((registration) => registration.active?.postMessage({ type: "clear-caches" }))
  } catch {
    // No service worker: nothing cached.
  }
}

export function ServiceWorkerRegistrar() {
  const i18n = useOptionalI18n()
  const updateText = i18n?.t("pwaUpdateAvailable") ?? ""
  const reloadText = i18n?.t("pwaUpdateReload") ?? ""

  useEffect(() => {
    if (
      !shouldRegisterServiceWorker({
        nodeEnv: process.env.NODE_ENV,
        pwaFlag: process.env.NEXT_PUBLIC_MEETSUM_PWA,
        isSecureContext: window.isSecureContext,
        hasServiceWorker: "serviceWorker" in navigator,
      })
    ) {
      return
    }

    let reloading = false
    const onControllerChange = () => {
      if (reloading) return
      reloading = true
      window.location.reload()
    }
    const offerUpdate = (worker: ServiceWorker) => {
      toast(updateText, {
        duration: Infinity,
        action: { label: reloadText, onClick: () => worker.postMessage({ type: "skip-waiting" }) },
      })
    }

    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange)
    void navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then((registration) => {
        // An update finished installing while the page was closed.
        if (registration.waiting && navigator.serviceWorker.controller) offerUpdate(registration.waiting)
        registration.addEventListener("updatefound", () => {
          const installing = registration.installing

          installing?.addEventListener("statechange", () => {
            if (installing.state === "installed" && navigator.serviceWorker.controller) offerUpdate(installing)
          })
        })
      })
      .catch(() => undefined)

    return () => navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange)
  }, [reloadText, updateText])

  return null
}
