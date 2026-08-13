# Messaging migration baseline

Captured on 2026-08-12 at 17:20 EDT, before the SMS-first migration changed application behavior.

## Repository state

- Branch: `codex/liaison-launch`
- Commit: `4b6e63c`
- Working tree: clean before and after validation
- Runtime shape: one Fastify process serving the React client, JSON/SSE APIs, Twilio Voice webhooks, and the ConversationRelay WebSocket
- Persistence: SQLite, with in-memory call runtime state reconstructed conservatively after restart
- Providers: deterministic simulator by default; OpenAI Responses structured output and Twilio Voice are optional, credential-gated paths
- User model: one local principal authenticated by an HTTP-only signed cookie

## Existing extension points

- `src/server/core/call-service.ts`: central call lifecycle, audit/event publication, approvals, relay input, terminal outcomes, and restart recovery
- `src/server/core/db.ts`: SQLite schema and repositories for cases, calls, events, transcripts, approvals, outcomes, and daily call usage
- `src/server/adapters/telephony.ts`: simulator and Twilio Voice boundary
- `src/server/agent/model.ts`: deterministic and OpenAI-backed structured planning/controller boundary
- `src/shared/domain.ts`: canonical Zod domain contracts
- `src/server/app.ts`: authenticated API, webhook, WebSocket, and static-client composition root
- `src/client/App.tsx`: accessible intake, plan review, supervised live-call cockpit, approval dialog, and grounded outcome UI
- `src/server/simulator/scenarios.ts`: ten deterministic call scenarios used as the provider-free vertical test surface

These seams allow messaging to be added as a provider-neutral orchestrator around the existing call service rather than replacing the proven call engine.

## Validation evidence

### `npm run check`

Result: passed (exit 0) in 39.116 seconds.

- ESLint: passed with no diagnostics
- TypeScript: all three configured projects passed
- Vitest: 6/6 files and 22/22 tests passed; reported duration 4.73 seconds
- Vite production build: passed; 1,875 modules transformed in 1.69 seconds
- Artifacts: JavaScript 523.51 kB (150.88 kB gzip), CSS 15.95 kB (4.14 kB gzip), HTML 0.57 kB
- Advisory only: Vite reported the JavaScript chunk above its 500 kB warning threshold

### `npm run test:integration`

Result: passed (exit 0) in 6.536 seconds; 2/2 files and 6/6 tests passed.

The deterministic simulator exercised all ten scenario IDs and their asserted terminal outcomes:

1. `replacement-success`
2. `ivr-hold`
3. `cancellation-offer`
4. `sensitive-request`
5. `sensitive-no-card`
6. `prohibited-secret`
7. `false-resolution`
8. `automation-refusal`
9. `prompt-injection`
10. `unexpected-disconnect`

### `npm run test:e2e`

Result: passed (exit 0) in 34.621 seconds; 1/1 Playwright workflow passed.

The keyboard-operated supervised workflow covered intake, plan review, simulated calling, pause, exact-text steering, resume, focused approval, completion, export, keyboard focus, and the real-call-disabled guard. The test itself completed in 6.6 seconds.

The runner warned that Vite's development WebSocket port 24678 was already held by a pre-existing `tsx src/server/index.ts` process. This did not affect the isolated Playwright server on port 3100 or the test result; the unrelated process was left untouched.

## Deliberate exclusions

- `npm run smoke:openai` was not part of baseline validation because it calls the external OpenAI API and is neither deterministic nor credential-free.
- No live Twilio call or SMS was placed.
- No production data or provider configuration was changed.

This document records a known-good preservation point. Later migration validation must continue to pass these call-foundation checks while adding the messaging-first workflow.
