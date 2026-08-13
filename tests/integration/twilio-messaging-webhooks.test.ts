import twilio from "twilio";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp, type AppContext } from "../../src/server/app.js";
import type { Config } from "../../src/server/config.js";

const accountSid = "AC11111111111111111111111111111111";
const authToken = "route-test-auth-token";
const owner = "+13045550101";
const sender = "+13045550100";
const publicBaseUrl = "https://liaison.example";
const inboundPath = "/webhooks/twilio/messaging/inbound";
const statusPath = "/webhooks/twilio/messaging/status";

type TwilioForm = Record<string, string>;

let context: AppContext | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await context?.app.close();
  context = undefined;
});

async function app(overrides: Partial<Config> = {}): Promise<AppContext> {
  context = await buildApp({
    NODE_ENV: "test",
    LLM_MODE: "mock",
    TELEPHONY_MODE: "simulator",
    ALLOW_REAL_CALLS: false,
    DATABASE_PATH: ":memory:",
    PUBLIC_BASE_URL: publicBaseUrl,
    PUBLIC_WSS_URL: "wss://liaison.example",
    APP_ACCESS_KEY: "",
    SESSION_SECRET: "route-test-session-secret",
    CALL_TOKEN_SECRET: "route-test-call-secret",
    ACTION_LINK_SECRET: "route-test-action-secret",
    MESSAGING_MODE: "twilio_sms",
    ALLOW_REAL_MESSAGING: true,
    TWILIO_ACCOUNT_SID: accountSid,
    TWILIO_AUTH_TOKEN: authToken,
    TWILIO_MESSAGING_SERVICE_SID: "",
    TWILIO_SMS_FROM_NUMBER: sender,
    OWNER_PHONE_E164: owner,
    ...overrides,
  }, { serveClient: false, databasePath: ":memory:" });
  await context.app.ready();
  await context.messaging.stop();
  return context;
}

function inboundForm(overrides: Partial<TwilioForm> = {}): TwilioForm {
  return {
    MessageSid: "SM11111111111111111111111111111111",
    SmsSid: "SM11111111111111111111111111111111",
    AccountSid: accountSid,
    From: owner,
    To: sender,
    Body: "STOP",
    NumMedia: "0",
    NumSegments: "1",
    ApiVersion: "2010-04-01",
    FutureTwilioField: "included-in-signature",
    ...overrides,
  };
}

function statusForm(overrides: Partial<TwilioForm> = {}): TwilioForm {
  return {
    MessageSid: "SM99999999999999999999999999999999",
    SmsSid: "SM99999999999999999999999999999999",
    AccountSid: accountSid,
    MessageStatus: "delivered",
    SmsStatus: "delivered",
    From: sender,
    To: owner,
    ApiVersion: "2010-04-01",
    FutureStatusField: "included-in-signature",
    ...overrides,
  };
}

async function signedPost(path: string, form: TwilioForm, options: {
  signature?: string;
  signatureUrl?: string;
  signatureForm?: TwilioForm;
} = {}) {
  const signature = options.signature ?? twilio.getExpectedTwilioSignature(
    authToken,
    options.signatureUrl ?? `${publicBaseUrl}${path}`,
    options.signatureForm ?? form,
  );
  return context!.app.inject({
    method: "POST",
    url: path,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature,
    },
    payload: new URLSearchParams(form).toString(),
  });
}

describe("Twilio messaging webhook routes", () => {
  it("validates the complete form against the exact configured external URL and returns empty TwiML", async () => {
    await app();
    const pathWithQuery = `${inboundPath}?edge=ashburn`;
    const form = inboundForm({ MessageSid: "SM-exact-url", SmsSid: "SM-exact-url" });
    const response = await signedPost(pathWithQuery, form);

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/xml");
    expect(response.body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response/>');
    expect((context!.database.db.prepare("SELECT COUNT(*) AS count FROM inbound_messages WHERE provider_message_id='SM-exact-url'").get() as {count:number}).count).toBe(1);

    const changedUnsignedField = await signedPost(inboundPath, { ...form, FutureTwilioField: "tampered" }, {
      signatureUrl: `${publicBaseUrl}${inboundPath}`,
      signatureForm: form,
    });
    expect(changedUnsignedField.statusCode).toBe(403);
  });

  it("rejects an invalid signature before persisting or processing the message", async () => {
    await app();
    const response = await signedPost(inboundPath, inboundForm(), { signature: "invalid-signature" });
    expect(response.statusCode).toBe(403);
    expect((context!.database.db.prepare("SELECT COUNT(*) AS count FROM inbound_messages").get() as {count:number}).count).toBe(0);
    expect((context!.database.db.prepare("SELECT COUNT(*) AS count FROM provider_security_events").get() as {count:number}).count).toBe(0);
  });

  it.each([
    {
      name: "account",
      sid: "SM-account-rejected",
      changes: { AccountSid: "AC22222222222222222222222222222222" },
      reason: "ACCOUNT_MISMATCH",
    },
    {
      name: "destination",
      sid: "SM-destination-rejected",
      changes: { To: "+13045550999" },
      reason: "DESTINATION_MISMATCH",
    },
  ])("rejects a mismatched $name without creating inbox work", async ({ sid, changes, reason }) => {
    await app();
    const response = await signedPost(inboundPath, inboundForm({ MessageSid: sid, SmsSid: sid, ...changes }));
    expect(response.statusCode).toBe(403);
    expect((context!.database.db.prepare("SELECT COUNT(*) AS count FROM inbound_messages").get() as {count:number}).count).toBe(0);
    expect(context!.database.listProviderSecurityEvents()).toEqual([
      expect.objectContaining({ providerMessageId: sid, reasonCode: reason, callId: null }),
    ]);
  });

  it("silently rejects a non-owner sender without revealing the allowlist or scheduling work", async () => {
    await app();
    const sid = "SM-owner-rejected";
    const response = await signedPost(inboundPath, inboundForm({ MessageSid: sid, SmsSid: sid, From: "+13045550888" }));
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response/>');
    expect((context!.database.db.prepare("SELECT COUNT(*) AS count FROM inbound_messages").get() as {count:number}).count).toBe(0);
    expect((context!.database.db.prepare("SELECT COUNT(*) AS count FROM messaging_work_items").get() as {count:number}).count).toBe(0);
    expect((context!.database.db.prepare("SELECT COUNT(*) AS count FROM outbound_messages").get() as {count:number}).count).toBe(0);
    expect(context!.database.listProviderSecurityEvents()[0]).toMatchObject({
      providerMessageId: sid,
      reasonCode: "UNAUTHORIZED_SENDER",
      redactedMetadata: { senderFingerprint: expect.stringMatching(/^[a-f0-9]{16}$/) },
    });
  });

  it("deduplicates repeated MessageSid deliveries before application processing", async () => {
    await app();
    const form = inboundForm({ MessageSid: "SM-duplicate", SmsSid: "SM-duplicate" });
    expect((await signedPost(inboundPath, form)).statusCode).toBe(200);
    expect((await signedPost(inboundPath, form)).statusCode).toBe(200);
    expect((context!.database.db.prepare("SELECT COUNT(*) AS count FROM inbound_messages WHERE provider_message_id='SM-duplicate'").get() as {count:number}).count).toBe(1);
    expect((context!.database.db.prepare("SELECT COUNT(*) AS count FROM messaging_work_items").get() as {count:number}).count).toBe(1);
  });

  it("does not replay an old opt-state command when the same MessageSid is redelivered", async () => {
    await app();
    const stop = inboundForm({ MessageSid: "SM-old-stop", SmsSid: "SM-old-stop", OptOutType: "STOP" });
    expect((await signedPost(inboundPath, stop)).statusCode).toBe(200);
    const thread = context!.messaging.snapshot().thread;
    expect(context!.database.getSupportThread(thread.id)?.messagingOptState).toBe("OPTED_OUT");
    context!.database.updateSupportThread(thread.id, { messagingOptState: "OPTED_IN" });
    expect((await signedPost(inboundPath, stop)).statusCode).toBe(200);
    expect(context!.database.getSupportThread(thread.id)?.messagingOptState).toBe("OPTED_IN");
  });

  it("records MMS as unsupported without downloading or fetching the media URL", async () => {
    await app();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const form = inboundForm({
      MessageSid: "SM-media",
      SmsSid: "SM-media",
      Body: "Here is a screenshot",
      NumMedia: "1",
      MediaUrl0: "https://api.twilio.example/media/private-object",
      MediaContentType0: "image/png",
      OptOutType: "STOP",
    });
    const response = await signedPost(inboundPath, form);
    await context!.messaging.flush();

    expect(response.statusCode).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(context!.database.getInboundMessage((context!.database.db.prepare("SELECT id FROM inbound_messages WHERE provider_message_id='SM-media'").get() as {id:string}).id))
      .toMatchObject({ errorCode: "MMS_UNSUPPORTED", redactedBody: "Here is a screenshot" });
    expect((context!.database.db.prepare("SELECT COUNT(*) AS count FROM outbound_messages").get() as {count:number}).count).toBe(0);
  });

  it("applies STOP synchronously, cancels queued sends, and creates no opt-out reply", async () => {
    await app();
    const snapshot = context!.messaging.snapshot();
    context!.database.enqueueOutboundMessage({
      id: "queued-before-stop",
      threadId: snapshot.thread.id,
      providerKind: "TWILIO_SMS",
      redactedBody: "Ordinary queued update",
      sender,
      recipient: owner,
      segmentEstimate: 1,
      idempotencyKey: "queued-before-stop",
    });
    const response = await signedPost(inboundPath, inboundForm({
      MessageSid: "SM-stop",
      SmsSid: "SM-stop",
      OptOutType: "STOP",
    }));
    await context!.messaging.flush();

    expect(response.statusCode).toBe(200);
    expect(context!.database.getSupportThread(snapshot.thread.id)?.messagingOptState).toBe("OPTED_OUT");
    expect(context!.database.getOutboundMessage("queued-before-stop")).toMatchObject({
      processingState: "DEAD_LETTER",
      deliveryState: "FAILED",
      errorCode: "OWNER_OPTED_OUT",
      providerMessageId: null,
    });
    expect((context!.database.db.prepare("SELECT COUNT(*) AS count FROM outbound_messages").get() as {count:number}).count).toBe(1);
  });

  it("validates status callbacks and reduces out-of-order delivery without regression", async () => {
    await app();
    const snapshot = context!.messaging.snapshot();
    context!.database.enqueueOutboundMessage({
      id: "outbound-status",
      threadId: snapshot.thread.id,
      providerKind: "TWILIO_SMS",
      redactedBody: "Progress update",
      sender,
      recipient: owner,
      segmentEstimate: 1,
      idempotencyKey: "outbound-status",
    });
    expect(context!.database.claimOutboundMessages({ workerId: "test-seed", now: new Date().toISOString(), leaseSeconds: 60, limit: 1 })).toHaveLength(1);
    expect(context!.database.markOutboundSent({
      id: "outbound-status",
      workerId: "test-seed",
      providerMessageId: "SM99999999999999999999999999999999",
      deliveryState: "QUEUED",
    })).toBe(true);

    expect((await signedPost(statusPath, statusForm({ MessageStatus: "delivered", SmsStatus: "delivered" }))).statusCode).toBe(204);
    expect((await signedPost(statusPath, statusForm({ MessageStatus: "sent", SmsStatus: "sent" }))).statusCode).toBe(204);
    expect(context!.database.getOutboundMessage("outbound-status")).toMatchObject({
      deliveryState: "DELIVERED",
      errorCode: null,
      providerMessageId: "SM99999999999999999999999999999999",
    });
    expect(context!.database.listMessageDeliveryEvents("outbound-status")).toHaveLength(2);

    const invalid = await signedPost(statusPath, statusForm({ MessageStatus: "failed" }), { signature: "invalid-signature" });
    expect(invalid.statusCode).toBe(403);
    expect(context!.database.listMessageDeliveryEvents("outbound-status")).toHaveLength(2);
  });
});
