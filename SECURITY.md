# Security policy

## Supported versions

Security fixes are made on the current default branch and, when practical, the most recent tagged release. Older self-hosted deployments should upgrade before requesting a backport. No commercial support or response-time guarantee is included.

## Report a vulnerability privately

Do not open a public issue for a suspected vulnerability.

1. Prefer GitHub's private vulnerability-reporting form at `https://github.com/kaushika05/liaison/security/advisories/new` when it is enabled.
2. If that form is unavailable, contact the repository owner privately through the contact method on their GitHub profile.
3. Include the affected revision, impact, prerequisites, a minimal simulator-mode reproduction, and suggested mitigation if known.
4. Redact access keys, cookies, Twilio credentials, action tokens, phone numbers, case contents, and transcripts.

The maintainer will acknowledge reports as capacity allows, validate them in a safe environment, and coordinate a fix and disclosure. Please allow a reasonable remediation window before public discussion.

## Safe research rules

- Use a local clone with `LLM_MODE=mock`, `MESSAGING_MODE=web`, `TELEPHONY_MODE=simulator`, `ALLOW_REAL_MESSAGING=false`, and `ALLOW_REAL_CALLS=false`.
- Never send an SMS or place a call to a number you do not own or have explicit permission to test.
- Do not access another operator's deployment, data, Twilio account, or OpenAI project.
- Do not use denial-of-service, social-engineering, credential-harvesting, or destructive techniques.
- Store only synthetic case and transcript content in a report.

## Security boundaries

Liaison is a personal, single-principal service. The deployment access key and owner phone allow powerful actions; anyone who controls either associated session can act as the owner. Operators must secure the host, reverse proxy, secret store, browser, Twilio project, OpenAI project, and backups.

Real messaging and real calling are separate opt-in capabilities and default off. Twilio callbacks require signature validation, but correct validation also depends on exact public callback URLs and a protected Twilio auth token. The application rejects non-owner SMS input, MMS, stale or duplicate commands, prohibited credentials, and expired or mismatched action tokens. These controls reduce risk; they do not make keyword classification or carrier delivery infallible.

For the detailed application threat model and mitigations, see [docs/SECURITY.md](docs/SECURITY.md).
