# Support

Liaison is community-maintained self-hosted software. There is no hosted service, paid support plan, uptime promise, or guaranteed response time.

## Where to ask

- Use a GitHub issue for a reproducible bug or a scoped feature proposal.
- Use the issue templates and include the Liaison revision, Node.js version, deployment method, active mock/provider modes, redacted `npm run doctor` output, and exact reproduction steps.
- Use [SECURITY.md](SECURITY.md) for vulnerabilities; never disclose them in a public issue.
- Use Twilio or OpenAI support for provider-account, billing, registration, quota, or platform incidents. This project cannot inspect or change those accounts.

Before filing, run:

```bash
npm run doctor
npm run check
```

When the problem is browser-specific, include the browser and viewport. When it is Twilio-specific, include redacted provider SIDs and timestamps, not credentials or message/call contents.

## Supported scope

Maintainers can help with the code in this repository and documented self-hosting paths. Operating-system hardening, reverse-proxy administration, carrier compliance, legal advice, custom provider integrations, and production incident response remain the operator's responsibility.
