import { randomBytes } from "node:crypto"

const CRLF = "\r\n"
/** RFC 2047: an encoded-word is at most 75 chars; `=?UTF-8?B?` + `?=` = 12. */
const MAX_ENCODED_WORD_BYTES = 45

/** Strip CR/LF so user-controlled values can never inject headers. */
export function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim()
}

function isPrintableAscii(value: string): boolean {
  return /^[\x20-\x7e]*$/.test(value)
}

/**
 * RFC 2047 encoding of a header value. ASCII stays as-is; anything else is
 * split into `=?UTF-8?B?…?=` words (≤ 75 chars, never splitting a UTF-8
 * sequence) folded with CRLF + space.
 */
export function encodeHeaderWord(value: string): string {
  const clean = sanitizeHeaderValue(value)

  if (isPrintableAscii(clean)) return clean

  const words: string[] = []
  let chunk = ""

  for (const char of clean) {
    if (Buffer.byteLength(chunk + char, "utf8") > MAX_ENCODED_WORD_BYTES) {
      words.push(chunk)
      chunk = ""
    }

    chunk += char
  }

  if (chunk) words.push(chunk)

  return words
    .map((word) => `=?UTF-8?B?${Buffer.from(word, "utf8").toString("base64")}?=`)
    .join(`${CRLF} `)
}

/** `Name <address>` with the display name encoded when needed. */
export function formatAddress(address: string, name?: string): string {
  const cleanAddress = sanitizeHeaderValue(address)
  const cleanName = name ? sanitizeHeaderValue(name) : ""

  if (!cleanName) return cleanAddress

  const displayName = isPrintableAscii(cleanName)
    ? `"${cleanName.replace(/["\\]/g, "\\$&")}"`
    : encodeHeaderWord(cleanName)

  return `${displayName} <${cleanAddress}>`
}

function base64Body(value: string): string {
  return (
    Buffer.from(value, "utf8")
      .toString("base64")
      .match(/.{1,76}/g)
      ?.join(CRLF) ?? ""
  )
}

export type MimeMessageInput = {
  from: string
  fromName?: string
  to: string
  subject: string
  text: string
  html?: string
  replyTo?: string
  date?: Date
  messageIdDomain?: string
  boundary?: string
}

/** RFC 5322 message (text, or multipart/alternative text + html), CRLF line endings. */
export function buildMimeMessage(input: MimeMessageInput): string {
  const domain = input.messageIdDomain ?? input.from.split("@")[1] ?? "meetsum.local"
  const headers = [
    `From: ${formatAddress(input.from, input.fromName)}`,
    `To: ${formatAddress(input.to)}`,
    ...(input.replyTo ? [`Reply-To: ${formatAddress(input.replyTo)}`] : []),
    `Subject: ${encodeHeaderWord(input.subject)}`,
    `Date: ${(input.date ?? new Date()).toUTCString()}`,
    `Message-ID: <${randomBytes(12).toString("hex")}@${sanitizeHeaderValue(domain)}>`,
    "MIME-Version: 1.0",
  ]

  if (!input.html) {
    return [
      ...headers,
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      base64Body(input.text),
    ].join(CRLF)
  }

  const boundary = input.boundary ?? `meetsum_${randomBytes(12).toString("hex")}`

  return [
    ...headers,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Body(input.text),
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Body(input.html),
    `--${boundary}--`,
    "",
  ].join(CRLF)
}

/** Gmail API `raw` field: base64url of the full message. */
export function toBase64Url(raw: string): string {
  return Buffer.from(raw, "utf8").toString("base64url")
}
