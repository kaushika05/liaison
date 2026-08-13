# Privacy

Liaison is self-hosted, but optional providers still process data. The operator is responsible for understanding applicable consent, retention, disclosure, and provider terms. This document describes application behavior, not legal advice.

## Audio

Liaison does not intentionally record or retain call audio and does not request Twilio call recording. Twilio ConversationRelay and its configured speech providers necessarily process telephone audio to transcribe representative speech and synthesize Liaison speech. A remote representative, carrier, or support organization may record independently; Liaison cannot control or guarantee otherwise.

Participants receive an automated-assistant and real-time-transcription disclosure before substantive human conversation. Liaison states only what this application does, not that no external party processes audio.

## Messages

The authenticated web thread stays within the self-hosted service and browser connection. SMS is not private end-to-end: Twilio, carriers, handset systems, and notification surfaces process or display message content and addresses.

SQLite stores redacted inbound/outbound message text, timestamps, direction, thread/case/call links, provider kind and message ID, sender/recipient addresses, processing state, delivery state, segment estimate, idempotency key, and redacted error code/detail as required for operation and audit. Twilio can retain message metadata/content under its own account configuration and policies.

Inbound MMS is rejected and media is not downloaded. Prohibited credential patterns in inbound SMS are replaced before persistence, logging, model input, or orchestration. Pattern detection cannot recognize every secret; never text passwords, one-time codes, full payment-card data, full Social Security numbers, PINs, security answers, recovery codes, or API keys.

The owner phone is a principal identifier and is stored in deployment configuration. Unauthorized sender content is not accepted as owner instruction; silent rejection is the default to avoid confirming the deployment.

## Cases, calls, and outcomes

SQLite stores case narrative, approved plan and authority, autonomy mode, conditional rules, thread state, call authorization metadata and hashes, call state, redacted transcript turns, attention requests/resolutions, semantic events, commitments, disclosure metadata/events, audit events, duration/cost estimates, and grounded outcomes.

Confirmed commitments and material outcome fields contain transcript evidence. That improves truthfulness but means the database holds sensitive support statements and case identifiers. Restrict host, volume, backup, log, and browser access accordingly.

## Temporary disclosure values

Supported disclosure values live only in server process memory. They are not stored in SQLite, ordinary logs, SSE events, SMS, model input, secure-action URLs, or stored transcripts. The model sees label, category, purposes, permission, and channel only. Stored text uses typed redaction markers.

Values are cleared when the call ends, the case is deleted, the process shuts down, or the process loses the associated call. A restart makes the value unrecoverable by design.

## Secure links and authorization codes

Call authorization codes and secure-action tokens are random, short-lived, scoped, and single-use. SQLite stores one-way hashes and binding metadata rather than plaintext tokens. Plaintext necessarily appears in the owner-facing SMS or browser output that delivers it and may therefore remain in carrier/handset history. Expiry or consumption does not erase a previously delivered message; it makes the token unusable.

## Model provider

In `LLM_MODE=mock`, Liaison makes no OpenAI request. In `LLM_MODE=openai`, OpenAI receives structured case context and the minimum redacted transcript/message context used for planning, control, or outcome extraction. Disclosure values and prohibited SMS credentials are excluded. Review the current data controls and retention terms for the configured OpenAI project. A custom `OPENAI_BASE_URL` introduces a different processor under the operator's control.

## Logs and telemetry

Application logs are structured and designed to omit request/message bodies and redact authorization, cookies, secrets, long token-like strings, and case-specific disclosure values. Logs still contain sensitive operational identifiers and timestamps. Access-control and retain them deliberately.

Liaison includes no product analytics or maintainer telemetry. Hosting platforms, reverse proxies, Twilio, OpenAI, operating systems, and container registries may have their own logs or telemetry.

## Retention and deletion

`DATA_RETENTION_DAYS` controls eligible completed-case retention. The repository does not install a scheduler; the operator runs `npm run retention` or `npm run retention:production`. Case deletion cascades through application-owned calls, messages, attention, events, commitments, and outcomes as defined by the database schema.

Deletion does not automatically erase provider records, handset history, remote support records, host logs, snapshots, or older backups. Apply compatible retention and secure deletion policies in each system, and document restoration procedures so expired data is not unintentionally reintroduced.

Liaison is not an emergency, medical, legal, financial, insurance, government, or credential-handling service.
