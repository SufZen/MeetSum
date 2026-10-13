/**
 * `@[name](user:<id>)` mentions (M5 C3). Pure and client-safe: the composer
 * inserts the markup, the server keeps it only for workspace members and
 * turns any other mention into plain `@name` text.
 */

export type ParsedMention = {
  userId: string
  name: string
}

const MENTION = /@\[([^\]\r\n]{1,100})\]\(user:([A-Za-z0-9_-]{1,100})\)/g

/** Mentions in body order, deduplicated by user id. */
export function parseMentions(body: string): ParsedMention[] {
  const seen = new Set<string>()
  const mentions: ParsedMention[] = []

  for (const match of body.matchAll(MENTION)) {
    const userId = match[2]

    if (seen.has(userId)) continue
    seen.add(userId)
    mentions.push({ userId, name: match[1].trim() })
  }

  return mentions
}

/** Keeps only workspace members; non-members are stripped. */
export function filterMemberMentions(
  mentions: ParsedMention[],
  memberUserIds: ReadonlySet<string>
): ParsedMention[] {
  return mentions.filter((mention) => memberUserIds.has(mention.userId))
}

/**
 * Body with non-member mention markup replaced by plain `@name`, plus the
 * member user ids that remain mentioned.
 */
export function sanitizeMentions(
  body: string,
  memberUserIds: ReadonlySet<string>
): { body: string; mentions: string[] } {
  const cleaned = body.replace(MENTION, (markup, name: string, userId: string) =>
    memberUserIds.has(userId) ? markup : `@${name.trim()}`
  )

  return {
    body: cleaned,
    mentions: filterMemberMentions(parseMentions(cleaned), memberUserIds).map(
      (mention) => mention.userId
    ),
  }
}

export type BodyPart = { type: "text"; text: string } | { type: "mention"; name: string; userId: string }

/** Body split into text and mention parts for escaped rendering. */
export function splitMentions(body: string): BodyPart[] {
  const parts: BodyPart[] = []
  let cursor = 0

  for (const match of body.matchAll(MENTION)) {
    const index = match.index ?? 0

    if (index > cursor) parts.push({ type: "text", text: body.slice(cursor, index) })
    parts.push({ type: "mention", name: match[1].trim(), userId: match[2] })
    cursor = index + match[0].length
  }

  if (cursor < body.length) parts.push({ type: "text", text: body.slice(cursor) })
  return parts
}

/** The markup the composer inserts for a picked member. */
export function mentionMarkup(name: string, userId: string): string {
  const safeName = name.replace(/[\][\r\n()]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100)

  return `@[${safeName || "user"}](user:${userId})`
}
