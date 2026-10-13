/**
 * Redaction for bot error text stored in bot_sessions.error, bot_events and
 * logs (M7 A1 redaction rules). Strips URL queries, passcodes (`pwd=`, `p=`,
 * `passcode`), API keys and Authorization values, then truncates.
 * Owned by Package A.
 */
export function redactBotError(input: unknown, maxLength = 500): string {
  const raw = input instanceof Error ? input.message : String(input ?? "")

  const redacted = raw
    // URL query strings and fragments carry passcodes and Teams context.
    .replace(/(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi, "$1?[redacted]")
    .replace(/\b(authorization|x-api-key|api[_-]?key)\b\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+(?:\s+[^\s,;]+)?)/gi, "$1: [redacted]")
    .replace(/\bbearer\s+[^\s,;"']+/gi, "Bearer [redacted]")
    .replace(/\b(pwd|p|passcode|password|secret|token)\b(["']?\s*[:=]\s*["']?)[^\s&,;"'}]+/gi, "$1$2[redacted]")

  return redacted.length > maxLength ? `${redacted.slice(0, maxLength - 1)}…` : redacted
}
