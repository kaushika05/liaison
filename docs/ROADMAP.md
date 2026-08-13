# Roadmap

This file separates shipped boundaries from possible future work. It is not a delivery promise.

## Current release line

- One self-hosted principal and one active support call.
- Authenticated browser messaging and an optional owner-allowlisted Twilio SMS transport.
- Deterministic mock model, web transport, and call simulator for credential-free operation.
- Optional OpenAI structured-output models.
- Optional Twilio Programmable Voice with ConversationRelay.
- Protocol v1, durable SQLite inbox/outbox, inspectable authority, low-consequence SMS choices, secure web escalation, commitments, and grounded outcomes.

## Candidates for later releases

- A provider-adapter conformance harness that can validate third-party messaging adapters without adding one to core.
- More migration and backup diagnostics, including an operator-invoked SQLite online-backup helper.
- Additional synthetic simulator scenarios for callback reordering, process interruption, and long support holds.
- Stronger local accessibility regression checks across desktop and mobile viewports.
- A record/replay research harness for the open-source voice path described in [OPEN_SOURCE_VOICE_MIGRATION.md](OPEN_SOURCE_VOICE_MIGRATION.md).

None of those candidates is implemented merely because it appears here.

## Intentionally out of scope

- Hosted SaaS, multi-tenant accounts, teams, roles, billing, or usage telemetry.
- Marketing, campaign messaging, bulk messaging, contact lists, or company/number discovery.
- WhatsApp, RCS, email, social messaging, or automatic provider fallback.
- Web browsing, browser automation, or account-portal automation.
- Multiple simultaneous calls, scheduled calls, automatic redial, retry calling, or inbound calls.
- Emergency, medical, legal, financial, insurance, government, debt, employment, immigration, or law-enforcement workflows.
- Purchases, new contracts, credential disclosure, payment-card handling, impersonation, or waiver of rights.
- Call recording or stored audio.
- Redis, Postgres, Kubernetes, or a microservice deployment topology for the personal-instance product.
