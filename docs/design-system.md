# MeetSum Design System

MeetSum uses a compact operational SaaS interface rather than a marketing-first layout. The first screen is the product: navigation, command/search, meeting inbox, selected meeting detail, and an intelligence/integration rail.

## Palette

- Background: warm white in light mode, deep neutral in dark mode.
- Text: high-contrast neutral.
- Primary: restrained teal for the main product action and active state.
- Secondary/info: soft blue for system context.
- Highlight/action: amber for attention without alarm.
- Success: green.
- Destructive: red.
- AI accent: violet, used only for intelligence and model states.

## Typography

- Latin UI: Inter.
- Hebrew UI: Noto Sans Hebrew.
- Code, IDs, timestamps: Geist Mono.
- Hebrew is the only RTL locale for day one.

## Layout

- Left navigation remains fixed in desktop layouts.
- The top bar contains command/search, language switching, recording, upload, and agent actions.
- The center column is optimized for reading summary, transcript, and Q&A.
- The right rail holds pipeline status, tags, action items, Google scope visibility, and integration readiness.
- Cards are used only for repeated meeting/task objects and framed tools.

## Component Inventory

- `AppShell`
- `LanguageSwitcher`
- `MeetingList`
- `MeetingDetail`
- `MeetingIntelligencePanel`
- `StatusBadge`
- `TagList`
- `ActionItemList`
