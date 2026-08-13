## Outcome

Describe the user-visible result and why it belongs in Liaison's single-principal, self-hosted scope.

## Safety and privacy

- Authority or attention impact:
- Data stored, transmitted, or deleted:
- External side effects and idempotency:
- New provider cost or compliance boundary:
- Failure and rollback behavior:

## Compatibility

- Database migration:
- Protocol/schema change:
- Configuration change:
- Accessibility impact:

## Validation

List exact commands and results. Distinguish mock/simulator coverage from any live-provider test.

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm run test:unit`
- [ ] `npm run test:integration`
- [ ] `npm run test:e2e`
- [ ] `npm run build`
- [ ] `docker build --tag liaison:local .`
- [ ] Documentation and generated protocol artifacts are current.
- [ ] No secrets, personal data, real phone numbers, message bodies, or transcripts are included.
