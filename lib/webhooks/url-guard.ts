import { lookup as dnsLookupCallback, type LookupAddress } from "node:dns"
import { BlockList, isIP } from "node:net"

import { Agent, fetch as undiciFetch } from "undici"

/**
 * SSRF guard for outgoing webhook requests.
 *
 * Webhook URLs are operator-supplied, so every delivery must refuse to talk to
 * loopback, private, link-local (cloud metadata), CGNAT, multicast and other
 * non-public ranges. The check runs twice: once statically before the request
 * (`assertSafeWebhookUrl`) and again inside the socket connect lookup
 * (`guardedWebhookFetch`) so a DNS-rebinding answer that flips to a private
 * address between the two resolutions is still refused.
 *
 * `MEETSUM_WEBHOOK_ALLOWED_HOSTS` (comma separated: exact hosts, `*.suffix`,
 * or CIDR ranges) explicitly bypasses the guard for known internal receivers.
 */

export class UnsafeWebhookUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UnsafeWebhookUrlError"
  }
}

export type ResolvedAddress = { address: string; family: 4 | 6 }
export type WebhookHostResolver = (hostname: string) => Promise<ResolvedAddress[]>

export type WebhookUrlGuardOptions = {
  env?: NodeJS.ProcessEnv
  /** Override DNS resolution (tests). Used for the static check and at connect time. */
  resolve?: WebhookHostResolver
}

const blockedV4 = new BlockList()
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedV4.addSubnet(network, prefix, "ipv4")
}

const blockedV6 = new BlockList()
blockedV6.addAddress("::", "ipv6")
blockedV6.addAddress("::1", "ipv6")
for (const [network, prefix] of [
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
] as const) {
  blockedV6.addSubnet(network, prefix, "ipv6")
}

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"]

function stripBrackets(host: string) {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host
}

function normalizeHost(host: string) {
  return stripBrackets(host.trim().toLowerCase()).replace(/\.$/, "")
}

/** Expands an IPv6 literal into its eight 16-bit groups, or null when invalid. */
function parseIPv6Groups(address: string): number[] | null {
  let value = address.toLowerCase()
  const zoneIndex = value.indexOf("%")
  if (zoneIndex >= 0) value = value.slice(0, zoneIndex)
  if (isIP(value) !== 6) return null

  // Convert a trailing dotted IPv4 tail into two hex groups.
  const lastColon = value.lastIndexOf(":")
  const tail = value.slice(lastColon + 1)
  if (tail.includes(".")) {
    const octets = tail.split(".").map(Number)
    value =
      value.slice(0, lastColon + 1) +
      ((octets[0] << 8) | octets[1]).toString(16) +
      ":" +
      ((octets[2] << 8) | octets[3]).toString(16)
  }

  const [head, rest] = value.split("::") as [string, string | undefined]
  const headGroups = head ? head.split(":") : []
  const restGroups = rest ? rest.split(":") : []
  const missing =
    rest === undefined ? 0 : 8 - headGroups.length - restGroups.length
  const groups = [
    ...headGroups,
    ...Array.from({ length: missing }, () => "0"),
    ...restGroups,
  ].map((group) => parseInt(group, 16))

  return groups.length === 8 && groups.every((group) => Number.isInteger(group))
    ? groups
    : null
}

function groupsToIPv4(high: number, low: number) {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".")
}

/** IPv4 address embedded in an IPv4-mapped, IPv4-compatible, NAT64 or 6to4 IPv6 address. */
function embeddedIPv4(groups: number[]): string | null {
  const zeroPrefix = (count: number) =>
    groups.slice(0, count).every((group) => group === 0)

  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (deprecated compatible form)
  if (zeroPrefix(5) && (groups[5] === 0xffff || groups[5] === 0)) {
    if (groups[5] === 0 && groups[6] === 0) return null // :: and ::1 handled by the list
    return groupsToIPv4(groups[6], groups[7])
  }
  // ::ffff:0:a.b.c.d (SIIT translated)
  if (zeroPrefix(4) && groups[4] === 0xffff && groups[5] === 0) {
    return groupsToIPv4(groups[6], groups[7])
  }
  // 64:ff9b::/96 well-known NAT64 prefix and 64:ff9b:1::/48 local-use prefix
  if (groups[0] === 0x64 && groups[1] === 0xff9b) {
    return groupsToIPv4(groups[6], groups[7])
  }
  // 2002::/16 6to4 carries the IPv4 address in groups 1-2
  if (groups[0] === 0x2002) {
    return groupsToIPv4(groups[1], groups[2])
  }

  return null
}

/** True when the address is loopback, private, reserved or otherwise non-public. */
export function isBlockedAddress(address: string): boolean {
  const value = stripBrackets(address.trim())
  const family = isIP(value)

  if (family === 4) return blockedV4.check(value, "ipv4")
  // Not an IP address at all: never treat it as safe.
  if (family !== 6) return true

  const groups = parseIPv6Groups(value)
  if (!groups) return true

  const v4 = embeddedIPv4(groups)
  if (v4 && blockedV4.check(v4, "ipv4")) return true

  const canonical = groups.map((group) => group.toString(16)).join(":")
  return blockedV6.check(canonical, "ipv6")
}

type AllowPolicy = {
  hosts: Set<string>
  suffixes: string[]
  cidrs: BlockList
  hasCidrs: boolean
}

function parseAllowPolicy(env: NodeJS.ProcessEnv): AllowPolicy {
  const policy: AllowPolicy = {
    hosts: new Set(),
    suffixes: [],
    cidrs: new BlockList(),
    hasCidrs: false,
  }

  for (const raw of (env.MEETSUM_WEBHOOK_ALLOWED_HOSTS ?? "").split(",")) {
    const entry = raw.trim().toLowerCase()
    if (!entry) continue

    if (entry.includes("/")) {
      const [network, prefixText] = entry.split("/")
      const family = isIP(stripBrackets(network))
      const prefix = Number(prefixText)
      const max = family === 4 ? 32 : 128
      if (family && Number.isInteger(prefix) && prefix >= 0 && prefix <= max) {
        policy.cidrs.addSubnet(
          stripBrackets(network),
          prefix,
          family === 4 ? "ipv4" : "ipv6"
        )
        policy.hasCidrs = true
      }
      continue
    }

    if (entry.startsWith("*.")) {
      policy.suffixes.push(entry.slice(1).replace(/\.$/, ""))
      continue
    }

    policy.hosts.add(normalizeHost(entry))
  }

  return policy
}

function isHostAllowlisted(host: string, policy: AllowPolicy) {
  return (
    policy.hosts.has(host) ||
    policy.suffixes.some((suffix) => host.endsWith(suffix) && host.length > suffix.length)
  )
}

function isAddressAllowlisted(address: string, policy: AllowPolicy) {
  if (!policy.hasCidrs) return false
  const value = stripBrackets(address)
  const family = isIP(value)
  if (family === 4) return policy.cidrs.check(value, "ipv4")
  if (family === 6) {
    if (policy.cidrs.check(value, "ipv6")) return true
    const groups = parseIPv6Groups(value)
    const v4 = groups ? embeddedIPv4(groups) : null
    return v4 ? policy.cidrs.check(v4, "ipv4") : false
  }
  return false
}

function isAddressPermitted(address: string, policy: AllowPolicy) {
  return isAddressAllowlisted(address, policy) || !isBlockedAddress(address)
}

const systemResolver: WebhookHostResolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookupCallback(
      hostname,
      { all: true, verbatim: true },
      (error, addresses: LookupAddress[]) => {
        if (error) reject(error)
        else
          resolve(
            addresses.map((entry) => ({
              address: entry.address,
              family: entry.family === 6 ? 6 : 4,
            }))
          )
      }
    )
  })

function isProduction(env: NodeJS.ProcessEnv) {
  return env.NODE_ENV === "production"
}

/**
 * Validates a webhook URL and every address its host resolves to. Returns the
 * normalized URL string, or throws `UnsafeWebhookUrlError`.
 */
export async function assertSafeWebhookUrl(
  rawUrl: string,
  options: WebhookUrlGuardOptions = {}
): Promise<string> {
  const env = options.env ?? process.env
  const resolve = options.resolve ?? systemResolver
  let parsed: URL

  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new UnsafeWebhookUrlError("Webhook URL must be a valid absolute URL")
  }

  const policy = parseAllowPolicy(env)
  const host = normalizeHost(parsed.hostname)
  const hostAllowlisted = isHostAllowlisted(host, policy)
  const literalFamily = isIP(host)
  const literalAllowlisted =
    literalFamily !== 0 && isAddressAllowlisted(host, policy)

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new UnsafeWebhookUrlError("Webhook URL must use https")
  }

  if (
    parsed.protocol === "http:" &&
    isProduction(env) &&
    !hostAllowlisted &&
    !literalAllowlisted
  ) {
    throw new UnsafeWebhookUrlError(
      "Webhook URL must use https (http is only allowed for allowlisted hosts)"
    )
  }

  if (parsed.username || parsed.password) {
    throw new UnsafeWebhookUrlError("Webhook URL must not contain credentials")
  }

  if (!host) {
    throw new UnsafeWebhookUrlError("Webhook URL must include a host")
  }

  if (hostAllowlisted || literalAllowlisted) return parsed.toString()

  if (
    host === "localhost" ||
    BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
  ) {
    throw new UnsafeWebhookUrlError(
      "Webhook URL must not target a local or internal host"
    )
  }

  if (literalFamily !== 0) {
    if (isBlockedAddress(host)) {
      throw new UnsafeWebhookUrlError(
        "Webhook URL must not target a private or reserved address"
      )
    }
    return parsed.toString()
  }

  let addresses: ResolvedAddress[]
  try {
    addresses = await resolve(host)
  } catch {
    throw new UnsafeWebhookUrlError(`Webhook host ${host} could not be resolved`)
  }

  if (!addresses.length) {
    throw new UnsafeWebhookUrlError(`Webhook host ${host} could not be resolved`)
  }

  if (addresses.some((entry) => !isAddressPermitted(entry.address, policy))) {
    throw new UnsafeWebhookUrlError(
      "Webhook URL resolves to a private or reserved address"
    )
  }

  return parsed.toString()
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number
) => void

/** `net.connect` lookup that re-validates addresses at connect time (DNS rebinding defence). */
function createGuardedLookup(env: NodeJS.ProcessEnv, resolve: WebhookHostResolver) {
  return (
    hostname: string,
    options: { all?: boolean } | number | undefined,
    callback: LookupCallback
  ) => {
    const policy = parseAllowPolicy(env)
    const host = normalizeHost(hostname)
    const wantsAll = typeof options === "object" && options?.all === true

    resolve(host)
      .then((addresses) => {
        if (!addresses.length) {
          throw new UnsafeWebhookUrlError(`Webhook host ${host} could not be resolved`)
        }
        if (
          !isHostAllowlisted(host, policy) &&
          addresses.some((entry) => !isAddressPermitted(entry.address, policy))
        ) {
          throw new UnsafeWebhookUrlError(
            "Webhook URL resolves to a private or reserved address"
          )
        }

        if (wantsAll) callback(null, addresses)
        else callback(null, addresses[0].address, addresses[0].family)
      })
      .catch((error: NodeJS.ErrnoException) => callback(error, wantsAll ? [] : ""))
  }
}

export type GuardedWebhookResponse = {
  ok: boolean
  status: number
  durationMs: number
}

/**
 * POSTs (or otherwise sends) a webhook request with the SSRF guard applied
 * before and during connect. Redirects are never followed; the response body
 * is discarded so the socket is released.
 */
export async function guardedWebhookFetch(
  url: string,
  init: {
    method?: string
    headers?: Record<string, string>
    body?: string
    timeoutMs: number
  },
  options: WebhookUrlGuardOptions = {}
): Promise<GuardedWebhookResponse> {
  const env = options.env ?? process.env
  const resolve = options.resolve ?? systemResolver
  const safeUrl = await assertSafeWebhookUrl(url, { env, resolve })
  const dispatcher = new Agent({
    connect: { lookup: createGuardedLookup(env, resolve) },
  })
  const startedAt = Date.now()

  try {
    const response = await undiciFetch(safeUrl, {
      method: init.method ?? "POST",
      headers: init.headers,
      body: init.body,
      redirect: "manual",
      dispatcher,
      signal: AbortSignal.timeout(init.timeoutMs),
    })

    await response.body?.cancel().catch(() => {})

    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      durationMs: Date.now() - startedAt,
    }
  } catch (error) {
    // Surface guard rejections raised inside the connect lookup as-is.
    const cause = (error as { cause?: unknown }).cause
    if (cause instanceof UnsafeWebhookUrlError) throw cause
    throw error
  } finally {
    await dispatcher.close().catch(() => {})
  }
}
