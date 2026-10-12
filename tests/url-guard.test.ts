import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  assertSafeWebhookUrl,
  guardedWebhookFetch,
  isBlockedAddress,
  UnsafeWebhookUrlError,
  type WebhookHostResolver,
} from "@/lib/webhooks/url-guard"

const publicResolver: WebhookHostResolver = async () => [
  { address: "93.184.216.34", family: 4 },
]

describe("isBlockedAddress", () => {
  it.each([
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "127.255.255.254",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.8",
    "192.0.2.10",
    "192.168.1.1",
    "198.18.0.1",
    "198.19.255.255",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.1",
    "239.255.255.250",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "[::1]",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "fe80::1%eth0",
    "ff02::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "64:ff9b::a9fe:a9fe",
    "64:ff9b::10.0.0.1",
    "2002:7f00:1::",
    "2002:c0a8:101::1",
    "2002:a9fe:a9fe::",
    "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    "2001::1",
    "::127.0.0.1",
    "::ffff:0:127.0.0.1",
    "64:ff9b:1::7f00:1",
    "not-an-ip",
  ])("blocks %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true)
  })

  it.each([
    "8.8.8.8",
    "93.184.216.34",
    "172.32.0.1",
    "100.128.0.1",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
  ])("allows public %s", (address) => {
    expect(isBlockedAddress(address)).toBe(false)
  })
})

describe("assertSafeWebhookUrl", () => {
  const prod = { NODE_ENV: "production" } as NodeJS.ProcessEnv

  it("accepts a public https URL", async () => {
    await expect(
      assertSafeWebhookUrl("https://hooks.example.com/meetsum", {
        env: prod,
        resolve: publicResolver,
      })
    ).resolves.toBe("https://hooks.example.com/meetsum")
  })

  it.each([
    ["http in production", "http://hooks.example.com/x"],
    ["non-http scheme", "ftp://hooks.example.com/x"],
    ["credentials", "https://user:pass@hooks.example.com/x"],
    ["localhost", "https://localhost/x"],
    ["localhost subdomain", "https://api.localhost/x"],
    [".local", "https://printer.local/x"],
    [".internal", "https://metadata.google.internal/x"],
    [".home.arpa", "https://nas.home.arpa/x"],
    ["metadata IP", "https://169.254.169.254/latest/meta-data"],
    ["loopback IPv6", "https://[::1]/x"],
    ["mapped IPv6", "https://[::ffff:127.0.0.1]/x"],
    ["private IP", "https://10.0.0.5/x"],
    ["invalid", "not a url"],
    ["hex IPv4 shorthand", "https://0x7f.1/x"],
    ["decimal IPv4", "https://2130706433/x"],
    ["octal IPv4", "https://0177.0.0.1/x"],
    ["short IPv4", "https://127.1/x"],
    ["decimal metadata IP", "https://2852039166/latest"],
    ["trailing-dot localhost", "https://localhost./x"],
    ["uppercase localhost", "https://LOCALHOST/x"],
    ["fullwidth localhost (IDN)", "https://ｌｏｃａｌｈｏｓｔ/x"],
    ["trailing-dot internal", "https://metadata.google.internal./x"],
    ["hex-mapped IPv6", "https://[::ffff:7f00:1]/x"],
    ["NAT64 metadata", "https://[64:ff9b::a9fe:a9fe]/x"],
    ["6to4 private", "https://[2002:c0a8:101::1]/x"],
    ["Teredo", "https://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/x"],
    ["unspecified IPv4", "https://0.0.0.0/x"],
  ])("rejects %s", async (_label, url) => {
    await expect(
      assertSafeWebhookUrl(url, { env: prod, resolve: publicResolver })
    ).rejects.toBeInstanceOf(UnsafeWebhookUrlError)
  })

  it("allows http outside production", async () => {
    await expect(
      assertSafeWebhookUrl("http://hooks.example.com/x", {
        env: { NODE_ENV: "development" } as NodeJS.ProcessEnv,
        resolve: publicResolver,
      })
    ).resolves.toBe("http://hooks.example.com/x")
  })

  it("rejects a hostname when any resolved address is private", async () => {
    await expect(
      assertSafeWebhookUrl("https://mixed.example.com/x", {
        env: prod,
        resolve: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "10.0.0.8", family: 4 },
        ],
      })
    ).rejects.toThrow(/private or reserved/)
  })

  it("rejects unresolvable hosts", async () => {
    await expect(
      assertSafeWebhookUrl("https://nowhere.example.com/x", {
        env: prod,
        resolve: async () => {
          throw new Error("ENOTFOUND")
        },
      })
    ).rejects.toThrow(/could not be resolved/)
  })

  it("honours exact host, wildcard suffix and CIDR allowlist entries", async () => {
    const env = {
      NODE_ENV: "production",
      MEETSUM_WEBHOOK_ALLOWED_HOSTS: "n8n, *.svc.cluster, 10.20.0.0/16",
    } as NodeJS.ProcessEnv
    const privateResolver: WebhookHostResolver = async () => [
      { address: "10.20.3.4", family: 4 },
    ]
    const loopbackResolver: WebhookHostResolver = async () => [
      { address: "127.0.0.1", family: 4 },
    ]

    await expect(
      assertSafeWebhookUrl("http://n8n:5678/webhook/x", { env, resolve: loopbackResolver })
    ).resolves.toBe("http://n8n:5678/webhook/x")
    await expect(
      assertSafeWebhookUrl("https://hooks.svc.cluster/x", { env, resolve: loopbackResolver })
    ).resolves.toBe("https://hooks.svc.cluster/x")
    await expect(
      assertSafeWebhookUrl("https://svc.cluster/x", { env, resolve: loopbackResolver })
    ).rejects.toBeInstanceOf(UnsafeWebhookUrlError)
    await expect(
      assertSafeWebhookUrl("https://evilsvc.cluster/x", { env, resolve: loopbackResolver })
    ).rejects.toBeInstanceOf(UnsafeWebhookUrlError)
    await expect(
      assertSafeWebhookUrl("https://n8n.evil.example/x", { env, resolve: loopbackResolver })
    ).rejects.toBeInstanceOf(UnsafeWebhookUrlError)
    await expect(
      assertSafeWebhookUrl("https://N8N./x", { env, resolve: loopbackResolver })
    ).resolves.toBe("https://n8n./x")
    await expect(
      assertSafeWebhookUrl("https://receiver.example.com/x", { env, resolve: privateResolver })
    ).resolves.toBe("https://receiver.example.com/x")
    await expect(
      assertSafeWebhookUrl("http://10.20.9.9/x", { env, resolve: publicResolver })
    ).resolves.toBe("http://10.20.9.9/x")
    await expect(
      assertSafeWebhookUrl("https://10.21.0.1/x", { env, resolve: publicResolver })
    ).rejects.toBeInstanceOf(UnsafeWebhookUrlError)
  })
})

describe("guardedWebhookFetch", () => {
  let server: Server
  let port: number
  let requests: string[]

  beforeEach(async () => {
    requests = []
    server = createServer((request, response) => {
      requests.push(request.url ?? "")
      if (request.url === "/redirect") {
        response.writeHead(302, { location: `http://127.0.0.1:${port}/target` })
        response.end()
        return
      }
      response.writeHead(200, { "content-type": "text/plain" })
      response.end("ok")
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    port = (server.address() as AddressInfo).port
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  const allowLoopback = {
    NODE_ENV: "test",
    MEETSUM_WEBHOOK_ALLOWED_HOSTS: "127.0.0.1/32",
  } as NodeJS.ProcessEnv

  it("delivers to an allowlisted receiver", async () => {
    const response = await guardedWebhookFetch(
      `http://127.0.0.1:${port}/hook`,
      { body: "{}", headers: { "content-type": "application/json" }, timeoutMs: 5000 },
      { env: allowLoopback }
    )

    expect(response).toMatchObject({ ok: true, status: 200 })
    expect(requests).toEqual(["/hook"])
  })

  it("does not follow redirects", async () => {
    const response = await guardedWebhookFetch(
      `http://127.0.0.1:${port}/redirect`,
      { body: "{}", timeoutMs: 5000 },
      { env: allowLoopback }
    )

    expect(response.ok).toBe(false)
    expect(response.status).toBe(302)
    expect(requests).toEqual(["/redirect"])
  })

  it("refuses loopback without an allowlist entry", async () => {
    await expect(
      guardedWebhookFetch(
        `http://127.0.0.1:${port}/hook`,
        { body: "{}", timeoutMs: 5000 },
        { env: { NODE_ENV: "test" } as NodeJS.ProcessEnv }
      )
    ).rejects.toBeInstanceOf(UnsafeWebhookUrlError)
    expect(requests).toEqual([])
  })

  it("re-checks DNS at connect time even when one family is public", async () => {
    let calls = 0
    const mixed: WebhookHostResolver = async () => {
      calls += 1
      return calls === 1
        ? [{ address: "93.184.216.34", family: 4 }]
        : [
            { address: "93.184.216.34", family: 4 },
            { address: "::1", family: 6 },
          ]
    }

    await expect(
      guardedWebhookFetch(
        `http://mixed.example.com:${port}/hook`,
        { body: "{}", timeoutMs: 5000 },
        { env: { NODE_ENV: "test" } as NodeJS.ProcessEnv, resolve: mixed }
      )
    ).rejects.toBeInstanceOf(UnsafeWebhookUrlError)
    expect(requests).toEqual([])
  })

  it("aborts a receiver that never answers within the timeout", async () => {
    const slow = createServer(() => {
      // never respond
    })
    await new Promise<void>((resolve) => slow.listen(0, "127.0.0.1", resolve))
    const slowPort = (slow.address() as AddressInfo).port
    const started = Date.now()

    try {
      await expect(
        guardedWebhookFetch(
          `http://127.0.0.1:${slowPort}/hook`,
          { body: "{}", timeoutMs: 300 },
          { env: allowLoopback }
        )
      ).rejects.toThrow()
      expect(Date.now() - started).toBeLessThan(3000)
    } finally {
      slow.closeAllConnections()
      await new Promise<void>((resolve) => slow.close(() => resolve()))
    }
  })

  it("discards large response bodies without reading them", async () => {
    const big = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/octet-stream" })
      response.end(Buffer.alloc(4 * 1024 * 1024))
    })
    await new Promise<void>((resolve) => big.listen(0, "127.0.0.1", resolve))
    const bigPort = (big.address() as AddressInfo).port

    try {
      await expect(
        guardedWebhookFetch(
          `http://127.0.0.1:${bigPort}/hook`,
          { body: "{}", timeoutMs: 5000 },
          { env: allowLoopback }
        )
      ).resolves.toMatchObject({ status: 200, ok: true })
    } finally {
      big.closeAllConnections()
      await new Promise<void>((resolve) => big.close(() => resolve()))
    }
  })

  it("re-checks DNS at connect time (rebinding defence)", async () => {
    let calls = 0
    const rebinding: WebhookHostResolver = async () => {
      calls += 1
      return calls === 1
        ? [{ address: "93.184.216.34", family: 4 }]
        : [{ address: "127.0.0.1", family: 4 }]
    }

    await expect(
      guardedWebhookFetch(
        `http://rebind.example.com:${port}/hook`,
        { body: "{}", timeoutMs: 5000 },
        { env: { NODE_ENV: "test" } as NodeJS.ProcessEnv, resolve: rebinding }
      )
    ).rejects.toBeInstanceOf(UnsafeWebhookUrlError)
    expect(calls).toBeGreaterThanOrEqual(2)
    expect(requests).toEqual([])
  })
})
