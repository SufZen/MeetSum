/**
 * M5 comment and reaction strings (owner: Package C). Hebrew-first; every
 * key exists in `he` and `en`.
 */

export const commentsMessagesEn = {
  commentsTitle: "Comments",
  commentsAdd: "Add a comment",
  commentsReply: "Reply",
  commentsResolve: "Resolve",
  commentsOrphaned: "The commented content changed",
}

export const commentsMessagesHe: Record<keyof typeof commentsMessagesEn, string> = {
  commentsTitle: "תגובות",
  commentsAdd: "הוספת תגובה",
  commentsReply: "השב",
  commentsResolve: "סמן כטופל",
  commentsOrphaned: "התוכן שהתגובה מתייחסת אליו השתנה",
}
