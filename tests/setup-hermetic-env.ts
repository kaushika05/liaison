/**
 * Forces provider-free defaults before any test imports `src/server/config.ts`.
 *
 * `config.ts` runs `dotenv/config` at import time, so without this a developer's local `.env` leaks
 * into the suite — and a `.env` with `LLM_MODE=openai` makes tests issue real, billable API calls.
 * The project promises that automated tests never contact a provider, so that promise is enforced
 * here rather than left to each test remembering to pin the mode.
 *
 * Individual tests may still opt into provider *configuration* (credentials, webhook URLs) to
 * exercise signature validation and adapter wiring; what they cannot do is accidentally inherit a
 * live mode from the machine running them.
 */
const hermeticDefaults: Record<string, string> = {
  NODE_ENV: "test",
  LLM_MODE: "mock",
  OPENAI_API_KEY: "",
  OPENAI_BASE_URL: "",
  MESSAGING_MODE: "web",
  ALLOW_REAL_MESSAGING: "false",
  TELEPHONY_MODE: "simulator",
  ALLOW_REAL_CALLS: "false",
  MESSAGING_REGISTRATION_CONFIRMED: "false",
  DATABASE_PATH: ":memory:",
};

for (const [key, value] of Object.entries(hermeticDefaults)) process.env[key] = value;
