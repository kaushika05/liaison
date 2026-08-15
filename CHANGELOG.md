# Changelog

All notable changes to Liaison are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-08-15

### Added

- Universal Support Protocol v1 is now served, not just published: `GET /api/cases/:caseId/execution-plan`, `GET /api/attention/:id`, and `GET /api/cases/:caseId/commitments` return documents validated against the checked-in JSON Schemas.
- A metadata-only `DisclosureEvent` is written to the audit log when an approved disclosure executes, so the record survives a restart that clears the in-memory ledger.
- Running estimate of SMS spend over segments actually submitted to a carrier, plus a visible count of rejected inbound provider requests.
- Test coverage tooling (`npm run test:coverage`) and a Prettier formatting gate in CI.

### Changed

- `SUPERSEDED` added to the protocol attention status so runtime state maps losslessly; `attention-request.schema.json` regenerated.
- `db.ts` split into `schema.ts`, `records.ts`, and the query layer.
- The whole tree is Prettier-formatted, and ESLint now runs type-aware rules including `no-floating-promises`.
- `CaseDetail` gained `createdAt`.

### Removed

- `MAX_CONCURRENT_CALLS` and `UNAUTHORIZED_SENDER_RESPONSE`. Neither was read anywhere. Concurrency is enforced by the single-active-call check, and replies to unauthorized senders are always silent by design.

### Fixed

- A Twilio call SID adopted from a signed callback after an ambiguous start is now bound to the relay adapter, so a later hang-up terminates the provider call instead of silently reporting success. `endCall` also refuses to claim success with neither a SID nor an open relay socket.
- Disclosure release now requires the representative's request to name that card's own category, using a closed disjoint classifier. The previous term-overlap check was satisfiable by shared policy wording.
- `CallService.shutdown` no longer throws on an active call row this process never owned in memory.
- Two unhandled promises in the client polling loop.
- `busy_timeout` set so the retention job and backup tooling wait rather than failing with `SQLITE_BUSY`.
- The session store is scoped to the app instance and cleared on close.

### Security

- Tests can no longer inherit a provider-calling mode from a local `.env`. The suite previously issued a real, billable OpenAI request when run on a developer machine configured for live use.

## [Unreleased]

### Added

- SMS-first universal-support protocol v1 with canonical Zod schemas, generated JSON Schemas, examples, support-thread states, autonomy modes, attention tiers, conditional authority, commitments, disclosures, and semantic call events.
- Provider-neutral `WebMessagingAdapter` and `TwilioSmsMessagingAdapter` boundaries.
- Durable SQLite messaging inbox/outbox, delivery-state reduction, opt-out state, call-authorization records, secure-action-token records, and migration tracking.
- Exact messaging commands, segment-aware composition, prohibited-credential redaction, fail-closed ambiguous-delivery handling, and a simulator-mode messaging demonstration.
- Interactive setup and a provider-call-free doctor command that validates and, when needed, initializes database migrations.
- Self-hosting, protocol, provider-adapter, Twilio, security, privacy, design, and deployment documentation.
- Docker Compose, optional Caddy example, contribution and community health files, expanded CI, dependency review, and tag-only container publishing.

### Changed

- The primary product flow is moving from browser-form-first call control to a unified text thread that can use secure web messaging or owner-allowlisted SMS while retaining the existing call supervisor.

### Security

- Real SMS and calls remain independently disabled by default.
- SMS call authorization is exact, version-bound, expiring, and single-use; sensitive and material actions stay on authenticated, single-use web links.

## [1.0.0] - 2026-08-12

### Added

- Accessibility-first browser workflow for planning and supervising a low-risk support call.
- Deterministic planner and ten simulator scenarios.
- Optional OpenAI structured-output planning/control/outcome path.
- Optional Twilio Calls API and ConversationRelay path with signed HTTP and WebSocket callbacks.
- SQLite audit trail, transcript-grounded outcome, non-root container image, and Railway deployment configuration.

[Unreleased]: https://github.com/kaushika05/liaison/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/kaushika05/liaison/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/kaushika05/liaison/releases/tag/v1.0.0
