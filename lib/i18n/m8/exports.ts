/**
 * M8 meeting export menu and localized export headings (owner: Package C).
 * Step 0 froze the key list (docs/parity/m8.md, item 12); Package C fills
 * the he/en values. `{format}` and `{provider}` are `formatMessage` slots.
 */

export const exportsMessagesEn = {
  exportMenuLabel: "Export",
  exportMenuDownload: "Download",
  exportDownloadPdf: "PDF",
  exportDownloadMarkdown: "Markdown",
  exportDownloadDocx: "Word (DOCX)",
  exportDownloadStarted: "{format} downloaded",
  exportDownloadFailed: "Could not export {format}",
  exportGoogleDocs: "Google Docs",
  exportGoogleDocsConnect: "Connect Google Drive",
  exportGoogleDocsConnectHint: "Connect your Google Drive to export meetings as Google Docs.",
  exportGoogleDocsExporting: "Exporting to Google Docs…",
  exportGoogleDocsDone: "Exported to Google Docs",
  exportGoogleDocsOpen: "Open",
  exportGoogleDocsFailed: "Could not export to Google Docs",
  exportGoogleDocsNew: "Export as a new document",
  exportSendTo: "Send to…",
  exportSendToSlack: "Slack",
  exportSendToNotion: "Notion",
  exportSendToHubspot: "HubSpot",
  exportSendChooseDestination: "Choose a destination",
  exportSendQueued: "Sending to {provider}…",
  exportSendSent: "Sent to {provider}",
  exportSendFailed: "Could not send to {provider}",
  exportSendSkipped: "Not sent to {provider}",
  exportSendPrivateHint: "Only the meeting owner can send a private meeting.",
  exportSendNone: "No connected app allows sending. Connect one in Settings → Integrations.",
  exportHeadingOverview: "Overview",
  exportHeadingDecisions: "Decisions",
  exportHeadingActionItems: "Action Items",
  exportHeadingOpenQuestions: "Open Questions",
  exportHeadingTranscript: "Transcript",
  exportHeadingParticipants: "Participants",
  exportLabelDate: "Date",
  exportLabelDuration: "Duration",
  exportLabelOwner: "Owner",
  exportLabelDue: "due",
}

export const exportsMessagesHe: Record<keyof typeof exportsMessagesEn, string> = {
  exportMenuLabel: "ייצוא",
  exportMenuDownload: "הורדה",
  exportDownloadPdf: "PDF",
  exportDownloadMarkdown: "Markdown",
  exportDownloadDocx: "Word‏ (DOCX)",
  exportDownloadStarted: "קובץ {format} ירד",
  exportDownloadFailed: "לא ניתן לייצא {format}",
  exportGoogleDocs: "Google Docs",
  exportGoogleDocsConnect: "חיבור Google Drive",
  exportGoogleDocsConnectHint: "חברו את Google Drive כדי לייצא פגישות ל-Google Docs.",
  exportGoogleDocsExporting: "מייצא ל-Google Docs…",
  exportGoogleDocsDone: "יוצא ל-Google Docs",
  exportGoogleDocsOpen: "פתיחה",
  exportGoogleDocsFailed: "לא ניתן לייצא ל-Google Docs",
  exportGoogleDocsNew: "ייצוא כמסמך חדש",
  exportSendTo: "שליחה אל…",
  exportSendToSlack: "Slack",
  exportSendToNotion: "Notion",
  exportSendToHubspot: "HubSpot",
  exportSendChooseDestination: "בחירת יעד",
  exportSendQueued: "שולח אל {provider}…",
  exportSendSent: "נשלח אל {provider}",
  exportSendFailed: "לא ניתן לשלוח אל {provider}",
  exportSendSkipped: "לא נשלח אל {provider}",
  exportSendPrivateHint: "רק מי שמנהל/ת את הפגישה יכול/ה לשלוח פגישה פרטית.",
  exportSendNone: "אין אפליקציה מחוברת שמאפשרת שליחה. אפשר לחבר אחת בהגדרות ← אינטגרציות.",
  exportHeadingOverview: "סקירה",
  exportHeadingDecisions: "החלטות",
  exportHeadingActionItems: "משימות",
  exportHeadingOpenQuestions: "שאלות פתוחות",
  exportHeadingTranscript: "תמליל",
  exportHeadingParticipants: "משתתפים",
  exportLabelDate: "תאריך",
  exportLabelDuration: "משך",
  exportLabelOwner: "אחראי/ת",
  exportLabelDue: "עד",
}

export type ExportsMessages = typeof exportsMessagesEn

export function getExportsMessages(locale: string | null | undefined): ExportsMessages {
  return locale === "he" ? exportsMessagesHe : exportsMessagesEn
}
