/**
 * Built-in summary templates (A6): seven M5 templates plus the legacy keys
 * (`real-estate`, `product`, `operations`, `legal`) re-expressed as sections.
 * Reserved section keys (see `RESERVED_SECTION_KEYS`) are filled from the core
 * summary fields; the others are written by the model.
 *
 * The English addenda of the legacy keys are kept verbatim (the
 * `summary-templates.ts` shim still serves them).
 */
import type {
  BuiltInTemplateKey,
  LocalizedText,
  SectionKind,
  SectionSpec,
  SummaryTemplateDef,
} from "@/lib/ai/templates/types"

function section(
  key: string,
  title: LocalizedText,
  kind: SectionKind,
  instructions: LocalizedText,
  options: { maxItems?: number; required?: boolean } = {}
): SectionSpec {
  return {
    key,
    title,
    kind,
    instructions: instructions.en,
    localizedInstructions: instructions,
    ...(options.maxItems ? { maxItems: options.maxItems } : {}),
    required: options.required ?? false,
  }
}

const OVERVIEW = section(
  "overview",
  { he: "תקציר", en: "Overview" },
  "paragraph",
  { he: "תקציר קצר של הפגישה.", en: "A short overview of the meeting." },
  { required: true }
)
const EXECUTIVE_SUMMARY = section(
  "overview",
  { he: "תקציר מנהלים", en: "Executive summary" },
  "paragraph",
  { he: "תקציר מנהלים של 3–5 משפטים.", en: "A 3–5 sentence executive summary." },
  { required: true }
)
const DECISIONS = section(
  "decisions",
  { he: "החלטות", en: "Decisions" },
  "bullets",
  { he: "החלטות שהתקבלו בפגישה.", en: "Decisions made in the meeting." }
)
const ACTION_ITEMS = section(
  "action_items",
  { he: "משימות", en: "Action items" },
  "bullets",
  { he: "משימות עם אחראי ותאריך יעד.", en: "Tasks with owner and due date." }
)
const OPEN_QUESTIONS = section(
  "open_questions",
  { he: "נקודות פתוחות", en: "Open questions" },
  "bullets",
  { he: "שאלות ונושאים שנשארו פתוחים.", en: "Questions and topics left open." }
)
const RISKS = section(
  "risks",
  { he: "סיכונים", en: "Risks" },
  "bullets",
  { he: "סיכונים וחסמים שעלו.", en: "Risks and blockers raised." }
)
const NEXT_STEPS = section(
  "next_steps",
  { he: "צעדים הבאים", en: "Next steps" },
  "bullets",
  { he: "הצעדים הבאים שסוכמו.", en: "Agreed next steps." }
)

function bullets(
  key: string,
  title: LocalizedText,
  instructions: LocalizedText,
  maxItems = 8
): SectionSpec {
  return section(key, title, "bullets", instructions, { maxItems })
}

const LEGACY_ADDENDA_EN: Record<"sales" | "real-estate" | "product" | "operations" | "legal", string> = {
  sales: [
    "This is a sales call. Pay special attention to:",
    "- Lead qualification signals (budget, authority, need, timeline)",
    "- Objections raised and responses given",
    "- Next steps and follow-up commitments",
    "- Pricing discussed or quoted",
    "- Competitor mentions",
    "- Deal stage progression or regression signals",
    "Structure action items as sales follow-ups with clear owners and deadlines.",
  ].join("\n"),
  "real-estate": [
    "This is a real estate meeting. Pay special attention to:",
    "- Property details (address, price, size, condition)",
    "- Client requirements and preferences",
    "- Financial terms (mortgage, commission, closing costs)",
    "- Legal obligations and deadlines (inspection, closing date)",
    "- Regulatory or zoning considerations",
    "- Counterparty positions and negotiation points",
    "Preserve all monetary amounts, dates, and property identifiers exactly.",
  ].join("\n"),
  product: [
    "This is a product review or planning meeting. Pay special attention to:",
    "- Feature decisions and priorities",
    "- Technical architecture or design decisions",
    "- Sprint/milestone commitments",
    "- Bug reports or quality issues discussed",
    "- User feedback referenced",
    "- Dependencies and blockers identified",
    "Structure action items as development tasks with assignees.",
  ].join("\n"),
  operations: [
    "This is an operations or planning meeting. Pay special attention to:",
    "- Process improvements discussed",
    "- Resource allocation decisions",
    "- Timeline and milestone adjustments",
    "- Risk identification and mitigation plans",
    "- Budget or cost discussions",
    "- Cross-team dependencies",
    "Structure action items as operational tasks with clear deadlines.",
  ].join("\n"),
  legal: [
    "This is a legal or compliance meeting. Pay special attention to:",
    "- Regulatory requirements discussed",
    "- Contract terms and conditions",
    "- Compliance deadlines and obligations",
    "- Risk assessments and liability considerations",
    "- Document review status",
    "- Approval or sign-off requirements",
    "Preserve all legal terms, dates, and party names exactly. Flag any uncertainty clearly.",
  ].join("\n"),
}

function template(
  key: BuiltInTemplateKey,
  name: LocalizedText,
  description: LocalizedText,
  promptAddendum: LocalizedText,
  sections: SectionSpec[],
  language?: string
): SummaryTemplateDef {
  return {
    key,
    builtIn: true,
    name,
    description,
    promptAddendum,
    sections,
    ...(language ? { language } : {}),
  }
}

export const BUILT_IN_TEMPLATES: Readonly<Record<BuiltInTemplateKey, SummaryTemplateDef>> = {
  general: template(
    "general",
    { he: "פגישה כללית", en: "General Meeting" },
    { he: "סיכום כללי לכל סוג פגישה.", en: "A general summary for any meeting." },
    { he: "", en: "" },
    [
      OVERVIEW,
      bullets(
        "key_points",
        { he: "נקודות עיקריות", en: "Key points" },
        { he: "הנקודות העיקריות שנדונו.", en: "The main points discussed." }
      ),
      DECISIONS,
      ACTION_ITEMS,
      OPEN_QUESTIONS,
      NEXT_STEPS,
    ]
  ),
  sales: template(
    "sales",
    { he: "שיחת מכירה", en: "Sales Call" },
    { he: "צרכי לקוח, התנגדויות, תמחור וצעדים הבאים.", en: "Customer needs, objections, pricing and next steps." },
    {
      he: "זו שיחת מכירה. יש לשים לב לסימני הכשרת ליד (תקציב, סמכות, צורך, לוח זמנים), להתנגדויות ולתשובות, לתמחור שהוזכר, למתחרים ולסימנים להתקדמות או לנסיגה בעסקה.",
      en: LEGACY_ADDENDA_EN.sales,
    },
    [
      OVERVIEW,
      bullets(
        "customer_needs",
        { he: "צרכי הלקוח", en: "Customer needs" },
        { he: "הצרכים והכאבים שהלקוח תיאר.", en: "Needs and pain points the customer described." }
      ),
      section(
        "objections",
        { he: "התנגדויות ותשובות", en: "Objections and responses" },
        "qa",
        {
          he: "כל פריט: \"התנגדות — התשובה שניתנה\".",
          en: "Each item: \"objection — response given\".",
        },
        { maxItems: 8 }
      ),
      bullets(
        "pricing",
        { he: "תמחור", en: "Pricing" },
        { he: "מחירים, הצעות והנחות שהוזכרו, בדיוק כפי שנאמרו.", en: "Prices, quotes and discounts mentioned, exactly as stated." }
      ),
      bullets(
        "competitors",
        { he: "מתחרים", en: "Competitors" },
        { he: "מתחרים שהוזכרו ובאיזה הקשר.", en: "Competitors mentioned and in what context." },
        5
      ),
      section(
        "qualification",
        { he: "הכשרת ליד", en: "Qualification" },
        "scorecard",
        {
          he: "פריט לכל אחד: תקציב, סמכות, צורך, לוח זמנים — \"קריטריון: ממצא\".",
          en: "One item each for budget, authority, need, timeline — \"criterion: finding\".",
        },
        { maxItems: 4 }
      ),
      NEXT_STEPS,
      ACTION_ITEMS,
    ]
  ),
  standup: template(
    "standup",
    { he: "סטנדאפ", en: "Stand-up" },
    { he: "עדכונים לפי משתתף וחסמים.", en: "Per-person updates and blockers." },
    {
      he: "זו פגישת סטנדאפ. יש לסכם בקצרה מה כל משתתף עשה, מה מתוכנן וחסמים.",
      en: "This is a stand-up. Briefly summarize what each person did, what is planned, and blockers.",
    },
    [
      section(
        "updates",
        { he: "עדכונים", en: "Updates" },
        "table",
        {
          he: "פריט לכל משתתף: \"שם: מה נעשה; מה מתוכנן\".",
          en: "One item per person: \"name: done; planned\".",
        },
        { maxItems: 12, required: true }
      ),
      bullets(
        "blockers",
        { he: "חסמים", en: "Blockers" },
        { he: "חסמים ומי צריך לעזור.", en: "Blockers and who needs to help." }
      ),
      ACTION_ITEMS,
    ]
  ),
  one_on_one: template(
    "one_on_one",
    { he: "שיחת 1:1", en: "One-on-one" },
    { he: "הצלחות, קשיים, משוב וצמיחה.", en: "Wins, concerns, feedback and growth." },
    {
      he: "זו שיחת 1:1. יש לנסח בעדינות ובלשון ניטרלית, ולהתמקד בהצלחות, בקשיים, במשוב ובמטרות.",
      en: "This is a one-on-one. Be tactful and focus on wins, concerns, feedback and goals.",
    },
    [
      OVERVIEW,
      bullets("wins", { he: "הצלחות", en: "Wins" }, { he: "הישגים והצלחות.", en: "Achievements and wins." }, 6),
      bullets(
        "concerns",
        { he: "קשיים", en: "Concerns" },
        { he: "קשיים ודאגות שעלו.", en: "Difficulties and concerns raised." },
        6
      ),
      bullets("feedback", { he: "משוב", en: "Feedback" }, { he: "משוב שניתן בשני הכיוונים.", en: "Feedback given in either direction." }, 6),
      bullets("growth", { he: "צמיחה ומטרות", en: "Growth and goals" }, { he: "מטרות והתפתחות.", en: "Goals and development." }, 6),
      ACTION_ITEMS,
    ]
  ),
  interview: template(
    "interview",
    { he: "ראיון", en: "Interview" },
    { he: "סיכום מועמד/ת, חוזקות, חששות והערכה.", en: "Candidate summary, strengths, concerns and assessment." },
    {
      he: "זה ראיון עבודה. יש להיצמד לעובדות שנאמרו, בלי הערכות אישיות שלא נשמעו בפגישה.",
      en: "This is a job interview. Stick to what was said; no personal judgments that were not voiced.",
    },
    [
      section(
        "candidate_summary",
        { he: "סיכום המועמד/ת", en: "Candidate summary" },
        "paragraph",
        { he: "רקע וניסיון כפי שעלו בראיון.", en: "Background and experience as discussed." },
        { required: true }
      ),
      bullets("strengths", { he: "חוזקות", en: "Strengths" }, { he: "חוזקות שעלו.", en: "Strengths that came up." }, 6),
      bullets("concerns", { he: "חששות", en: "Concerns" }, { he: "חששות או פערים שעלו.", en: "Concerns or gaps raised." }, 6),
      section(
        "questions",
        { he: "שאלות ותשובות", en: "Questions and answers" },
        "qa",
        { he: "כל פריט: \"שאלה — תמצית התשובה\".", en: "Each item: \"question — answer summary\"." },
        { maxItems: 10 }
      ),
      section(
        "assessment",
        { he: "הערכה", en: "Assessment" },
        "scorecard",
        {
          he: "\"קריטריון: ממצא\" רק לפי מה שנאמר בראיון.",
          en: "\"criterion: finding\" based only on what was said.",
        },
        { maxItems: 6 }
      ),
      NEXT_STEPS,
    ]
  ),
  board_investor: template(
    "board_investor",
    { he: "דירקטוריון / משקיעים", en: "Board / investor" },
    { he: "מדדים, כספים, החלטות אסטרטגיות ובקשות.", en: "KPIs, financials, strategic decisions and asks." },
    {
      he: "זו ישיבת דירקטוריון או משקיעים. יש לשמור על כל מספר, סכום ותאריך בדיוק.",
      en: "This is a board or investor meeting. Preserve every number, amount and date exactly.",
    },
    [
      EXECUTIVE_SUMMARY,
      section(
        "kpis",
        { he: "מדדים", en: "KPIs" },
        "table",
        { he: "פריט לכל מדד: \"מדד: ערך\".", en: "One item per metric: \"metric: value\"." },
        { maxItems: 12 }
      ),
      bullets(
        "financials",
        { he: "כספים", en: "Financials" },
        { he: "הכנסות, הוצאות, מזומנים וגיוס כפי שהוצגו.", en: "Revenue, burn, cash and fundraising as presented." }
      ),
      DECISIONS,
      RISKS,
      bullets("asks", { he: "בקשות", en: "Asks" }, { he: "בקשות מהדירקטוריון או מהמשקיעים.", en: "Asks of the board or investors." }, 6),
      ACTION_ITEMS,
    ]
  ),
  hebrew_business: template(
    "hebrew_business",
    { he: "פגישה עסקית", en: "Hebrew business" },
    { he: "סיכום עסקי מלא בעברית.", en: "A complete Hebrew business summary." },
    {
      he: "זו פגישה עסקית. יש לכתוב סיכום עסקי מלא וענייני.",
      en: "This is a business meeting. Write a complete, factual business summary.",
    },
    [
      EXECUTIVE_SUMMARY,
      DECISIONS,
      ACTION_ITEMS,
      OPEN_QUESTIONS,
      RISKS,
      NEXT_STEPS,
      bullets(
        "numbers_dates",
        { he: "מספרים ותאריכים שהוזכרו", en: "Numbers and dates mentioned" },
        {
          he: "כל סכום, אחוז, כמות ותאריך שהוזכרו, עם ההקשר, בדיוק כפי שנאמרו.",
          en: "Every amount, percentage, quantity and date mentioned, with context, exactly as stated.",
        },
        12
      ),
    ],
    "he"
  ),
  "real-estate": template(
    "real-estate",
    { he: "נדל״ן", en: "Real Estate" },
    { he: "פרטי נכס, תנאים כספיים ומועדים.", en: "Property details, financial terms and deadlines." },
    {
      he: "זו פגישת נדל״ן. יש לשמור בדיוק על כל סכום, תאריך ומזהה נכס.",
      en: LEGACY_ADDENDA_EN["real-estate"],
    },
    [
      OVERVIEW,
      bullets("property_details", { he: "פרטי הנכס", en: "Property details" }, { he: "כתובת, מחיר, גודל ומצב.", en: "Address, price, size and condition." }),
      bullets("client_requirements", { he: "דרישות הלקוח", en: "Client requirements" }, { he: "דרישות והעדפות.", en: "Requirements and preferences." }),
      bullets("financial_terms", { he: "תנאים כספיים", en: "Financial terms" }, { he: "משכנתא, עמלות ועלויות סגירה.", en: "Mortgage, commission and closing costs." }),
      bullets("deadlines", { he: "מועדים", en: "Deadlines" }, { he: "מועדים משפטיים ותפעוליים.", en: "Legal and operational deadlines." }),
      RISKS,
      ACTION_ITEMS,
    ]
  ),
  product: template(
    "product",
    { he: "סקירת מוצר", en: "Product Review" },
    { he: "החלטות פיצ׳רים, ארכיטקטורה וחסמים.", en: "Feature decisions, architecture and blockers." },
    {
      he: "זו פגישת מוצר. יש להתמקד בהחלטות פיצ׳רים, בהחלטות טכניות, בהתחייבויות ספרינט ובחסמים.",
      en: LEGACY_ADDENDA_EN.product,
    },
    [
      OVERVIEW,
      DECISIONS,
      bullets("technical_decisions", { he: "החלטות טכניות", en: "Technical decisions" }, { he: "ארכיטקטורה ועיצוב.", en: "Architecture and design." }),
      bullets("user_feedback", { he: "משוב משתמשים", en: "User feedback" }, { he: "משוב משתמשים שהוזכר.", en: "User feedback referenced." }),
      bullets("blockers", { he: "תלויות וחסמים", en: "Dependencies and blockers" }, { he: "תלויות וחסמים.", en: "Dependencies and blockers." }),
      ACTION_ITEMS,
    ]
  ),
  operations: template(
    "operations",
    { he: "תפעול ותכנון", en: "Operations & Planning" },
    { he: "תהליכים, משאבים ולוחות זמנים.", en: "Processes, resources and timelines." },
    {
      he: "זו פגישת תפעול ותכנון. יש להתמקד בשיפורי תהליכים, בהקצאת משאבים ובשינויי לוחות זמנים.",
      en: LEGACY_ADDENDA_EN.operations,
    },
    [
      OVERVIEW,
      bullets("process_changes", { he: "שינויי תהליכים", en: "Process changes" }, { he: "שיפורי תהליכים שנדונו.", en: "Process improvements discussed." }),
      bullets("resources", { he: "משאבים ותקציב", en: "Resources and budget" }, { he: "הקצאת משאבים ועלויות.", en: "Resource allocation and costs." }),
      bullets("timeline", { he: "לוח זמנים", en: "Timeline" }, { he: "אבני דרך ושינויים בלוח הזמנים.", en: "Milestones and timeline changes." }),
      RISKS,
      ACTION_ITEMS,
    ]
  ),
  legal: template(
    "legal",
    { he: "משפטי ורגולציה", en: "Legal & Compliance" },
    { he: "דרישות רגולציה, תנאי חוזה ומועדים.", en: "Regulatory requirements, contract terms and deadlines." },
    {
      he: "זו פגישה משפטית. יש לשמור בדיוק על מונחים משפטיים, תאריכים ושמות צדדים, ולסמן כל אי-ודאות.",
      en: LEGACY_ADDENDA_EN.legal,
    },
    [
      OVERVIEW,
      bullets("regulatory", { he: "דרישות רגולציה", en: "Regulatory requirements" }, { he: "דרישות רגולציה שנדונו.", en: "Regulatory requirements discussed." }),
      bullets("contract_terms", { he: "תנאי חוזה", en: "Contract terms" }, { he: "תנאים והתחייבויות.", en: "Terms and obligations." }),
      bullets("deadlines", { he: "מועדים", en: "Deadlines" }, { he: "מועדי ציות והתחייבויות.", en: "Compliance deadlines and obligations." }),
      bullets("approvals", { he: "אישורים נדרשים", en: "Approvals" }, { he: "אישורים וחתימות נדרשים.", en: "Approvals and sign-offs required." }),
      RISKS,
      ACTION_ITEMS,
    ]
  ),
}

/** Classified meeting types (title/tags/type task). */
export const MEETING_TYPES = [
  "general",
  "sales",
  "standup",
  "one_on_one",
  "interview",
  "board_investor",
  "real_estate",
  "product",
  "operations",
  "legal",
  "other",
] as const

export type MeetingType = (typeof MEETING_TYPES)[number]

const MEETING_TYPE_TEMPLATES: Partial<Record<MeetingType, BuiltInTemplateKey>> = {
  sales: "sales",
  standup: "standup",
  one_on_one: "one_on_one",
  interview: "interview",
  board_investor: "board_investor",
  real_estate: "real-estate",
  product: "product",
  operations: "operations",
  legal: "legal",
}

/**
 * Built-in template for a classified meeting type (`auto`). Hebrew meetings
 * with no specific match use `hebrew_business`; others use `general`.
 */
export function templateForMeetingType(
  meetingType: string | undefined,
  language: string
): BuiltInTemplateKey {
  const match = meetingType ? MEETING_TYPE_TEMPLATES[meetingType as MeetingType] : undefined

  if (match) return match
  return language === "he" ? "hebrew_business" : "general"
}
