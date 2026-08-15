import { buildApp, type AppContext } from "../src/server/app.js";
import type { MessagingThreadSnapshot } from "../src/shared/api.js";

const issue =
  "Call Xfinity at +18009346489. They charged me a $35 installation fee even though installation was promised free. I want the fee removed. Account credit is acceptable only if it is at least $35. Do not change my plan or accept any new charge.";

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(
  context: AppContext,
  description: string,
  predicate: (snapshot: MessagingThreadSnapshot) => boolean,
  timeoutMs = 8_000,
): Promise<MessagingThreadSnapshot> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await context.messaging.flush();
    const snapshot = context.messaging.snapshot();
    if (predicate(snapshot)) return snapshot;
    await wait(25);
  }
  const snapshot = context.messaging.snapshot();
  throw new Error(
    `DEMO_TIMEOUT:${description}:thread=${snapshot.thread.state}:call=${snapshot.call?.state ?? "none"}:paused=${snapshot.call?.paused ?? false}:attention=${snapshot.attention?.tier ?? "none"}`,
  );
}

async function main(): Promise<void> {
  const context = await buildApp(
    {
      NODE_ENV: "test",
      DATABASE_PATH: ":memory:",
      LLM_MODE: "mock",
      TELEPHONY_MODE: "simulator",
      MESSAGING_MODE: "web",
      APP_ACCESS_KEY: "demo-access-key",
      SESSION_SECRET: "demo-session-secret-that-is-long-enough",
      CALL_TOKEN_SECRET: "demo-call-secret-that-is-long-enough",
      ACTION_LINK_SECRET: "demo-action-secret-that-is-long-enough",
      OWNER_DISPLAY_NAME: "Avery",
      PUBLIC_BASE_URL: "http://127.0.0.1:3000",
      PUBLIC_WSS_URL: "ws://127.0.0.1:3000",
      SMS_MAX_SEGMENTS_PER_MESSAGE: 3,
    },
    { serveClient: false, databasePath: ":memory:" },
  );

  try {
    process.stdout.write("1/6 Collecting one-message support request...\n");
    let snapshot = await context.messaging.receiveWebText(issue);
    if (snapshot.thread.state !== "AWAITING_INFORMATION") throw new Error("DEMO_AUTHORITY_CONFIRMATION_NOT_REQUESTED");
    snapshot = await context.messaging.receiveWebText("YES");
    if (snapshot.thread.state !== "AWAITING_PLAN_APPROVAL" || !snapshot.case?.brief)
      throw new Error("DEMO_PLAN_NOT_CREATED");

    process.stdout.write("2/6 Approving the exact plan and issuing a one-use code...\n");
    snapshot = await context.messaging.receiveWebText("APPROVE PLAN");
    const authorizationMessage = [...snapshot.messages]
      .reverse()
      .find((message) => message.direction === "OUTBOUND" && /CALL [23456789A-HJ-NP-Z]{6}/.test(message.redactedBody));
    const code = authorizationMessage?.redactedBody.match(/CALL ([23456789A-HJ-NP-Z]{6})/)?.[1];
    if (!code) throw new Error("DEMO_CALL_CODE_NOT_ISSUED");

    process.stdout.write("3/6 Consuming the code and starting the deterministic call...\n");
    await context.messaging.receiveWebText(`CALL ${code}`);
    snapshot = await waitFor(
      context,
      "low-consequence decision",
      (value) => value.attention?.tier === "LOW_CONSEQUENCE",
    );
    if (!snapshot.call?.paused) throw new Error("DEMO_CALL_NOT_PAUSED_FOR_ATTENTION");

    process.stdout.write("4/6 Resolving the A/B/C hold decision through messaging...\n");
    snapshot = await context.messaging.receiveWebText("A");
    if (snapshot.call?.paused) {
      const latest =
        [...snapshot.messages]
          .reverse()
          .find((message) => message.direction === "OUTBOUND")
          ?.redactedBody.split("\n")[0] ?? "no-reply";
      throw new Error(`DEMO_LOW_DECISION_DID_NOT_RESUME:${latest}`);
    }
    snapshot = await waitFor(context, "secure review", (value) => value.attention?.tier === "SENSITIVE");
    const secureMessage = [...snapshot.messages]
      .reverse()
      .find((message) => message.direction === "OUTBOUND" && message.redactedBody.includes("/a/"));
    const secureToken = secureMessage?.redactedBody.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1];
    if (!secureToken) throw new Error("DEMO_SECURE_ACTION_NOT_ISSUED");

    process.stdout.write("5/6 Resolving secure sensitive and material decisions...\n");
    await context.messaging.resolveSecureAction(secureToken, { decision: "REJECT" });
    snapshot = await waitFor(context, "material review", (value) => value.attention?.tier === "MATERIAL");
    const materialMessage = [...snapshot.messages]
      .reverse()
      .find((message) => message.direction === "OUTBOUND" && message.redactedBody.includes("/a/"));
    const materialToken = materialMessage?.redactedBody.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1];
    if (!materialToken) throw new Error("DEMO_MATERIAL_ACTION_NOT_ISSUED");
    await context.messaging.resolveSecureAction(materialToken, { decision: "APPROVE" }).then(
      () => {
        throw new Error("DEMO_MATERIAL_CONFIRMATION_NOT_REQUIRED");
      },
      (error: unknown) => {
        if (!(error instanceof Error) || !error.message.includes("MATERIAL_CONFIRMATION_REQUIRED")) throw error;
      },
    );
    await context.messaging.resolveSecureAction(materialToken, { decision: "APPROVE", confirmation: "CONFIRM" }).then(
      () => {
        throw new Error("DEMO_CONDITIONAL_PLAN_RULE_NOT_ENFORCED");
      },
      (error: unknown) => {
        if (!(error instanceof Error) || !error.message.includes("CONDITIONAL_AUTHORITY_DENIED")) throw error;
      },
    );
    await context.messaging.resolveSecureAction(materialToken, { decision: "REJECT" });
    snapshot = await waitFor(
      context,
      "grounded outcome",
      (value) => value.thread.state === "COMPLETED" && value.commitments.length > 0,
    );

    const callRow = context.database.db.prepare("SELECT id FROM calls ORDER BY started_at DESC LIMIT 1").get() as
      | { id: string }
      | undefined;
    if (!callRow) throw new Error("DEMO_CALL_NOT_PERSISTED");
    const call = context.service.snapshot(callRow.id);
    if (call.outcome?.status !== "RESOLVED" || !call.outcome.caseNumber) throw new Error("DEMO_OUTCOME_NOT_GROUNDED");

    process.stdout.write("6/6 Verifying call-code replay is rejected...\n");
    await context.messaging.receiveWebText(`CALL ${code}`);
    const callCount = (context.database.db.prepare("SELECT COUNT(*) AS count FROM calls").get() as { count: number })
      .count;
    if (callCount !== 1) throw new Error("DEMO_CALL_CODE_REPLAYED");

    process.stdout.write(
      `PASS: ${snapshot.case?.companyName} case completed with ${snapshot.commitments.length} evidence-bound commitment(s), one call, and no credential disclosure.\n`,
    );
  } finally {
    await context.app.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "DEMO_FAILED"}\n`);
  process.exitCode = 1;
});
