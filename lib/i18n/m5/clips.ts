/**
 * M5 clip strings (owner: Package C). Hebrew-first; every key exists in `he`
 * and `en`.
 */

export const clipsMessagesEn = {
  clipsTitle: "Clips",
  clipsCreate: "Create clip",
  clipsCopyLink: "Copy share link",
  clipsRendering: "Preparing audio…",
  clipsRenderFailed: "The clip couldn't be prepared.",
}

export const clipsMessagesHe: Record<keyof typeof clipsMessagesEn, string> = {
  clipsTitle: "קליפים",
  clipsCreate: "צור קליפ",
  clipsCopyLink: "העתק קישור שיתוף",
  clipsRendering: "מכין את האודיו…",
  clipsRenderFailed: "לא הצלחנו להכין את הקליפ.",
}
