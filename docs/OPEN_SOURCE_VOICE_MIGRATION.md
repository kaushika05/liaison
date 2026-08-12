# Future open-source voice migration

Version 1 deliberately keeps telephony behind `TelephonyAdapter` and uses ConversationRelay. A future provider-cost migration could use Kokoro-82M for TTS, Moonshine Streaming Small for primary STT, and faster-whisper as fallback, transported through Twilio bidirectional Media Streams or another PSTN media bridge. This is documentation, not an implemented production path.

The bridge would need to accept 8 kHz telephony audio, decode μ-law, resample for the STT model, stream revisions, and separately resample/encode TTS back to the carrier codec. It must implement bounded jitter buffers, voice-activity and end-of-turn detection, interruption/barge-in, echo avoidance, TTS cancellation, and ordering so canceled audio is never played after a policy or user stop.

Preserve the existing policy/state/event boundary: STT emits finalized transcript turns, the controller proposes one typed action, policy validates, and TTS executes only a current generation. Partial transcript revisions must not trigger normal model decisions. Measure capture-to-partial, capture-to-final, controller, first-audio, and end-to-end latencies separately.

Deployment planning must cover CPU/GPU/NPU targets, model memory, warm-up, concurrency, quantization quality, container/image size, model artifact integrity, autoscaling, queue rejection, and failure recovery. Review licenses for models, runtimes, voices, and redistributed weights. Load-test packet loss, long hold periods, noisy speech, accents, barge-in, process restart, provider disconnect, and maximum-duration termination.

A staged migration should first build a non-PSTN record/replay harness, then owned-number testing, then shadow transcription, then controlled TTS. It must retain Twilio signature validation, short-lived call binding, secret non-persistence, no recording, and safe user takeover. Although provider voice cost may fall, engineering and operational complexity rises materially: the application becomes responsible for real-time media quality and availability rather than only text decisions.
