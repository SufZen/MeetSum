# MeetSum documentation

Current guides are listed here. Anything under [`archive/`](archive/) is historical (earlier plans, handoff prompts and status reports) and carries an "Archived" banner.

## Start here
- [README](../README.md): what MeetSum is, features, quick start, status.
- [SETUP](../SETUP.md): step-by-step setup with free-tier keys, the external-apps checklist, MCP.
- [User manual](user-manual.md) (he/en): daily workflow, capture, sharing, integrations, known limitations.
- [Parity audit](parity/AUDIT.md): every feature row scored against Fireflies, with evidence and what still needs live keys.

## Reference
- [API reference](api-reference.md): every `/api` route with its guard and API-key scope (completeness is tested).
- [Webhooks](webhooks/README.md) and the JSON schemas in [`webhooks/schemas/`](webhooks/schemas/).
- [Architecture](architecture.md).
- [Design system](../design-system/README.md) (Cadence; the canonical UI guide).
- [Internationalization](internationalization.md) and the [Hebrew style guide](i18n/hebrew-style.md) (gender-neutral UI Hebrew).
- [Language intelligence](language-intelligence.md): mixed-language detection, Hebrew cleanup, tags, tasks.
- [Desktop recorder](desktop-recorder.md).
- [n8n templates](n8n-templates/).

## Operations (runbooks)
- [Free-tier and low-cost ASR](runbooks/free-tier-asr.md) (Groq, local ivrit-ai, Modal, RunPod, Soniox) and the [laptop Hebrew ASR server](runbooks/laptop-hebrew-asr/README.md).
- [Integrations](runbooks/integrations.md): Slack, Microsoft, Notion, HubSpot, Google Docs, email; vendor-doc verification; token-key rotation.
- [Meeting bot (Vexa)](runbooks/vexa.md) and [bot security notes](runbooks/meeting-bot.md); the isolated-host runbook is `runbooks/vexa-isolated-host.md` (M10 B).
- Deploy, rollback and backups: `runbooks/deploy.md`, `runbooks/postgres-17-pgvector.md`, `runbooks/observability.md`, `env-matrix.md` (M10 B), plus [production deployment](production-deployment.md) and [backup and restore](backup-restore.md).
- [Google Cloud bootstrap](google-cloud-bootstrap.md) and [Google Workspace setup](google-workspace-setup.md).

## Quality and parity
- [Parity plan](parity/PLAN.md), [status](parity/STATUS.md) and the per-milestone specs `parity/m0.md`–`parity/m10.md`.
- Evaluations: [ASR](parity/asr-eval.md) (manifest example: [asr-eval-manifest.example.json](parity/asr-eval-manifest.example.json)), [summaries](parity/llm-eval.md), [search](parity/search-eval.md); background in [asr-evaluation.md](asr-evaluation.md).
- [Integration inputs](integration-inputs.md): the credentials each integration needs.

## Generated files
- `db/schema.sql`: a normalized `pg_dump` of every migration (`npm run db:schema:generate`; CI runs `db:schema:check`). Edit migrations, never this file.
- The route index at the end of `api-reference.md` (`npm run api:reference`).
