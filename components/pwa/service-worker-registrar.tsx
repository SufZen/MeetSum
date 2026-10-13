"use client"

/**
 * Service worker registration (M9 Step 0 mount point in the `[locale]`
 * layout; owner: Package D, docs/parity/m9.md D4). Registers only in
 * production, on a secure context, unless NEXT_PUBLIC_MEETSUM_PWA="false".
 * Step 0 stub: registers nothing.
 */
export function ServiceWorkerRegistrar() {
  return null
}
