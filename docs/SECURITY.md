# Security

## Threat model

Liaison must withstand unauthorized browser use, robocalling abuse, destination substitution, prompt injection in remote speech, credential extraction, unauthorized account action, duplicate approval or speech, stale controller output, Twilio spoofing, log leakage, denial of service, and a compromised browser session. It is a single-user service, not a tenant-isolation system.

## Mitigations

- A deployment access key is compared through fixed-length HMAC digests with `timingSafeEqual`. Sessions are signed, HTTP-only, SameSite=Strict, Secure in production, expiring, and never stored in browser storage. Login and global traffic are rate-limited.
- Production requires explicit security secrets and HTTPS/WSS. Mutation origins are checked. Helmet security headers, 256 KiB body limits, Zod length limits, and secret-filtered errors are active.
- Only a user-entered valid US E.164 destination is accepted. Emergency/short codes and detectable 900/976 premium prefixes are rejected. There is no redirect/call-another-number capability.
- Real calls default off and need complete Twilio configuration plus `ALLOW_REAL_CALLS=true`. One active call, daily call limits, maximum duration, no background calls, no retries, and no redial constrain abuse and cost.
- High-risk keyword detection blocks real calling for emergency, medical, legal, financial, government, debt, employment, immigration, and law-enforcement language. It is intentionally not treated as a complete classifier.
- Hard-denied credentials and actions cannot become approvals. Exact text and disclosure cards reject password, OTP, full SSN, card, CVV, PIN, security-answer, key, and recovery-code classes.
- Remote transcript is delimited as untrusted model input. It cannot create tools, change policy, supply approval, change destination, or reveal disclosure values. The deterministic validator has final authority.
- Each remote turn has a generation. Pause, interrupt, approval, and ending invalidate prior generations. External action fingerprints reject duplicates. Approval status changes are conditional and idempotent.
- Twilio HTTP and WSS requests use the official SDK's signature validation against the exact public URL. WSS setup also checks account SID and call SID against server-owned state. The internal call token is HMAC-signed and short-lived; it is an additional binding, not a substitute for Twilio validation.
- Structured logs omit bodies and redact credential/cookie headers. Stored payloads pass through case-specific redaction. Error messages filter long token-like strings.

## Known limitations

Anyone with the access key can operate this single-user deployment. Protect the host and browser session. Keyword risk screening has false positives and false negatives. Secret pattern detection cannot recognize every credential form, so users must follow the prohibition notice. A process compromise can read in-memory disclosure values. The configured Twilio auth token validates callbacks and also authorizes API calls; use restricted Twilio API keys for production API access when account policy permits, while retaining the auth token securely for signature validation.

No application can guarantee what a remote representative or carrier records. Liaison's statement is only that this application does not request or retain audio recording.

## Responsible disclosure

Do not test a suspected issue against non-consenting telephone numbers or real customer accounts. Reproduce in simulator mode, preserve redacted request/call IDs, and contact the repository owner privately with impact, prerequisites, and reproduction steps. Never include access keys, Twilio credentials, disclosure values, or unredacted transcripts.
