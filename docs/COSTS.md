# Costs

The browser messaging adapter, deterministic mock model, and call simulator run locally without Twilio or OpenAI usage charges. Hosting, storage, bandwidth, backups, domain registration, and local hardware can still cost money.

## SMS

Real SMS can include inbound and outbound message segments, carrier fees, registration/campaign fees, telephone-number rental, taxes, and country/sender-specific charges. A single visible message may be billed as multiple segments. GSM-7 and UCS-2 encoding have different character limits, and concatenation headers reduce the capacity of later segments.

Liaison estimates encoding and segment count before enqueueing an SMS and limits composition with `SMS_MAX_SEGMENTS_PER_MESSAGE`. This is a guardrail, not a billing meter: carrier normalization, Twilio processing, media, country rules, and provider changes can differ. `ESTIMATED_SMS_COST_PER_SEGMENT_USD` is an operator-entered planning value and defaults to zero rather than pretending to know a current price. When it is set, the messaging setup panel multiplies it by the segments actually submitted to the carrier and shows the running estimate; web-thread messages and rows that never left the outbox are excluded because neither was billed.

Review Twilio's current [Messaging pricing](https://www.twilio.com/en-us/messaging/pricing), [Messages resource behavior](https://www.twilio.com/docs/messaging/api/message-resource), and your account's sender/registration charges. Twilio documents `numSegments` on the final Message resource; the local pre-send estimate is not an invoice.

## Voice

Live calling can include a Twilio Programmable Voice destination minute, ConversationRelay processing, number rental, transcription/TTS provider charges, taxes, and destination-specific fees. `ESTIMATED_TELEPHONY_COST_PER_MINUTE_USD` is an operator-maintained blended estimate. The checked-in default of `$0.084` per minute comes from the original product brief and is not a Twilio quote.

At that unchanged example value:

| Duration | Local estimate |
| --- | ---: |
| 5 minutes | $0.42 |
| 10 minutes | $0.84 |
| 30 minutes | $2.52 |

The UI must label these values as estimates and exclude taxes, rental, provider-specific line items, and future price changes. One active call, a daily cap, hard duration, no redial, and no call retry constrain—not eliminate—cost exposure.

## Models

`LLM_MODE=mock` makes no OpenAI request. `LLM_MODE=openai` can incur input, cached-input, reasoning, and output token charges for planning, controller decisions, and outcome extraction. Liaison bounds schemas, timeouts, context, and normal controller cadence, but support-call length and model pricing still affect spend. Review the current OpenAI project limits and official pricing before enabling it.

## Hosting and operations

SQLite avoids a managed-database bill, but persistent volumes, snapshots, egress, logs, domains, TLS/proxy infrastructure, and operator time remain real costs. Docker Compose does not provision backups, a domain, or monitoring.

## Cost controls

- Keep `ALLOW_REAL_MESSAGING=false` and `ALLOW_REAL_CALLS=false` until each live path is deliberately tested.
- Set conservative segment, duration, daily-call, and destination-prefix limits.
- Use `SMS_UPDATE_DETAIL=MINIMAL` or `STANDARD` when carrier segments matter.
- Use simulator and mock modes for development and CI.
- Inspect provider billing separately; local estimates cannot reconcile invoices.
- Disable the relevant allow flag and redeploy if unexpected spend appears.

Open-source voice remains future work because removing a provider line item transfers real-time media engineering and operations to the self-hoster. See [OPEN_SOURCE_VOICE_MIGRATION.md](OPEN_SOURCE_VOICE_MIGRATION.md).
