# Costs

Liaison's simulator and mock planner run locally without Twilio or OpenAI usage charges. Hosting and local hardware may still have costs.

Live telephony can include a Twilio Programmable Voice destination minute, ConversationRelay processing, a rented telephone number, provider-specific transcription/TTS, taxes, and destination-specific charges. OpenAI mode adds input, cached-input, reasoning, and output token charges for planner, controller, and outcome calls. Hosting adds compute, storage, bandwidth, and persistent-volume cost.

Provider pricing changes. As of this documentation update (2026-08-12), operators must review the current Twilio and OpenAI pricing pages rather than treat any checked-in number as a quote. `ESTIMATED_TELEPHONY_COST_PER_MINUTE_USD` is an operator-maintained blended estimate; the safe default is `$0.084` per minute from the product brief, not a provider invoice.

At that configured estimate:

| Duration | Estimate |
| --- | ---: |
| 5 minutes | $0.42 |
| 10 minutes | $0.84 |
| 30 minutes | $2.52 |

The UI displays elapsed and maximum estimates and explicitly excludes taxes, number rental, destination-specific charges, and future pricing changes. The application enforces one call, a daily limit, a hard duration, no retry/redial, no speculative model calls, one controller call per material final utterance, short context, and GPT-5.6 Luna low-effort defaults.

Open-source voice was deferred because eliminating provider voice fees requires a bidirectional PSTN media bridge, codec conversion, streaming STT/TTS, turn detection, barge-in, cancellation, echo control, GPU/CPU capacity planning, and around-the-clock failure handling. See [OPEN_SOURCE_VOICE_MIGRATION.md](OPEN_SOURCE_VOICE_MIGRATION.md).
