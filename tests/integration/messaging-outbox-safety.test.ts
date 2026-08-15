import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type AppContext } from "../../src/server/app.js";

let context: AppContext | undefined;
afterEach(async () => {
  await context?.app.close();
  context = undefined;
});

describe("messaging outbox transport safety", () => {
  it("never silently delivers a Twilio SMS row through the web adapter", async () => {
    context = await buildApp(
      {
        NODE_ENV: "test",
        DATABASE_PATH: ":memory:",
        LLM_MODE: "mock",
        TELEPHONY_MODE: "simulator",
        MESSAGING_MODE: "web",
        SESSION_SECRET: "test-session-secret-that-is-long-enough",
        CALL_TOKEN_SECRET: "test-call-secret-that-is-long-enough",
        ACTION_LINK_SECRET: "test-action-secret-that-is-long-enough",
      },
      { serveClient: false, databasePath: ":memory:" },
    );
    const thread = context.database.getOrCreateActiveSupportThread({ id: "transport-thread", principalId: "owner" });
    context.database.enqueueOutboundMessage({
      id: "sms-without-adapter",
      threadId: thread.id,
      providerKind: "TWILIO_SMS",
      redactedBody: "Provider-bound message",
      sender: "+12125550100",
      recipient: "+12125550101",
      segmentEstimate: 1,
      idempotencyKey: "sms-without-adapter",
    });
    await context.messaging.flush();
    expect(context.database.getOutboundMessage("sms-without-adapter")).toMatchObject({
      processingState: "DEAD_LETTER",
      deliveryState: "FAILED",
      errorCode: "SMS_ADAPTER_MISSING",
      providerMessageId: null,
    });
  });
});
