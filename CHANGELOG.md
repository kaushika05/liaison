# Changelog

All notable changes to Liaison are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[Unreleased]: https://github.com/kaushika05/liaison/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/kaushika05/liaison/releases/tag/v1.0.0
