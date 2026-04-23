# MeetSum Integration Inputs

This file tracks non-secret setup details already provided. Do not commit API keys, private keys, OAuth tokens, service-account JSON, SSH keys, or real passwords.

## Google Workspace

- Admin/contact email: `info@realization.co.il`
- Google Cloud project ID: `meetsum-494211`
- Google Cloud project number: `91554489040`
- Current state: project was newly created and still needs API enablement, OAuth/service-account setup, domain-wide delegation, Pub/Sub, and Workspace admin authorization.

## VPS

- SSH target: `root@37.27.182.247`
- Expected services to inspect/connect:
  - RealizeOS
  - Openclaw
  - n8n
  - Future MeetSum deployment

## AI Direction

- Primary API preference: Google Gemini API.
- Possible local model: Gemma 4, likely first for textual summaries if quality is good.
- Hebrew quality samples: source candidate is the existing Fireflies account. Exported examples should include audio or transcript, current Fireflies summary, and preferred corrected summary.

## Next Connection Steps

1. Install and authenticate Google Cloud CLI locally.
2. Set the active project to `meetsum-494211`.
3. Enable required APIs: Calendar, Gmail, Drive, Admin SDK, Pub/Sub, IAM, Secret Manager, Cloud Resource Manager.
4. Create a service account for Workspace domain-wide delegation.
5. Authorize least-privilege scopes in Google Admin Console.
6. Inspect VPS services over SSH and document RealizeOS, Openclaw, and n8n endpoints without committing secrets.
