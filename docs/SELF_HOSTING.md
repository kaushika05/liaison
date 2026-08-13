# Self-hosting Liaison

Liaison is one Node.js service with one SQLite database. It has no Redis, Postgres, external queue, analytics collector, or required cloud account. The default browser messaging, mock-model, and call-simulator path runs without Twilio or OpenAI credentials.

## Operating assumptions

- One trusted owner operates one personal instance.
- The host and browser session are private; this is not tenant isolation.
- Public HTTPS is required for production and for Twilio callbacks.
- The SQLite database and backups contain sensitive support data.
- Real SMS and real calls are independent opt-in capabilities and may incur provider charges.

## Local safe start

Requirements: Node.js 22 or newer and npm.

```bash
npm ci
npm run setup
npm run doctor
npm run dev
```

`npm run setup` interactively creates `.env`, generates independent secrets, prints the access key once, and leaves real messaging and calling disabled. For a non-interactive local file with safe defaults:

```bash
npm run setup -- --defaults --output=.env
```

If `.env` exists, setup asks before replacing it. `npm run doctor` validates configuration, secret strength, database writability/migrations, public URL shape, and enabled-provider prerequisites without sending a message, placing a call, or invoking a paid model.

Open `http://localhost:3000`, sign in with the printed access key, and exercise the browser thread. Run the deterministic vertical slice separately with:

```bash
npm run demo:messaging
```

The demo must remain in web/mock/simulator modes and must not need credentials.

## Docker Compose

Copy `.env.example` to `.env`, replace every production secret, and set the exact public origins. Then:

```bash
docker compose build
docker compose up -d
docker compose ps
```

The included Compose file runs one `liaison` service, publishes port 3000 by default, and stores `/data/liaison.db` in the named `liaison-data` volume. Change the host port with `LIAISON_PORT` in the shell that runs Compose; do not add it to Liaison's application environment unless intended.

Inspect health and logs:

```bash
curl --fail http://127.0.0.1:3000/health
docker compose logs --tail=200 liaison
```

The container starts as root only long enough to make the mounted `/data` directory writable, then executes the Node.js process as the unprivileged `liaison` user.

## Configuration profiles

### Browser-only, no paid providers

```text
LLM_MODE=mock
MESSAGING_MODE=web
ALLOW_REAL_MESSAGING=false
TELEPHONY_MODE=simulator
ALLOW_REAL_CALLS=false
```

This is the recommended first deployment and remains useful as the production fallback.

### OpenAI structured outputs

Set `LLM_MODE=openai` and add `OPENAI_API_KEY`. `OPENAI_BASE_URL` is an advanced compatibility option and should normally stay empty. The planner, controller, and outcome model names and reasoning effort are independently configurable. The doctor checks presence only; it does not spend tokens or prove account quota.

### Twilio SMS and voice

Follow [TWILIO_SETUP.md](TWILIO_SETUP.md). Configure and test one capability at a time. Credentials alone do not enable either capability; its mode and `ALLOW_REAL_*` flag must also be set.

## Reverse proxy and TLS

Production startup refuses plain HTTP/WSS public origins. Put Liaison behind a reverse proxy with a publicly trusted certificate. The optional [Caddyfile](../examples/Caddyfile) is a minimal starting point; it is not included as a second Compose service.

Set:

```text
NODE_ENV=production
PUBLIC_BASE_URL=https://liaison.example.com
PUBLIC_WSS_URL=wss://liaison.example.com
```

The reverse proxy must pass the original host and scheme, support WebSocket upgrades, and avoid buffering Server-Sent Events. Set `TRUST_PROXY=true` only when the proxy is trusted and overwrites client-provided forwarding headers. Twilio signature validation uses exact externally observed callback URLs, including scheme, host, port, path, and encoded query.

## Persistence, backup, and restore

The default container database path is `/data/liaison.db`. SQLite may also create WAL and shared-memory files beside it.

For a simple consistent backup, stop the service, snapshot or copy the named volume, and restart it. For online operation, use SQLite's online backup tooling rather than copying only the main database file. Encrypt backups, restrict access, apply a retention period, and test restore into an isolated instance with both real-use flags disabled.

Upgrades run idempotent schema migrations at startup. Before upgrading:

1. record the running image tag or commit;
2. take and verify a consistent backup;
3. review `CHANGELOG.md` for protocol or configuration changes;
4. deploy with real messaging and calling disabled when the change touches migrations, provider callbacks, authorization, or call control;
5. run doctor and the safe demo before re-enabling providers.

Do not downgrade a migrated database unless the target release explicitly documents downgrade compatibility.

## Retention and deletion

`DATA_RETENTION_DAYS` controls the completed-case retention window. Liaison does not install a scheduler. Run `npm run retention:production` in the production image on an operator-controlled schedule. Deletion cannot erase copies retained in provider systems, logs, or older backups; manage those separately.

## Health and recovery

- `/health` proves the process is serving HTTP.
- `/ready` checks readiness required to accept work.
- `npm run doctor` is an operator diagnostic and does not make provider calls.
- A restart reloads durable messaging and call state. Ephemeral disclosure values are intentionally lost and cannot be reconstructed.
- Inbound interpretation retries are bounded. An outbound provider-send error is not retried automatically because acceptance may be ambiguous; the failed message remains inspectable, and Liaison does not silently switch providers.
- There is no automatic call retry or redial after a failure.

## Kill switches

To stop new SMS sends, set `ALLOW_REAL_MESSAGING=false` or `MESSAGING_MODE=web` and redeploy. To stop new calls, set `ALLOW_REAL_CALLS=false` or `TELEPHONY_MODE=simulator` and redeploy. Use the authenticated hang-up control for an already active call before taking the service offline.

Rotate the access key, session secret, call-token secret, action-link secret, Twilio credentials, and OpenAI key in their respective systems after suspected exposure. Rotation invalidates related sessions or links; record the operational impact before changing a secret during an active call.

## Production checklist

Use [DEPLOYMENT_CHECKLIST.md](DEPLOYMENT_CHECKLIST.md) before enabling any live provider. Read [SECURITY.md](SECURITY.md), [PRIVACY.md](PRIVACY.md), and [COSTS.md](COSTS.md) as operator requirements, not optional background.
