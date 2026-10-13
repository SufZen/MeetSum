/**
 * Meeting visibility predicate for stores outside the meeting repository
 * (M5 Step 0): tasks, clips, comments, analytics and prep apply the same M2
 * scope as `ctx.meetings`.
 */
export { meetingScopeSql } from "@/lib/meetings/visibility"
