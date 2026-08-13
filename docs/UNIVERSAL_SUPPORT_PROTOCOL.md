# Universal Support Protocol

Liaison Universal Support Protocol version 1 models a bounded delegation relationship for customer-support work. Its purpose is to make the user's intent, the approved execution plan, the agent's authority, decision boundaries, commitments, disclosures, and verified outcome inspectable as data.

The protocol is maintained by this project. It is not an industry standard and does not claim compatibility with unrelated support systems.

## Provider- and channel-neutral boundary

The protocol deliberately does not encode a particular:

- User messaging channel, such as the secure web thread or SMS.
- Support execution channel, such as a supervised telephone call.
- Model provider.
- Telephony provider.
- User interface.

Adapters translate provider events into protocol-backed application operations. Deterministic application state and policy remain authoritative; a model may propose structured content but cannot grant itself authority or assign the final attention tier.

## Core documents

### Support intent

`SupportIntent` captures who the support request is for, the company and user-supplied official number, the issue and chronology, the desired outcome, acceptable alternatives, unacceptable outcomes, known facts, unresolved questions, and the selected autonomy mode. It makes missing information explicit and does not authorize a call.

### Execution plan

`ExecutionPlan` binds an intent and the existing `CallBrief` to one positive plan version. It includes the exact `AuthorityEnvelope`, autonomy mode, and structured conditional-authority rules. Its identifiers, version, autonomy mode, and authority must agree with the wrapped documents. Changing those plan inputs requires a new version and invalidates any authorization bound to the old version.

### Authority

The authority envelope is the source of action-specific permissions. `ASSIST`, `COPILOT`, and `DELEGATE` are interaction presets; they never weaken hard denials. Conditional rules can refine approved outcomes with deterministic integer-cent comparisons, but hard policy wins and conflicting rules are rejected or surfaced rather than guessed through.

### Attention request

An `AttentionRequest` records a representative's request, the current goal, proposed action, consequences, a finite set of choices, timing, and resolution metadata. Deterministic policy assigns one tier:

- `INFORMATIONAL`: no decision is required.
- `LOW_CONSEQUENCE`: an unexpired pending choice may be resolved through an authenticated SMS sender.
- `SENSITIVE`: review and resolution require the secure web application; sensitive values never belong in SMS.
- `MATERIAL`: the secure web application and explicit confirmation are required.
- `PROHIBITED`: the action cannot be approved.

Only low-consequence requests are SMS-resolvable. Silence, an expired request, a stale message, or a reply with no currently pending eligible request is not approval.

### Commitments, disclosures, and evidence

`Commitment` distinguishes the committing party and whether the item is proposed, confirmed, rejected, superseded, or unverified. A confirmed commitment requires at least one `EvidenceReference`, which names a transcript turn and its exact supporting excerpt. An unverified statement may be stored as unverified, but it must not be presented as a confirmed commitment.

`DisclosureEvent` stores consent and delivery metadata only. It intentionally has no field for the sensitive disclosure value. Values remain in the separate ephemeral disclosure-card workflow.

`OutcomeReport` reuses Liaison's existing evidence-grounded outcome schema. Grounded fields carry transcript evidence, allowing the web application to show what supports each conclusion and the messaging layer to summarize only verified results.

## State and semantic events

The support-thread state is separate from telephone call state. Its pure transition function is implemented in `src/shared/support-thread-state.ts` and tested across every source-and-destination pair. Current plan version, approved version, active call, pending attention request, and messaging opt state are explicit server-owned data; they are not inferred from the latest message.

`SemanticCallEvent` represents meaningful facts such as reaching a department, going on hold, receiving an offer, confirming a commitment, receiving a case number, or verifying a resolution. Evidence is mandatory for facts, case numbers, and deadlines. Stable event keys allow equivalent events to be deduplicated so user messaging can remain concise instead of becoming a transcript stream.

## Schemas and examples

The versioned JSON Schemas and representative instances are under [`protocol/v1`](../protocol/v1). The canonical Zod schemas live in [`src/shared/protocol.ts`](../src/shared/protocol.ts); generated files should be recreated with:

```bash
npx tsx scripts/generate-protocol-schemas.ts
```

Protocol schemas validate structure. They do not replace runtime checks for ownership, freshness, single-use authorization, one-active-call limits, provider configuration, delivery state, or hard safety policy.
