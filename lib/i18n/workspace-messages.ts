/**
 * M2 workspace / admin UI strings. Hebrew-first: every key exists in `he`
 * and `en`; other locales fall back to English until translated.
 * Placeholders use `{name}` and are filled by `formatMessage`.
 */

export const workspaceMessagesEn = {
  // Common
  retry: "Retry",
  cancel: "Cancel",
  done: "Done",
  logOut: "Log out",
  loadFailed: "Could not load data",
  actionFailed: "Action failed",
  columnActions: "Actions",
  copy: "Copy",
  copied: "Copied",

  // Roles
  roleOwner: "Owner",
  roleAdmin: "Admin",
  roleMember: "Member",
  roleViewer: "Viewer",

  // Workspace switcher
  workspaceSwitcherLabel: "Workspace",
  workspaceSwitchAction: "Switch workspace",
  workspaceCreate: "Create workspace",
  workspaceCreateDescription: "A new, empty workspace where you are the owner.",
  workspaceNameLabel: "Workspace name",
  workspaceCreating: "Creating…",
  workspaceCreated: "Workspace created",
  workspaceCreateFailed: "Could not create the workspace",
  workspaceSwitched: "Switched to {name}",
  workspaceSwitchFailed: "Could not switch workspace",
  workspaceLoading: "Loading workspace…",
  workspaceLoadFailed: "Could not load your workspaces",

  // Google Workspace not configured for this workspace (API 409)
  googleNotConfigured:
    "Google Workspace is not connected for this workspace. An owner must set the workspace Google account first.",

  // No workspace
  noWorkspaceTitle: "No workspace yet",
  noWorkspaceDescription:
    "You are signed in as {email}, but you are not a member of any workspace. Ask an admin to invite you, or open the invitation link you received.",

  // Admin panel
  navAdmin: "Admin",
  adminEyebrow: "Workspace administration",
  adminTitle: "Members & access",
  adminDescription:
    "Manage who can access this workspace, API keys for machines, and the audit trail.",
  adminTabMembers: "Members",
  adminTabInvitations: "Invitations",
  adminTabApiKeys: "API keys",
  adminTabAudit: "Audit log",
  adminNoAccess: "You do not have permission to manage this workspace.",

  // Members
  membersEmpty: "No members yet.",
  membersColumnMember: "Member",
  membersColumnRole: "Role",
  membersColumnJoined: "Joined",
  membersYou: "(you)",
  membersRemove: "Remove",
  membersLeave: "Leave workspace",
  membersRemoveTitle: "Remove {name}?",
  membersRemoveDescription:
    "They lose access to this workspace immediately. Their private meetings stay theirs.",
  membersLeaveTitle: "Leave this workspace?",
  membersLeaveDescription: "You lose access until someone invites you again.",
  membersRoleUpdated: "Role updated",
  membersRemoved: "Member removed",
  membersLeft: "You left the workspace",
  membersLastOwner: "A workspace must keep at least one owner.",

  // Invitations
  invitationsInvite: "Invite member",
  invitationsInviteTitle: "Invite to this workspace",
  invitationsInviteDescription:
    "The person signs in with Google using exactly this email address.",
  invitationsEmailLabel: "Email",
  invitationsRoleLabel: "Role",
  invitationsSend: "Send invitation",
  invitationsSending: "Sending…",
  invitationsEmpty: "No invitations yet.",
  invitationsColumnEmail: "Email",
  invitationsColumnStatus: "Status",
  invitationsColumnExpires: "Expires",
  invitationStatusPending: "Pending",
  invitationStatusAccepted: "Accepted",
  invitationStatusRevoked: "Revoked",
  invitationStatusExpired: "Expired",
  invitationsResend: "Resend",
  invitationsRevoke: "Revoke",
  invitationsCopyLink: "Copy link",
  invitationsLinkTitle: "Invitation link",
  invitationsEmailSent: "The invitation email was sent.",
  invitationsEmailNotSent:
    "The email could not be sent. Share this link with the person directly:",
  invitationsLinkCopied: "Invitation link copied",
  invitationsRevokeTitle: "Revoke the invitation for {email}?",
  invitationsRevokeDescription:
    "The invitation link stops working immediately.",
  invitationsRevoked: "Invitation revoked",
  invitationsSendError: "Last send failed: {error}",

  // API keys
  apiKeysCreate: "Create API key",
  apiKeysCreateDescription:
    "Keys act on this workspace only. Read keys can only read; write keys can also create and edit meetings; admin keys can manage the workspace.",
  apiKeysLabel: "Label",
  apiKeysScope: "Scope",
  apiKeysExpires: "Expires (optional)",
  apiKeyScopeRead: "Read",
  apiKeyScopeWrite: "Write",
  apiKeyScopeAdmin: "Admin",
  apiKeysEmpty: "No API keys yet.",
  apiKeysColumnKey: "Key",
  apiKeysColumnLastUsed: "Last used",
  apiKeysColumnCreated: "Created",
  apiKeysNever: "Never",
  apiKeysRevokedBadge: "Revoked",
  apiKeysRevoke: "Revoke",
  apiKeysRevokeTitle: "Revoke the API key {label}?",
  apiKeysRevokeDescription:
    "Every client using this key stops working immediately.",
  apiKeysRevoked: "API key revoked",
  apiKeysCreatedTitle: "Copy your new API key",
  apiKeysCreatedDescription:
    "This is the only time the key is shown. Store it in a secret manager before closing.",
  apiKeysCopy: "Copy key",
  apiKeysCopied: "API key copied",

  // Audit log
  auditFilterAction: "Action",
  auditFilterActor: "Actor",
  auditFilterTarget: "Target ID",
  auditApply: "Apply",
  auditClear: "Clear",
  auditEmpty: "No audit events match these filters.",
  auditColumnTime: "Time",
  auditColumnAction: "Action",
  auditColumnActor: "Actor",
  auditColumnTarget: "Target",
  auditLoadMore: "Load more",
  auditSystemActor: "System",

  // Meeting visibility
  visibilityLabel: "Visibility",
  visibilityPrivate: "Private",
  visibilityWorkspace: "Workspace",
  visibilityLink: "Link",
  visibilityPrivateHint: "Only the owner and meeting participants",
  visibilityWorkspaceHint: "Everyone in this workspace",
  visibilityLinkHint: "The workspace plus anyone with the share link",
  visibilityUpdated: "Visibility updated",
  visibilityLeaveLinkTitle: "Revoke the public share link?",
  visibilityLeaveLinkDescription:
    "Changing visibility revokes the active share link. Anyone holding the link loses access.",
  visibilityConfirm: "Change visibility",
  visibilityReadOnly:
    "Only the meeting owner or a workspace admin can change visibility.",
  visibilityLinkUseShare: "Use Share to create a public link.",
  sharePrivateWarning:
    "This meeting is private. A public link makes it visible to the whole workspace and to anyone with the link.",

  // Settings
  settingsReadOnly: "Only workspace admins can change these settings.",
  settingsKeepVideoTitle: "Keep original video for Drive imports",
  settingsKeepVideoDescription:
    "Recommended off. Drive recordings are stored as audio unless this is on.",
  settingsDefaultVisibilityTitle: "Default meeting visibility",
  settingsDefaultVisibilityDescription:
    "Applies to meetings created from now on.",

  // Invitation page
  inviteTitle: "You are invited",
  inviteJoin: "Join {workspace} as {role}.",
  inviteForEmail: "This invitation is for {email}.",
  inviteAccept: "Accept invitation",
  inviteAccepting: "Joining…",
  inviteSignIn: "Sign in with Google to accept",
  inviteSignedInAs: "Signed in as {email}",
  inviteSwitchAccount: "Use a different Google account",
  inviteEmailMismatch:
    "This invitation was sent to a different email address. Sign in with the invited Google account.",
  inviteInvalid: "This invitation is invalid or has expired.",
  inviteUsed: "This invitation was already used or revoked.",
  inviteLoading: "Checking the invitation…",
  inviteOpenApp: "Open MeetSum",
  inviteAccepted: "You joined {workspace}",

  // Login errors
  loginErrorNoAccess:
    "This Google account has no access to MeetSum. Ask a workspace admin for an invitation.",
  loginErrorGeneric: "Sign-in failed. Please try again.",
} as const

export type WorkspaceMessageKey = keyof typeof workspaceMessagesEn

export const workspaceMessagesHe: Record<WorkspaceMessageKey, string> = {
  retry: "ניסיון חוזר",
  cancel: "ביטול",
  done: "סיום",
  logOut: "התנתקות",
  loadFailed: "לא ניתן לטעון את הנתונים",
  actionFailed: "הפעולה נכשלה",
  columnActions: "פעולות",
  copy: "העתקה",
  copied: "הועתק",

  roleOwner: "בעלים",
  roleAdmin: "מנהל",
  roleMember: "חבר",
  roleViewer: "צופה",

  workspaceSwitcherLabel: "סביבת עבודה",
  workspaceSwitchAction: "החלפת סביבת עבודה",
  workspaceCreate: "יצירת סביבת עבודה",
  workspaceCreateDescription: "סביבת עבודה חדשה וריקה, שבה תהיו הבעלים.",
  workspaceNameLabel: "שם סביבת העבודה",
  workspaceCreating: "יוצר…",
  workspaceCreated: "סביבת העבודה נוצרה",
  workspaceCreateFailed: "לא ניתן ליצור את סביבת העבודה",
  workspaceSwitched: "עברתם אל {name}",
  workspaceSwitchFailed: "לא ניתן להחליף סביבת עבודה",
  workspaceLoading: "טוען סביבת עבודה…",
  workspaceLoadFailed: "לא ניתן לטעון את סביבות העבודה שלכם",

  googleNotConfigured:
    "Google Workspace אינו מחובר לסביבת העבודה הזו. בעלים צריך להגדיר קודם את חשבון Google של סביבת העבודה.",

  noWorkspaceTitle: "עדיין אין סביבת עבודה",
  noWorkspaceDescription:
    "התחברתם בתור {email}, אבל אינכם חברים באף סביבת עבודה. בקשו ממנהל להזמין אתכם, או פתחו את קישור ההזמנה שקיבלתם.",

  navAdmin: "ניהול",
  adminEyebrow: "ניהול סביבת העבודה",
  adminTitle: "חברים והרשאות",
  adminDescription:
    "ניהול הגישה לסביבת העבודה, מפתחות API למערכות, ויומן הביקורת.",
  adminTabMembers: "חברים",
  adminTabInvitations: "הזמנות",
  adminTabApiKeys: "מפתחות API",
  adminTabAudit: "יומן ביקורת",
  adminNoAccess: "אין לכם הרשאה לנהל את סביבת העבודה הזו.",

  membersEmpty: "אין חברים עדיין.",
  membersColumnMember: "חבר",
  membersColumnRole: "תפקיד",
  membersColumnJoined: "הצטרף",
  membersYou: "(אני)",
  membersRemove: "הסרה",
  membersLeave: "עזיבת סביבת העבודה",
  membersRemoveTitle: "להסיר את {name}?",
  membersRemoveDescription:
    "הגישה לסביבת העבודה תיחסם מיד. הפגישות הפרטיות שלהם יישארו בבעלותם.",
  membersLeaveTitle: "לעזוב את סביבת העבודה?",
  membersLeaveDescription: "תאבדו את הגישה עד שמישהו יזמין אתכם שוב.",
  membersRoleUpdated: "התפקיד עודכן",
  membersRemoved: "החבר הוסר",
  membersLeft: "עזבתם את סביבת העבודה",
  membersLastOwner: "בסביבת עבודה חייב להישאר לפחות בעלים אחד.",

  invitationsInvite: "הזמנת חבר",
  invitationsInviteTitle: "הזמנה לסביבת העבודה",
  invitationsInviteDescription:
    "המוזמנים מתחברים עם Google באמצעות כתובת האימייל הזו בדיוק.",
  invitationsEmailLabel: "אימייל",
  invitationsRoleLabel: "תפקיד",
  invitationsSend: "שליחת הזמנה",
  invitationsSending: "שולח…",
  invitationsEmpty: "אין הזמנות עדיין.",
  invitationsColumnEmail: "אימייל",
  invitationsColumnStatus: "סטטוס",
  invitationsColumnExpires: "תפוגה",
  invitationStatusPending: "ממתינה",
  invitationStatusAccepted: "התקבלה",
  invitationStatusRevoked: "בוטלה",
  invitationStatusExpired: "פגה",
  invitationsResend: "שליחה חוזרת",
  invitationsRevoke: "ביטול",
  invitationsCopyLink: "העתקת קישור",
  invitationsLinkTitle: "קישור הזמנה",
  invitationsEmailSent: "מייל ההזמנה נשלח.",
  invitationsEmailNotSent:
    "לא ניתן היה לשלוח את המייל. שתפו את הקישור הזה ישירות עם המוזמנים:",
  invitationsLinkCopied: "קישור ההזמנה הועתק",
  invitationsRevokeTitle: "לבטל את ההזמנה של {email}?",
  invitationsRevokeDescription: "קישור ההזמנה יפסיק לעבוד מיד.",
  invitationsRevoked: "ההזמנה בוטלה",
  invitationsSendError: "השליחה האחרונה נכשלה: {error}",

  apiKeysCreate: "יצירת מפתח API",
  apiKeysCreateDescription:
    "מפתחות פועלים בסביבת עבודה זו בלבד. מפתח קריאה יכול רק לקרוא; מפתח כתיבה יכול גם ליצור ולערוך פגישות; מפתח מנהל יכול לנהל את סביבת העבודה.",
  apiKeysLabel: "תווית",
  apiKeysScope: "הרשאה",
  apiKeysExpires: "תפוגה (אופציונלי)",
  apiKeyScopeRead: "קריאה",
  apiKeyScopeWrite: "כתיבה",
  apiKeyScopeAdmin: "מנהל",
  apiKeysEmpty: "אין מפתחות API עדיין.",
  apiKeysColumnKey: "מפתח",
  apiKeysColumnLastUsed: "שימוש אחרון",
  apiKeysColumnCreated: "נוצר",
  apiKeysNever: "אף פעם",
  apiKeysRevokedBadge: "בוטל",
  apiKeysRevoke: "ביטול",
  apiKeysRevokeTitle: "לבטל את מפתח ה-\u2060API {label}?",
  apiKeysRevokeDescription: "כל מערכת שמשתמשת במפתח הזה תפסיק לעבוד מיד.",
  apiKeysRevoked: "מפתח ה-\u2060API בוטל",
  apiKeysCreatedTitle: "העתיקו את מפתח ה-\u2060API החדש",
  apiKeysCreatedDescription:
    "זו הפעם היחידה שהמפתח מוצג. שמרו אותו במנהל סודות לפני הסגירה.",
  apiKeysCopy: "העתקת המפתח",
  apiKeysCopied: "מפתח ה-\u2060API הועתק",

  auditFilterAction: "פעולה",
  auditFilterActor: "מבצע",
  auditFilterTarget: "מזהה יעד",
  auditApply: "החלה",
  auditClear: "ניקוי",
  auditEmpty: "אין אירועי ביקורת שתואמים לסינון.",
  auditColumnTime: "זמן",
  auditColumnAction: "פעולה",
  auditColumnActor: "מבצע",
  auditColumnTarget: "יעד",
  auditLoadMore: "טעינת עוד",
  auditSystemActor: "מערכת",

  visibilityLabel: "נראות",
  visibilityPrivate: "פרטית",
  visibilityWorkspace: "סביבת העבודה",
  visibilityLink: "קישור",
  visibilityPrivateHint: "רק הבעלים ומשתתפי הפגישה",
  visibilityWorkspaceHint: "כל חברי סביבת העבודה",
  visibilityLinkHint: "סביבת העבודה וכל מי שמחזיק בקישור השיתוף",
  visibilityUpdated: "הנראות עודכנה",
  visibilityLeaveLinkTitle: "לבטל את קישור השיתוף הציבורי?",
  visibilityLeaveLinkDescription:
    "שינוי הנראות מבטל את קישור השיתוף הפעיל. כל מי שמחזיק בקישור יאבד את הגישה.",
  visibilityConfirm: "שינוי נראות",
  visibilityReadOnly: "רק בעלי הפגישה או מנהל סביבת העבודה יכולים לשנות נראות.",
  visibilityLinkUseShare: "השתמשו בכפתור השיתוף כדי ליצור קישור ציבורי.",
  sharePrivateWarning:
    "הפגישה פרטית. קישור ציבורי יהפוך אותה לגלויה לכל סביבת העבודה ולכל מי שמחזיק בקישור.",

  settingsReadOnly: "רק מנהלי סביבת העבודה יכולים לשנות הגדרות אלה.",
  settingsKeepVideoTitle: "שמירת הווידאו המקורי בייבוא מ-\u2060Drive",
  settingsKeepVideoDescription:
    "מומלץ כבוי. הקלטות מ-\u2060Drive נשמרות כאודיו אלא אם האפשרות פעילה.",
  settingsDefaultVisibilityTitle: "נראות ברירת מחדל לפגישות",
  settingsDefaultVisibilityDescription: "חל על פגישות שייווצרו מעכשיו.",

  inviteTitle: "הוזמנתם",
  inviteJoin: "הצטרפות אל {workspace} בתפקיד {role}.",
  inviteForEmail: "ההזמנה מיועדת ל-{email}.",
  inviteAccept: "קבלת ההזמנה",
  inviteAccepting: "ההצטרפות מתבצעת…",
  inviteSignIn: "התחברו עם Google כדי לקבל את ההזמנה",
  inviteSignedInAs: "מחוברים בתור {email}",
  inviteSwitchAccount: "שימוש בחשבון Google אחר",
  inviteEmailMismatch:
    "ההזמנה נשלחה לכתובת אימייל אחרת. התחברו עם חשבון Google שהוזמן.",
  inviteInvalid: "ההזמנה אינה תקפה או שתוקפה פג.",
  inviteUsed: "כבר נעשה שימוש בהזמנה או שהיא בוטלה.",
  inviteLoading: "בודק את ההזמנה…",
  inviteOpenApp: "פתיחת MeetSum",
  inviteAccepted: "הצטרפתם אל {workspace}",

  loginErrorNoAccess:
    "לחשבון Google הזה אין גישה ל-\u2060MeetSum. בקשו הזמנה ממנהל סביבת עבודה.",
  loginErrorGeneric: "ההתחברות נכשלה. נסו שוב.",
}

/** Fills `{name}` placeholders. Unknown placeholders are left as-is. */
export function formatMessage(
  template: string,
  values: Record<string, string | number | undefined>
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = values[key]

    return value === undefined ? match : String(value)
  })
}
