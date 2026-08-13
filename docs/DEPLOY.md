# Deployment

The complete operator guide is [SELF_HOSTING.md](SELF_HOSTING.md); use [DEPLOYMENT_CHECKLIST.md](DEPLOYMENT_CHECKLIST.md) for a release gate and [TWILIO_SETUP.md](TWILIO_SETUP.md) for optional provider configuration.

## Safe production profile

Build the repository's Dockerfile or use `docker compose`. A first deployment should use:

```text
NODE_ENV=production
PORT=3000
PUBLIC_BASE_URL=https://liaison.example.com
PUBLIC_WSS_URL=wss://liaison.example.com
DATABASE_PATH=/data/liaison.db

INSTANCE_MODE=personal
APP_ACCESS_KEY=<long unique value>
SESSION_SECRET=<independent random 32+ characters>
CALL_TOKEN_SECRET=<independent random 32+ characters>
ACTION_LINK_SECRET=<independent random 32+ characters>

LLM_MODE=mock
MESSAGING_MODE=web
ALLOW_REAL_MESSAGING=false
TELEPHONY_MODE=simulator
ALLOW_REAL_CALLS=false
```

Generate a complete environment interactively with `npm run setup`, then run `npm run doctor`. Production rejects missing core security secrets or insecure public origins. Keep `.env` out of the image and repository.

## Docker Compose

```bash
docker compose build
docker compose up -d
docker compose ps
```

The named `liaison-data` volume is mounted at `/data`. Back it up consistently and test restoration. Compose runs only Liaison; add a reverse proxy separately. The optional `examples/Caddyfile` shows a minimal Caddy reverse proxy when both services share a network.

## Railway

1. Create a service from the repository. `railway.json` selects the Dockerfile and `/health` check.
2. Attach a persistent volume at `/data` and set `DATABASE_PATH=/data/liaison.db`.
3. Add all production variables in Railway Variables, using the assigned/custom HTTPS origin for `PUBLIC_BASE_URL` and its WSS equivalent for `PUBLIC_WSS_URL`.
4. Deploy with mock/web/simulator modes and both allow flags false.
5. Confirm `/health`, `/ready`, login, `npm run doctor` in the deployment environment where practical, the messaging demo, and the browser simulator workflow.
6. Confirm the public service supports WebSocket upgrades and unbuffered SSE.
7. Configure and enable one live provider at a time only after its checklist passes.

The Docker entrypoint prepares volume permissions and then drops to the unprivileged `liaison` user. Do not override the container user unless the mounted volume is already writable and the security effect is understood.

## Reverse proxy

TLS must use a publicly trusted certificate for provider callbacks. Preserve the external host and scheme, WebSocket upgrade headers, request bodies, and unknown Twilio form fields. Avoid SSE response buffering. Set `TRUST_PROXY=true` only behind a trusted proxy that overwrites forwarding headers.

Twilio signs the exact URL it requested. A mismatch between proxy-visible and configured scheme/host/port/path causes correct signature rejection. Do not work around it by disabling validation.

## Cloudflare Tunnel for development

Use a named tunnel with a stable hostname and follow Cloudflare's current [Tunnel setup guide](https://developers.cloudflare.com/tunnel/setup/). Configure the hostname to `http://localhost:3000`, then use matching HTTPS/WSS public origins. Confirm that the chosen tunnel mode supports both WebSockets and Server-Sent Events; product limitations can change.

Never expose the local development login bypass. Set all security secrets and an access key before starting a public tunnel. A tunnel does not make the deployment production-ready or persist SQLite.

## Optional providers

- OpenAI: set `LLM_MODE=openai` and `OPENAI_API_KEY`; test quota separately because doctor makes no paid request.
- Twilio SMS: set `MESSAGING_MODE=twilio_sms`, owner and sender variables, then follow the exact inbound/status paths in [TWILIO_SETUP.md](TWILIO_SETUP.md).
- Twilio voice: set `TELEPHONY_MODE=twilio`, voice credentials/sender, complete ConversationRelay onboarding, and preserve signed HTTP/WSS routes.

Credentials and selected mode are not enough. `ALLOW_REAL_MESSAGING=true` and `ALLOW_REAL_CALLS=true` are separate final switches.

## Operations

- Use `/health` for liveness and `/ready` for readiness.
- Use structured request, message, case, and call IDs in logs; never log bodies or credentials.
- Inspect Twilio Debugger for provider failures and delivery/call state, without treating provider acceptance as completion.
- Run `npm run retention:production` from an operator-managed scheduler.
- Back up SQLite with a stopped-volume snapshot or online backup tooling; raw copies must include a consistent WAL state.
- Rotate secrets after exposure and understand which sessions, call URLs, and action links become invalid.
- Disable real messaging/calling and redeploy before investigating an authorization, routing, signature, or cost anomaly.

No automatic external backup, monitoring service, deployment rollback, or provider failover is configured by this repository.
