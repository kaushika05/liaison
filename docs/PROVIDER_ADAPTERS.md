# Provider adapters

Liaison keeps provider mechanics outside the support-thread orchestrator. The orchestrator owns state, authorization, policy, persistence, composition, retries, attention, and call coordination. An adapter owns only transport-specific validation, parsing, and send calls.

## Messaging adapter contract

`MessagingAdapter` has a deliberately small surface:

- a stable provider kind;
- `sendText`, returning a provider message identifier and initial status;
- optional inbound-request validation and parsing;
- optional delivery-status parsing.

Canonical internal envelopes use normalized provider IDs, sender/recipient addresses, body, media count, opt-out signal, delivery status, and diagnostic fields. Provider-specific callback parameters are retained at the ingress boundary only as needed for validation and audit; the orchestrator does not branch on Twilio SDK objects.

## Implemented: `WebMessagingAdapter`

The web adapter writes outbound messages to the authenticated browser thread through an injected sink and returns a local provider identifier with delivered state. It has no provider credentials, webhook, carrier cost, or external network call. This is the default self-hosting and deterministic demonstration path.

## Implemented: `TwilioSmsMessagingAdapter`

The Twilio adapter:

- sends through the official generated Message resource type;
- uses either `TWILIO_MESSAGING_SERVICE_SID` or `TWILIO_SMS_FROM_NUMBER`;
- attaches the exact configured status-callback URL to each outbound send;
- validates inbound and status callbacks with the official SDK and the exact canonical URL;
- parses form-encoded SMS fields, aliases, media count, `OptOutType`, status, and error detail;
- returns empty MessagingResponse TwiML after accepted inbound processing.

The application layer still enforces the account SID, owner-phone allowlist, destination, SMS-only media policy, consent state, duplicate provider SID, command scope, and real-messaging kill switch.

Twilio documents that incoming messaging webhooks are form-encoded and that callback parameters can evolve, so validation accepts the complete parameter collection through the SDK rather than reimplementing the signature algorithm. See [Twilio's incoming-message webhook request](https://www.twilio.com/docs/messaging/guides/webhook-request) and [webhook security guidance](https://www.twilio.com/docs/usage/webhooks/webhooks-security).

## Voice adapter boundary

The existing `TelephonyAdapter` isolates the deterministic simulator and Twilio ConversationRelay call path. Both feed the same call service, state machine, policy, transcript, approval, semantic-event, and outcome pipeline. The Twilio implementation uses signed voice/status callbacks and a signed ConversationRelay WebSocket; simulator evidence must not be described as live-provider evidence.

## Adding a provider

A proposed provider adapter must:

1. map into the existing internal envelopes without provider conditionals in policy;
2. authenticate every callback using the provider's supported mechanism;
3. preserve idempotency across retries and reordered callbacks;
4. expose truthful acceptance, delivery, failure, and unknown states;
5. support owner allowlisting and opt-out behavior at least as strict as the existing transport;
6. reject media and secrets unless a separately reviewed protocol version defines them;
7. include contract, signature, retry, duplicate, and failure tests without live charges;
8. document data processors, retention, compliance, pricing boundaries, and kill-switch behavior.

## Unimplemented adapters

No other messaging provider, email, RCS, WhatsApp, chat-network, browser-automation, or self-hosted PSTN adapter is implemented. Names or ideas in [ROADMAP.md](ROADMAP.md) are not availability claims. Unsupported providers must not be selected through environment variables or presented as fallback routes.
