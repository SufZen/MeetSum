/**
 * M9 follow-up: the first visit's clients.claim() fires controllerchange;
 * the registrar must not reload for it, only for a real update.
 */
import { describe, expect, it, vi } from "vitest"

import { createControllerChangeHandler, shouldRegisterServiceWorker } from "@/components/pwa/service-worker-registrar"

describe("createControllerChangeHandler", () => {
  it("does not reload on the first claim (no controller at mount)", () => {
    const reload = vi.fn()
    const onChange = createControllerChangeHandler(false, reload)

    onChange()
    onChange()
    expect(reload).not.toHaveBeenCalled()
  })

  it("reloads exactly once for an update of an already controlled page", () => {
    const reload = vi.fn()
    const onChange = createControllerChangeHandler(true, reload)

    onChange()
    onChange()
    expect(reload).toHaveBeenCalledTimes(1)
  })
})

describe("shouldRegisterServiceWorker", () => {
  it("registers only in production on a secure context", () => {
    const base = { nodeEnv: "production", pwaFlag: undefined, isSecureContext: true, hasServiceWorker: true }

    expect(shouldRegisterServiceWorker(base)).toBe(true)
    expect(shouldRegisterServiceWorker({ ...base, nodeEnv: "development" })).toBe(false)
    expect(shouldRegisterServiceWorker({ ...base, pwaFlag: "false" })).toBe(false)
  })
})
