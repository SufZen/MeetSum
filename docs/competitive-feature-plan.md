# MeetSum Competitive Feature Plan

Last updated: 2026-04-23

## Goal

Use the best parts of Fireflies and Timeless without copying their entire product surface too early. MeetSum should first become a reliable, Hebrew-strong, Google-native meeting intelligence platform. Only then should it widen into deeper workflow automation and agent orchestration.

## Sources Reviewed

- Fireflies AskFred docs
- Fireflies product guides for AI Apps, Topic Tracker, Voice Commands, Soundbites, Desktop App, and Global AskFred
- Timeless public site, pricing, terms, and product messaging
- Internal qualitative benchmark from your Fireflies Hebrew meetings

Note: Timeless’s public marketing strongly emphasizes action-oriented meeting agents, Rooms, API/MCP/webhooks, and moment-based triggers. Its exact Hebrew processing pipeline is not documented publicly, so Hebrew-specific product conclusions below are partly inferred from the product positioning and from your own experience using it.

## What Fireflies Does Well

- Broad capture surface: bot joins, browser capture, desktop capture, mobile capture, uploads
- Fast post-meeting workflow: transcript, summary, action items, search
- Strong “query my meetings” layer through AskFred
- Good automation primitives:
  - AI Apps for custom structured outputs
  - Topic Tracker / Smart Search
  - voice-command-triggered task creation
  - shareable clips / soundbites

## What Timeless Appears To Do Well

- Treats meetings as triggers for downstream work, not just documentation
- Organizes context by project/client/topic using “Rooms”
- Wakes up specialized agents from moments detected in meetings
- Pushes toward action and follow-through more than passive note storage
- Exposes API, MCP, and webhooks as first-class product surfaces

## What Your Hebrew Samples Show

Based on the Fireflies summaries and transcripts reviewed:

- Hebrew summaries are useful but not consistently faithful on nuance
- Mixed Hebrew/English technical vocabulary drifts too often
- Speaker attribution and normalization are still noisy
- Technical and financial conversations need stronger number/entity preservation
- Repeated filler, audio glitches, and bot artifacts should be cleaned earlier in the pipeline

This means MeetSum should not compete only on “more features.” It should compete on:

1. Hebrew fidelity
2. decision/task extraction accuracy
3. turning outcomes into real workflows

## Build Now

These features fit the current architecture and should be added in the next implementation phases.

### 1. Hebrew-first cleanup and transcript quality layer

- transcript cleanup pass for duplicated lines, filler, and audio glitches
- mixed Hebrew/English term preservation dictionary
- entity preservation for names, companies, products, dates, amounts, currencies
- meeting-type prompts for technical, operational, sales, and finance conversations

Why now:
- This is the core product differentiator
- It improves every downstream feature

### 2. Structured summaries beyond “overview”

- decisions
- action items
- blockers / risks
- open questions
- commitments
- follow-up draft
- key quotes with timestamps

Why now:
- low infrastructure cost
- high user-visible value

### 3. Auto-tags

Start with deterministic + AI hybrid tags:

- sales
- hiring
- product
- customer-success
- operations
- finance
- legal
- follow-up-needed
- executive-review
- urgent
- Hebrew / mixed-language / English

Why now:
- easy to implement on top of transcript + summary
- helps filtering, search, automation, and future agents

### 4. Smart task extraction

- infer owner, due date, priority, confidence
- separate explicit commitments from soft suggestions
- mark unresolved owner/date fields for review
- output directly into MeetSum action items table

Why now:
- this is a direct upgrade over passive summaries
- aligns with your automation vision

### 5. Meeting memory / cross-meeting ask

- search across meetings
- ask questions scoped to:
  - one meeting
  - one participant
  - one client/project
  - date range
- answer with citations and timestamps

Why now:
- Fireflies sets the expectation here
- your current API scaffold already points in this direction

### 6. Room-style grouping

Implement a simpler version of Timeless Rooms:

- client
- project
- deal
- internal initiative
- person

Each meeting can belong to one or more contexts. Context pages can aggregate:

- recent meetings
- decisions
- open action items
- related docs / Drive files
- Gmail threads

Why now:
- huge leverage for RealizeOS sync later
- can be implemented without building the full agent system first

### 7. Automation/event infrastructure only

- keep emitting internal events
- keep webhook subscriptions
- define payload contracts
- add placeholder outbound connectors for:
  - n8n
  - RealizeOS
  - custom REST

Why now:
- you asked correctly to build the infrastructure before live automations

### 8. Specialized post-meeting agent suggestions

Not full autonomous execution yet. Start with:

- “suggested agent run” cards after a meeting
- examples:
  - create follow-up email
  - send context to RealizeOS
  - generate project brief
  - create CRM notes
  - prepare next-meeting brief

Why now:
- preserves control
- avoids premature autonomous side effects

## Keep For The Next Phase

These are valuable, but should wait until persistence, auth, Google sync, and job reliability are stronger.

### 1. Fully autonomous agent execution from meeting moments

- agent wakes up from a detected moment
- executes tools on its own
- changes external systems automatically

Why later:
- needs mature permissions, audit logs, retries, approvals, and rollback thinking

### 2. Voice-command tasking during live meetings

- “create task”
- “follow up with X”
- “schedule next call”

Why later:
- depends on live assist UX, high confidence parsing, and external integrations

### 3. Soundbites / shareable clips

- auto-highlight moments
- short audio/video exports
- quote clips

Why later:
- useful, but storage, transcoding, retention, and sharing permissions add complexity

### 4. Live meeting copilot

- live transcription
- live ask
- live suggestions
- live smart tasking

Why later:
- much harder operationally than post-meeting workflows

### 5. Full CRM/project-tool write-back automation

- Jira / Asana / Monday / HubSpot / Salesforce / ClickUp direct sync

Why later:
- should wait until MeetSum’s own task and context models stabilize

### 6. Team analytics / coaching / sentiment dashboards

- speaker balance
- participation trends
- objection analysis
- sales coaching

Why later:
- lower immediate value for your current personal/admin-first scope

## Recommended Product Order

### Stage A: Quality and trust

- Hebrew cleanup
- structured summaries
- better action items
- confidence scoring

### Stage B: Retrieval and context

- cross-meeting ask
- auto-tags
- Room-style context pages
- Gmail/Drive/Calendar enrichment

### Stage C: Actionability

- suggested agent runs
- outbound webhook framework
- RealizeOS payload export
- n8n-ready event contracts

### Stage D: Controlled automation

- approval-based task execution
- selected external write-backs
- specialized agents with guardrails

## Backend / Database Recommendation

Yes — for this product, the backend and database should be managed on your VPS.

Recommended production layout:

- Next.js app/API: VPS container
- Postgres: VPS container or managed VM service on the same VPS host
- Redis: VPS container
- MinIO / S3-compatible storage: VPS container
- worker containers: VPS
- reverse proxy / TLS: existing VPS proxy layer

This keeps MeetSum:

- self-hosted
- cheaper than SaaS-first alternatives
- easier to connect to your internal systems
- free to expose API, CLI, MCP, and webhooks without vendor constraints

## Immediate Implementation Implications

The next engineering slice after Phase 1 foundation should be:

1. Hebrew transcript cleanup + structured summary pipeline
2. auto-tags + smarter action-item extraction
3. context model for Room-style grouping
4. outbound event payloads for RealizeOS and future n8n workflows

That sequence gives MeetSum a differentiated product core before wider automation sprawl.
