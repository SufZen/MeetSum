import type { ActionItem } from "@/lib/meetings/repository"

export type ActionItemMergePlan = {
  /** Protected items (user-edited, user-created or done); left untouched. */
  keep: ActionItem[]
  /** Unprotected existing items refreshed in place from the new AI output. */
  update: ActionItem[]
  /** New AI items with no existing counterpart. */
  insert: ActionItem[]
  /** Ids of unprotected existing items the new AI output no longer contains. */
  remove: string[]
}

const NIQQUD_PATTERN = /[֑-ׇ]/g
const NON_WORD_PATTERN = /[^\p{L}\p{N}]+/gu

/**
 * Canonical form used to match a regenerated AI task against an existing one:
 * NFKC, lowercase, Hebrew niqqud/cantillation stripped, punctuation collapsed.
 */
export function normalizeTaskTitle(title: string): string {
  return title
    .normalize("NFKC")
    .toLowerCase()
    .replace(NIQQUD_PATTERN, "")
    .replace(NON_WORD_PATTERN, " ")
    .trim()
}

export function isProtectedActionItem(item: ActionItem): boolean {
  return item.editedByUser === true || item.origin === "user" || item.status === "done"
}

function existingKey(item: ActionItem) {
  return normalizeTaskTitle(item.originalTitle ?? item.title)
}

/**
 * Plans how to fold a fresh AI extraction into the persisted action items
 * without losing user work. Pure: callers apply the plan in one transaction.
 */
export function mergeActionItems(
  existing: ActionItem[],
  incoming: ActionItem[],
  createId: () => string
): ActionItemMergePlan {
  const keep = existing.filter(isProtectedActionItem)
  const protectedKeys = new Set(keep.map(existingKey).filter(Boolean))
  const unprotected = new Map<string, ActionItem>()

  for (const item of existing) {
    if (isProtectedActionItem(item)) continue
    const key = existingKey(item)
    if (key && !unprotected.has(key)) unprotected.set(key, item)
  }

  const usedIds = new Set(existing.map((item) => item.id))
  const matchedIds = new Set<string>()
  const update: ActionItem[] = []
  const insert: ActionItem[] = []

  for (const item of incoming) {
    const key = normalizeTaskTitle(item.title)

    if (key && protectedKeys.has(key)) continue

    const match = key ? unprotected.get(key) : undefined

    if (match && !matchedIds.has(match.id)) {
      matchedIds.add(match.id)
      update.push({
        ...item,
        id: match.id,
        origin: "ai",
        editedByUser: false,
        originalTitle: item.title,
        completedAt: undefined,
      })
      continue
    }

    let id = item.id

    while (!id || usedIds.has(id)) {
      id = createId()
    }
    usedIds.add(id)
    insert.push({
      ...item,
      id,
      origin: "ai",
      editedByUser: false,
      originalTitle: item.title,
    })
  }

  const remove = existing
    .filter((item) => !isProtectedActionItem(item) && !matchedIds.has(item.id))
    .map((item) => item.id)

  return { keep, update, insert, remove }
}
