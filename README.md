# Liaison

Liaison is a single-user, accessibility-first web application for supervising low-risk customer-support calls entirely through text. It creates an editable call brief, requires explicit authorization, places a call through Twilio ConversationRelay when deliberately enabled, shows every important call state and transcript turn, pauses for sensitive decisions, and produces an evidence-grounded outcome report.

The core invariant is simple: no important information, warning, request, decision, or call state exists only in audio.

## What is included

- Access-key login with a local-development bypass, signed HTTP-only sessions, origin checks, security headers, request limits, and failed-login throttling.
- Manual US support-number entry and low-risk-use screening. Liaison validates number shape; it does not verify company ownership.
- Deterministic mock planning and ten simulator scenarios that require neither Twilio nor OpenAI credentials.
- Editable plans, explicit plan approval, authority limits, ephemeral disclosure cards, and hard-denied credential categories.
- A tested call state machine, append-only audit events, SQLite persistence, authenticated SSE updates, speaker-labeled transcripts, approval cards, pause/resume, private steering, exact text, and hang-up.
- Official OpenAI JavaScript SDK using the Responses API and strict Zod structured outputs when `LLM_MODE=openai`.
- A real Twilio outbound Calls API path, generated `<Connect><ConversationRelay>` TwiML, HTTP and WebSocket signature validation, setup identity checks, finalized prompt handling, DTMF, text speech, interruption invalidation, status callbacks, and safe termination.
- Transcript-grounded outcome validation plus JSON and plain-text export.
- WCAG-oriented semantic UI, keyboard controls, visible focus, urgent-focus movement, text labels, large-text and contrast controls, reduced motion, responsive layouts, and text-only status parity.
- Tests, one-process production build, non-root Docker image, Railway configuration, retention command, and operations documentation.

Liaison intentionally excludes multi-user accounts, number discovery, browser automation, inbound or international calling, high-risk domains, recording, payment handling, scheduled/background/retry calls, multiple LLM agents, and self-hosted voice inference.

## Quick start (free simulator)

Requirements: Node.js 22 or newer.

```bash
npm install
cp .env.example .env
npm run dev
```

On Windows PowerShell, use `Copy-Item .env.example .env`. Open `http://localhost:3000`. With the safe development defaults, the login screen clearly offers local access, planning is deterministic, the simulator is active, and real calls are disabled.

Create a case, review and edit its plan, select any demo scenario, then choose **Approve plan and start simulation**. The cancellation and sensitive-information scenarios stop on a real approval card. All ten scenarios use the same state machine, policy, audit store, UI, report compiler, and control endpoints as live mode.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run the Fastify server and Vite development middleware |
| `npm run check` | Lint, type-check, run unit/integration tests, and production-build |
| `npm run test:e2e` | Run the Playwright browser workflow |
| `npm run build` | Build the client and server |
| `npm start` | Run the production build |
| `npm run retention` | Delete completed cases older than `DATA_RETENTION_DAYS` |
| `npm run retention:production` | Run the compiled retention command inside a production image |

## Configuration

`.env.example` contains every variable and safe defaults.

- Required in production: `APP_ACCESS_KEY`, `SESSION_SECRET`, `CALL_TOKEN_SECRET`, public HTTPS/WSS URLs.
- Required only for OpenAI mode: `LLM_MODE=openai`, `OPENAI_API_KEY`. Model names and reasoning effort remain configurable. Defaults are GPT-5.6 Luna at low effort.
- Required only for live Twilio: `TELEPHONY_MODE=twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `PUBLIC_BASE_URL=https://…`, and `PUBLIC_WSS_URL=wss://…`.
- Real calling additionally requires `ALLOW_REAL_CALLS=true`. It defaults to false even with credentials present.

Production refuses to start with missing security secrets or insecure public URLs. OpenAI and Twilio requirements are validated only when their modes are used. Logs emit configuration status but omit secret values.

## Security, privacy, and cost boundaries

Liaison is a supervised accessibility relay, not a general-purpose autonomous caller. It accepts only a user-entered US number, permits one active call, enforces a daily limit and hard duration, never redials, and blocks detected high-risk categories. Keyword screening is only a warning layer and cannot prove a call is safe.

The application does not request call recording or intentionally store audio. Twilio and its configured transcription/TTS providers necessarily process telephone audio. Redacted text transcripts, events, approvals, and outcomes are stored in SQLite. Temporary disclosure values exist only in server memory, never enter the database, model context, SSE payloads, or ordinary logs, and are cleared after termination. A server restart deliberately loses those values.

The displayed call cost is a configurable estimate, not an invoice. It excludes taxes, number rental, provider-specific prices, and future changes. See [SECURITY.md](docs/SECURITY.md), [PRIVACY.md](docs/PRIVACY.md), and [COSTS.md](docs/COSTS.md).

## Live calls and deployment

Follow [DEPLOY.md](docs/DEPLOY.md) exactly. It covers Twilio setup and the AI/ML addendum, a voice-capable US number, public TLS/WSS endpoints, Railway persistent storage, Cloudflare Tunnel development, deliberate real-call activation, testing only with owned or consenting destinations, credential rotation, and the calling kill switch.

The current Twilio integration follows the official [outbound Calls API guide](https://www.twilio.com/docs/voice/tutorials/how-to-make-outbound-phone-calls), [`<ConversationRelay>` reference](https://www.twilio.com/docs/voice/twiml/connect/conversationrelay), [WebSocket message protocol](https://www.twilio.com/docs/voice/conversationrelay/websocket-messages), and [webhook signature guidance](https://www.twilio.com/docs/usage/webhooks/webhooks-security). The OpenAI integration follows the official [Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs) using `responses.parse` with `zodTextFormat`.

## Troubleshooting

- Login shows local access only when `NODE_ENV` is not production and `APP_ACCESS_KEY` is blank.
- Real-call control stays disabled until Twilio credentials, HTTPS/WSS URLs, mode, and the real-call flag are all complete.
- A high-risk warning blocks live calls; edit the case rather than attempting an override.
- Twilio signature failures usually mean the configured public URL does not exactly match the URL Twilio requested through the proxy.
- ConversationRelay requires account onboarding. Inspect Twilio Debugger and structured server logs using the request/call ID.
- SQLite must be on persistent writable storage in production. Back it up with a filesystem snapshot while the service is stopped or with SQLite's online backup tooling.

## Additional documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Security](docs/SECURITY.md)
- [Privacy](docs/PRIVACY.md)
- [Costs](docs/COSTS.md)
- [Deployment](docs/DEPLOY.md)
- [Future open-source voice migration](docs/OPEN_SOURCE_VOICE_MIGRATION.md)
