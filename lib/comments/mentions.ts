/**
 * `@[name](user:<id>)` mentions (owner: Package C). Step 0 stubs: nothing
 * is parsed and no member is accepted.
 */

export type ParsedMention = {
  userId: string
  name: string
}

export function parseMentions(body: string): ParsedMention[] {
  void body
  return []
}

/** Keeps only workspace members; non-members are stripped. */
export function filterMemberMentions(
  mentions: ParsedMention[],
  memberUserIds: ReadonlySet<string>
): ParsedMention[] {
  void mentions
  void memberUserIds
  return []
}
