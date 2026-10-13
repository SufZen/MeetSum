"use client"

import type { Dictionary } from "@/lib/i18n/dictionaries"

/**
 * Settings → Integrations (owner: Package D; docs/parity/m8.md, D1).
 * Lazy-loaded by the Settings panel; deep link
 * `?panel=settings&section=integrations`.
 *
 * Step 0 stub: renders nothing.
 */
export function IntegrationsSettings({ dictionary }: { dictionary: Dictionary }) {
  void dictionary

  return null
}
