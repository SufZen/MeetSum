/**
 * Dev/e2e fake provider server (docs/parity/m8.md, "Fake mode"). Owner:
 * Package A. Loopback only; never used in production.
 * Step 0 stub: throws until Package A implements it.
 */
import type { FakeProviderHandlers, FakeProviderRequest } from "@/lib/integrations/core/types"

export type FakeProviderServer = {
  /** `http://127.0.0.1:<port>` */
  url: string
  /** Requests received so far, tokens redacted. */
  requests(): FakeProviderRequest[]
  close(): Promise<void>
}

export async function createFakeProviderServer(
  handlers: FakeProviderHandlers,
  options: { port?: number } = {}
): Promise<FakeProviderServer> {
  void handlers
  void options
  throw new Error("createFakeProviderServer: not implemented")
}
