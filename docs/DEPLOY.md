# Deployment and real-call setup

Complete these steps before enabling a real call. Test only with a telephone number you own or whose participant has agreed to the test.

## 1. Twilio account

1. Create or select a Twilio project and complete identity/trial requirements.
2. In Twilio Console, buy or configure a US number with Voice capability. Record its E.164 number for `TWILIO_FROM_NUMBER`.
3. Copy the Account SID and Auth Token into the deployment secret store, never a committed file. Production API calls should use a restricted Twilio API key if your account policy supports it; signature validation still needs the auth token.
4. Follow the official [ConversationRelay onboarding](https://www.twilio.com/docs/voice/conversationrelay/onboarding). Review and accept the Predictive and Generative AI/ML Features Addendum and confirm ConversationRelay access for the project.
5. No inbound phone-number Voice URL is required for Liaison's outbound path. The application supplies its signed TwiML URL when it creates each call.

## 2. Public service and environment

Deploy a public HTTPS service whose WebSocket upgrade path is also reachable through WSS. Set:

```text
NODE_ENV=production
PUBLIC_BASE_URL=https://liaison.example.com
PUBLIC_WSS_URL=wss://liaison.example.com
DATABASE_PATH=/data/liaison.db
APP_ACCESS_KEY=<long unique key>
SESSION_SECRET=<random 32+ bytes>
CALL_TOKEN_SECRET=<different random 32+ bytes>
TELEPHONY_MODE=twilio
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=<secret>
TWILIO_FROM_NUMBER=+1...
ALLOW_REAL_CALLS=false
```

Leave `ALLOW_REAL_CALLS=false` through initial health, login, and simulator testing. Configure OpenAI separately only if wanted. Public URLs must exactly match the externally observed scheme, host, port, and path used for Twilio signatures. Set `TRUST_PROXY=true` only behind a trusted proxy that overwrites forwarding headers.

## 3. Railway

1. Create a Railway service from this repository; `railway.json` selects the Dockerfile.
2. Attach a persistent volume mounted at `/data`; set `DATABASE_PATH=/data/liaison.db`.
3. Add the environment values above in Railway Variables. Set `PUBLIC_BASE_URL` and `PUBLIC_WSS_URL` to the assigned/custom domain.
4. Deploy. Confirm `/health` and `/ready`, log in, run every relevant simulator scenario, and review the production configuration badges.
5. Enable WebSocket support through any upstream proxy. Railway supports upgrades on public services.
6. Only after the tests pass, set `ALLOW_REAL_CALLS=true`, redeploy, and place one owned/consenting-number test from the plan review screen.

## 4. Cloudflare Tunnel for local development

Use a named tunnel with a stable hostname. Cloudflare's current quick tunnels are testing-only and do not support Server-Sent Events, which Liaison uses for browser updates.

1. Install `cloudflared`, run `cloudflared tunnel login`, then create a tunnel: `cloudflared tunnel create liaison-dev`.
2. Route a hostname you control: `cloudflared tunnel route dns liaison-dev liaison-dev.example.com`.
3. Create the `cloudflared` configuration described in the official [Tunnel setup guide](https://developers.cloudflare.com/tunnel/setup/) with that hostname routed to `http://localhost:3000` and a final `http_status:404` ingress rule.
4. Set `PUBLIC_BASE_URL=https://liaison-dev.example.com` and `PUBLIC_WSS_URL=wss://liaison-dev.example.com`. Configure non-empty `APP_ACCESS_KEY`, `SESSION_SECRET`, and `CALL_TOKEN_SECRET`; never expose the development bypass publicly.
5. Start Liaison, then `cloudflared tunnel run liaison-dev`. Confirm `/health`, `/ready`, authenticated SSE updates, and the ConversationRelay WebSocket upgrade before a test call.

Twilio signatures depend on the exact public URL, so restart Liaison after changing either public URL. Do not use `cloudflared tunnel --url ...` for full Liaison testing while Cloudflare documents the quick-tunnel SSE limitation.

## 5. First real-call checklist

- Number came from an official source; destination is owned/consenting for testing.
- The case is low-risk and for an authorized account.
- Real-call privacy notice has been reviewed.
- Plan version is approved; cost and duration caps are correct.
- Twilio Debugger is open, service logs are available, and no recording setting is enabled.
- Place one call. Confirm the setup event, textual IVR selection, human disclosure, consent, transcript, pause, approval, exact text, hang-up, and report export.

ConversationRelay's current protocol accepts `text`, `sendDigits`, and `end` frames. Incoming setup, finalized prompt, DTMF, interrupt, error, and close are implemented. This repository selects documented defaults for en-US voice/transcription rather than pinning a provider/voice tuple likely to drift.

## Operations

Use Twilio Debugger plus structured request/call IDs to inspect failures. Rotate `APP_ACCESS_KEY`, session/call secrets, and Twilio credentials in the provider and deployment secret store; active sessions and signed links should be treated as invalid after rotation. Stop all new real calls immediately by setting `ALLOW_REAL_CALLS=false` or `TELEPHONY_MODE=simulator` and redeploying. To stop an active call, use Hang up before disabling the service.

Run `npm run retention:production` periodically in the deployed image (`npm run retention` is the source-mode equivalent). Back up SQLite with a volume snapshot while the service is stopped, or use SQLite's online backup command against `/data/liaison.db`; copy the WAL/SHM consistently if using raw filesystem copies. Test restore procedures. No automatic external backup is configured.
