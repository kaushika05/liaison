# Twilio SMS and ConversationRelay setup

This guide configures the optional Twilio transports. It does not prove that a particular Twilio project, sender, registration, region, or destination is ready. Provider products, console labels, prices, and legal requirements change; verify the current Twilio Console and documentation before live use.

Test only with a phone number you control and a support destination whose participant has agreed to the test. Liaison is not a marketing, campaign, emergency, or high-risk calling tool.

## 1. Prepare the Twilio project

1. Complete Twilio account identity, trial, geographic-permission, and messaging-registration requirements for your intended US traffic.
2. Obtain a Twilio sender with the needed SMS and Voice capabilities. One number can be used for both when its capabilities and registration allow it; separate numbers are also supported through separate environment variables.
3. Keep the Account SID and Auth Token in the deployment secret store. The auth token is needed for webhook-signature validation even if a restricted API key is later used for outbound API authorization.
4. Review current [Twilio Messaging compliance guidance](https://www.twilio.com/docs/messaging/compliance) and current [Messaging pricing](https://www.twilio.com/en-us/messaging/pricing). This repository does not determine consent, registration, tax, or carrier obligations for you.

Do not paste credentials into issues, logs, screenshots, source files, or chat transcripts.

## 2. Configure a Messaging Service

A Messaging Service is recommended because it groups sender configuration, inbound routing, delivery callbacks, and opt-out behavior. Follow Twilio's [Messaging Services setup](https://www.twilio.com/docs/messaging/services):

1. Create a Messaging Service for the support-assistant use case.
2. Add the SMS-capable sender to its sender pool.
3. In the Integration settings, route incoming messages by HTTP `POST` to:

   ```text
   https://liaison.example.com/webhooks/twilio/messaging/inbound
   ```

4. Configure delivery status callbacks by HTTP `POST` to:

   ```text
   https://liaison.example.com/webhooks/twilio/messaging/status
   ```

Liaison also supplies the message-specific status callback on outbound API requests. Twilio documents that a message-specific callback takes precedence over the service-level callback; keep both values identical to avoid confusing duplicate routes. See [tracking outbound message status](https://www.twilio.com/docs/messaging/guides/track-outbound-message-status).

If you do not use a Messaging Service, configure the number's incoming-message webhook to the same inbound path and set `TWILIO_SMS_FROM_NUMBER` instead of `TWILIO_MESSAGING_SERVICE_SID`.

## 3. Configure opt-out behavior

Twilio applies standard STOP filtering to supported SMS senders. A Messaging Service can use [Advanced Opt-Out](https://www.twilio.com/docs/messaging/tutorials/advanced-opt-out), which can send an `OptOutType` value of `STOP`, `START`, or `HELP` to the inbound webhook after matching a configured keyword.

Liaison records the provider opt-out signal, refuses later unsent Twilio submissions as the worker claims them, and avoids sending a second response when Twilio has already handled the confirmation. It cannot recall a message already accepted by Twilio or a carrier. Align provider keywords and help text with the application's documented `STOP`, `START`, and `HELP` commands. Test STOP and the correct re-subscribe keyword for the sender type from the owner phone before live use. Carrier and sender-type behavior can differ, especially for toll-free numbers.

Opt-out handling is a floor, not a complete legal-compliance program. This personal agent must not be repurposed for bulk or promotional traffic.

## 4. Configure ConversationRelay

1. Complete the official [ConversationRelay onboarding](https://www.twilio.com/docs/voice/conversationrelay/onboarding), including any current Predictive and Generative AI/ML terms required for the project.
2. Set a voice-capable Twilio number as `TWILIO_VOICE_FROM_NUMBER`.
3. No inbound Voice URL is needed for Liaison's outbound-only call path. For each authorized call, Liaison supplies a short-lived voice webhook URL:

   ```text
   https://liaison.example.com/webhooks/twilio/voice/<signed-token>
   ```

4. Twilio status callbacks use:

   ```text
   https://liaison.example.com/webhooks/twilio/status/<signed-token>
   ```

5. The returned TwiML connects the call to the server's signed ConversationRelay WSS path. The server validates the WebSocket signature and checks account/call identity before accepting relay frames.

Relevant official references are the [outbound Calls API guide](https://www.twilio.com/docs/voice/tutorials/how-to-make-outbound-phone-calls), [`<ConversationRelay>` reference](https://www.twilio.com/docs/voice/twiml/connect/conversationrelay), and [ConversationRelay WebSocket messages](https://www.twilio.com/docs/voice/conversationrelay/websocket-messages).

## 5. Set environment variables

Start with both allow flags false:

```text
NODE_ENV=production
PUBLIC_BASE_URL=https://liaison.example.com
PUBLIC_WSS_URL=wss://liaison.example.com

INSTANCE_MODE=personal
OWNER_PHONE_E164=+13045550123

TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=<secret>

MESSAGING_MODE=twilio_sms
TWILIO_MESSAGING_SERVICE_SID=MG...
TWILIO_SMS_FROM_NUMBER=
ALLOW_REAL_MESSAGING=false

TELEPHONY_MODE=twilio
TWILIO_VOICE_FROM_NUMBER=+13045550199
ALLOW_REAL_CALLS=false
```

Use either the Messaging Service SID or the direct SMS sender. `TWILIO_FROM_NUMBER` remains a backward-compatible voice alias, but new deployments should use `TWILIO_VOICE_FROM_NUMBER`.

`OWNER_PHONE_E164` is the only SMS principal and must be an exact E.164 value. Messages from other numbers are rejected and answered with empty TwiML, so the sender learns nothing about whether an instance exists. There is no setting that enables a reply to an unauthorized sender; the rejection is recorded as a provider security event and surfaced as a count in the messaging setup panel. The browser remains protected by `APP_ACCESS_KEY` and signed sessions.

Run:

```bash
npm run doctor
```

Doctor validates local configuration only. It does not query Twilio, send SMS, or place a call.

## 6. Validate callbacks safely

Twilio signs webhook requests using the exact URL and all form parameters. Liaison validates through the official Twilio SDK, following [Twilio webhook security guidance](https://www.twilio.com/docs/usage/webhooks/webhooks-security). A reverse proxy must preserve the public host and scheme. `PUBLIC_BASE_URL` must exactly match the URL Twilio calls.

Before enabling real sends, confirm in a staging instance:

- a missing or invalid signature is rejected;
- a valid request from a non-owner number does not create a case;
- a duplicate `MessageSid` is idempotent;
- `NumMedia>0` is rejected with a text-only explanation for the owner;
- a prohibited credential-like value is redacted before persistence and not used;
- STOP updates local consent, prevents later provider submission of unsent work, and leaves those claimed rows visibly failed rather than silently sending them;
- status callbacks move delivery forward without regressing on late or duplicate events;
- an undelivered/failed callback remains visible with redacted diagnostics.

Twilio sends inbound messaging webhooks as `application/x-www-form-urlencoded` and may add parameters over time; do not place a proxy in front that drops unknown form fields. See [Twilio's inbound webhook request](https://www.twilio.com/docs/messaging/guides/webhook-request).

## 7. Enable one capability at a time

After the browser/mock/simulator slice and signed callback tests pass:

1. Set `ALLOW_REAL_MESSAGING=true`, redeploy, and send one message from the configured owner phone.
2. Verify the inbound thread, reply, provider SID, segment estimate, and delivered or undelivered status in both Liaison and Twilio logs.
3. Restore `ALLOW_REAL_MESSAGING=false` while investigating any mismatch.
4. Separately set `ALLOW_REAL_CALLS=true`, redeploy, and authorize one simulator-reviewed plan to call an owned/consenting test destination.
5. Verify disclosure, transcript, interruption, pause, attention, hang-up, terminal callback, and grounded outcome.

Provider `accepted` or `queued` status is not handset delivery. A successful call-create response is not a completed call. Record the exact live evidence rather than inferring it.

## Troubleshooting

### Signature validation fails

Compare Twilio's requested URL with `PUBLIC_BASE_URL` character for character. Check the external scheme, host, port, path, query encoding, auth token/project, and proxy forwarding configuration. Do not disable signature validation to make a test pass.

### Inbound SMS reaches Twilio but not Liaison

Confirm the sender is attached to the intended Messaging Service, its inbound handling is set to the webhook rather than Conversations, the method is POST, TLS is valid, and the public route is reachable. Twilio describes this routing in [Messaging Services](https://www.twilio.com/docs/messaging/services).

### Outbound status stays accepted or queued

The initial API response may not trigger a callback for its initial state. Later status callbacks report progress such as queued, sent, delivered, failed, or undelivered. Consult [Twilio's outbound status lifecycle](https://www.twilio.com/docs/messaging/guides/outbound-message-status-in-status-callbacks) and Twilio Debugger.

### STOP prevents later replies

That is expected. Test the sender-type-specific opt-in keyword from the owner phone and verify both Twilio and local consent state. An application send to an opted-out number can fail asynchronously.

### ConversationRelay does not connect

Confirm project onboarding/terms, WSS reachability, TLS, WebSocket upgrade support, exact public URL, Twilio signature, account SID, call SID, and Twilio Debugger events. Keep real calls disabled while fixing configuration.
