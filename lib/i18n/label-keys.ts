/**
 * Dictionary keys derived from stable ids (M9): `prefix` + PascalCase of the
 * id's dot/underscore/hyphen parts. `auditActionKey("meeting.share.created")`
 * → `auditActionMeetingShareCreated`. Messages: lib/i18n/m9/admin-labels.ts.
 */
function pascal(id: string): string {
  return id
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("")
}

export function auditActionKey(action: string): string {
  return `auditAction${pascal(action)}`
}

export function webhookEventDescriptionKey(eventName: string): string {
  return `webhookEventDesc${pascal(eventName)}`
}

/** The dictionary text for `key`, or `fallback` when the key is unknown. */
export function labelOr(messages: Readonly<Record<string, string>>, key: string, fallback: string): string {
  return messages[key] ?? fallback
}
