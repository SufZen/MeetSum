# MeetSum Cadence: design system v2.0

Cadence is MeetSum's design language: Hebrew-first, citation-first, calm until something matters. It replaces `docs/design-system.md` (v1) and the token block in `app/globals.css`.

The live showcase (`design-system/showcase/index.html`) includes a working prototype of the meeting workspace in English and Hebrew, light and dark. Build it with `node design-system/showcase/build.mjs --preview` and open `public/ds/index.html`.

| File | What it is |
|---|---|
| `tokens.css` | **Source of truth.** Colour, type, space, radius, elevation, layers, icon sizes and motion tokens, plus Hebrew `:lang(he)` overrides, shadcn aliases, Tailwind v4 `@theme` registration and keyframes. Drop-in for `app/globals.css`. |
| `motion.ts` | Motion constants for JS-driven animation (WAAPI, scroll, canvas, optional `motion` library) and reduced-motion helpers. |
| `reference/meeting-atoms.tsx` | Reference React components: `CitedMark`, `TimecodeChip`, `CitationChip`, `SpeakerAvatar`, `SpeakerLabel`, `AvatarStack`, `LiveDot`, `StatusPill`, `AiProvenance`, `provenanceGradient`. They typecheck against the repo and pass the guardrails. |
| `check.mjs` | Guardrail scanner: physical direction, raw palette, bracketed colours/`var()`, arbitrary px/rem, hex literals. Becomes the CI gate. |
| `showcase/` | Interactive showcase. `tokens.generated.css` is built from `tokens.css`, so the showcase can't drift from production. |

How it was made: competitor and design-system research, an audit of the current UI, then six build → screenshot → critique rounds. Each round was captured in en/he × light/dark × desktop/mobile with `agent-browser`. Independent reviews scored round 2 at 6.5, round 4 at 7.6 and round 5 at 8.4, and round 6 fixed everything the last review listed. The behaviour suite (scrubber keys, tabs, palette, menu, dialog focus, live regions, Hebrew aria labels, source trace) passes.

---

## 1. Principles

1. **Hebrew first, not Hebrew too.** Design every screen in RTL with code-switched Hebrew and English, then check LTR. A component isn't done until its Hebrew screenshot is.
2. **Every AI claim has a source.** Summary lines, decisions, actions and answers carry a timecode that plays the moment. Hover any line and its source lanes light up on the timeline. If a citation can't resolve to a real segment, it isn't rendered.
3. **The AI mark is a citation.** Model-written text carries the cited mark (a play head inside brackets) and a hairline split into the colours of the speakers it came from. When a person edits it, it becomes theirs, loses both, and survives reprocessing. Iris (`--ai`) is used for nothing else.
4. **Calm by default, expressive on meaning.** Routine feedback takes 70–160ms. Anything that moves for longer than 240ms must explain something: a summary arriving and its sources lighting up, a citation landing, recording starting.
5. **Honest state.** Real durations, real progress, real owners. Show exceptions, not reassurance: no "Ready" pill on every row. Never invent a number to fill a layout.

## 2. Identity

- **The Σ mark.** Four rounded bars in speaker colours 1–4. Resting state is Σ ("Sum"). The "lanes" state is the same four bars laid out as speaker lanes. Transitions between them are the brand's motion signature: the topbar mark arrives as lanes and sums into Σ, the rail mark splits into lanes while a recording processes and returns to Σ when the summary is ready, and the empty state breathes between the two. Under reduced motion it is a static Σ.
- **The cited mark** replaces the sparkle as the AI glyph (tab icon, AI labels, AI tags, toasts). It carries the product's promise: AI output points at a moment.
- **Speaker colour as provenance.** The hairline beside AI text is split into the colours of the speakers it cites, so authorship stays human.
- What it avoids: sparkle + violet slab as "AI", waveform-bar logos, black filter chips and send buttons, thumbs-up/down toolbars.

## 3. Market benchmark (October 2026)

| Product | Best idea | Cadence takes | Cadence avoids |
|---|---|---|---|
| Granola | Human text vs AI text by colour; zoom into source quotes | Edit-to-own provenance, citation peek | Weak playback and team views |
| Fathom | Clickable timeline; topics jump to the moment | Speaker timeline with markers + source trace on hover | Cramped scrolling on laptops |
| Fireflies | Chapters, AskFred, transcript filters | Structured summary sections, one regenerate | Panel overload (three docks fighting for width) |
| Otter | Word highlight synced to playback | Word-level follow + "Back to playback" pill | Dated chrome, upsells inside meetings |
| tl;dv | One box that searches and answers | Ctrl K palette that jumps or asks, with visible scope | Shallow interaction detail |
| Notion AI notes | Edit transcript, retry summary | Edits survive reprocessing | Weak speaker labels |
| Timeless | Rooms per client; a recorder with character | Rooms as breadcrumb; blinking-colon recorder | Marketing-only claims |
| Read.ai | Jump to impactful moments | Markers for decisions/questions/actions | Per-person engagement scores |

System references: Linear (LCH-generated themes), Radix Colors (fixed roles per step), IBM Carbon (productive vs expressive motion, Plex), Atlassian (50–150ms interaction timing), Material 3 Expressive (spatial vs effect springs), Vercel Geist (two canvases, disciplined greys).

## 4. Foundations

### Colour (OKLCH, light on `:root`, dark on `.dark`)

One neutral hue (≈242) and four **reserved** accents. Every text token passes 4.5:1 and every control/fill passes 3:1 against `--surface` in both themes; the showcase measures this live.

| Token | Role | Rule |
|---|---|---|
| `--canvas` / `--surface` / `--surface-2…4` | App ground, panels, rails/inputs, hover, pressed | Dark mode lifts with lighter surfaces plus a 1px rim, not shadow |
| `--line` / `--line-strong` / `--line-control` | Hairlines / dividers and chips / **input and checkbox boundaries** | `--line-control` is ≥3:1 (WCAG 1.4.11): 3.3:1 in both themes |
| `--fg` / `--fg-2` / `--fg-3` | Primary / secondary / meta text | ≥4.5:1 in both themes |
| `--brand` (Signal teal, h≈184) | Primary action, selection, focus, tab ink | One primary per view: Play in the meeting view |
| `--ai` (Iris, h≈289) | **Model-written content and model state only** | Lines, labels, caret, AI button outline. Never large fills |
| `--live` (h≈25) | **Recording now only** | Record button, live pill, recorder dock |
| `--ok` / `--warn` / `--danger` / `--info` | Status | Each has `-soft` (fill) and `-text` (AA text). `--warn` is a badge fill with dark text on it, not a stand-alone mark |
| `--mark-action` | Action markers on the timeline and legend | ≥3:1 on surface in both themes (3.79:1 light), because `--warn` amber is only ~2.4:1 |
| `--spk-1…8` | Speakers and provenance | Matched lightness (L .60 light / .74 dark). Assign by first speech, persist per person |

### Type

- **IBM Plex Sans + IBM Plex Sans Hebrew + IBM Plex Mono.** One superfamily, drawn together, so x-heights and weights match when a transcript line switches script mid-sentence. Replaces Inter, Noto Sans Hebrew and Geist Mono.
- One stack for both locales: `--font-ui: "IBM Plex Sans", "IBM Plex Sans Hebrew"`. Each glyph is resolved per script.
- **Hebrew metrics are tokens, not calc() at call sites.** `:lang(he)` redefines `--lh-sm…2xl`, sets `--tracking-*` to 0, and swaps `--font-label` from mono to the Hebrew face, because Plex Mono has no Hebrew glyphs and would fall back to Courier.
- The Hebrew face is applied with `[lang="he"] { font-family: var(--font-he) }` on the element that declares the language, **not** `:lang(he)`. `:lang()` matches every descendant and would override `font-mono` on timecodes inside Hebrew screens.
- No italics, uppercase transforms or negative tracking on Hebrew.
- **Drop `html { font-size: 14px }`.** Tokens are rem-based on a 16px root and body is 14px through `--text-base`. The current override silently shrinks every Tailwind spacing value by 12.5%.

| Token | Size / line | Use |
|---|---|---|
| `text-3xs` | 9 / 12 | Avatar initials only |
| `text-2xs` | 11 / 16 | Mono labels (Latin); replaces 30× `text-[11px]` |
| `text-xs` | 12 / 16 | Meta, chips, pills |
| `text-sm` | 13 / 20 | Dense lists, tables |
| `text-base` | 14 / 22 | Body, controls |
| `text-md` | 16 / 24 | **Transcript and answers** (reading) |
| `text-lg` | 18 / 26 | Section titles |
| `text-xl` | 22 / 28 | Page titles |
| `text-2xl` | 28 / 34 | Empty-state titles |

Timecodes are always `font-mono tabular-nums`, LTR-isolated. Product-generated titles use a no-break space before "—" so the dash never starts a line.

### Space, radius, elevation, layers, icons

- 4px grid (`--space-*`). Controls are 28 (toolbar), 32 (default) and 40 (primary/touch). Rows are 36 dense and 56 inbox. The reading column is capped at `--measure` (44rem).
- Radius by role: xs 4 timecodes/kbd · sm 6 tags · md 8 buttons/inputs · lg 12 cards/popovers · xl 16 dialogs/player · full pills/avatars.
- Elevation: 1 cards · 2 hover/dock · 3 popover · 4 dialog.
- Layers: `--z-sticky` 10 · `--z-dock` 15 · `--z-popover` 20 · `--z-toast` 30 · `--z-overlay` 40.
- Icons: `--icon-xs` 12 · `sm` 14 · `md` 16 · `lg` 20.
- Breakpoints (in `@theme`): `rail` 720px, `inbox` 1080px.

## 5. Motion

Two speeds. **Productive** (70–160ms) confirms. **Expressive** (240–400ms) explains. Springs move things; opacity and colour fade on their own curve and never bounce.

- **Overlays** (menu, popover, citation peek, dialog, palette, toast, citation and status pops) use `animate-ms-pop-in`: scale from 0.96 plus fade, 160ms ease-out. They are routine, so they get no spring.
- **The spring** (`animate-ms-pop`, `--dur-spring` 520ms, scale from 0.92 plus a separate 160ms fade) is for elements whose arrival is the message: the recorder dock and the "Back to playback" pill.

| Token | ms | Use |
|---|---|---|
| `--dur-1` | 70 | Hover, press, colour |
| `--dur-2` | 120 | Toggles, checks |
| `--dur-3` | 160 | Menus, tooltips, fades |
| `--dur-4` | 240 | Panels, tab content, compact player |
| `--dur-5` | 400 | Summary reveal, view change |
| `--dur-6` | 700 | Ambient: waveform cycle |
| `--dur-pulse` | 1600 | Live-dot halo loop |
| `--dur-shimmer` | 1400 | Skeleton and progress shimmer loop |
| `--dur-spring` | 520 | Recorder dock, follow pill (with `--ease-spring`) |

**Named moments** are the only motion allowed past 400ms, and each one explains something:

| Token | ms | Moment |
|---|---|---|
| `--dur-flash` | 1200 | A landed citation fades its brand highlight |
| `--dur-trace` | 900 | Cited speaker lanes glow as a summary line lands |
| `--dur-scan` | 1300 | Source-trace scan line across the timeline (0 with reduced motion) |
| `--dur-sigma` | 760 | Speaker lanes rotate into the Σ mark (0 with reduced motion) |
| `--dur-reveal` | 480 | Theme switch reveal (0 with reduced motion) |

Easings: `--ease-standard` (in place), `--ease-out` (enter), `--ease-in` (exit), `--ease-emphasized` (view transitions, Σ), `--ease-spring` (`linear()` spring, ~4% overshoot, transform only). Stagger is 35ms, capped at 8 items.

**Signature moments** (each runs in the showcase prototype):

| Moment | Spec |
|---|---|
| **Source trace** | On regenerate, an iris scan line sweeps the speaker timeline (`--dur-scan`). As each summary line lands, the lanes it cites glow (`--dur-trace`). Hovering or focusing any line or citation lights its lanes and marker. Under reduced motion there is no sweep and the glow stays. |
| **Lanes → Σ** | The rail mark splits into lanes while a recording processes and sums back into Σ when it's ready (`--dur-sigma`, emphasized). |
| Citation landing | Click a timecode: the player seeks, and a peek (160ms pop-in) shows speaker, time, quote, "Play from here" and "Open in transcript". The transcript line flashes brand for `--dur-flash`. |
| Summary streaming | Layout-matched skeletons, three-word chunks at 55ms with an iris caret, then sections rise in a 35ms stagger. Stop replaces Regenerate for the whole stream, and stopped sections say so. |
| Live recording | Spring dock with a pulsing live dot, "REC", a blinking-colon mono timer and a live waveform that runs left to right in every language. |
| **Compact player** | Once the reading pane scrolls past 24px, the speaker lanes slide into one colour-coded lane and chapter labels fold away (240ms), giving the reading column its height back. |
| Follow playback | The speaking lane lifts (12px with a 3px halo) while the others dim to 45%. Words go to full contrast as they are spoken, and the current word gets a speaker-coloured underline. Scrolling away shows a "Back to playback" spring pill. |
| Meeting open | A view transition morphs the inbox title into the page title (`--dur-4`, emphasized). The root snapshot swaps instantly. |
| Command palette | Ctrl/⌘ K: meetings, decisions, actions, commands. With no match, Enter asks MeetSum instead. |
| Task check-off | The tick draws (160ms), then a strike-through sweeps in reading direction (240ms). |

**Reduced motion** (`prefers-reduced-motion` or the in-app toggle) removes travel and keeps fades and colour feedback: no stagger, static caret, static live ring with "REC", frozen waveform, no scan sweep, static Σ, instant scroll, instant view transitions. `tokens.css` remaps the duration tokens.

`<ViewTransition>` is still a React canary feature. Feature-detect `document.startViewTransition` until it's stable.

## 6. Components

### Existing shadcn primitives (`components/ui`): restyle, keep the APIs

| Component | Change |
|---|---|
| Button | Variants: `default` (brand, one per view), `secondary` (surface + line-strong), `ghost`, `destructive` (danger-soft), **`ai`** (iris outline, only where a model will run), **`record`** (live hue on hover/pressed). Sizes xs 24 / sm 28 / md 32 / lg 40. Press = `scale(.97)` at 70ms |
| Badge → split | Status becomes `StatusPill` (exceptions only). Tags stay `Badge` with soft colours |
| Tabs | Sliding 2px brand ink (`--dur-4`); arrow keys follow reading direction |
| Input / Textarea | `--line-control` boundary, brand focus with 3px halo; errors name the cause and the fix |
| Dialog | Elevation 4, 160ms pop-in, `--overlay` scrim, focus to the first meaningful control, Tab trap, Esc returns focus to the opener. Replaces hand-built modals and `window.prompt/confirm` |
| Dropdown menu | `role=menu`, arrows/Home/End wrap, Esc returns focus, destructive items last after a separator |
| Radio cards | Selection is a filled radio; focus is the ring. The two signals are never the same |
| Sonner (toasts) | Bottom-end, 160ms rise + fade, the object's name in the title, one action, lifted above the recorder dock |
| Skeleton | Matches the final layout line for line |

### Meeting atoms (`reference/meeting-atoms.tsx`)

`CitedMark` · `TimecodeChip` · `CitationChip` (renders only for resolvable segments, with an `onTrace` hook for source trace) · `SpeakerAvatar` (22px xs with 9px initials, 8 colours, dashed `unconfirmed` state) · `SpeakerLabel` (name in `<bdi>`) · `AvatarStack` (3 people, then a neutral +N, 2px overlap) · `LiveDot` · `StatusPill` (live / processing with a real % / new / review / failed) · `AiProvenance` (ai / edited / streaming, explicit `dir`, speaker hairline from `sources`).

### New patterns shown in the showcase

Share dialog (room / workspace / anyone with link, transcript toggle, copy link, live hint) · overflow menu (rename with F2, PDF with embedded Hebrew font, Word, reprocess with "your edits are kept", delete with Undo) · speaker review (calendar suggestions, confirm, merge, undo) · meeting bot states (scheduled → joining → waiting to be admitted → recording → processing, plus blocked with the reason and a fallback) · upload dropzone · errors that name the cause and the next step · offline banner · cross-meeting tasks table where every row cites its moment · empty state with the Σ mark.

## 7. Surfaces

**Meeting workspace** replaces the 3-pane command center: `rail 56px | inbox 296px | reading column (max 44rem)`. There is no permanent right rail. Pipeline status lives in the inbox row; integrations and Google scopes move to Settings. Under 1080px the inbox becomes a slide-over. Under 720px the rail hides, header actions go full width, and the chapter row and legend hide.

Reading column, top to bottom:
1. Breadcrumb (Room); title (dir from the meeting language); meta row (date, real duration, people, source); actions: Record, Share (secondary) and ⋯.
2. **Player card.** Back/forward 10s, a **brand Play button (the view's primary)**, mono time, current chapter ("2/4 · Financing and returns"), marker legend and speed. The **speaker timeline** has one lane per speaker, ordered by first speech, with chapter labels above (hidden when narrower than 56px) and markers below (◆ decision, ● action, ○ question) that seek. The player is `dir="ltr"` in Hebrew too. The scrubber is a keyboard slider.
3. Tabs: **Summary · Transcript · Ask**.
   - **Summary order: Overview → Action items → Decisions → Open questions → Chapters** (what happened, what you have to do, why, where). The Overview header carries "AI · 4 min after the call", copy, edit and Regenerate; there is no separate AI banner. Under it is the provenance line: "From 4 moments in the call", the cited speakers, and the citation chips. Each line has its citations and a hover-revealed **flag** ("MeetSum re-checks it against the transcript").
   - Transcript: talk-time bar, diarization status, segments with avatar, name and a clickable timecode; clicking a word seeks to it.
   - Ask: scope switch, suggested questions, streamed answers with inline citations and a speaker hairline, Stop while streaming, and "I couldn't find that" instead of a guess. Feedback is flag + copy.

**Inbox row**: title (2 lines, no-break before "—"), time, avatar stack (3 + N), real duration, and a pill **only** for live / processing / new / needs review. Processing rows show the step and a real percentage.

## 8. RTL and bidi rules

1. Logical properties only: `ms/me/ps/pe/start/end/text-start/border-s/rounded-s…`. `check.mjs` enforces this.
2. **Set `dir` from the language you know.** ASR gives each segment a language, and summaries are written in the meeting's language. Use `dir="auto"` **only** for text of unknown language (search box, chat input, user-entered fields). It resolves from the first strong character, so "Lisboa Riverside נכנסת ל-due diligence…" would render LTR. The showcase hit this bug in round 1.
3. Names, emails and product names inside sentences go in `<bdi>`.
4. Timecodes, durations and percentages: `[direction:ltr] [unicode-bidi:isolate]`, mono, tabular, Western digits.
5. **Time-based visuals never mirror**: the scrubber, speaker timeline, chapter ticks (`direction: ltr` on the tick, text isolated in `<bdi>`) and the recording waveform. Reading-direction visuals do mirror: strike-throughs, progress fills, chevrons, panel toggles, reply/enter. Mark mirroring icons with `data-icon="directional"` and remove the current blanket `[data-icon="inline-start"]` flip.
6. Hebrew titles generated by the product start with Hebrew ("עדכון סטטוס עסקה — Lisboa Riverside").

## 9. Accessibility floor

- Text ≥4.5:1; controls and input boundaries ≥3:1; both themes (measured in the showcase).
- Targets: icon buttons are 28px. Citation chips are 20px tall and meet WCAG 2.5.8 through the spacing exception (a 24px circle on each never overlaps a neighbour). Timeline markers are a shortcut: every moment they mark is also reachable from the summary and the scrubber (equivalent-control exception).
- Focus: `outline: 2px solid transparent; outline-offset: 2px` **plus** the `shadow-focus` ring, so focus survives Windows forced-colours mode. Controls drawn only with box-shadow (checkbox, radio, switch, inputs, chips) get `border: 1px solid CanvasText` and a `Highlight` checked state inside `@media (forced-colors: active)`. Speaker lanes, avatars and the live dot use `forced-color-adjust: none` so identity survives. It is never hidden under the sticky player, recorder or toasts (WCAG 2.4.11).
- Dragging has non-drag alternatives: click-to-seek and the keyboard slider (2.5.7).
- Live regions announce once. The recorder says "Recording started" and "Recording stopped" through a polite region, and the ticking timer is `aria-hidden`. Streams use `aria-busy` and announce on completion.
- Every label and aria-label is translated, including icon buttons and Play/Pause.
- Tabs, listbox/combobox (`aria-activedescendant`), menu and dialog follow the ARIA Authoring Practices patterns.
- State never relies on colour alone.

## 10. AI UX contract

1. Citations resolve to a real segment or aren't rendered.
2. Stop is visible for the whole stream; Regenerate is one click.
3. Feedback is a **flag on the exact line**, checkable against the transcript. No thumbs.
4. Edited AI text becomes human text and survives reprocessing (ties to the M1 fix "reprocess wipes user edits").
5. Unknown answers say so plainly; the scope (this meeting, room or all) is always visible.
6. Unconfirmed speaker names are labelled until a person confirms them.

## 11. Rollout

Measured with `node design-system/check.mjs` on `parity/m1-pipeline`: **661 violations** (528 bracketed colour/`var()` classes, 53 arbitrary px/rem sizes, 50 raw palette classes, 25 physical-direction classes, 5 hex literals). On top of that there are 30 uses of `text-[11px]`, 0 motion tokens (Cadence has 9 durations, 5 named moments and 5 easings), and 5 equal-weight teal buttons in the top bar.

**Phase 1 · Tokens** (independent of the parity work; after M1)
1. Replace the `@theme inline` and `:root`/`.dark` blocks of `app/globals.css` with `design-system/tokens.css`. Keep the `@import`s, `@custom-variant dark` and the `@layer base` block. The token blocks must stay **unlayered** so they win over `@theme`'s layered variables.
2. In `app/[locale]/layout.tsx`, load `IBM_Plex_Sans`, `IBM_Plex_Sans_Hebrew` and `IBM_Plex_Mono` from `next/font/google`, and point `--font-ui`/`--font-he`/`--font-mono` at their variables.
3. Remove `html { font-size: 14px }`, then check density on the inbox, header and settings.
4. Codemod the legacy aliases: `bg-[var(--surface)]` → `bg-surface`, `border-[var(--divider)]` → `border-line`, `bg-[var(--surface-subtle)]` → `bg-surface-2`, `bg-[var(--selected)]` → `bg-brand-soft`, `text-[var(--text-muted)]` → `text-fg-3`, `text-[11px]` → `text-2xs`. Then delete the alias block from `tokens.css`.

**Phase 2 · Primitives** (before M4)
Restyle `components/ui` per §6. Move `reference/meeting-atoms.tsx` into `components/ui/`. Add `lib/motion.ts` from `motion.ts`. Replace the logo with the Σ mark and the sparkle with `CitedMark`.

**Phase 3 · Surfaces** (ride along with the parity milestones)
- M4: player, speaker timeline, compact player, source trace, transcript follow, click-to-seek, citation peek.
- M5: summary order and sections, provenance hairline, edit-to-own, flags, action-item editor.
- M6: Ask with citations and scope, palette.
- M7: recorder dock and bot states.
- M2: inbox row states with real data, share dialog with real access levels.

**Phase 4 · Guardrails** (M9)
Run `node design-system/check.mjs --strict` in CI as a ratchet: fail if the count rises, then drive it to 0. Add Playwright screenshots of every surface in he/en × light/dark. Retire `docs/design-system.md` v1.

## 12. Open decisions for the owner

- **Plex vs keeping Inter.** Plex is recommended for bilingual harmony. Keeping Inter + Noto Sans Hebrew is lower risk but leaves the mixed-script lines mismatched.
- **Removing the 14px root.** Right call, but it touches every screen's density; do it in one pass with screenshots.
- **The `motion` library.** Not needed for phases 1–3 (CSS + WAAPI cover everything shown). Consider it only for shared-layout transitions beyond the title morph.
