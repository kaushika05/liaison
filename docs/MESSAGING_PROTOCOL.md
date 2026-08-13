# Messaging protocol

Liaison Protocol v1 is the provider-neutral contract for turning a text conversation into one supervised support call. The canonical runtime definitions are Zod schemas in `src/shared/protocol.ts`; generated JSON Schema 2020-12 artifacts and validated examples live in `protocol/v1`. [UNIVERSAL_SUPPORT_PROTOCOL.md](UNIVERSAL_SUPPORT_PROTOCOL.md) describes the protocol documents in channel-neutral terms; this file defines the messaging-specific lifecycle and command semantics.

Run `npm run protocol:generate` after a compatible schema change. Do not edit generated schema files by hand.

## Conversation lifecycle

One support thread advances through explicit states:

```text
IDLE
  -> COLLECTING_ISSUE
  -> AWAITING_INFORMATION
  -> PLAN_DRAFTED
  -> AWAITING_PLAN_APPROVAL
  -> AWAITING_AVAILABILITY
  -> CALL_STARTING
  -> CALL_ACTIVE
  -> AWAITING_USER_DECISION
  -> CALL_ENDING
  -> COMPLETED | FAILED
```

`CANCELLED` is a terminal path before or during preparation. The state-transition table is deterministic; a message or model cannot jump directly to a later state.

## Canonical documents

| Document | Purpose |
| --- | --- |
| `SupportIntent` | Structured interpretation of a natural-language owner message, with missing information made explicit. |
| `AuthorityEnvelope` | Hard boundaries and owner-granted permissions for one case. |
| `ExecutionPlan` | Versioned, inspectable call plan bound to a destination, goal, authority, autonomy mode, and conditional rules. |
| `AttentionRequest` | A blocking or informational request with deterministic risk tier, expiry, and at most three explicit choices. |
| `Commitment` | A proposed or confirmed obligation with amount/deadline/recurrence fields and transcript evidence. |
| `DisclosureEvent` | An audit record that says what category was disclosed, why, and through which allowed channel, without storing the secret value. |
| `OutcomeReport` | Terminal summary whose material fields cite exact transcript evidence. |

Every versioned document carries `protocolVersion: 1`. Unknown or invalid documents are rejected at the boundary.

## Natural-language messages and commands

Ordinary text adds issue context or answers the current concise question. Exact commands are parsed before any model classifier:

| Command | Effect |
| --- | --- |
| `NEW` | Start a new support request. |
| `STATUS` | Return the current state and next required action. |
| `EDIT` or `LINK` | Return the secure web location for review/editing. |
| `CALL <code>` | Consume the exact call-authorization code for the currently approved plan version. |
| `A`, `B`, or `C` | Resolve the one pending, unexpired low-consequence choice. |
| `MODE ASSIST`, `MODE COPILOT`, `MODE DELEGATE` | Change the interaction preset without expanding authority. |
| `PAUSE` / `RESUME` | Pause or resume agent output during an active call. |
| `HANGUP` then `HANGUP YES` | Two-step termination confirmation. |
| `SAY: <text>` | Request exact speech after deterministic safety checks. |
| `CANCEL` | Cancel the support thread where the current state allows it. |
| `STOP`, `START`, `HELP` | Messaging consent/help commands, coordinated with provider opt-out behavior. |

Commands are case-insensitive after surrounding whitespace is removed. Free text that resembles but does not exactly match a privileged command cannot authorize the action.

## Call authorization

Approving a plan creates a short-lived random code bound to the owner, thread, case, destination, plan version, and call mode. Only the exact `CALL <code>` command may consume it. The database stores a one-way hash, not the plaintext code. Consumption is transactional and single-use; expiry, plan edits, case cancellation, or replacement revoke it.

This code authorizes one call start. It does not authorize later sensitive or material decisions.

## Autonomy modes

| Mode | Interaction policy |
| --- | --- |
| `ASSIST` | Owner authors substantive responses. |
| `COPILOT` | Liaison may explain and ask factual questions within authority, but asks on consequential or ambiguous choices. |
| `DELEGATE` | Liaison proceeds inside approved boundaries and asks at hard boundaries. |

All three modes remain subordinate to the same authority envelope, conditional rules, attention tiers, policy checks, and prohibited-action list.

## Attention tiers

The final tier comes from a deterministic action-to-tier table, never from a model suggestion.

| Tier | SMS behavior |
| --- | --- |
| `INFORMATIONAL` | Send a concise status; no choice is accepted. |
| `LOW_CONSEQUENCE` | May present two or three labeled choices and accept exact `A`, `B`, or `C` while pending and unexpired. |
| `SENSITIVE` | Do not resolve by SMS; provide an authenticated secure web action. |
| `MATERIAL` | Do not resolve by SMS; provide an authenticated secure web action with consequences and evidence. |
| `PROHIBITED` | Refuse. No link, mode, or owner reply can approve it. |

Only one blocking attention request may be pending for a call. A newer blocking request supersedes the older request and revokes its action tokens.

## Conditional authority

Rules may address refunds, credits, fees, charges, plan changes, cancellation, appointments, or an explicit other category. Monetary rules use `AT_LEAST`, `AT_MOST`, `EXACTLY`, or `ANY` and resolve to `ALLOW`, `ASK`, or `DENY`. Conflicting predicates fail closed. Hard policy denial always wins.

## Semantic call events and commitments

Provider or simulator turns are reduced to stable events such as department reached, human reached, hold started, authentication requested, offer made, case number received, deadline received, commitment confirmed, resolution verified, and call disconnected. Stable deduplication keys prevent repeated updates from duplicate interpretation.

A commitment is `CONFIRMED` only when it contains transcript evidence. Otherwise it remains proposed, rejected, superseded, or unverified. The terminal outcome applies the same evidence rule.

## Message transport and delivery

Inbound messages are written to the durable inbox before interpretation. Outbound message intents are written to the durable outbox before provider submission. Provider IDs and idempotency keys prevent duplicate ingestion and duplicate enqueueing. Inbound processing uses bounded attempts and retry eligibility timestamps before dead-lettering. Outbound provider-send errors are immediately retained as failed or `UNKNOWN` dead-letter deliveries rather than retried automatically, because a transport error can be ambiguous about whether the provider accepted the SMS. Restart can reclaim expired inbound claims; an expired outbound-send lease is dead-lettered without resending. This does not create a carrier exactly-once guarantee.

Provider delivery callbacks may arrive late, more than once, or out of order. Liaison reduces them by semantic progress and retains terminal failure detail. `accepted` or `queued` means the provider accepted work, not that the owner's handset received it.

## SMS composition

The composer estimates GSM-7 or UCS-2 encoding and concatenated segment count. `SMS_MAX_SEGMENTS_PER_MESSAGE` is a composition limit, not a carrier guarantee. When content is too long, optional detail is removed before required action, expiry, amount, consequence, and secure-link fragments. The web thread remains the complete record.

## Compatibility

Adding optional fields or enum-independent metadata may be compatible within v1. Removing fields, changing their meaning, narrowing accepted documents, or changing command authorization semantics requires a new major protocol directory and a documented migration. Runtime Zod validation remains authoritative when a generated artifact and code disagree.
