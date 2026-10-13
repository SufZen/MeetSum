/* Cadence showcase — prototype behaviour. Vanilla JS, no dependencies.
   Everything is example data; nothing leaves the page. */
(() => {
  "use strict"

  const $ = (s, r = document) => r.querySelector(s)
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s))
  const root = document.documentElement
  const app = $("#app")
  const store = {
    get(k) { try { return localStorage.getItem(k) } catch { return null } },
    set(k, v) { try { localStorage.setItem(k, v) } catch { /* storage unavailable */ } },
  }
  const reduced = () => root.classList.contains("rm") || matchMedia("(prefers-reduced-motion: reduce)").matches
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])
  const fmt = (s) => { s = Math.max(0, Math.floor(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const icon = (id, cls = "") => `<svg class="i ${cls}"><use href="#i-${id}"/></svg>`
  const NB = " " // keeps "—" on the same line as the words before it

  /* ------------------------------------------------------------------ data */
  const SPK = [
    null,
    { en: "Ran Nahmany", he: "רן נחמני", ini: { en: "RN", he: "ר" }, c: "var(--spk-1)" },
    { en: "Yael Ben-David", he: "יעל בן-דוד", ini: { en: "YB", he: "י" }, c: "var(--spk-2)" },
    { en: "Leandro Silva", he: "לאנדרו סילבה", ini: { en: "LS", he: "ל" }, c: "var(--spk-3)" },
    { en: "Asaf Ronen", he: "אסף רונן", ini: { en: "AR", he: "א" }, c: "var(--spk-4)" },
    { en: "Noa Levi", he: "נועה לוי", ini: { en: "NL", he: "נ" }, c: "var(--spk-5)" },
    { en: "Daniel Cohen", he: "דניאל כהן", ini: { en: "DC", he: "ד" }, c: "var(--spk-6)" },
    { en: "Maya Peretz", he: "מאיה פרץ", ini: { en: "MP", he: "מ" }, c: "var(--spk-7)" },
    { en: "Omer Katz", he: "עומר כץ", ini: { en: "OK", he: "ע" }, c: "var(--spk-8)" },
  ]

  // [speaker, English, Hebrew]
  const LINES = [
    [1, "Okay, let's start. The goal today is simple: decide whether Lisboa Riverside moves to full due diligence, and agree who owns what this week.", "טוב, בואו נתחיל. המטרה היום פשוטה: להחליט אם Lisboa Riverside עוברת ל-due diligence מלא, ולסגור מי אחראי על מה השבוע."],
    [3, "From the lender side we have a term sheet draft. They're offering sixty percent LTV at a fixed rate, but they want the SPA reviewed before they commit.", "מהצד של הבנק יש לנו טיוטת term sheet. הם מציעים LTV של 60% בריבית קבועה, אבל רוצים שה-SPA ייבדק לפני שהם מתחייבים."],
    [2, "Our model shows an IRR of 18.2% in the base case. If construction slips six months, it drops to 15.9%.", "המודל שלנו מראה IRR של 18.2% בתרחיש הבסיס. אם הבנייה מתעכבת בחצי שנה, זה יורד ל-15.9%."],
    [1, "So the base case clears our 17% target and the downside doesn't. I'm comfortable with that if we price the delay risk into the offer.", "אז תרחיש הבסיס עובר את יעד ה-17% שלנו, והתרחיש השלילי לא. אני בסדר עם זה אם נתמחר את סיכון העיכוב בהצעה."],
    [4, "The Porto industrial site is a different story. The roof needs work, and I haven't seen it in person yet.", "האתר התעשייתי בפורטו זה סיפור אחר. הגג צריך עבודה, ועוד לא ראיתי אותו בעיניים."],
    [2, "Then let's not let Porto slow down Lisboa. Two separate tracks.", "אז בוא לא ניתן לפורטו לעכב את ליסבון. שני מסלולים נפרדים."],
    [1, "Agreed. Decision: Lisboa Riverside goes to full due diligence starting Monday. Porto stays in screening until Asaf visits.", "מסכים. החלטה: Lisboa Riverside נכנסת ל-due diligence מלא החל מיום שני. פורטו נשאר בסינון עד שאסף מבקר שם."],
    [3, "I'll push the lender to finalize the term sheet by May first. If we want the fixed rate, we need to lock it this month.", "אני אלחץ על הבנק לסגור את ה-term sheet עד ה-1 במאי. אם אנחנו רוצים את הריבית הקבועה, צריך לנעול אותה החודש."],
    [1, "Good. Yael, can you rerun the model with a six-month delay and a 2% cost overrun, and send it before Wednesday?", "מצוין. יעל, תוכלי להריץ את המודל מחדש עם עיכוב של חצי שנה וחריגה של 2% בעלויות, ולשלוח לפני יום רביעי?"],
    [2, "Yes. You'll have the downside scenarios by Tuesday evening.", "כן, תרחישי ה-downside יהיו אצלכם עד שלישי בערב."],
    [4, "I'll book the Porto site visit for next week and bring a roofing contractor with me.", "אני אקבע את הביקור באתר בפורטו לשבוע הבא ואביא איתי קבלן גגות."],
    [1, "And legal needs the SPA by April thirtieth. Leandro, loop them in today. One open question: do we bring in a local partner for permits?", "והמחלקה המשפטית צריכה את ה-SPA עד ה-30 באפריל. לאנדרו, תכניס אותם לתמונה היום. שאלה פתוחה אחת: האם מביאים שותף מקומי בשביל ההיתרים?"],
    [3, "I'd say yes, but let's ask the lawyers what it changes in the structure first.", "הייתי אומר שכן, אבל קודם נשאל את עורכי הדין מה זה משנה במבנה."],
    [1, "Fine, that's the open question for next week. Thanks, everyone.", "בסדר, זו השאלה הפתוחה לשבוע הבא. תודה לכולם."],
  ]

  const SUMMARY = {
    en: {
      overview: "The team agreed to move Lisboa Riverside into full due diligence on Monday: the base-case IRR of 18.2% clears the 17% target. Porto Industrial stays in screening until Asaf's site visit. Financing depends on locking the lender's fixed rate this month.",
      overviewCites: [6, 2, 4, 7],
      decisions: [
        { t: "Lisboa Riverside moves to full due diligence starting Monday.", at: 6, cites: [6] },
        { t: "Porto Industrial stays in screening until the site visit.", at: 5, cites: [5, 6] },
        { t: "Keep the 17% IRR target and price construction-delay risk into the offer.", at: 3, cites: [2, 3] },
      ],
      actions: [
        { id: "a1", t: "Rerun the model with a 6-month delay and a 2% cost overrun", owner: 2, due: "Tue, Apr 29", soon: true, at: 9, cites: [8, 9] },
        { id: "a2", t: "Get the lender to finalize the term sheet", owner: 3, due: "Thu, May 1", at: 7, cites: [7] },
        { id: "a3", t: "Book the Porto site visit with a roofing contractor", owner: 4, due: "Next week", at: 10, cites: [10] },
        { id: "a4", t: "Send the SPA to legal", owner: 3, due: "Today", soon: true, at: 11, cites: [11] },
      ],
      questions: [{ t: "Do we bring in a local partner for permits?", at: 12, cites: [11, 12] }],
      chapters: [{ t: "Goals for the call", at: 0 }, { t: "Financing and returns", at: 1 }, { t: "Porto site", at: 4 }, { t: "Decisions and owners", at: 6 }],
    },
    he: {
      overview: "הצוות החליט להעביר את Lisboa Riverside ל-due diligence מלא ביום שני: IRR של 18.2% בתרחיש הבסיס עובר את יעד ה-17%. פורטו נשאר בשלב סינון עד הביקור של אסף באתר. המימון תלוי בנעילת הריבית הקבועה מול הבנק עוד החודש.",
      overviewCites: [6, 2, 4, 7],
      decisions: [
        { t: "Lisboa Riverside נכנסת ל-due diligence מלא החל מיום שני.", at: 6, cites: [6] },
        { t: "פורטו נשאר בשלב סינון עד הביקור באתר.", at: 5, cites: [5, 6] },
        { t: "יעד ה-IRR נשאר 17%, וסיכון עיכוב הבנייה יתומחר בהצעה.", at: 3, cites: [2, 3] },
      ],
      actions: [
        { id: "a1", t: "הרצת המודל מחדש עם עיכוב של חצי שנה וחריגה של 2%", owner: 2, due: "יום ג׳, 29 באפר׳", soon: true, at: 9, cites: [8, 9] },
        { id: "a2", t: "סגירת ה-term sheet מול הבנק", owner: 3, due: "יום ה׳, 1 במאי", at: 7, cites: [7] },
        { id: "a3", t: "קביעת ביקור באתר בפורטו עם קבלן גגות", owner: 4, due: "שבוע הבא", at: 10, cites: [10] },
        { id: "a4", t: "העברת ה-SPA למחלקה המשפטית", owner: 3, due: "היום", soon: true, at: 11, cites: [11] },
      ],
      questions: [{ t: "האם להביא שותף מקומי בשביל ההיתרים?", at: 12, cites: [11, 12] }],
      chapters: [{ t: "מטרות השיחה", at: 0 }, { t: "מימון ותשואות", at: 1 }, { t: "האתר בפורטו", at: 4 }, { t: "החלטות ואחריות", at: 6 }],
    },
  }

  const ANSWERS = {
    en: [
      { q: "What did we decide about Lisboa Riverside?", k: ["decid", "decision", "lisboa", "riverside", "diligence"], a: "Lisboa Riverside moves to full due diligence starting Monday [6]. The base case clears the target, with an 18.2% IRR against 17% [2][3]. The team will price the construction-delay risk into the offer [3]." },
      { q: "Who owns financing, and by when?", k: ["financ", "lender", "term sheet", "who", "owner", "bank", "rate"], a: "Leandro Silva. He'll push the lender to finalize the term sheet by May 1 so the fixed rate is locked this month [7], and he's sending the SPA to legal today for the April 30 deadline [11]." },
      { q: "What's still open?", k: ["open", "question", "permit", "partner", "unresolved"], a: "One question is open: whether to bring in a local partner for permits [11]. Leandro wants to ask the lawyers how it changes the deal structure first [12]." },
    ],
    he: [
      { q: "מה הוחלט לגבי Lisboa Riverside?", k: ["החלט", "הוחלט", "ליסבון", "lisboa", "riverside", "diligence"], a: "Lisboa Riverside עוברת ל-due diligence מלא החל מיום שני [6]. תרחיש הבסיס עובר את היעד: IRR של 18.2% מול 17% [2][3]. סיכון עיכוב הבנייה יתומחר בהצעה [3]." },
      { q: "מי אחראי על המימון, ועד מתי?", k: ["מימון", "בנק", "term sheet", "מי", "אחראי", "ריבית"], a: "לאנדרו סילבה. הוא ילחץ על הבנק לסגור את ה-term sheet עד ה-1 במאי כדי לנעול את הריבית הקבועה החודש [7], ושולח היום את ה-SPA למחלקה המשפטית לקראת ה-30 באפריל [11]." },
      { q: "מה עדיין פתוח?", k: ["פתוח", "פתוחה", "שאלה", "היתר", "שותף"], a: "נשארה שאלה אחת: האם להביא שותף מקומי בשביל ההיתרים [11]. לאנדרו רוצה קודם לשאול את עורכי הדין מה זה משנה במבנה העסקה [12]." },
    ],
  }

  const T = {
    en: {
      "inbox.title": "Meetings", "inbox.upload": "Upload", "inbox.search": "Search or ask",
      "filter.all": "All", "filter.mine": "My actions", "filter.review": "Needs review",
      room: "Rooms", "rec.start": "Record", "rec.on": "Recording", "rec.label": "REC", "rec.stop": "Stop & summarize", "rec.consent": "Participants were notified",
      share: "Share", "tab.summary": "Summary", "tab.transcript": "Transcript", "tab.ask": "Ask", follow: "Back to playback",
      "ask.ph": "Ask about this meeting", "ask.scope.meeting": "This meeting", "ask.scope.all": "All meetings",
      "palette.ph": "Jump to a meeting, decision, or action", "palette.move": "move", "palette.open": "open",
      "nav.meetings": "Meetings", "nav.ask": "Ask", "nav.tasks": "Tasks", "nav.rooms": "Rooms", "nav.settings": "Settings",
      "aria.back": "Back 10 seconds", "aria.fwd": "Forward 10 seconds", "aria.play": "Play", "aria.pause": "Pause", "aria.seek": "Seek",
      "aria.speed": "Playback speed", "aria.more": "More actions", "aria.send": "Send", "aria.close": "Close", "aria.filter": "Filter", "aria.scope": "Scope", "aria.palette": "Command palette",
      title: `Lisboa Riverside${NB}— deal check-in`, date: "Thu, Apr 24 · 10:30", people: "4 people",
      "ai.meta": "AI · 4 min after the call", "ai.writing": "Writing from the transcript", "ai.fresh": "AI · regenerated just now", "ai.stopped": "Stopped. Regenerate to finish.",
      "ai.regen": "Regenerate", "ai.stop": "Stop", copy: "Copy summary", copyAns: "Copy answer", flag: "Flag this line",
      "prov.from": "From {n} moments in the call", "ai.kept": "Edited by you · kept when you regenerate",
      "sec.overview": "Overview", "sec.decisions": "Decisions", "sec.actions": "Action items", "sec.questions": "Open questions", "sec.chapters": "Chapters",
      edit: "Edit", done: "Done", "mark.done": "Mark done", "peek.play": "Play from here", "peek.open": "Open in transcript", "cite.aria": "Play source at",
      stoppedSec: "Stopped before this section.",
      "t.speakers": "4 speakers · talk time", "t.diarized": "Speakers identified · 4 of 4 confirmed",
      "ask.title": "Ask this meeting", "ask.sub": "Answers cite the moment they come from. Click a timecode to hear it.",
      "ask.who": "MeetSum AI", "ask.miss": "I couldn't find that in this meeting. Try asking about decisions, owners, dates or numbers.",
      "ask.all": "All-meeting answers are coming. This demo answers from this meeting.",
      "pill.live": "Live", "pill.review": "Needs review", "pill.new": "New",
      steps: ["Uploaded", "Transcribing", "Finding speakers", "Summarizing"],
      today: "Today", yesterday: "Yesterday", earlier: "Earlier",
      "toast.upload": "Uploading {f}", "toast.uploadSub": "You can keep working. We'll tell you when it's ready.",
      "toast.ready": "Summary ready", open: "Open",
      "toast.saved": "Recording saved", "toast.share": "Share link copied", "toast.shareSub": "Paste it anywhere. Access follows the setting you chose.",
      "toast.copied": "Summary copied", "toast.ansCopied": "Answer copied", "toast.copyFail": "Copy was blocked. Select the text instead.",
      "toast.flag": "Line flagged", "toast.flagSub": "MeetSum re-checks it against the transcript",
      "toast.pdf": "PDF ready", "toast.pdfSub": "Hebrew text embedded with IBM Plex Sans Hebrew", "toast.docx": "Word file ready",
      "toast.reprocess": "Reprocessing the audio", "toast.reprocessSub": "Your edits to the summary are kept",
      "toast.deleted": "Moved to Trash", "toast.deletedSub": "You can restore it for 30 days", undo: "Undo", "toast.restored": "Restored", "toast.renamed": "Renamed",
      "sr.recStart": "Recording started", "sr.recStop": "Recording stopped",
      "preview.note": "This demo opens one meeting in full. The other rows show the states a meeting can be in.", "preview.open": "Open Lisboa Riverside",
      newRec: "New recording", boardPrep: `Board prep${NB}— Q2 pipeline`,
      "pg.meetings": "Meetings", "pg.decisions": "Decisions", "pg.actions": "Action items", "pg.commands": "Commands",
      "cmd.theme": "Switch light / dark", "cmd.lang": "Switch to Hebrew", "cmd.rec": "Start recording", "cmd.upload": "Upload a recording", "cmd.regen": "Regenerate summary", "cmd.share": "Share summary",
      "palette.none": "No matches. Press Enter to ask MeetSum instead.",
      "mark.decision": "Decision", "mark.action": "Action", "mark.question": "Question",
      "menu.rename": "Rename", "menu.pdf": "Export PDF", "menu.docx": "Download Word (.docx)", "menu.reprocess": "Reprocess audio", "menu.delete": "Delete meeting",
      "sh.title": "Share summary", "sh.who": "Who can open it", "sh.room": "People in this room", "sh.roomSub": "Lisboa acquisitions · 6 people",
      "sh.ws": "Everyone in the workspace", "sh.wsSub": "Realization · signed-in members", "sh.link": "Anyone with the link", "sh.linkSub": "No sign-in. The link expires in 7 days.",
      "sh.transcript": "Include transcript and recording", "sh.copy": "Copy link", "sh.done": "Done", "sh.linkLabel": "Share link",
      "sh.hint.room": "People in Lisboa acquisitions sign in to open it.", "sh.hint.ws": "Anyone signed in to Realization can open it.", "sh.hint.link": "Anyone with the link can read the summary without signing in.",
      "sh.hint.tr": " The transcript and recording are included.",
    },
    he: {
      "inbox.title": "פגישות", "inbox.upload": "העלאה", "inbox.search": "חיפוש או שאלה",
      "filter.all": "הכול", "filter.mine": "המשימות שלי", "filter.review": "לבדיקה",
      room: "חדרים", "rec.start": "הקלטה", "rec.on": "מקליט", "rec.label": "הקלטה", "rec.stop": "עצירה וסיכום", "rec.consent": "המשתתפים קיבלו הודעה",
      share: "שיתוף", "tab.summary": "סיכום", "tab.transcript": "תמלול", "tab.ask": "שאלה", follow: "חזרה לנגינה",
      "ask.ph": "שאלו על הפגישה", "ask.scope.meeting": "הפגישה הזו", "ask.scope.all": "כל הפגישות",
      "palette.ph": "מעבר לפגישה, החלטה או משימה", "palette.move": "ניווט", "palette.open": "פתיחה",
      "nav.meetings": "פגישות", "nav.ask": "שאלה", "nav.tasks": "משימות", "nav.rooms": "חדרים", "nav.settings": "הגדרות",
      "aria.back": "10 שניות אחורה", "aria.fwd": "10 שניות קדימה", "aria.play": "ניגון", "aria.pause": "השהיה", "aria.seek": "מיקום בהקלטה",
      "aria.speed": "מהירות ניגון", "aria.more": "פעולות נוספות", "aria.send": "שליחה", "aria.close": "סגירה", "aria.filter": "סינון", "aria.scope": "היקף", "aria.palette": "לוח פקודות",
      title: `עדכון סטטוס עסקה${NB}— Lisboa${NB}Riverside`, date: "יום ה׳, 24 באפר׳ · 10:30", people: "4 משתתפים",
      "ai.meta": "AI\u200F · 4 דק׳ אחרי השיחה", "ai.writing": "כותב מתוך התמלול", "ai.fresh": "AI\u200F · נוצר מחדש עכשיו", "ai.stopped": "נעצר. אפשר ליצור מחדש כדי להשלים.",
      "ai.regen": "יצירה מחדש", "ai.stop": "עצירה", copy: "העתקת הסיכום", copyAns: "העתקת התשובה", flag: "סימון השורה לבדיקה",
      "prov.from": "מתוך {n} רגעים בשיחה", "ai.kept": "נערך על ידך · נשמר גם ביצירה מחדש",
      "sec.overview": "תקציר", "sec.decisions": "החלטות", "sec.actions": "משימות", "sec.questions": "שאלות פתוחות", "sec.chapters": "פרקים",
      edit: "עריכה", done: "סיום", "mark.done": "סימון כבוצע", "peek.play": "ניגון מכאן", "peek.open": "פתיחה בתמלול", "cite.aria": "ניגון המקור ב-",
      stoppedSec: "נעצר לפני הסעיף הזה.",
      "t.speakers": "4 דוברים · זמן דיבור", "t.diarized": "הדוברים זוהו · 4 מתוך 4 אושרו",
      "ask.title": "שאלו את הפגישה", "ask.sub": "כל תשובה מצטטת את הרגע שממנו היא באה. לחיצה על חותמת זמן מנגנת אותו.",
      "ask.who": "MeetSum AI", "ask.miss": "לא מצאתי את זה בפגישה. נסו לשאול על החלטות, אחראים, תאריכים או מספרים.",
      "ask.all": "תשובות מכל הפגישות יגיעו בקרוב. ההדגמה עונה מתוך הפגישה הזו.",
      "pill.live": "בשידור", "pill.review": "לבדיקה", "pill.new": "חדש",
      steps: ["הועלה", "מתמלל", "מזהה דוברים", "מסכם"],
      today: "היום", yesterday: "אתמול", earlier: "קודם",
      "toast.upload": "מעלה את {f}", "toast.uploadSub": "אפשר להמשיך לעבוד. נעדכן כשהסיכום מוכן.",
      "toast.ready": "הסיכום מוכן", open: "פתיחה",
      "toast.saved": "ההקלטה נשמרה", "toast.share": "קישור השיתוף הועתק", "toast.shareSub": "אפשר להדביק בכל מקום. הגישה לפי ההגדרה שבחרת.",
      "toast.copied": "הסיכום הועתק", "toast.ansCopied": "התשובה הועתקה", "toast.copyFail": "ההעתקה נחסמה. אפשר לסמן את הטקסט ידנית.",
      "toast.flag": "השורה סומנה", "toast.flagSub": "MeetSum יבדוק אותה מול התמלול",
      "toast.pdf": "קובץ ה-PDF מוכן", "toast.pdfSub": "הטקסט בעברית מוטמע בגופן IBM Plex Sans Hebrew", "toast.docx": "קובץ ה-Word מוכן",
      "toast.reprocess": "מעבד מחדש את השמע", "toast.reprocessSub": "העריכות שלך בסיכום נשמרות",
      "toast.deleted": "הועבר לסל המחזור", "toast.deletedSub": "אפשר לשחזר במשך 30 יום", undo: "ביטול", "toast.restored": "שוחזר", "toast.renamed": "השם עודכן",
      "sr.recStart": "ההקלטה התחילה", "sr.recStop": "ההקלטה נעצרה",
      "preview.note": "ההדגמה פותחת פגישה אחת במלואה. השורות האחרות מראות את המצבים האפשריים של פגישה.", "preview.open": "פתיחת Lisboa Riverside",
      newRec: "הקלטה חדשה", boardPrep: `הכנה לדירקטוריון${NB}— צנרת Q2`,
      "pg.meetings": "פגישות", "pg.decisions": "החלטות", "pg.actions": "משימות", "pg.commands": "פקודות",
      "cmd.theme": "מעבר בין בהיר לכהה", "cmd.lang": "Switch to English", "cmd.rec": "התחלת הקלטה", "cmd.upload": "העלאת הקלטה", "cmd.regen": "יצירת הסיכום מחדש", "cmd.share": "שיתוף הסיכום",
      "palette.none": "אין תוצאות. Enter כדי לשאול את MeetSum.",
      "mark.decision": "החלטה", "mark.action": "משימה", "mark.question": "שאלה",
      "menu.rename": "שינוי שם", "menu.pdf": "ייצוא PDF", "menu.docx": "הורדת Word ‏(.docx)", "menu.reprocess": "עיבוד מחדש של השמע", "menu.delete": "מחיקת הפגישה",
      "sh.title": "שיתוף הסיכום", "sh.who": "מי יכול לפתוח", "sh.room": "אנשי החדר הזה", "sh.roomSub": "Lisboa acquisitions\u200F · 6 אנשים",
      "sh.ws": "כל סביבת העבודה", "sh.wsSub": "Realization\u200F · חברים מחוברים", "sh.link": "כל מי שיש לו קישור", "sh.linkSub": "בלי התחברות. הקישור פג אחרי 7 ימים.",
      "sh.transcript": "לכלול תמלול והקלטה", "sh.copy": "העתקת קישור", "sh.done": "סיום", "sh.linkLabel": "קישור שיתוף",
      "sh.hint.room": "אנשי Lisboa acquisitions נכנסים עם החשבון שלהם.", "sh.hint.ws": "כל מי שמחובר ל-Realization יכול לפתוח.", "sh.hint.link": "כל מי שיש לו את הקישור יכול לקרוא את הסיכום בלי להתחבר.",
      "sh.hint.tr": " התמלול וההקלטה כלולים.",
    },
  }

  // Hebrew prefixes ("ל-due diligence", "ה-SPA") must not be left alone at a
  // line end: a word joiner after the hyphen keeps them with their word.
  const joinPrefix = (s) => s.replace(/([\u0590-\u05FF])-(?=\S)/g, "$1-\u2060")
  const deep = (v) => typeof v === "string" ? joinPrefix(v) : Array.isArray(v) ? v.map(deep) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "k" ? x : deep(x)])) : v
  LINES.forEach((l) => { l[2] = joinPrefix(l[2]) })
  SUMMARY.he = deep(SUMMARY.he)
  ANSWERS.he = deep(ANSWERS.he)
  T.he = deep(T.he)

  const liveBase = Date.now() - (12 * 60 + 48) * 1000
  const ROWS = [
    { id: "live", day: "today", when: "11:00", live: true, spk: [4, 3], title: { en: `Legal sync${NB}— SPA review`, he: `סנכרון משפטי${NB}— סקירת SPA` },
      overview: { en: "MeetSum's notetaker is in the call. The live transcript fills in here, and the summary starts when the call ends.", he: "ה-notetaker של MeetSum נמצא בשיחה. התמלול החי מתעדכן כאן, והסיכום יתחיל כשהשיחה תסתיים." } },
    { id: "main", day: "today", when: "10:30", spk: [1, 2, 3, 4] },
    { id: "ops", day: "yesterday", when: "09:30", dur: "18:22", spk: [1, 4, 6], title: { en: "Weekly ops standup", he: "סטנדאפ תפעול שבועי" },
      overview: { en: "Maintenance backlog is down to 6 tickets. Daniel takes over vendor invoices from next week.", he: "תור התחזוקה ירד ל-6 קריאות. דניאל לוקח את חשבוניות הספקים מהשבוע הבא." } },
    { id: "inv", day: "earlier", when: { en: "Mon 16:00", he: "ב׳ 16:00" }, dur: "46:10", spk: [1, 7, 8, 5, 6], status: "review", title: { en: `Investor call${NB}— Porto fund`, he: `שיחת משקיעים${NB}— קרן פורטו` },
      overview: { en: "Two speakers still need names before this summary is shared. The draft covers fund size, fees and the Q3 close.", he: "שני דוברים עדיין צריכים שם לפני שמשתפים את הסיכום. הטיוטה מכסה את גודל הקרן, העמלות והסגירה ב-Q3." } },
  ]

  ROWS.forEach((r) => {
    if (r.overview) r.overview.he = joinPrefix(r.overview.he)
    if (r.title?.he) r.title.he = joinPrefix(r.title.he)
  })

  /* ----------------------------------------------------------------- state */
  const state = {
    lang: store.get("cadence.lang") === "he" ? "he" : "en",
    t: 0, playing: false, speed: 1, tab: "summary", selected: "main",
    follow: true, edited: { en: null, he: null }, done: new Set(["a4"]), flagged: new Set(),
    seg: -1, word: -1, chap: -1, rec: null, gen: null, ask: null, procN: 0, procActive: 0,
  }
  const L = () => state.lang
  // Content of a known language gets an explicit dir. dir="auto" is only for text
  // of unknown language (user input): it resolves from the first strong character
  // and would flip "Lisboa Riverside נכנסת…" to LTR.
  const ddir = () => (state.lang === "he" ? "rtl" : "ltr")
  const t = (k, vars) => {
    let s = T[state.lang][k] ?? T.en[k] ?? k
    if (vars && typeof s === "string") for (const [a, b] of Object.entries(vars)) s = s.replace(`{${a}}`, b)
    return s
  }
  const spkName = (n) => SPK[n][state.lang]
  const avatar = (n, size = "sm") => `<span class="avatar avatar-${size}" style="--c:${SPK[n].c}" aria-hidden="true">${SPK[n].ini[state.lang]}</span>`
  const stackHTML = (list, max = 3) => `<span class="stack">${list.slice(0, max).map((n) => avatar(n, "xs")).join("")}${list.length > max ? `<span class="avatar avatar-xs avatar-more" aria-hidden="true">+${list.length - max}</span>` : ""}</span>`

  let meet = null
  function buildMeeting() {
    const rate = state.lang === "he" ? 2.1 : 2.6
    let at = 0.4
    const segs = LINES.map(([spk, en, he], i) => {
      const text = state.lang === "he" ? he : en
      const words = text.split(/\s+/)
      const dur = Math.max(2.2, words.length / rate)
      const s = { i, spk, text, words, start: at, end: at + dur }
      at += dur + 0.7
      return s
    })
    const order = []
    segs.forEach((s) => { if (!order.includes(s.spk)) order.push(s.spk) })
    meet = { segs, dur: Math.ceil(at), order, sum: SUMMARY[state.lang] }
  }

  // Provenance hairline: the speakers a claim is drawn from, in order, as colour bands.
  function provGradient(segIdx) {
    const spk = [...new Set(segIdx.map((i) => meet.segs[i].spk))]
    const n = spk.length
    return `linear-gradient(${spk.map((s, k) => `${SPK[s].c} ${(k / n * 100).toFixed(1)}% ${((k + 1) / n * 100).toFixed(1)}%`).join(", ")})`
  }

  function srSay(msg) {
    const el = $("#sr-live")
    el.textContent = ""
    setTimeout(() => { el.textContent = msg }, 30)
  }

  /* ---------------------------------------------------------------- toasts */
  function toast({ kind = "ok", title, sub = "", action, ms = 4200 }) {
    const box = $("#toasts")
    while (box.children.length >= 3) box.firstElementChild.remove()
    const el = document.createElement("div")
    el.className = "toast"
    const ic = { ok: "check", info: "upload", ai: "cite", live: "mic", warn: "flag", danger: "trash" }[kind] || "check"
    el.innerHTML = `<span class="toast-icon ${kind}">${icon(ic)}</span><div><b>${esc(title)}</b>${sub ? `<span>${esc(sub)}</span>` : ""}</div>${action ? `<button type="button" class="btn btn-ghost btn-xs">${esc(action.label)}</button>` : ""}`
    if (action) el.querySelector("button").addEventListener("click", () => { action.fn(); close() })
    box.append(el)
    let timer = setTimeout(close, ms)
    el.addEventListener("mouseenter", () => clearTimeout(timer))
    el.addEventListener("mouseleave", () => { timer = setTimeout(close, 1600) })
    function close() {
      if (!el.isConnected) return
      el.classList.add("out")
      setTimeout(() => el.remove(), reduced() ? 0 : 170)
    }
  }

  /* --------------------------------------------------------------- chrome */
  function applyI18n() {
    app.lang = state.lang
    app.dir = ddir()
    $$("[data-i18n]", app).forEach((el) => { el.textContent = t(el.dataset.i18n) })
    $$("[data-i18n-ph]", app).forEach((el) => { el.placeholder = t(el.dataset.i18nPh) })
    $$("[data-i18n-aria]", app).forEach((el) => {
      el.setAttribute("aria-label", t(el.dataset.i18nAria))
      if (el.classList.contains("icon-btn")) el.title = t(el.dataset.i18nAria)
    })
    $$("[data-tip-i18n]", app).forEach((el) => { el.dataset.tip = t(el.dataset.tipI18n); el.setAttribute("aria-label", t(el.dataset.tipI18n)) })
    $(".tl-legend").dir = ddir()
    $("#lang-en").setAttribute("aria-pressed", String(state.lang === "en"))
    $("#lang-he").setAttribute("aria-pressed", String(state.lang === "he"))
    $("#rec-btn [data-i18n]").textContent = state.rec ? t("rec.on") : t("rec.start")
    $("#p-play").setAttribute("aria-label", t(state.playing ? "aria.pause" : "aria.play"))
  }

  /* ---------------------------------------------------------------- inbox */
  const rowTitle = (r) => r.id === "main" ? t("title") : r.title[L()] ?? r.title
  const whenOf = (r) => typeof r.when === "string" ? r.when : r.when[L()]
  const liveElapsed = () => (Date.now() - liveBase) / 1000

  function progHTML(r) {
    const steps = t("steps")
    const p = r.proc
    return `<span class="prog-label"><span>${esc(steps[p.step])}</span><span class="num" dir="ltr">${p.step === 1 ? Math.round(p.p) + "%" : ""}</span></span>` +
      `<span class="prog-steps">${steps.map((_, i) => `<span class="${i < p.step ? "done" : i === p.step ? "cur" : ""}" style="--p:${i === p.step ? p.p : 0}%"></span>`).join("")}</span>`
  }

  // Exceptions only: a finished meeting needs no badge.
  function statusPill(r) {
    if (r.live) return `<span class="pill pill-live"><span class="rec-dot"></span>${t("pill.live")}</span>`
    if (r.status === "review") return `<span class="pill pill-warn">${icon("alert")}${t("pill.review")}</span>`
    if (r.isNew) return `<span class="pill pill-new${r.pop ? " pop" : ""}">${t("pill.new")}</span>`
    return ""
  }

  function rowHTML(r) {
    const dur = r.live ? `<span class="dur" dir="ltr" data-live-dur>${fmt(liveElapsed())}</span>`
      : r.id === "main" ? `<span class="dur" dir="ltr">${fmt(meet.dur)}</span>`
      : r.dur ? `<span class="dur" dir="ltr">${r.dur}</span>` : ""
    const body = r.proc
      ? `<span class="prog" data-prog="${r.id}">${progHTML(r)}</span>`
      : `<span class="meta">${r.spk ? stackHTML(r.spk) : ""}${dur}<span class="grow"></span>${statusPill(r)}</span>`
    return `<button type="button" role="option" class="row-m${r.enter ? " enter" : ""}" aria-selected="${state.selected === r.id}" data-row="${r.id}">` +
      `<span class="t" dir="${ddir()}">${esc(rowTitle(r))}</span><span class="when">${esc(whenOf(r))}</span>${body}</button>`
  }

  function renderInbox() {
    $("#inbox-list").innerHTML = ["today", "yesterday", "earlier"].map((d) => {
      const rows = ROWS.filter((r) => r.day === d)
      return rows.length ? `<div class="day">${t(d)}</div>${rows.map(rowHTML).join("")}` : ""
    }).join("")
    ROWS.forEach((r) => { r.enter = false; r.pop = false })
  }
  function rerenderRow(r) {
    const btn = $(`[data-row="${r.id}"]`)
    if (!btn) return
    const tmp = document.createElement("div")
    tmp.innerHTML = rowHTML(r)
    btn.replaceWith(tmp.firstElementChild)
    r.pop = false
  }

  /* --------------------------------------------------------------- header */
  function renderHeader() {
    const r = ROWS.find((x) => x.id === state.selected)
    const title = $("#m-title")
    title.textContent = rowTitle(r)
    title.dir = ddir()
    if (r.id === "main") {
      $("#m-meta").innerHTML = `<span>${icon("cal")}${esc(t("date"))}</span><span>${icon("clock")}<span dir="ltr" class="num">${fmt(meet.dur)}</span></span><span>${icon("users")}${esc(t("people"))}</span><span class="tag">Google Meet</span>`
    } else {
      $("#m-meta").innerHTML = `<span>${icon("clock")}<span class="num">${esc(whenOf(r))}</span></span>${r.spk ? stackHTML(r.spk) : ""}${statusPill(r)}`
    }
    $("#share-sub").textContent = rowTitle(r)
  }

  /* ------------------------------------------------------------- timeline */
  function renderTimeline(draw = false) {
    const D = meet.dur
    const pct = (x) => (x / D * 100).toFixed(3) + "%"
    let i = 0
    const rows = $("#tl-rows")
    rows.style.setProperty("--rows", meet.order.length)
    rows.innerHTML = meet.order.map((n, r) => {
      const bars = meet.segs.filter((s) => s.spk === n).map((s) => `<span class="tl-bar" data-seg="${s.i}" style="left:${pct(s.start)};width:${pct(s.end - s.start)};--c:${SPK[n].c};--i:${i++}"></span>`).join("")
      return `<div class="tl-row" data-spk="${n}" style="--r:${r}">${avatar(n, "xs")}${bars}</div>`
    }).join("")
    const ch = meet.sum.chapters
    // The player is LTR in both languages; chapter text is isolated so a
    // Hebrew label can't move its tick to the end of the chapter.
    $("#tl-chapters").innerHTML = ch.map((c, k) => {
      const a = meet.segs[c.at].start, b = k + 1 < ch.length ? meet.segs[ch[k + 1].at].start : D
      return `<span class="tl-ch" style="left:${pct(a)};width:${pct(b - a)}"><bdi dir="${ddir()}">${esc(c.t)}</bdi></span>`
    }).join("")
    const marks = [
      ...meet.sum.decisions.map((d, k) => ({ cls: "", at: d.at, label: t("mark.decision"), txt: d.t, ref: `d${k}` })),
      ...meet.sum.actions.map((a) => ({ cls: "act", at: a.at, label: t("mark.action"), txt: a.t, ref: a.id })),
      ...meet.sum.questions.map((q, k) => ({ cls: "q", at: q.at, label: t("mark.question"), txt: q.t, ref: `q${k}` })),
    ]
    $("#tl-marks").innerHTML = marks.map((m) => `<button type="button" class="tl-mark ${m.cls}" style="left:${pct(meet.segs[m.at].start + 0.6)}" data-mark="${m.ref}" data-seek="${m.at}" aria-label="${esc(m.label)}: ${esc(m.txt)} · ${fmt(meet.segs[m.at].start)}" title="${esc(m.label)} · ${fmt(meet.segs[m.at].start)}"></button>`).join("")
    const tl = $("#tl")
    tl.classList.remove("draw")
    if (draw && !reduced()) { void tl.offsetWidth; tl.classList.add("draw") }
    $("#tl-hit").setAttribute("aria-valuemax", String(meet.dur))
    $("#p-dur").textContent = fmt(meet.dur)
    requestAnimationFrame(fitChapters)
  }
  function fitChapters() { $$(".tl-ch").forEach((el) => el.classList.toggle("tight", el.offsetWidth < 56)) }

  // Source trace: light up the lanes (and markers) a claim came from.
  function trace(segs, ref) {
    $$(".tl-bar.trace, .tl-mark.trace").forEach((el) => el.classList.remove("trace"))
    if (!segs) return
    segs.forEach((i) => $(`.tl-bar[data-seg="${i}"]`)?.classList.add("trace"))
    if (ref) $(`.tl-mark[data-mark="${ref}"]`)?.classList.add("trace")
  }
  function flashSources(segs) {
    segs.forEach((i) => {
      const b = $(`.tl-bar[data-seg="${i}"]`)
      if (!b) return
      b.classList.remove("traced"); void b.offsetWidth; b.classList.add("traced")
      setTimeout(() => b.classList.remove("traced"), 950)
    })
  }
  function scanTimeline() {
    if (reduced()) return
    const scan = $("#tl-scan")
    scan.style.setProperty("--scan-w", $("#tl-hit").clientWidth + "px")
    scan.classList.remove("run"); void scan.offsetWidth; scan.classList.add("run")
  }

  /* -------------------------------------------------------------- summary */
  const citeBtn = (i, pop = false) => `<button type="button" class="cite${pop ? " pop" : ""}" data-cite="${i}" aria-expanded="false" aria-label="${esc(t("cite.aria"))} ${fmt(meet.segs[i].start)}">${icon("play")}${fmt(meet.segs[i].start)}</button>`
  const itemEnd = (cites, pop, ref) => `<span class="end">${cites.map((i) => citeBtn(i, pop)).join("")}<button type="button" class="icon-btn flag" data-flag="${ref}" aria-pressed="${state.flagged.has(ref)}" aria-label="${esc(t("flag"))}" title="${esc(t("flag"))}">${icon("flag")}</button></span>`
  const liAttrs = (cls, k, anim, ref, cites) => `class="item${cls}${anim ? " rise" : ""}${state.flagged.has(ref) ? " flagged" : ""}" style="--i:${k}" data-ref="${ref}" data-cites="${cites.join(",")}"`

  const decisionHTML = (d, k, anim) => `<li ${liAttrs("", k, anim, `d${k}`, d.cites)}><span class="ico">${icon("diamond")}</span><div><span class="txt" dir="${ddir()}">${esc(d.t)}</span></div>${itemEnd(d.cites, anim, `d${k}`)}</li>`
  const questionHTML = (q, k, anim) => `<li ${liAttrs(" q", k, anim, `q${k}`, q.cites)}><span class="ico">${icon("help")}</span><div><span class="txt" dir="${ddir()}">${esc(q.t)}</span></div>${itemEnd(q.cites, anim, `q${k}`)}</li>`
  const actionHTML = (a, k, anim) => {
    const done = state.done.has(a.id)
    return `<li ${liAttrs(` act${done ? " done" : ""}`, k, anim, a.id, a.cites)}>` +
      `<label class="check"><input type="checkbox" data-act="${a.id}" ${done ? "checked" : ""}><span class="check-box">${icon("check")}</span><span class="sr">${esc(t("mark.done"))}</span></label>` +
      `<div><span class="txt" dir="${ddir()}">${esc(a.t)}</span><div class="sub"><span class="speaker">${avatar(a.owner, "xs")}<bdi>${esc(spkName(a.owner))}</bdi></span><span class="due${a.soon ? " soon" : ""}">${icon("cal")}${esc(a.due)}</span></div></div>${itemEnd(a.cites, anim, a.id)}</li>`
  }
  const chapterHTML = (c, k, anim) => `<button type="button" class="chap${anim ? " rise" : ""}" style="--i:${k}" data-seek="${c.at}"><span class="tc">${fmt(meet.segs[c.at].start)}</span><span dir="${ddir()}">${esc(c.t)}</span></button>`
  const actCount = () => `${meet.sum.actions.filter((a) => state.done.has(a.id)).length}/${meet.sum.actions.length}`

  function overviewHead(busy = false, status = t("ai.meta")) {
    return `<h3 class="sec-h">${esc(t("sec.overview"))}<span class="grow"></span>` +
      `<span class="ai-meta${busy ? " is-busy" : ""}" id="ai-status">${icon("cite")}<span>${esc(status)}</span></span>` +
      `<span class="sec-tools" id="ai-tools">` +
      (busy ? "" : `<button type="button" class="icon-btn" id="copy-sum" aria-label="${esc(t("copy"))}" title="${esc(t("copy"))}">${icon("copy")}</button><button type="button" class="icon-btn" id="edit-ov" aria-label="${esc(t("edit"))}" title="${esc(t("edit"))}">${icon("edit")}</button>`) +
      (busy ? `<button type="button" class="btn btn-ghost btn-xs" id="regen">${icon("stop")}${esc(t("ai.stop"))}</button>` : `<button type="button" class="btn btn-ghost btn-xs" id="regen">${icon("refresh")}${esc(t("ai.regen"))}</button>`) +
      `</span></h3>`
  }
  function provLineHTML() {
    const human = state.edited[L()]
    if (human) return `<div class="prov-line" id="ov-prov">${icon("edit")}${esc(t("ai.kept"))}</div>`
    const c = meet.sum.overviewCites
    const spk = [...new Set(c.map((i) => meet.segs[i].spk))]
    return `<div class="prov-line" id="ov-prov">${esc(t("prov.from", { n: c.length }))}${stackHTML(spk, 4)}${[...c].sort((a, b) => a - b).map((i) => citeBtn(i)).join("")}</div>`
  }
  function overviewBodyHTML() {
    const human = state.edited[L()]
    return `<p class="overview${human ? " is-human" : ""}" id="ov" dir="${ddir()}" data-cites="${meet.sum.overviewCites.join(",")}" style="--prov:${provGradient(meet.sum.overviewCites)}">${esc(human ?? meet.sum.overview)}</p>` + provLineHTML()
  }

  const secShell = (id, title, count, inner) => `<section class="sec" id="${id}"><h3 class="sec-h">${esc(title)}${count != null ? ` <span class="count" ${id === "s-actions" ? "data-act-count" : ""}>${count}</span>` : ""}</h3>${inner}</section>`

  // Order: what happened, then what you have to do, then why, then where.
  function renderSummary() {
    const S = meet.sum
    $("#pane-summary").innerHTML =
      `<section class="sec" id="s-overview">${overviewHead()}${overviewBodyHTML()}</section>` +
      secShell("s-actions", t("sec.actions"), actCount(), `<ul class="items">${S.actions.map((a, k) => actionHTML(a, k)).join("")}</ul>`) +
      secShell("s-decisions", t("sec.decisions"), S.decisions.length, `<ul class="items">${S.decisions.map((d, k) => decisionHTML(d, k)).join("")}</ul>`) +
      secShell("s-questions", t("sec.questions"), S.questions.length, `<ul class="items">${S.questions.map((q, k) => questionHTML(q, k)).join("")}</ul>`) +
      secShell("s-chapters", t("sec.chapters"), null, `<div class="chapters">${S.chapters.map((c, k) => chapterHTML(c, k)).join("")}</div>`)
    markChapter(true)
  }

  const skel = (n) => `<div class="skel-block">${Array.from({ length: n }, (_, k) => `<span class="skel" style="width:${[92, 78, 64, 86][k % 4]}%"></span>`).join("")}</div>`

  async function regenerate() {
    if (state.gen) { state.gen.cancelled = true; return }
    const g = (state.gen = { cancelled: false })
    closePeek()
    const S = meet.sum
    const fast = reduced()
    const human = state.edited[L()]
    $("#pane-summary").innerHTML =
      `<section class="sec" id="s-overview">${overviewHead(true, t("ai.writing"))}${human ? overviewBodyHTML() : `<div id="ov-slot">${skel(3)}</div>`}</section>` +
      secShell("s-actions", t("sec.actions"), "", `<div class="slot">${skel(4)}</div>`) +
      secShell("s-decisions", t("sec.decisions"), "", `<div class="slot">${skel(3)}</div>`) +
      secShell("s-questions", t("sec.questions"), "", `<div class="slot">${skel(1)}</div>`) +
      secShell("s-chapters", t("sec.chapters"), "", `<div class="slot">${skel(2)}</div>`)
    $("#pane-summary").scrollTop = 0
    $("#player").classList.remove("is-compact")
    scanTimeline()
    const wait = async (ms) => { await sleep(fast ? Math.min(ms, 120) : ms); return g.cancelled }

    if (!human) {
      if (await wait(700)) return finish(true)
      const slot = $("#ov-slot")
      slot.innerHTML = `<p class="overview" id="ov" dir="${ddir()}" data-cites="${S.overviewCites.join(",")}" style="--prov:${provGradient(S.overviewCites)}"></p>`
      const p = $("#ov")
      flashSources(S.overviewCites)
      if (fast) p.textContent = S.overview
      else {
        const words = S.overview.split(" ")
        const caret = document.createElement("span")
        caret.className = "caret"
        p.append(caret)
        for (let k = 0; k < words.length; k += 3) {
          if (g.cancelled) { caret.remove(); return finish(true) }
          const chunk = document.createElement("span")
          chunk.className = "chunk"
          chunk.textContent = (k ? " " : "") + words.slice(k, k + 3).join(" ")
          caret.before(chunk)
          await sleep(55)
        }
        caret.remove()
        p.textContent = S.overview
      }
      slot.insertAdjacentHTML("beforeend", provLineHTML())
    }
    const fill = async (id, count, html, cites) => {
      if (await wait(420)) return true
      const sec = $("#" + id)
      $(".slot", sec).outerHTML = html
      const c = $(".count", sec)
      if (c) c.textContent = count
      cites.forEach((list, k) => setTimeout(() => flashSources(list), fast ? 0 : k * 90))
      return false
    }
    if (await fill("s-actions", actCount(), `<ul class="items">${S.actions.map((a, k) => actionHTML(a, k, true)).join("")}</ul>`, S.actions.map((a) => a.cites))) return finish(true)
    if (await fill("s-decisions", S.decisions.length, `<ul class="items">${S.decisions.map((d, k) => decisionHTML(d, k, true)).join("")}</ul>`, S.decisions.map((d) => d.cites))) return finish(true)
    if (await fill("s-questions", S.questions.length, `<ul class="items">${S.questions.map((q, k) => questionHTML(q, k, true)).join("")}</ul>`, S.questions.map((q) => q.cites))) return finish(true)
    if (await fill("s-chapters", null, `<div class="chapters">${S.chapters.map((c, k) => chapterHTML(c, k, true)).join("")}</div>`, [])) return finish(true)
    finish(false)

    function finish(stopped) {
      state.gen = null
      $$("#pane-summary .slot, #ov-slot .skel-block").forEach((el) => { el.outerHTML = `<p class="stopped">${esc(t("stoppedSec"))}</p>` })
      const head = $("#s-overview .sec-h")
      if (head) head.outerHTML = overviewHead(false, stopped ? t("ai.stopped") : t("ai.fresh"))
      markChapter(true)
    }
  }

  function markChapter(force = false) {
    const ch = meet.sum.chapters
    let cur = 0
    ch.forEach((c, k) => { if (state.t >= meet.segs[c.at].start) cur = k })
    if (!force && cur === state.chap) return
    state.chap = cur
    $$("#pane-summary .chap").forEach((el, k) => el.classList.toggle("is-now", k === cur && state.t > 0))
    $$(".tl-ch").forEach((el, k) => el.classList.toggle("is-now", k === cur))
    $("#p-chap").dir = ddir()
    $("#p-chap").innerHTML = `<span class="n">${cur + 1}/${ch.length}</span><bdi dir="${ddir()}">${esc(ch[cur].t)}</bdi>`
  }

  /* ----------------------------------------------------------- transcript */
  function renderTranscript() {
    const talk = meet.order.map((n) => ({ n, s: meet.segs.filter((x) => x.spk === n).reduce((a, x) => a + x.end - x.start, 0) }))
    const total = talk.reduce((a, x) => a + x.s, 0)
    $("#pane-transcript").innerHTML =
      `<div class="t-head"><span>${esc(t("t.speakers"))}</span><span class="talk" dir="ltr">${talk.map((x) => `<span style="--c:${SPK[x.n].c};flex:${(x.s / total).toFixed(3)}" title="${esc(spkName(x.n))} · ${Math.round(x.s / total * 100)}%"></span>`).join("")}</span><span class="grow"></span><span class="tag tag-ai">${icon("cite")}${esc(t("t.diarized"))}</span></div>` +
      `<div class="seg-list">${meet.segs.map((s) => `<div class="tseg" data-seg="${s.i}" style="--c:${SPK[s.spk].c}">${avatar(s.spk, "sm")}<div class="tseg-head"><b><bdi>${esc(spkName(s.spk))}</bdi></b><button type="button" class="tsb" data-seek="${s.i}">${fmt(s.start)}</button></div><p dir="${ddir()}">${s.words.map((w, k) => `<span class="w" data-w="${k}">${esc(w)}</span>`).join(" ")}</p></div>`).join("")}</div>`
    state.seg = -1
    state.word = -1
  }

  /* ------------------------------------------------------------------ ask */
  function renderAskEmpty() {
    state.ask = null
    $("#ask-log").innerHTML = `<div class="ask-empty"><h3>${esc(t("ask.title"))}</h3><p>${esc(t("ask.sub"))}</p><div class="sugg">${ANSWERS[L()].map((a, k) => `<button type="button" data-sugg="${k}">${icon("cite")}<span dir="${ddir()}">${esc(a.q)}</span></button>`).join("")}</div></div>`
  }

  function answerFor(q) {
    const s = q.toLowerCase()
    return ANSWERS[L()].find((a) => a.k.some((k) => s.includes(k.toLowerCase())))
  }

  async function ask(q) {
    q = q.trim()
    if (!q) return
    const bar = $("#ask-form")
    if (state.ask) { state.ask.cancelled = true; return }
    const job = (state.ask = { cancelled: false })
    const log = $("#ask-log")
    $(".ask-empty", log)?.remove()
    log.insertAdjacentHTML("beforeend", `<div class="msg msg-q" dir="auto">${esc(q)}</div>`)
    const hit = answerFor(q)
    const cited = hit ? [...hit.a.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])) : []
    const a = document.createElement("div")
    a.className = "msg msg-a" + (hit ? "" : " miss")
    if (hit) a.style.setProperty("--prov", provGradient(cited))
    a.innerHTML = `<div class="who">${icon("cite")}${esc(t("ask.who"))}</div><div class="body" dir="${ddir()}"><span class="skel" style="width:60%"></span></div>`
    if (hit) a.dataset.cites = [...new Set(cited)].join(",")
    log.append(a)
    log.setAttribute("aria-busy", "true")
    bar.classList.add("is-busy")
    log.scrollTop = log.scrollHeight
    $("#ask-input").value = ""
    const fast = reduced()
    await sleep(fast ? 200 : 650)
    const body = $(".body", a)
    body.innerHTML = ""
    if (!hit) body.textContent = t("ask.miss")
    else {
      flashSources([...new Set(cited)])
      const tokens = hit.a.split(/(\[\d+\])/).flatMap((p) => /^\[\d+\]$/.test(p) ? [p] : p.split(/(\s+)/)).filter((x) => x !== "")
      for (const tok of tokens) {
        if (job.cancelled) break
        const m = tok.match(/^\[(\d+)\]$/)
        if (m) body.insertAdjacentHTML("beforeend", citeBtn(Number(m[1]), true))
        else {
          const span = document.createElement("span")
          if (!fast) span.className = "chunk"
          span.textContent = tok
          body.append(span)
        }
        if (!fast && !/^\s+$/.test(tok)) await sleep(38)
        log.scrollTop = log.scrollHeight
      }
    }
    if (hit) a.insertAdjacentHTML("beforeend", `<div class="tools"><button type="button" class="icon-btn" data-flag="ans" aria-pressed="false" aria-label="${esc(t("flag"))}" title="${esc(t("flag"))}">${icon("flag")}</button><button type="button" class="icon-btn" data-copy-ans aria-label="${esc(t("copyAns"))}" title="${esc(t("copyAns"))}">${icon("copy")}</button></div>`)
    log.setAttribute("aria-busy", "false")
    bar.classList.remove("is-busy")
    state.ask = null
    log.scrollTop = log.scrollHeight
  }

  /* -------------------------------------------------------------- playback */
  let raf = 0, last = 0
  function play() {
    if (state.t >= meet.dur - 0.2) seek(0)
    state.playing = true
    $("#player").classList.add("is-playing")
    $("#p-play").setAttribute("aria-label", t("aria.pause"))
    last = 0
    if (!raf) raf = requestAnimationFrame(tick)
  }
  function pause() {
    state.playing = false
    $("#player").classList.remove("is-playing")
    $("#p-play").setAttribute("aria-label", t("aria.play"))
  }
  function tick(ts) {
    if (!state.playing) { raf = 0; return }
    const dt = last ? Math.min(0.1, (ts - last) / 1000) : 0
    last = ts
    setTime(state.t + dt * state.speed)
    if (state.t >= meet.dur) { setTime(meet.dur); pause() }
    raf = requestAnimationFrame(tick)
  }
  function seek(sec, { flash = false } = {}) {
    setTime(Math.max(0, Math.min(meet.dur, sec)))
    if (flash) {
      const el = $(`#pane-transcript .tseg[data-seg="${state.seg}"]`)
      if (el) { el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash") }
    }
  }

  function segAt(sec) {
    let idx = -1
    for (const s of meet.segs) { if (sec >= s.start - 0.01) idx = s.i; else break }
    return idx
  }

  function setTime(sec) {
    state.t = sec
    $("#p-now").textContent = fmt(sec)
    const hit = $("#tl-hit")
    $("#tl-head").style.transform = `translateX(${(sec / meet.dur) * hit.clientWidth}px)`
    hit.setAttribute("aria-valuenow", String(Math.round(sec)))
    hit.setAttribute("aria-valuetext", fmt(sec))
    const i = segAt(sec)
    const s = meet.segs[i]
    const inside = s && sec < s.end
    if (i !== state.seg) {
      $$("#pane-transcript .tseg.is-active").forEach((el) => { el.classList.remove("is-active"); $$(".w.said, .w.now", el).forEach((w2) => w2.classList.remove("said", "now")) })
      $$("#tl-rows .tl-row").forEach((r) => r.classList.toggle("is-speaking", !!s && inside && Number(r.dataset.spk) === s.spk))
      state.seg = i
      state.word = -1
      const el = $(`#pane-transcript .tseg[data-seg="${i}"]`)
      if (el) {
        el.classList.add("is-active")
        if (state.follow && state.tab === "transcript") scrollToSeg(el)
      }
    }
    markChapter()
    if (s) {
      $$("#tl-rows .tl-row").forEach((r) => r.classList.toggle("is-speaking", inside && Number(r.dataset.spk) === s.spk))
      const k = inside ? Math.floor(((sec - s.start) / (s.end - s.start)) * s.words.length) : s.words.length
      if (k !== state.word) {
        const el = $(`#pane-transcript .tseg[data-seg="${i}"]`)
        if (el) $$(".w", el).forEach((wEl, n) => { wEl.classList.toggle("said", n < k); wEl.classList.toggle("now", n === k && state.playing) })
        state.word = k
      }
    }
  }

  let autoScrollUntil = 0
  function scrollToSeg(el) {
    const pane = $("#pane-transcript")
    autoScrollUntil = performance.now() + 700
    pane.scrollTo({ top: el.offsetTop - pane.clientHeight * 0.3, behavior: reduced() ? "auto" : "smooth" })
  }
  function setFollow(on) {
    state.follow = on
    $("#follow-pill").hidden = on || state.tab !== "transcript"
    if (on) { const el = $(`#pane-transcript .tseg[data-seg="${state.seg}"]`); if (el) scrollToSeg(el) }
  }

  /* ----------------------------------------------------------------- tabs */
  function setTab(name, { focus = false } = {}) {
    if (state.selected !== "main") selectRow("main")
    state.tab = name
    $$("#tabs [role=tab]").forEach((b) => {
      const on = b.dataset.tab === name
      b.setAttribute("aria-selected", String(on))
      b.tabIndex = on ? 0 : -1
      if (on && focus) b.focus()
    })
    ;["summary", "transcript", "ask"].forEach((n) => {
      const p = $("#pane-" + n)
      const show = n === name
      if (show && p.hidden) { p.hidden = false; if (!reduced()) { p.classList.remove("enter"); void p.offsetWidth; p.classList.add("enter") } }
      if (!show) p.hidden = true
    })
    $("#pane-preview").hidden = true
    moveInk()
    closePeek()
    syncCompact()
    $("#follow-pill").hidden = state.follow || name !== "transcript"
    if (name === "transcript") {
      const el = $(`#pane-transcript .tseg[data-seg="${state.seg}"]`)
      if (el && state.follow) requestAnimationFrame(() => scrollToSeg(el))
    }
  }
  function moveInk() {
    const b = $(`#tabs [aria-selected="true"]`)
    const ink = $("#tabs-ink")
    if (!b || !b.offsetWidth) return
    ink.style.width = b.offsetWidth - 16 + "px"
    ink.style.transform = `translateX(${b.offsetLeft + 8}px)`
  }
  // Compact player: lanes slide into one when the reading pane scrolls.
  function syncCompact() {
    const pane = state.tab === "ask" ? null : $("#pane-" + state.tab)
    $("#player").classList.toggle("is-compact", !!pane && !pane.hidden && pane.scrollTop > 24)
  }

  /* ------------------------------------------------------- row selection */
  function openRow(id) {
    const rowT = $(`[data-row="${id}"] .t`)
    if (!document.startViewTransition || reduced() || id === state.selected || !rowT) return selectRow(id)
    rowT.style.viewTransitionName = "meeting-title"
    const vt = document.startViewTransition(() => {
      rowT.style.viewTransitionName = ""
      selectRow(id)
      $("#m-title").style.viewTransitionName = "meeting-title"
    })
    vt.finished.finally(() => { $("#m-title").style.viewTransitionName = "" })
  }

  function selectRow(id) {
    state.selected = id
    const r = ROWS.find((x) => x.id === id)
    if (r.isNew) { r.isNew = false; rerenderRow(r) }
    $$("#inbox-list .row-m").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.row === id)))
    app.classList.toggle("is-preview", id !== "main")
    app.classList.remove("inbox-open")
    $("#inbox-toggle").setAttribute("aria-expanded", "false")
    closePeek()
    closeMenu()
    renderHeader()
    if (id === "main") {
      $("#pane-preview").hidden = true
      $("#pane-" + state.tab).hidden = false
      moveInk()
      return
    }
    pause()
    ;["summary", "transcript", "ask"].forEach((n) => { $("#pane-" + n).hidden = true })
    $("#follow-pill").hidden = true
    const pv = $("#pane-preview")
    pv.hidden = false
    pv.innerHTML = `<div class="preview-card">${skel(3)}</div>`
    setTimeout(() => {
      if (state.selected !== id) return
      const ov = r.proc ? null : r.overview?.[L()]
      pv.innerHTML = `<div class="preview-card rise">${ov ? `<p class="overview" dir="${ddir()}">${esc(ov)}</p>` : ""}<p class="spec-note">${esc(t("preview.note"))}</p><div><button type="button" class="btn btn-secondary btn-sm" data-open-main>${esc(t("preview.open"))}${icon("arrow-end", "flip")}</button></div></div>`
    }, reduced() ? 60 : 420)
  }

  /* ----------------------------------------------------------------- peek */
  let peekChip = null
  function openPeek(chip) {
    const i = Number(chip.dataset.cite)
    if (peekChip === chip) { closePeek(); return }
    closePeek()
    const s = meet.segs[i]
    seek(s.start)
    const pk = $("#peek")
    pk.innerHTML = `<div class="peek-head">${avatar(s.spk, "xs")}<b id="peek-who"><bdi>${esc(spkName(s.spk))}</bdi></b><span class="tc">${fmt(s.start)}</span><span class="grow"></span><button type="button" class="icon-btn" data-peek-close aria-label="${esc(t("aria.close"))}">${icon("x")}</button></div>` +
      `<blockquote dir="${ddir()}">${esc(s.text)}</blockquote><div class="row"><button type="button" class="btn btn-primary btn-xs" data-peek-play="${i}">${icon("play")}${esc(t("peek.play"))}</button><button type="button" class="btn btn-secondary btn-xs" data-peek-open="${i}">${esc(t("peek.open"))}</button></div>`
    pk.hidden = false
    const main = $(".main", app).getBoundingClientRect()
    const c = chip.getBoundingClientRect()
    const w = pk.offsetWidth, h = pk.offsetHeight
    let top = c.bottom - main.top + 6
    if (top + h > main.height - 8) top = c.top - main.top - h - 6
    let left = (app.dir === "rtl" ? c.right - main.left - w + 12 : c.left - main.left - 12)
    left = Math.max(12, Math.min(main.width - w - 12, left))
    pk.style.top = top + "px"
    pk.style.left = left + "px"
    chip.setAttribute("aria-expanded", "true")
    peekChip = chip
    trace([i])
  }
  function closePeek() {
    if (peekChip) peekChip.setAttribute("aria-expanded", "false")
    peekChip = null
    const pk = $("#peek")
    if (pk) pk.hidden = true
  }

  /* ----------------------------------------------------------------- menu */
  function openMenu() {
    const m = $("#more-menu")
    m.hidden = false
    $("#more-btn").setAttribute("aria-expanded", "true")
    $("[role=menuitem]", m).focus()
  }
  function closeMenu(focusBtn = false) {
    const m = $("#more-menu")
    if (m.hidden) return
    m.hidden = true
    $("#more-btn").setAttribute("aria-expanded", "false")
    if (focusBtn) $("#more-btn").focus()
  }
  function runMenu(k) {
    closeMenu(true)
    if (k === "rename") return renameTitle()
    if (k === "pdf") return toast({ kind: "ok", title: t("toast.pdf"), sub: t("toast.pdfSub") })
    if (k === "docx") return toast({ kind: "ok", title: t("toast.docx"), sub: rowTitle(ROWS[1]) })
    if (k === "reprocess") return toast({ kind: "info", title: t("toast.reprocess"), sub: t("toast.reprocessSub") })
    if (k === "delete") return toast({ kind: "danger", title: t("toast.deleted"), sub: t("toast.deletedSub"), action: { label: t("undo"), fn: () => toast({ title: t("toast.restored") }) }, ms: 6000 })
  }
  function renameTitle() {
    const h = $("#m-title")
    h.contentEditable = "true"
    h.focus()
    const range = document.createRange(); range.selectNodeContents(h)
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range)
    const done = (save) => {
      h.contentEditable = "false"
      h.removeEventListener("keydown", onKey)
      h.removeEventListener("blur", onBlur)
      if (save) toast({ title: t("toast.renamed"), sub: h.textContent.trim() })
      else renderHeader()
    }
    const onKey = (e) => { if (e.key === "Enter") { e.preventDefault(); done(true) } else if (e.key === "Escape") { e.preventDefault(); done(false) } }
    const onBlur = () => done(true)
    h.addEventListener("keydown", onKey)
    h.addEventListener("blur", onBlur)
  }

  /* --------------------------------------------------------------- dialog */
  let dlgOpener = null
  function updateShareHint() {
    const v = $("input[name=access]:checked").value
    $("#sh-hint").textContent = t("sh.hint." + v) + ($("#sh-transcript").checked ? t("sh.hint.tr") : "")
  }
  function openShare() {
    dlgOpener = document.activeElement
    closeMenu()
    renderHeader()
    $("#share-dlg").hidden = false
    updateShareHint()
    $("input[name=access]:checked").focus()
  }
  function closeShare() {
    $("#share-dlg").hidden = true
    if (dlgOpener?.focus) dlgOpener.focus({ preventScroll: true })
  }
  function trapFocus(e, box) {
    if (e.key !== "Tab") return
    const f = $$("button, input, [tabindex]:not([tabindex='-1'])", box).filter((x) => !x.disabled && x.offsetParent !== null && !(x.type === "radio" && !x.checked))
    if (!f.length) return
    const first = f[0], lastEl = f[f.length - 1]
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); lastEl.focus() }
    else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); first.focus() }
  }

  /* ------------------------------------------------------------- recorder */
  function toggleRec() {
    if (state.rec) return stopRec()
    selectRow(state.selected)
    $("#rec-btn").setAttribute("aria-pressed", "true")
    state.rec = { start: Date.now(), buf: Array.from({ length: 48 }, () => 0.08), raf: 0, timer: 0 }
    $("#rec-btn [data-i18n]").textContent = t("rec.on")
    const dock = $("#recorder")
    dock.classList.remove("out")
    dock.hidden = false
    app.classList.add("is-recording")
    srSay(t("sr.recStart"))
    const timeEl = $("#rec-time")
    const upd = () => {
      const s = Math.floor((Date.now() - state.rec.start) / 1000)
      timeEl.innerHTML = `${String(Math.floor(s / 60)).padStart(2, "0")}<span class="colon">:</span>${String(s % 60).padStart(2, "0")}`
    }
    upd()
    state.rec.timer = setInterval(upd, 1000)
    const cv = $("#rec-wave"), cx = cv.getContext("2d")
    let phase = 0, lastPush = 0
    const draw = (ts) => {
      if (!state.rec) return
      const dpr = window.devicePixelRatio || 1
      const W = cv.clientWidth, H = cv.clientHeight
      if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr) }
      cx.setTransform(dpr, 0, 0, dpr, 0, 0)
      if (!reduced() && ts - lastPush > 70) {
        lastPush = ts
        phase += 0.35
        const speech = Math.max(0, Math.sin(phase * 0.6)) * 0.7 + Math.random() * 0.35
        state.rec.buf.push(Math.min(1, 0.08 + speech * (Math.random() > 0.15 ? 1 : 0.2)))
        state.rec.buf.shift()
      }
      cx.clearRect(0, 0, W, H)
      const n = state.rec.buf.length, gap = 2, bw = Math.max(2, (W - gap * (n - 1)) / n)
      const cs = getComputedStyle(app)
      const live = cs.getPropertyValue("--live").trim() || "#d33"
      const dim = cs.getPropertyValue("--line-control").trim() || "#999"
      // Time runs left to right in every language, like the scrubber.
      state.rec.buf.forEach((v, k) => {
        const h = Math.max(3, v * (H - 4))
        cx.fillStyle = k > n - 6 ? live : dim
        cx.globalAlpha = k > n - 6 ? 1 : 0.35 + 0.65 * (k / n)
        cx.beginPath()
        const x = k * (bw + gap)
        cx.roundRect ? cx.roundRect(x, (H - h) / 2, bw, h, bw / 2) : cx.rect(x, (H - h) / 2, bw, h)
        cx.fill()
      })
      cx.globalAlpha = 1
      state.rec.raf = requestAnimationFrame(draw)
    }
    state.rec.raf = requestAnimationFrame(draw)
  }
  function stopRec() {
    if (!state.rec) return
    const secs = Math.max(1, Math.round((Date.now() - state.rec.start) / 1000))
    clearInterval(state.rec.timer)
    cancelAnimationFrame(state.rec.raf)
    state.rec = null
    $("#rec-btn").setAttribute("aria-pressed", "false")
    $("#rec-btn [data-i18n]").textContent = t("rec.start")
    app.classList.remove("is-recording")
    const dock = $("#recorder")
    dock.classList.add("out")
    setTimeout(() => { dock.hidden = true; dock.classList.remove("out") }, reduced() ? 0 : 170)
    srSay(t("sr.recStop"))
    toast({ kind: "ok", title: t("toast.saved"), sub: fmt(secs) })
    simulateProcessing(t("newRec"), "rec", secs)
  }

  /* ----------------------------------------------------------- processing */
  const railSigma = () => $("#rail-sigma")
  function simulateProcessing(title, kind = "upload", secs = 0) {
    const id = "p" + ++state.procN
    const now = new Date()
    const row = { id, day: "today", when: `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`, title: { en: title, he: title }, proc: { step: 0, p: 0 }, enter: true, spk: null,
      overview: { en: "Draft summary from the processed recording. Three action items were found and are waiting for owners.", he: "טיוטת סיכום מתוך ההקלטה שעובדה. נמצאו שלוש משימות שממתינות לאחראים." } }
    ROWS.unshift(row)
    renderInbox()
    state.procActive++
    railSigma().classList.add("lanes")
    if (kind === "upload") toast({ kind: "info", title: t("toast.upload", { f: title }), sub: t("toast.uploadSub") })
    const plan = [700, 3200, 1300, 1700]
    const tickMs = 120
    let step = 0, elapsed = 0
    const iv = setInterval(() => {
      elapsed += tickMs
      row.proc.step = step
      row.proc.p = Math.min(100, (elapsed / plan[step]) * 100)
      const el = $(`[data-prog="${id}"]`)
      if (el) el.innerHTML = progHTML(row)
      if (elapsed < plan[step]) return
      step++
      elapsed = 0
      if (step < plan.length) return
      clearInterval(iv)
      delete row.proc
      row.isNew = true
      row.spk = [1, 5]
      row.dur = kind === "rec" ? fmt(secs) : "27:15"
      row.pop = true
      rerenderRow(row)
      if (state.selected === id) renderHeader()
      if (--state.procActive === 0) railSigma().classList.remove("lanes")
      toast({ kind: "ai", title: t("toast.ready"), sub: title, action: { label: t("open"), fn: () => openRow(id) }, ms: 6000 })
    }, tickMs)
  }

  /* -------------------------------------------------------------- palette */
  let palItems = [], palIdx = 0, palOpener = null
  function paletteItems() {
    const S = meet.sum
    return [
      ...ROWS.map((r) => ({ g: t("pg.meetings"), ic: "inbox", label: rowTitle(r), meta: whenOf(r), run: () => openRow(r.id) })),
      ...S.decisions.map((d, k) => ({ g: t("pg.decisions"), ic: "diamond", label: d.t, meta: fmt(meet.segs[d.at].start), run: () => jumpTo(`d${k}`, d.at) })),
      ...S.actions.map((a) => ({ g: t("pg.actions"), ic: "tasks", label: a.t, meta: spkName(a.owner), run: () => jumpTo(a.id, a.at) })),
      { g: t("pg.commands"), ic: "share", label: t("cmd.share"), run: () => openShare() },
      { g: t("pg.commands"), ic: "sun", label: t("cmd.theme"), run: () => toggleTheme() },
      { g: t("pg.commands"), ic: "lang", label: t("cmd.lang"), run: () => setLang(L() === "en" ? "he" : "en") },
      { g: t("pg.commands"), ic: "mic", label: t("cmd.rec"), run: () => { if (!state.rec) toggleRec() } },
      { g: t("pg.commands"), ic: "upload", label: t("cmd.upload"), run: () => simulateProcessing(t("boardPrep")) },
      { g: t("pg.commands"), ic: "refresh", label: t("cmd.regen"), run: () => { setTab("summary"); regenerate() } },
    ]
  }
  function renderPalette() {
    const q = $("#palette-input").value.trim().toLowerCase()
    palItems = paletteItems().filter((it) => !q || it.label.toLowerCase().includes(q) || (it.meta || "").toLowerCase().includes(q))
    palIdx = Math.min(palIdx, Math.max(0, palItems.length - 1))
    const list = $("#palette-list")
    if (!palItems.length) { list.innerHTML = `<div class="po-empty">${esc(t("palette.none"))}</div>`; $("#palette-input").removeAttribute("aria-activedescendant"); return }
    let g = "", html = ""
    palItems.forEach((it, k) => {
      if (it.g !== g) { g = it.g; html += `<div class="pg" role="presentation">${esc(g)}</div>` }
      html += `<button type="button" class="po" role="option" tabindex="-1" id="po-${k}" data-po="${k}" aria-selected="${k === palIdx}">${icon(it.ic)}<span class="po-t" dir="${ddir()}">${esc(it.label)}</span>${it.meta ? `<span class="po-m" dir="auto">${esc(it.meta)}</span>` : ""}</button>`
    })
    list.innerHTML = html
    $("#palette-input").setAttribute("aria-activedescendant", `po-${palIdx}`)
  }
  function openPalette() {
    palOpener = document.activeElement
    palIdx = 0
    closeMenu()
    $("#palette-input").value = ""
    $("#palette").hidden = false
    renderPalette()
    $("#palette-input").focus()
  }
  function closePalette() {
    $("#palette").hidden = true
    if (palOpener && palOpener.focus) palOpener.focus({ preventScroll: true })
  }
  function runPalette(k) {
    const q = $("#palette-input").value.trim()
    const it = palItems[k]
    closePalette()
    if (it) it.run()
    else if (q) { setTab("ask"); ask(q) }
  }
  function jumpTo(ref, at) {
    selectRow("main")
    setTab("summary")
    seek(meet.segs[at].start)
    requestAnimationFrame(() => {
      const el = $(`#pane-summary [data-ref="${ref}"]`)
      if (!el) return
      el.scrollIntoView({ block: "center", behavior: reduced() ? "auto" : "smooth" })
      el.style.animation = "none"; void el.offsetWidth; el.style.animation = "ms-flash var(--dur-flash) var(--ease-out) both"
      trace(el.dataset.cites.split(",").map(Number), ref)
      setTimeout(() => trace(null), 1600)
    })
  }

  /* ------------------------------------------------------------ language */
  function setLang(l) {
    if (state.gen) state.gen.cancelled = true
    if (state.ask) state.ask.cancelled = true
    state.lang = l
    store.set("cadence.lang", l)
    pause()
    state.t = 0
    state.chap = -1
    buildMeeting()
    applyI18n()
    renderInbox()
    renderHeader()
    renderTimeline(true)
    renderSummary()
    renderTranscript()
    renderAskEmpty()
    renderTasks()
    selectRow(ROWS.some((r) => r.id === state.selected) ? state.selected : "main")
    setTime(0)
    requestAnimationFrame(moveInk)
  }

  /* --------------------------------------------------------------- theme */
  const effectiveDark = () => root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches
  function toggleTheme(fromEl) {
    const next = effectiveDark() ? "light" : "dark"
    const apply = () => { root.dataset.theme = next; store.set("cadence.theme", next) }
    const btn = fromEl || $("#theme-toggle")
    if (!document.startViewTransition || reduced()) { apply(); afterTheme(); return }
    const r = btn.getBoundingClientRect()
    const x = r.left + r.width / 2, y = r.top + r.height / 2
    const end = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))
    const vt = document.startViewTransition(apply)
    vt.ready.then(() => {
      root.animate({ clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${end}px at ${x}px ${y}px)`] }, { duration: parseFloat(cssVar("--dur-reveal")) || 480, easing: "cubic-bezier(0.3, 0, 0, 1)", pseudoElement: "::view-transition-new(root)" })
    }).catch(() => {})
    vt.finished.then(afterTheme, afterTheme)
  }
  function afterTheme() { renderSwatches() }

  /* -------------------------------------------------------- foundations */
  const cv = document.createElement("canvas")
  cv.width = cv.height = 1
  const cx = cv.getContext("2d", { willReadFrequently: true })
  const cssVar = (n) => getComputedStyle(root).getPropertyValue(n).trim()
  function rgbOver(color, ground) {
    cx.clearRect(0, 0, 1, 1)
    cx.fillStyle = "#fff"; cx.fillStyle = ground; cx.fillRect(0, 0, 1, 1)
    cx.fillStyle = "#000"; cx.fillStyle = color; cx.fillRect(0, 0, 1, 1)
    const d = cx.getImageData(0, 0, 1, 1).data
    return [d[0], d[1], d[2]]
  }
  const lum = ([r, g, b]) => [r, g, b].map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }).reduce((a, v, k) => a + v * [0.2126, 0.7152, 0.0722][k], 0)
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05) }

  const SWATCHES = [
    ["--canvas", "App ground", "s"], ["--surface", "Panels, cards", "s"], ["--surface-2", "Rails, inputs", "s"], ["--surface-3", "Hover", "s"],
    ["--line", "Hairlines", "s"], ["--line-strong", "Dividers, chips", "s"], ["--line-control", "Input boundaries", "u"],
    ["--fg", "Primary text", "t"], ["--fg-2", "Secondary text", "t"], ["--fg-3", "Meta, captions", "t"],
    ["--brand", "Signal · primary actions", "u"], ["--brand-soft", "Selected rows", "s"], ["--brand-text", "Brand text, links", "t"],
    ["--ai", "Iris · AI only", "u"], ["--ai-soft", "AI tags", "s"], ["--ai-text", "AI labels", "t"],
    ["--live", "Recording only", "u"], ["--live-text", "Live labels", "t"],
    ["--ok-text", "Done", "t"], ["--warn", "Badge fill (dark text on it)", "s"], ["--mark-action", "Action markers", "u"], ["--warn-text", "Attention text", "t"],
    ["--danger-text", "Errors", "t"], ["--info-text", "Processing", "t"],
  ]
  function renderSwatches() {
    const surf = cssVar("--surface")
    const sRGB = rgbOver(surf, "#fff")
    $("#swatches").innerHTML = SWATCHES.map(([n, role, kind]) => {
      const r = ratio(rgbOver(cssVar(n), surf), sRGB)
      const need = kind === "t" ? 4.5 : kind === "u" ? 3 : 0
      const cls = !need ? "ui" : r >= need ? "pass" : "fail"
      const label = !need ? `${r.toFixed(2)}:1` : `${r.toFixed(2)}:1 ${r >= need ? (kind === "t" ? "AA text" : "AA UI") : "below " + need}`
      const chip = kind === "t"
        ? `<div class="sw-chip" style="background:var(--surface);color:var(${n});font-size:22px;font-weight:600;justify-content:flex-start;align-items:center">Aa אב</div>`
        : `<div class="sw-chip"><span></span></div>`
      return `<div class="sw" style="--v:var(${n})">${chip}<div class="sw-body"><code>${n}</code><small>${role}</small><span class="ratio ${cls}">${label}</span></div></div>`
    }).join("")
  }

  function renderFoundations() {
    renderSwatches()
    const widths = [[42, 70, 30, 55], [60, 25, 44], [35, 50, 20, 40], [28, 62, 38], [50, 30, 45], [22, 40, 58], [64, 24, 30], [30, 30, 50, 20]]
    $("#speaker-demo").innerHTML = SPK.slice(1).map((s, k) => `<div class="spk" style="--c:${s.c}"><div class="spk-top"><span class="avatar avatar-sm" style="--c:${s.c}">${s.ini.en}</span>${s.en}</div><div class="spk-bars">${widths[k].map((w) => `<span style="flex:${w}"></span>`).join("")}</div><code>--spk-${k + 1}</code></div>`).join("")
    const TYPE = [
      ["2xl", "28 / 34", "Empty-state titles", "No meetings yet", "עדיין אין פגישות", 600],
      ["xl", "22 / 28", "Page titles", `Lisboa Riverside${NB}— deal check-in`, `עדכון סטטוס עסקה${NB}— Lisboa Riverside`, 600],
      ["lg", "18 / 26", "Section titles", "Action items", "משימות", 600],
      ["md", "16 / 24", "Transcript, answers", "Our model shows an IRR of 18.2% in the base case.", "המודל שלנו מראה IRR של 18.2% בתרחיש הבסיס.", 400],
      ["base", "14 / 22", "Body, controls", "Proceed with detailed due diligence.", "ממשיכים ל-due diligence מלא.", 400],
      ["sm", "13 / 20", "Dense lists", "Yael Ben-David · due Tue, Apr 29", "יעל בן-דוד · עד יום ג׳, 29 באפר׳", 400],
      ["xs", "12 / 16", "Meta, chips", "4 people · Google Meet", "4 משתתפים · Google Meet", 400],
      ["2xs", "11 / 16", "Mono labels (Latin only)", "TRANSCRIBING 42% · 01:12", "מתמלל 42% · 01:12", 500],
    ]
    $("#type-table").innerHTML = TYPE.map(([k, px, use, en, he, wgt]) => {
      const st = `font-size:var(--text-${k});line-height:var(--lh-${k});font-weight:${wgt}`
      const labelFont = k === "2xs" ? ";font-family:var(--font-label);letter-spacing:var(--tracking-caps)" : ""
      return `<div class="tt-row"><div class="tt-meta"><code>text-${k}</code><small>${px} · ${use}</small></div><p style="${st}${labelFont}">${en}</p><p dir="rtl" lang="he" style="${st}${labelFont}">${he}</p></div>`
    }).join("")
    $("#space-scale").innerHTML = [["1", 4], ["2", 8], ["3", 12], ["4", 16], ["6", 24], ["8", 32], ["12", 48], ["16", 64]].map(([n, px]) => `<div class="sp"><span>space-${n} · ${px}</span><i style="--w:var(--space-${n})"></i></div>`).join("")
  }

  function renderTasks() {
    const open = meet.sum.actions.filter((a) => !state.done.has(a.id)).length
    const badge = $("#rail-badge")
    badge.textContent = open
    badge.hidden = open === 0
    $("#tasks-body").innerHTML = meet.sum.actions.map((a) =>
      `<tr class="${state.done.has(a.id) ? "done" : ""}"><td dir="${ddir()}" lang="${L()}">${esc(a.t)}</td><td><span class="speaker">${avatar(a.owner, "xs")}<bdi>${esc(spkName(a.owner))}</bdi></span></td>` +
      `<td><span class="due${a.soon && !state.done.has(a.id) ? " soon" : ""}">${icon("cal")}<span dir="${ddir()}">${esc(a.due)}</span></span></td>` +
      `<td><span class="from"><bdi dir="${ddir()}">${esc(rowTitle(ROWS.find((r) => r.id === "main")))}</bdi><button type="button" class="cite" data-jump="${a.id}" data-at="${a.at}" aria-label="${esc(t("cite.aria"))} ${fmt(meet.segs[a.at].start)}">${icon("play")}${fmt(meet.segs[a.at].start)}</button></span></td></tr>`).join("")
  }

  /* --------------------------------------------------------------- motion */
  const DURS = [["--dur-1", "70ms", "Hover, press, colour"], ["--dur-2", "120ms", "Toggles, checks"], ["--dur-3", "160ms", "Menus, tooltips, fades"], ["--dur-4", "240ms", "Panels, tabs, compact player"], ["--dur-5", "400ms", "Summary reveal, view change"], ["--dur-spring", "520ms", "Recorder dock, follow pill (spring)"]]
  const EASES = [["--ease-standard", "In-place change", [0.2, 0, 0.38, 0.9]], ["--ease-out", "Things entering", [0.16, 1, 0.3, 1]], ["--ease-in", "Things leaving", [0.4, 0, 1, 1]], ["--ease-emphasized", "View transitions, Σ", [0.3, 0, 0, 1]], ["--ease-spring", "Transform only, ~4% overshoot", null]]
  function renderMotion() {
    $("#dur-list").innerHTML = DURS.map(([n, ms, use]) => `<div class="dur-row"><div class="lbl"><code>${n}</code><small>${ms} · ${use}</small></div><div class="track" style="--d:var(${n})${n === "--dur-spring" ? ";--e:var(--ease-spring)" : ";--e:var(--ease-out)"}"><i></i></div></div>`).join("")
    $("#ease-list").innerHTML = EASES.map(([n, use, b]) => {
      let path
      if (b) path = `<path class="curve" d="M0 48 C ${b[0] * 64} ${48 - b[1] * 48} ${b[2] * 64} ${48 - b[3] * 48} 64 0"/>`
      else {
        const raw = cssVar("--ease-spring").replace(/^linear\(|\)$/g, "")
        const stops = raw.split(",").map((p) => p.trim().split(/\s+/))
        const pts = stops.map(([v, x], k) => [x ? parseFloat(x) / 100 : k / (stops.length - 1), parseFloat(v)])
        path = `<polyline class="curve" points="${pts.map(([x, y]) => `${(x * 64).toFixed(1)},${(48 - y * 48).toFixed(1)}`).join(" ")}"/>`
      }
      return `<div class="ease-row"><svg viewBox="0 0 64 48" aria-hidden="true"><path class="axis" d="M0 48 H64 M0 0 V48"/>${path}</svg><div class="lbl"><code>${n}</code><small>${use}</small></div><div class="track" style="--d:900ms;--e:var(${n})"><i></i></div></div>`
    }).join("")
    const MOMENTS = [
      ["stream", "Source trace", "Regenerate: a scan line reads the timeline, and each summary line lights the speaker lanes it came from as it lands. Hover any line later to see the same trace.", "--dur-scan 1.3s · --dur-trace 900ms · 55ms chunks"],
      ["cite", "Citation landing", "Click a timecode: the player seeks, the source quote opens in a peek, the transcript line flashes.", "160ms pop-in · --dur-flash 1.2s"],
      ["processing", "Lanes to Σ", "While a recording processes, the rail mark splits into speaker lanes. When the summary is ready the lanes rotate back into Σ and the row says New.", "--dur-sigma 760ms · emphasized"],
      ["record", "Live recording", "A spring dock with a pulsing dot, a blinking-colon timer and a live waveform that runs left to right in every language.", "--dur-spring 520ms · --dur-pulse 1.6s"],
      ["compact", "Compact player", "Scroll the summary and the speaker lanes slide into one, giving the reading column its height back. Scroll up and they fan out again.", "240ms ease-out"],
      ["follow", "Follow playback", "The speaking lane lifts and glows while the others dim. The transcript follows word by word; scroll away and a pill offers to take you back.", "smooth scroll · spring pill"],
      ["open", "Meeting open", "Opening a meeting morphs its inbox title into the page title with a view transition, so your eye keeps its place.", "--dur-4 240ms · emphasized"],
      ["check", "Task check-off", "The tick draws itself, then a strike-through sweeps in reading direction.", "160ms draw · 240ms strike"],
    ]
    $("#moments").innerHTML = MOMENTS.map(([k, h, p, s]) => `<div class="moment"><h4>${h}</h4><p>${p}</p><span class="spec-line">${s}</span><button type="button" class="btn btn-secondary btn-xs" data-moment="${k}">${icon("play")}Play</button></div>`).join("")
  }
  // Tracks ping-pong: each call sends every dot to the other end with its own
  // duration and easing, so the comparison between tokens stays visible.
  function replay(sel) { $$(sel + " .track").forEach((tr) => tr.classList.toggle("go")) }

  /* ---------------------------------------------------------- components */
  const BOT = [
    { k: "Scheduled", kind: "info", ic: "cal", sub: "Joins Legal sync at 11:00 from the calendar invite" },
    { k: "Joining", kind: "info", ic: "bot", sub: "Opening Google Meet as “MeetSum Notetaker”" },
    { k: "Waiting to be admitted", kind: "warn", ic: "alert", sub: "Ask the host to admit MeetSum Notetaker from the waiting room" },
    { k: "Recording", kind: "live", ic: "mic", sub: "Everyone sees the consent message in the meeting chat" },
    { k: "Processing", kind: "info", ic: "wave", sub: "Transcript in about 3 minutes" },
    { k: "Blocked", kind: "danger", ic: "x", sub: "The host removed the bot. Record from the desktop app instead.", at: 2 },
  ]
  let botIdx = 0
  function renderBot() {
    const s = BOT[botIdx]
    const cur = s.at ?? botIdx
    const colour = { info: "var(--info)", warn: "var(--warn)", live: "var(--live)", danger: "var(--danger)" }[s.kind]
    $("#bot-steps").innerHTML = BOT.slice(0, 5).map((b, k) => `<li class="${k < cur ? "done" : k === cur ? "cur" : ""}" style="${k === cur ? `--c:${colour}` : ""}">${k === cur ? s.k : b.k}</li>`).join("")
    const now = $("#bot-now")
    now.innerHTML = `<span class="toast-icon ${s.kind}">${s.kind === "live" ? '<span class="rec-dot"></span>' : icon(s.ic)}</span><div><b>${s.k}</b><small>${s.sub}</small></div>`
    now.classList.remove("pop"); void now.offsetWidth; now.classList.add("pop")
  }

  /* -------------------------------------------------------------- moments */
  async function moment(k) {
    if (k !== "theme") {
      app.scrollIntoView({ block: "center", behavior: reduced() ? "auto" : "smooth" })
      await sleep(reduced() ? 50 : 450)
    }
    switch (k) {
      case "play": selectRow("main"); play(); break
      case "cite": { selectRow("main"); setTab("summary"); const c = $("#s-decisions .cite"); if (c) { c.scrollIntoView({ block: "nearest" }); openPeek(c) } break }
      case "stream": selectRow("main"); setTab("summary"); regenerate(); break
      case "record": if (!state.rec) toggleRec(); break
      case "palette": openPalette(); break
      case "share": openShare(); break
      case "menu": openMenu(); break
      case "processing": simulateProcessing(t("boardPrep")); break
      case "theme": toggleTheme(); break
      case "open": openRow("ops"); await sleep(1500); openRow("main"); break
      case "compact": {
        selectRow("main"); setTab("summary")
        const p = $("#pane-summary")
        p.scrollTo({ top: 260, behavior: reduced() ? "auto" : "smooth" })
        await sleep(1600)
        p.scrollTo({ top: 0, behavior: reduced() ? "auto" : "smooth" })
        break
      }
      case "check": { selectRow("main"); setTab("summary"); const cb = $('#pane-summary input[data-act="a1"]'); if (cb) { cb.closest(".item").scrollIntoView({ block: "center" }); cb.click() } break }
      case "follow": {
        selectRow("main"); setTab("transcript"); setFollow(true)
        if (state.t < 2) seek(meet.segs[2].start)
        play()
        await sleep(1800)
        const pane = $("#pane-transcript")
        pane.scrollTo({ top: pane.scrollHeight, behavior: reduced() ? "auto" : "smooth" })
        setFollow(false)
        break
      }
    }
  }

  /* --------------------------------------------------------------- events */
  function bind() {
    $("#lang-en").addEventListener("click", () => setLang("en"))
    $("#lang-he").addEventListener("click", () => setLang("he"))
    $("#theme-toggle").addEventListener("click", (e) => toggleTheme(e.currentTarget))
    $("#motion-toggle").addEventListener("click", (e) => {
      const on = root.classList.toggle("rm")
      e.currentTarget.setAttribute("aria-pressed", String(on))
      store.set("cadence.rm", on ? "1" : "0")
    })
    document.addEventListener("click", (e) => {
      const b = e.target.closest("[data-moment]")
      if (b && !app.contains(b)) return moment(b.dataset.moment)
      const j = e.target.closest("[data-jump]")
      if (j) {
        app.scrollIntoView({ block: "center", behavior: reduced() ? "auto" : "smooth" })
        setTimeout(() => jumpTo(j.dataset.jump, Number(j.dataset.at)), reduced() ? 0 : 450)
      }
    })
    // The viewer can change data-theme from outside; contrast ratios follow it.
    new MutationObserver(afterTheme).observe(root, { attributes: true, attributeFilter: ["data-theme", "class"] })
    $("#replay-dur").addEventListener("click", () => replay("#dur-list"))
    $("#replay-ease").addEventListener("click", () => replay("#ease-list"))

    // player
    $("#p-play").addEventListener("click", () => (state.playing ? pause() : play()))
    $("#p-back").addEventListener("click", () => seek(state.t - 10))
    $("#p-fwd").addEventListener("click", () => seek(state.t + 10))
    $("#p-speed").addEventListener("click", (e) => {
      const opts = [1, 1.5, 2]
      state.speed = opts[(opts.indexOf(state.speed) + 1) % opts.length]
      e.currentTarget.textContent = state.speed + "×"
    })
    const hit = $("#tl-hit"), hov = $("#tl-hover")
    const secAt = (x) => { const r = hit.getBoundingClientRect(); return Math.max(0, Math.min(1, (x - r.left) / r.width)) * meet.dur }
    let drag = false
    hit.addEventListener("pointerdown", (e) => { drag = true; hit.setPointerCapture(e.pointerId); seek(secAt(e.clientX)) })
    hit.addEventListener("pointermove", (e) => {
      const s = secAt(e.clientX)
      const r = hit.getBoundingClientRect()
      hov.textContent = fmt(s)
      hov.style.transform = `translateX(calc(${e.clientX - r.left}px - 50%))`
      if (drag) seek(s)
    })
    hit.addEventListener("pointerup", () => { drag = false })
    hit.addEventListener("keydown", (e) => {
      const map = { ArrowRight: 5, ArrowLeft: -5, ArrowUp: 5, ArrowDown: -5, PageUp: 30, PageDown: -30 }
      if (e.key in map) { e.preventDefault(); seek(state.t + map[e.key]) }
      else if (e.key === "Home") { e.preventDefault(); seek(0) }
      else if (e.key === "End") { e.preventDefault(); seek(meet.dur) }
      else if (e.key === " " || e.key === "Enter") { e.preventDefault(); state.playing ? pause() : play() }
    })

    // tabs
    $$("#tabs [role=tab]").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)))
    $("#tabs").addEventListener("keydown", (e) => {
      const order = ["summary", "transcript", "ask"]
      let k = order.indexOf(state.tab)
      const fwd = app.dir === "rtl" ? "ArrowLeft" : "ArrowRight", back = app.dir === "rtl" ? "ArrowRight" : "ArrowLeft"
      if (e.key === fwd) k = (k + 1) % 3
      else if (e.key === back) k = (k + 2) % 3
      else if (e.key === "Home") k = 0
      else if (e.key === "End") k = 2
      else return
      e.preventDefault()
      setTab(order[k], { focus: true })
    })

    // panes: follow, compact player, peek
    const tp = $("#pane-transcript")
    const userScroll = () => { if (performance.now() > autoScrollUntil && state.follow) setFollow(false) }
    tp.addEventListener("wheel", userScroll, { passive: true })
    tp.addEventListener("touchmove", userScroll, { passive: true })
    tp.addEventListener("keydown", (e) => { if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(e.key)) userScroll() })
    $("#follow-pill").addEventListener("click", () => setFollow(true))
    $$(".pane").forEach((p) => p.addEventListener("scroll", () => { if (peekChip) closePeek(); syncCompact() }, { passive: true }))

    // source trace on hover/focus
    const ps = $("#pane-summary"), al = $("#ask-log")
    const traceFrom = (e) => {
      const c = e.target.closest(".cite")
      if (c) return trace([Number(c.dataset.cite)])
      const it = e.target.closest("[data-cites]")
      trace(it ? it.dataset.cites.split(",").map(Number) : null, it?.dataset.ref)
    }
    for (const el of [ps, al]) {
      el.addEventListener("pointerover", traceFrom)
      el.addEventListener("focusin", traceFrom)
      el.addEventListener("pointerleave", () => { if (!peekChip) trace(null) })
    }

    // delegated app clicks
    app.addEventListener("click", (e) => {
      const el = e.target
      let b
      if ((b = el.closest("[data-moment]"))) return moment(b.dataset.moment)
      if ((b = el.closest("[data-cite]"))) { e.stopPropagation(); return openPeek(b) }
      if ((b = el.closest("[data-peek-close]"))) return closePeek()
      if ((b = el.closest("[data-peek-play]"))) { seek(meet.segs[+b.dataset.peekPlay].start); play(); return closePeek() }
      if ((b = el.closest("[data-peek-open]"))) { const i = +b.dataset.peekOpen; closePeek(); setTab("transcript"); seek(meet.segs[i].start, { flash: true }); setFollow(true); return }
      if ((b = el.closest("[data-seek]"))) { const i = +b.dataset.seek; seek(meet.segs[i].start, { flash: true }); if (state.tab === "transcript") setFollow(true); return }
      if ((b = el.closest(".tseg .w"))) {
        const seg = meet.segs[+b.closest(".tseg").dataset.seg]
        seek(seg.start + (+b.dataset.w / seg.words.length) * (seg.end - seg.start))
        return
      }
      if ((b = el.closest("[data-row]"))) return openRow(b.dataset.row)
      if ((b = el.closest("[data-open-main]"))) return openRow("main")
      if ((b = el.closest("[data-sugg]"))) return ask(ANSWERS[L()][+b.dataset.sugg].q)
      if ((b = el.closest("[data-flag]"))) {
        const ref = b.dataset.flag
        const on = b.getAttribute("aria-pressed") !== "true"
        b.setAttribute("aria-pressed", String(on))
        if (ref !== "ans") { on ? state.flagged.add(ref) : state.flagged.delete(ref); b.closest(".item")?.classList.toggle("flagged", on) }
        if (on) toast({ kind: "warn", title: t("toast.flag"), sub: t("toast.flagSub"), ms: 2800 })
        return
      }
      if ((b = el.closest("[data-copy-ans]"))) {
        const txt = b.closest(".msg-a").querySelector(".body").textContent
        navigator.clipboard?.writeText(txt).then(() => toast({ title: t("toast.ansCopied") }), () => toast({ kind: "info", title: t("toast.copyFail") })) ?? toast({ kind: "info", title: t("toast.copyFail") })
        return
      }
      if ((b = el.closest("#regen"))) return regenerate()
      if ((b = el.closest("#copy-sum"))) {
        const txt = [meet.sum.overview, ...meet.sum.actions.map((a) => `• ${a.t} (${spkName(a.owner)}, ${a.due})`), ...meet.sum.decisions.map((d) => "• " + d.t)].join("\n")
        navigator.clipboard?.writeText(txt).then(() => toast({ title: t("toast.copied") }), () => toast({ kind: "info", title: t("toast.copyFail") })) ?? toast({ kind: "info", title: t("toast.copyFail") })
        return
      }
      if ((b = el.closest("#edit-ov"))) {
        const ov = $("#ov")
        if (!ov.isContentEditable) {
          ov.dataset.before = ov.textContent
          ov.contentEditable = "true"
          ov.focus()
          b.setAttribute("aria-label", t("done")); b.title = t("done")
          b.setAttribute("aria-pressed", "true")
        } else commitEdit()
        return
      }
      if ((b = el.closest("[data-menu]"))) return runMenu(b.dataset.menu)
      if ((b = el.closest("[data-close-dlg]"))) return closeShare()
      if (el.id === "share-dlg") return closeShare()
      if (peekChip && !el.closest("#peek")) closePeek()
      if (!$("#more-menu").hidden && !el.closest("#more-menu") && !el.closest("#more-btn")) closeMenu()
      if (app.classList.contains("inbox-open") && !el.closest("#inbox") && !el.closest("#inbox-toggle")) { app.classList.remove("inbox-open"); $("#inbox-toggle").setAttribute("aria-expanded", "false") }
    })
    function commitEdit() {
      const ov = $("#ov")
      if (!ov || !ov.isContentEditable) return
      ov.contentEditable = "false"
      const btn = $("#edit-ov")
      if (btn) { btn.setAttribute("aria-label", t("edit")); btn.title = t("edit"); btn.setAttribute("aria-pressed", "false") }
      const txt = ov.textContent.trim()
      if (txt && txt !== ov.dataset.before) {
        state.edited[L()] = txt
        ov.classList.add("is-human")
        $("#ov-prov").outerHTML = provLineHTML()
      }
    }
    app.addEventListener("focusout", (e) => { if (e.target.id === "ov" && !e.relatedTarget?.closest?.("#edit-ov")) commitEdit() })
    app.addEventListener("keydown", (e) => {
      if (e.target.id === "ov" && e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitEdit() }
      if (e.key === "F2" && !e.target.isContentEditable && !/input|textarea/i.test(e.target.tagName)) { e.preventDefault(); renameTitle() }
    })

    app.addEventListener("change", (e) => {
      const cb = e.target.closest("[data-act]")
      if (cb) {
        const id = cb.dataset.act
        cb.checked ? state.done.add(id) : state.done.delete(id)
        cb.closest(".item").classList.toggle("done", cb.checked)
        const c = $("[data-act-count]")
        if (c) c.textContent = actCount()
        renderTasks()
        return
      }
      if (e.target.name === "access" || e.target.id === "sh-transcript") updateShareHint()
    })

    // menu keyboard
    $("#more-btn").addEventListener("click", (e) => { e.stopPropagation(); $("#more-menu").hidden ? openMenu() : closeMenu() })
    $("#more-menu").addEventListener("keydown", (e) => {
      const items = $$("[role=menuitem]", $("#more-menu"))
      let k = items.indexOf(document.activeElement)
      if (e.key === "ArrowDown") k = (k + 1) % items.length
      else if (e.key === "ArrowUp") k = (k - 1 + items.length) % items.length
      else if (e.key === "Home") k = 0
      else if (e.key === "End") k = items.length - 1
      else if (e.key === "Escape") { e.preventDefault(); return closeMenu(true) }
      else if (e.key === "Tab") return closeMenu()
      else return
      e.preventDefault()
      items[k].focus()
    })

    // dialog
    $("#share-btn").addEventListener("click", openShare)
    $("#share-dlg").addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); closeShare() } else trapFocus(e, $("#share-dlg .dlg")) })
    $("#sh-copy").addEventListener("click", () => {
      const done = () => toast({ title: t("toast.share"), sub: t("toast.shareSub") })
      navigator.clipboard?.writeText($("#sh-url").value).then(done, () => { $("#sh-url").select(); toast({ kind: "info", title: t("toast.copyFail") }) }) ?? done()
    })

    $("#inbox-toggle").addEventListener("click", (e) => {
      e.stopPropagation()
      const open = app.classList.toggle("inbox-open")
      e.currentTarget.setAttribute("aria-expanded", String(open))
    })
    $("#sim-upload").addEventListener("click", () => simulateProcessing(t("boardPrep")))
    $("#rec-btn").addEventListener("click", toggleRec)
    $("#rec-stop").addEventListener("click", stopRec)
    $("#scope-all").addEventListener("click", () => toast({ kind: "info", title: t("ask.all") }))
    $("#ask-form").addEventListener("submit", (e) => {
      e.preventDefault()
      if (state.ask) { state.ask.cancelled = true; return }
      ask($("#ask-input").value)
    })

    // palette
    $("#open-palette").addEventListener("click", openPalette)
    $("#palette-input").addEventListener("input", () => { palIdx = 0; renderPalette() })
    $("#palette-input").addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); palIdx = Math.min(palItems.length - 1, palIdx + 1); renderPalette(); $(`#po-${palIdx}`)?.scrollIntoView({ block: "nearest" }) }
      else if (e.key === "ArrowUp") { e.preventDefault(); palIdx = Math.max(0, palIdx - 1); renderPalette(); $(`#po-${palIdx}`)?.scrollIntoView({ block: "nearest" }) }
      else if (e.key === "Enter") { e.preventDefault(); runPalette(palItems.length ? palIdx : -1) }
      else if (e.key === "Escape") { e.preventDefault(); closePalette() }
    })
    $("#palette-list").addEventListener("click", (e) => { const b = e.target.closest("[data-po]"); if (b) runPalette(+b.dataset.po) })
    $("#palette-list").addEventListener("mousemove", (e) => { const b = e.target.closest("[data-po]"); if (b && +b.dataset.po !== palIdx) { palIdx = +b.dataset.po; $$("#palette-list .po").forEach((x) => x.setAttribute("aria-selected", String(+x.dataset.po === palIdx))) } })
    $("#palette").addEventListener("click", (e) => { if (e.target.id === "palette") closePalette() })
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); $("#palette").hidden ? openPalette() : closePalette() }
      else if (e.key === "Escape") { if (peekChip) closePeek() }
    })

    // components section
    $("#sr-sugg").addEventListener("click", (e) => {
      const b = e.target.closest("[data-assign]")
      if (!b) return
      const [name, ini] = b.dataset.assign.split("|")
      const av = $("#sr-avatar")
      av.textContent = ini
      av.classList.remove("speaker-unconfirmed-av", "pop"); void av.offsetWidth; av.classList.add("pop")
      $("#sr-name").textContent = name
      const st = $("#sr-state"); st.textContent = "confirmed"; st.className = "conf"
      $("#sr-sugg").innerHTML = `<span class="spec-note">Remembered for this workspace.</span><button type="button" class="btn btn-ghost btn-xs" data-unassign>Undo</button>`
    })
    $("#spk-review").addEventListener("click", (e) => {
      if (!e.target.closest("[data-unassign]")) return
      const av = $("#sr-avatar"); av.textContent = "?"; av.classList.add("speaker-unconfirmed-av")
      $("#sr-name").textContent = "Speaker 3"
      const st = $("#sr-state"); st.textContent = "unconfirmed"; st.className = "unconf"
      $("#sr-sugg").innerHTML = `<button type="button" class="chip" data-assign="Noa Levi|NL">Noa Levi</button><button type="button" class="chip" data-assign="Daniel Cohen|DC">Daniel Cohen</button><button type="button" class="chip" data-assign="Omer Katz|OK">Omer Katz</button><button type="button" class="btn btn-ghost btn-xs">${icon("merge")}Merge with…</button>`
    })
    $("#bot-next").addEventListener("click", () => { botIdx = (botIdx + 1) % BOT.length; renderBot() })
    const drop = $("#drop")
    const takeFile = (f) => {
      if (!f) return
      app.scrollIntoView({ block: "center", behavior: reduced() ? "auto" : "smooth" })
      setTimeout(() => simulateProcessing(f.name), reduced() ? 0 : 400)
    }
    ;["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over") }))
    ;["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove("over")))
    drop.addEventListener("drop", (e) => { e.preventDefault(); takeFile(e.dataTransfer?.files?.[0]) })
    $("#drop-input").addEventListener("change", (e) => { takeFile(e.target.files?.[0]); e.target.value = "" })

    // live row timer
    setInterval(() => { $$("[data-live-dur]").forEach((el) => { el.textContent = fmt(liveElapsed()) }) }, 1000)
    addEventListener("resize", () => { moveInk(); setTime(state.t); fitChapters() })
    matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", afterTheme)

    if ("IntersectionObserver" in window) {
      // motion tracks ping-pong while visible
      let loop = 0
      const io = new IntersectionObserver((ents) => {
        clearInterval(loop)
        if (!ents.some((x) => x.isIntersecting)) return
        const run = () => { replay("#dur-list"); replay("#ease-list") }
        run()
        if (!reduced()) loop = setInterval(run, 2600)
      }, { threshold: 0.2 })
      io.observe($(".motion-grid"))
      // empty-state mark breathes between lanes and Σ while visible
      let sLoop = 0
      const es = $("#empty-sigma")
      new IntersectionObserver((ents) => {
        clearInterval(sLoop)
        if (!ents.some((x) => x.isIntersecting) || reduced()) { es.classList.remove("lanes"); return }
        es.classList.toggle("lanes")
        sLoop = setInterval(() => es.classList.toggle("lanes"), 2200)
      }, { threshold: 0.4 }).observe(es)
    } else $("#empty-sigma").classList.remove("lanes")
  }

  /* ----------------------------------------------------------------- boot */
  const savedTheme = store.get("cadence.theme")
  if (savedTheme === "dark" || savedTheme === "light") root.dataset.theme = savedTheme
  if (store.get("cadence.rm") === "1") { root.classList.add("rm"); $("#motion-toggle").setAttribute("aria-pressed", "true") }
  buildMeeting()
  applyI18n()
  renderInbox()
  renderHeader()
  renderTimeline(false)
  renderSummary()
  renderTranscript()
  renderAskEmpty()
  renderFoundations()
  renderTasks()
  renderMotion()
  renderBot()
  bind()
  setTab("summary")
  setTime(meet.segs[2].start + 1.2)
  // The brand mark arrives as four speaker lanes and sums into Σ.
  setTimeout(() => $("#brand-sigma").classList.remove("lanes"), reduced() ? 0 : 450)
  if (document.fonts?.ready) document.fonts.ready.then(() => { moveInk(); setTime(state.t); fitChapters() })
})()
