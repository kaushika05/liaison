# Contributing to Liaison

Thank you for helping make text-first support calls safer and more accessible. Liaison is intentionally small, self-hosted, single-principal software. Contributions should preserve that operating model unless a maintainer has accepted a design change first.

## Before you begin

- Read [DESIGN_PRINCIPLES.md](docs/DESIGN_PRINCIPLES.md), [SECURITY.md](SECURITY.md), and [MESSAGING_PROTOCOL.md](docs/MESSAGING_PROTOCOL.md).
- Use the simulator, mock model, and web-messaging adapter for routine development. Tests must not contact real people or paid providers.
- Never commit `.env`, SQLite databases, access keys, phone numbers, provider credentials, transcripts, or real support-case data.
- Discuss a large behavior, schema, provider-adapter, or protocol change in an issue before investing in it.

## Development setup

Liaison requires Node.js 22 or newer.

```bash
npm ci
npm run setup -- --defaults --output=.env
npm run doctor
npm run dev
```

The generated defaults keep models, messaging, and calls in credential-free local modes. `npm run setup` prints the generated access key once; keep it private.

## Making a change

1. Create a focused branch from the current default branch.
2. Add or update tests with the behavior.
3. Keep provider-specific code behind the existing adapter boundary.
4. If a Zod protocol schema changes, run `npm run protocol:generate` and commit the generated `protocol/v1` artifacts when the change is compatible with v1. Breaking changes require a new protocol directory and migration notes.
5. Update operator and privacy documentation when storage, configuration, network traffic, cost, or retention changes.
6. Run the relevant focused tests while iterating, then run the complete local checks:

```bash
npm run check
npm run test:e2e
npm run demo:messaging
docker build --tag liaison:local .
```

`npm run demo:messaging` is a local deterministic demonstration. It must remain free of external provider calls.

## Safety requirements

Changes must not weaken these boundaries:

- Real SMS and real calls remain independently disabled by default.
- Only the configured owner may operate the SMS surface.
- A call starts only after approval of a specific plan version and consumption of its exact, short-lived authorization code.
- SMS may resolve only low-consequence A/B/C decisions. Sensitive and material decisions use the authenticated web surface.
- Passwords, one-time codes, full payment-card data, full Social Security numbers, PINs, security answers, purchases, new contracts, impersonation, and waiver of legal rights remain prohibited.
- Provider callbacks are authenticated before their contents are trusted.
- External side effects are idempotent, auditable, and recoverable after a process restart.
- Important information and controls cannot exist only in audio.

Use synthetic E.164 numbers from the reserved `+1 555` test ranges in fixtures. A test must never dial or message a real destination.

## Pull requests

Keep pull requests reviewable and explain:

- the user-visible outcome;
- the safety and privacy impact;
- database or protocol compatibility;
- exact validation performed;
- anything that still requires a live-provider test.

Do not describe mock or simulator evidence as live Twilio validation. Automated checks may run linting, type checks, unit and integration tests, browser tests, a production build, a container build, and dependency review.

By contributing, you agree that your contribution is licensed under the repository's [GNU Affero General Public License v3.0](LICENSE).
