# Design principles

These principles are product constraints, not marketing language. A change that conflicts with one needs an explicit design and safety review.

## Text is the complete control surface

No material request, warning, choice, state change, commitment, or outcome may exist only in audio. The browser thread and, where appropriate, SMS must let the owner understand and control the support call without listening to it.

## The owner remains the principal

Liaison is a self-hosted, single-principal tool. It is not a customer-contact platform, campaign system, call center, or multi-tenant service. The owner supplies the support destination, owns or is authorized on the account, approves the plan, and can pause or stop execution.

## Authority is data, not a vibe

Goals, permissions, limits, disclosures, and conditional rules are inspectable before a call. A named autonomy mode adjusts how often Liaison asks for input; it never expands the authority envelope or bypasses hard policy.

## Deterministic policy owns side effects

Models may extract structure or propose one bounded action. Deterministic code assigns attention tiers, validates state transitions and authority, rejects prohibited actions, checks freshness and idempotency, and authorizes every external side effect immediately before execution.

## Interruption has priority

Pause, hang-up, opt-out, superseding decisions, and relay interruptions invalidate stale work. A late model answer or duplicate provider callback must not speak, send, disclose, or commit after control has changed.

## Use the least sensitive channel

SMS is useful for status and narrow low-consequence A/B/C choices, but it is carrier-visible and identity is limited to possession of the allowlisted number. Sensitive and material decisions move to an authenticated, short-lived, single-use web action. Prohibited secrets and actions have no approval path.

## Durable at the boundary

Inbound provider events and outbound intents enter SQLite before asynchronous work. Unique keys, transactional claims, bounded inbound-processing retries, explicit no-retry handling for ambiguous outbound submissions, and monotonic delivery reduction make process restarts and reordered callbacks explicit rather than accidental.

## Claims require evidence

Commitments and outcome fields point to exact transcript evidence. A provider acceptance status is not delivery, a vague promise is not a confirmed commitment, and mock-mode success is not live-provider validation.

## Privacy is structural

Liaison does not intentionally record or store audio. Disclosure values are ephemeral, prohibited SMS credentials are redacted before persistence, logs omit message bodies and secrets, and retention is operator-controlled. Provider processing and carrier exposure are documented honestly.

## Accessible by default

Keyboard control, visible focus, semantic status, urgency announcements, large text, contrast, reduced motion, and responsive layout are part of correctness. Accessibility is tested through behavior, not inferred from component names.

## One deployable process

Fastify, the messaging worker, call supervisor, policy engine, SQLite, and static client remain one deployable unit. This is a deliberate fit for a personal instance, not a placeholder microservice diagram.

## Safe degradation

The credential-free web, mock-model, and simulator path is a first-class product path. Provider or model failure must lead to a truthful stalled/failed state and an owner-visible recovery action, never an invented outcome or silent retry of a call.

## Explicit non-goals

The project does not include SaaS tenancy, billing, analytics telemetry, contact discovery, web search, inbound calling, international calling, call recording, scheduled or repeated calls, campaign messaging, purchases, new contracts, emergency/medical/legal/financial/government workflows, or autonomous handling of secrets.
