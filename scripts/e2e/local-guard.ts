/** The e2e tooling only ever talks to loopback (docs/parity/m10.md, security check 5). */
export const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]"]

export function assertLocal(value: string, name: string): void {
  let host: string

  try {
    host = new URL(value).hostname
  } catch {
    throw new Error(`${name} is not a URL`)
  }
  if (!LOCAL_HOSTS.includes(host)) throw new Error(`${name} must point at localhost`)
}
