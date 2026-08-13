# Deployment checklist

Use this checklist for a new host and after a material upgrade. It does not replace [SELF_HOSTING.md](SELF_HOSTING.md) or [TWILIO_SETUP.md](TWILIO_SETUP.md).

## Before deployment

- [ ] Node.js 22+ or Docker/Compose is installed from a trusted source.
- [ ] The release tag or commit has been reviewed; the container is built locally or pulled from the expected GitHub Container Registry repository.
- [ ] `.env` is outside version control and readable only by the operator/service account.
- [ ] `APP_ACCESS_KEY`, `SESSION_SECRET`, `CALL_TOKEN_SECRET`, and `ACTION_LINK_SECRET` are unique, random values; generated plaintext has been stored safely.
- [ ] `PUBLIC_BASE_URL` is the exact external HTTPS origin and `PUBLIC_WSS_URL` is its exact WSS origin.
- [ ] SQLite points to persistent, writable storage with a tested backup destination.
- [ ] `LLM_MODE=mock`, `MESSAGING_MODE=web`, `TELEPHONY_MODE=simulator`, `ALLOW_REAL_MESSAGING=false`, and `ALLOW_REAL_CALLS=false` for the first start.

## Validate the safe path

- [ ] `npm run doctor` reports no failures.
- [ ] `/health` responds successfully and `/ready` reports ready.
- [ ] Login works without exposing the access key in logs or browser storage.
- [ ] `npm run demo:messaging` completes without provider calls.
- [ ] The browser path completes issue collection, plan review, exact call authorization, a simulator call, attention handling, and grounded outcome.
- [ ] Restarting the service preserves the support thread and leaves no duplicate outbox send.
- [ ] Large text, high contrast, reduced motion, keyboard focus, and a narrow viewport have been checked.

## Reverse proxy and operations

- [ ] TLS uses a publicly trusted certificate and HTTP redirects to HTTPS.
- [ ] WebSocket upgrades, SSE streaming, request bodies, and original host/scheme are preserved.
- [ ] `TRUST_PROXY=true` only when a trusted proxy overwrites forwarding headers.
- [ ] Logs and backups are access-controlled and have retention limits.
- [ ] A restore was tested before relying on backups.
- [ ] The operator knows how to disable both real-use flags and redeploy quickly.

## Before optional Twilio SMS

- [ ] The owner number is correct E.164 and controlled by the operator.
- [ ] The Twilio sender supports SMS and has required registration/compliance for the intended traffic.
- [ ] Inbound webhook is exactly `/webhooks/twilio/messaging/inbound` using POST.
- [ ] Delivery status callback is exactly `/webhooks/twilio/messaging/status` using POST.
- [ ] Messaging Service sender pool, inbound routing, and opt-out behavior are configured and tested from the owner's phone.
- [ ] Invalid signatures, a non-owner sender, duplicate SID, MMS, STOP, and an undelivered callback were tested safely.
- [ ] Only then is `MESSAGING_MODE=twilio_sms` selected and `ALLOW_REAL_MESSAGING=true` set.

## Before optional Twilio voice

- [ ] ConversationRelay onboarding and required AI/ML terms are complete for the project.
- [ ] The voice sender and owned/consenting test destination are correct.
- [ ] Voice/status webhooks and ConversationRelay WSS are reachable and signature validation passes.
- [ ] Simulator scenarios still pass in the deployed build.
- [ ] Only then is `TELEPHONY_MODE=twilio` selected and `ALLOW_REAL_CALLS=true` set for one controlled test.

## After deployment

- [ ] Provider acceptance is not reported as handset delivery or call success.
- [ ] No mock/simulator result is recorded as live-provider validation.
- [ ] Version, configuration mode, backup date, restore evidence, and any live-provider test are recorded in the operator's private runbook.
