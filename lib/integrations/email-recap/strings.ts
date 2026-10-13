/**
 * Email recap template strings (owner: Package A). Server-only: not part of
 * the client dictionary. The key list is frozen by Step 0 (docs/parity/m8.md,
 * item 12). `{title}`, `{workspace}` and `{date}` are placeholders filled
 * after HTML escaping.
 */

export const recapStringsEn = {
  recapSubject: "Meeting recap: {title}",
  recapGreeting: "Here is the recap of {title}.",
  recapOverview: "Overview",
  recapActionItems: "Action items",
  recapDecisions: "Decisions",
  recapOpenQuestions: "Open questions",
  recapOwner: "Owner",
  recapDue: "Due",
  recapOpenInMeetSum: "Open in MeetSum",
  recapOpenShare: "Open the shared recap",
  recapWhyReceived: "You received this email because you took part in “{title}” and the {workspace} workspace sends meeting recaps.",
  recapUnsubscribe: "Unsubscribe from meeting recaps",
  recapUnsubscribeConfirmTitle: "Unsubscribe from meeting recaps?",
  recapUnsubscribeConfirmBody: "You will stop receiving meeting recap emails from this workspace.",
  recapUnsubscribeConfirmButton: "Unsubscribe",
  recapUnsubscribeDone: "You are unsubscribed. You will no longer receive meeting recaps from this workspace.",
  recapUnsubscribeInvalid: "This unsubscribe link is not valid.",
}

export const recapStringsHe: Record<keyof typeof recapStringsEn, string> = {
  recapSubject: "סיכום פגישה: {title}",
  recapGreeting: "זהו הסיכום של {title}.",
  recapOverview: "סקירה",
  recapActionItems: "משימות",
  recapDecisions: "החלטות",
  recapOpenQuestions: "שאלות פתוחות",
  recapOwner: "אחראי/ת",
  recapDue: "עד",
  recapOpenInMeetSum: "פתיחה ב-MeetSum",
  recapOpenShare: "פתיחת הסיכום המשותף",
  recapWhyReceived: "קיבלת הודעה זו כי השתתפת בפגישה ״{title}״ וסביבת העבודה {workspace} שולחת סיכומי פגישות.",
  recapUnsubscribe: "הסרה מרשימת סיכומי הפגישות",
  recapUnsubscribeConfirmTitle: "להסיר אותך מסיכומי הפגישות?",
  recapUnsubscribeConfirmBody: "לא יישלחו אליך עוד הודעות סיכום פגישה מסביבת העבודה הזו.",
  recapUnsubscribeConfirmButton: "הסרה",
  recapUnsubscribeDone: "הוסרת מהרשימה. לא יישלחו אליך עוד סיכומי פגישות מסביבת העבודה הזו.",
  recapUnsubscribeInvalid: "קישור ההסרה אינו תקין.",
}

export type RecapStrings = typeof recapStringsEn

export function recapStrings(locale: "he" | "en"): RecapStrings {
  return locale === "he" ? recapStringsHe : recapStringsEn
}
