import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/server/config.js";
import { LiaisonDatabase } from "../src/server/database/db.js";

type Result = { name: string; status: "PASS" | "WARN" | "FAIL"; detail: string };
const results: Result[] = [];
const add = (name: Result["name"], status: Result["status"], detail: string) => results.push({ name, status, detail });
try {
  const major = Number(process.versions.node.split(".")[0]);
  add("Node.js", major >= 22 ? "PASS" : "FAIL", `v${process.versions.node}; Liaison requires 22 or newer`);
  const config = loadConfig();
  add("Environment", "PASS", "configuration parses without exposing secrets");
  for (const [name, value] of [
    ["APP_ACCESS_KEY", config.APP_ACCESS_KEY],
    ["SESSION_SECRET", config.SESSION_SECRET],
    ["CALL_TOKEN_SECRET", config.CALL_TOKEN_SECRET],
    ["ACTION_LINK_SECRET", config.ACTION_LINK_SECRET],
  ] as const)
    add(
      name,
      value.length >= 32 ? "PASS" : config.NODE_ENV === "production" ? "FAIL" : "WARN",
      value.length >= 32 ? "strong value present" : "generate a 32+ character value before production",
    );
  const directory = path.dirname(path.resolve(config.DATABASE_PATH));
  fs.mkdirSync(directory, { recursive: true });
  fs.accessSync(directory, fs.constants.W_OK);
  add("Database directory", "PASS", `${directory} is writable`);
  const db = new LiaisonDatabase(config.DATABASE_PATH);
  const tables = (
    db.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
  ).map((row) => row.name);
  db.close();
  add("Database migrations", "PASS", `${tables.length} tables available`);
  const publicHttp = new URL(config.PUBLIC_BASE_URL);
  const https =
    publicHttp.protocol === "https:" && publicHttp.pathname === "/" && !publicHttp.search && !publicHttp.hash;
  add(
    "Public base URL",
    https || config.NODE_ENV !== "production" ? "PASS" : "FAIL",
    https ? "path-free HTTPS callback origin configured" : "local HTTP is suitable only for mock development",
  );
  const publicWs = new URL(config.PUBLIC_WSS_URL);
  const wss = publicWs.protocol === "wss:" && publicWs.pathname === "/" && !publicWs.search && !publicWs.hash;
  add(
    "Public WebSocket",
    wss || config.TELEPHONY_MODE === "simulator" ? "PASS" : "FAIL",
    wss ? "path-free secure WebSocket origin configured" : "WSS is required for live ConversationRelay",
  );
  add(
    "Owner phone",
    config.OWNER_PHONE_E164 ? "PASS" : "WARN",
    config.OWNER_PHONE_E164 ? "normalized E.164 owner configured" : "not required for browser-only mode",
  );
  const twilioCredentials = Boolean(config.TWILIO_ACCOUNT_SID && config.TWILIO_AUTH_TOKEN);
  add(
    "Twilio credentials",
    twilioCredentials ? "PASS" : "WARN",
    twilioCredentials ? "present (not printed)" : "not required for mock mode",
  );
  const sender = Boolean(config.TWILIO_MESSAGING_SERVICE_SID || config.TWILIO_SMS_FROM_NUMBER);
  add(
    "Twilio messaging sender",
    sender ? "PASS" : "WARN",
    sender ? "Messaging Service or SMS sender present" : "not required while real messaging is disabled",
  );
  add(
    "Messaging registration",
    config.MESSAGING_REGISTRATION_CONFIRMED ? "PASS" : "WARN",
    config.MESSAGING_REGISTRATION_CONFIRMED
      ? "operator marked sender/A2P registration as confirmed"
      : "confirm registration in the Twilio Console before enabling real SMS",
  );
  add(
    "Twilio voice sender",
    config.TWILIO_VOICE_FROM_NUMBER ? "PASS" : "WARN",
    config.TWILIO_VOICE_FROM_NUMBER ? "voice-capable sender present" : "not required while real calling is disabled",
  );
  add(
    "Real messaging",
    config.ALLOW_REAL_MESSAGING ? "WARN" : "PASS",
    config.ALLOW_REAL_MESSAGING
      ? "enabled; verify registration, webhook signatures, and provider costs"
      : "disabled by default",
  );
  add(
    "Real calling",
    config.ALLOW_REAL_CALLS ? "WARN" : "PASS",
    config.ALLOW_REAL_CALLS ? "enabled; verify destination and provider costs" : "disabled by default",
  );
  const models = [config.PLANNER_MODEL, config.CONTROLLER_MODEL, config.OUTCOME_MODEL];
  add(
    "Model provider",
    config.LLM_MODE === "mock" ? "PASS" : config.OPENAI_API_KEY ? "WARN" : "FAIL",
    config.LLM_MODE === "mock"
      ? "deterministic credential-free mode selected"
      : "OpenAI mode is selected and a key is present; availability and billing were not checked because provider calls are opt-in",
  );
  add(
    "Model configuration",
    models.every(Boolean) ? "PASS" : "FAIL",
    models.every(Boolean)
      ? `${config.LLM_MODE} planner, controller, and outcome models configured`
      : "one or more model names are empty",
  );
  add("Mock-mode availability", "PASS", "built-in deterministic model and simulator require no provider credentials");
  const databasePath = path.resolve(config.DATABASE_PATH);
  const persistent =
    databasePath.includes(`${path.sep}data${path.sep}`) ||
    databasePath.startsWith(`${path.parse(databasePath).root}data${path.sep}`);
  const hosted = Boolean(
    process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.DOCKER_CONTAINER,
  );
  add(
    "Persistent path convention",
    persistent ? "PASS" : hosted ? "FAIL" : "WARN",
    persistent
      ? `${config.DATABASE_PATH} uses a data directory; verify the host mounts it persistently`
      : hosted
        ? "hosted deployment should mount a persistent volume and set DATABASE_PATH inside it"
        : `${config.DATABASE_PATH}; verify a mounted volume before hosted deployment`,
  );
} catch (error) {
  add("Startup validation", "FAIL", error instanceof Error ? error.message : "unknown validation error");
}
for (const result of results) console.log(`${result.status.padEnd(4)} ${result.name}: ${result.detail}`);
const failures = results.filter((result) => result.status === "FAIL");
console.log(
  `\n${results.length - failures.length}/${results.length} checks did not fail. No provider or model API calls were made.`,
);
if (failures.length) process.exitCode = 1;
