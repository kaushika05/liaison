# Liaison Universal Support Protocol

The Liaison Universal Support Protocol is this project's open, versioned data contract for supervised customer-support work. It separates what a person wants, what an agent may do, what requires attention, what each party committed to, and what the evidence supports from any particular user interface or provider.

This directory currently contains protocol version 1. It is a project protocol, not an industry standard.

## Implementation status

Every version 1 schema is served or enforced by the reference implementation:

| Schema | How the implementation uses it |
| --- | --- |
| `authority-envelope` | Parsed and applied on every call decision. |
| `outcome-report` | Validated against transcript evidence before storage. |
| `execution-plan` | Served from `GET /api/cases/:caseId/execution-plan`. |
| `support-intent` | Embedded in every `ExecutionPlan`. |
| `attention-request` | Served from `GET /api/attention/:id`. |
| `commitment` | Served from `GET /api/cases/:caseId/commitments`. |
| `disclosure-event` | Emitted to the audit log when an approved disclosure executes. |

Internal storage keeps its own record shapes so it can evolve independently.
[`src/server/protocol/projection.ts`](../src/server/protocol/projection.ts) is the single boundary
that maps those records onto protocol documents, and every projection ends in a `schema.parse`, so a
document that no longer satisfies the contract throws rather than being served.

Attention tiers, semantic call events, conditional authority rules, autonomy modes, and
support-thread states — also defined in `src/shared/protocol.ts` — are enforced on the live call path.

`tests/integration/protocol-surface.test.ts` asserts the API responses parse against these schemas.

## Version 1

The JSON Schema files in [`v1/`](v1/) cover:

- `support-intent`: the user's issue, goal, constraints, known information, and autonomy preference.
- `authority-envelope`: explicit `ALLOW`, `ASK`, and hard `DENY` boundaries.
- `execution-plan`: a version-bound wrapper around the existing Liaison call brief, authority, autonomy mode, and conditional rules.
- `attention-request`: a finite, expiring decision with a deterministic attention tier.
- `commitment`: a proposed, confirmed, rejected, superseded, or unverified commitment and its evidence.
- `disclosure-event`: metadata about a consented disclosure without the sensitive value.
- `outcome-report`: the existing evidence-grounded call result.

Representative documents are in [`v1/examples/`](v1/examples/).

## Canonical source and generation

The canonical schemas are Zod definitions in [`src/shared/protocol.ts`](../src/shared/protocol.ts) and the existing compatible definitions in [`src/shared/domain.ts`](../src/shared/domain.ts). Do not edit generated JSON Schema files by hand.

From the repository root, regenerate them with:

```bash
npx tsx scripts/generate-protocol-schemas.ts
```

The generator uses the installed Zod 4 `toJSONSchema` implementation and emits JSON Schema Draft 2020-12. Generated documents use the reserved `.invalid` namespace for stable schema identifiers; no network lookup or Liaison-operated service is required.

## Compatibility

Version 1 uses a required `protocolVersion: 1` discriminator on newly introduced wrapper documents. `ExecutionPlan.callBrief`, `ExecutionPlan.authority`, and `OutcomeReport` reuse the application's canonical schemas so protocol artifacts and the existing call path do not drift.

Breaking changes require a new major-version directory. Backward-compatible clarifications and tighter documentation may be released without changing the major version, but operators should still validate documents against the exact schema revision distributed with their deployment.
