# Application security

The project-level reporting policy is [../SECURITY.md](../SECURITY.md). This document describes the runtime threat model, mitigations, and known limitations.

## Threat model

Liaison considers unauthorized browser use, SMS sender spoofing, webhook forgery, callback replay/reordering, duplicate sends, queue restart races, robocalling abuse, destination substitution, call-code theft, secure-link theft, stale attention resolution, prompt injection in support speech/messages, credential capture, unauthorized account action, duplicate speech/DTMF, stale model output, log leakage, denial of service, and a compromised owner session.

It is a personal single-principal service, not a tenant-isolation boundary. It assumes the operator controls the configured owner phone, host, deployment secrets, reverse proxy, and provider projects.

## Authentication and HTTP controls

- The deployment access key is compared through fixed-length HMAC digests with constant-time comparison.
- Sessions are signed, HTTP-only, SameSite=Strict, Secure in production, expiring, and not stored in browser storage.
- Mutation origins are checked. Helmet headers, request/body limits, Zod bounds, global throttling, and failed-login throttling constrain abuse.
- Production requires non-empty independent secrets and HTTPS/WSS public origins.
- Logs omit bodies and sensitive headers; errors filter credential-like strings.

Anyone with the access key or an active browser session can operate this personal instance. Protect the browser and rotate compromised credentials.

## SMS ingress

- Real messaging defaults off and requires mode, complete provider/owner configuration, and `ALLOW_REAL_MESSAGING=true`.
- Twilio inbound and status callbacks are validated using the official SDK, the auth token, exact canonical URL, and complete form parameter set. Account SID and destination are checked after signature validation.
- Only the exact `OWNER_PHONE_E164` is accepted as the SMS principal. Unauthorized responses are silent by default.
- Duplicate provider message SIDs are idempotent. MMS and media are rejected without retrieval.
- STOP/START/HELP and provider `OptOutType` update explicit consent state. After opt-out, the worker refuses later unsent Twilio submissions and records claimed rows as failed; it cannot recall a message already accepted by Twilio or a carrier. Provider filtering remains an additional layer.
- Credential patterns are redacted before persistence, logs, model input, or command handling. Detection is defense in depth, not proof that arbitrary text is safe.

Twilio signatures authenticate a request from Twilio, not the human identity or security of the carrier/handset. SMS is unsuitable for sensitive/material decisions or secret disclosure.

## Durable messaging and delivery

Inbox and outbox rows are persisted before asynchronous work. Transactional claims, unique idempotency/provider keys, bounded inbound-processing attempts, and restart recovery constrain duplicate work. Ambiguous outbound send errors are not automatically retried and remain inspectable as failed/dead-letter deliveries. Status callbacks are reduced by semantic progression rather than arrival time so stale events do not regress a terminal outcome.

No local mechanism can guarantee carrier delivery or exactly-once external behavior. Provider acceptance is displayed separately from delivery, and terminal failures remain visible.

## Plan and call authorization

- The destination is manually entered, normalized to an allowed E.164 prefix, and bound to the plan; emergency/short-code and detectable premium destinations are rejected.
- There is no redirect or call-another-number capability.
- Plan edits invalidate prior approval and authorization.
- A call code is random, short-lived, stored only as a hash, bound to owner/thread/case/destination/plan version/mode, consumed transactionally, and single-use.
- Only exact `CALL <code>` parsing can authorize start. Natural-language intent, model output, secure-link access, or a stale code cannot.
- One active call, daily call limits, maximum duration, no background calling, no retry, and no redial constrain abuse and spend.

## Authority, attention, and secure actions

- Hard-denied credentials and actions cannot become approvals under any autonomy mode.
- Deterministic policy assigns attention tier, evaluates authority and conditional rules, checks current state/generation, and validates immediately before side effects.
- SMS resolves only one pending, low-consequence, unexpired A/B/C choice. Ambiguous, duplicate, late, sensitive, material, or prohibited responses fail closed.
- Sensitive/material choices require an authenticated secure web action. Tokens contain at least 32 random bytes, are stored as hashes, and bind exact action/thread/case/call/attention IDs, expiry, and single-use state.
- Superseding, resolving, expiring, ending, or cancelling related state revokes remaining tokens.
- Hang-up over messaging uses explicit confirmation; pause/interrupt/hang-up invalidates stale model generations.

Possession of an unexpired SMS-delivered action URL can expose its approval page until authentication and binding checks stop it. Handset and notification security remain operator responsibilities.

## Call and model boundary

- Remote transcript and inbound natural language are delimited as untrusted model input. They cannot create tools, grant approval, change destination/authority, authorize a call, or retrieve disclosure values.
- Structured model output is parsed against strict Zod schemas. Deterministic code has final authority.
- Each finalized remote turn has a generation. Pause, interruption, attention, approval, and termination invalidate earlier output.
- External action fingerprints reject duplicate speech/DTMF.
- Twilio voice/status HTTP and ConversationRelay WSS requests use official signature validation. Relay setup checks account SID and provider call SID against server-owned state. Short-lived internal call tokens add binding but do not replace Twilio validation.

## Disclosure and evidence

Passwords, one-time codes, full Social Security numbers, payment cards, CVV, PINs, security answers, recovery codes, API keys, purchases, new contracts, impersonation, and waiver of rights are prohibited.

Supported disclosure values remain in process memory, never in models, SQLite, SMS, SSE, normal logs, or persisted transcripts. A process compromise can read them while present. Restart intentionally loses them.

Confirmed commitments and outcome fields require exact stored transcript evidence. Evidence validation reduces invention; it cannot prove that a representative's statement is true or enforceable.

## Operational requirements

- Restrict `.env`, SQLite, backups, logs, Twilio, OpenAI, the host, and reverse-proxy control plane.
- Use a trusted TLS certificate and exact public URLs. Do not disable signature validation.
- Keep both real-use flags false while installing, migrating, restoring, or investigating.
- Test backup restoration in an isolated mock/simulator instance.
- Apply OS, Node.js, container-base, npm dependency, and reverse-proxy security updates.
- Review GitHub dependency and code-scanning results, but do not treat an automated scan as a complete audit.

## Known limitations

- Keyword risk and secret detection have false positives and false negatives.
- Phone-number possession is weaker than cryptographic identity and SMS can be forwarded, previewed, intercepted, or SIM-swapped.
- A compromised server process can read database contents, active disclosure values, provider credentials, and tokens before hashing/delivery.
- SQLite and one process are appropriate for a personal instance, not high availability.
- Provider signatures and TLS do not control what a remote representative, carrier, or handset records.
- The service cannot guarantee provider delivery, support-company truthfulness, legal validity of a commitment, or security of operator-managed backups.
- Unsupported high-risk domains remain prohibited rather than made safe by these controls.
