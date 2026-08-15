import twilio from "twilio";
import { describe, expect, it, vi } from "vitest";
import {
  createEmptyTwilioMessagingResponse,
  TwilioSmsMessagingAdapter,
  WebMessagingAdapter,
  type InboundProviderRequest,
  type TwilioMessageClient,
} from "../../src/server/messaging/adapter.js";

const accountSid = "AC11111111111111111111111111111111";
const authToken = "test-auth-token";
const inboundWebhookUrl = "https://liaison.example/webhooks/twilio/messaging/inbound";
const statusCallbackUrl = "https://liaison.example/webhooks/twilio/messaging/status";

function adapter(overrides: Partial<ConstructorParameters<typeof TwilioSmsMessagingAdapter>[0]> = {}) {
  return new TwilioSmsMessagingAdapter({
    accountSid,
    authToken,
    inboundWebhookUrl,
    statusCallbackUrl,
    fromNumber: "+13045550100",
    client: { messages: { create: vi.fn() } },
    ...overrides,
  });
}

describe("messaging adapters", () => {
  it("delivers browser messages through the WEB boundary", async () => {
    const sink = vi.fn();
    const web = new WebMessagingAdapter(sink, () => "fixed-id");
    const input = { messageId: "message-1", to: "thread-1", body: "Update" };
    await expect(web.sendText(input)).resolves.toEqual({
      providerMessageId: "WEB-fixed-id",
      status: "delivered",
    });
    expect(web.kind).toBe("WEB");
    expect(sink).toHaveBeenCalledWith(input);
  });

  it("validates signatures against the exact canonical URL and complete form map", async () => {
    const form = {
      MessageSid: "SM111",
      AccountSid: accountSid,
      From: "+13045550101",
      To: "+13045550100",
      Body: "Please call support",
      NumMedia: "0",
      FutureTwilioField: "must-be-signed-too",
    };
    const signature = twilio.getExpectedTwilioSignature(authToken, inboundWebhookUrl, form);
    const sms = adapter();
    await expect(sms.validateInboundRequest({ callbackKind: "INBOUND_MESSAGE", signature, form })).resolves.toEqual({
      valid: true,
    });
    await expect(
      sms.validateInboundRequest({
        callbackKind: "INBOUND_MESSAGE",
        signature,
        form: { ...form, FutureTwilioField: "changed" },
      }),
    ).resolves.toEqual({ valid: false, reason: "INVALID_SIGNATURE" });
    await expect(sms.validateInboundRequest({ callbackKind: "STATUS_CALLBACK", signature, form })).resolves.toEqual({
      valid: false,
      reason: "INVALID_SIGNATURE",
    });
    await expect(sms.validateInboundRequest({ callbackKind: "INBOUND_MESSAGE", form })).resolves.toEqual({
      valid: false,
      reason: "MISSING_SIGNATURE",
    });
  });

  it("parses evolving inbound forms without dropping extras or touching media", async () => {
    const request: InboundProviderRequest = {
      callbackKind: "INBOUND_MESSAGE",
      form: {
        MessageSid: "SM111",
        SmsSid: "SM111-legacy",
        AccountSid: accountSid,
        From: "+13045550101",
        To: "+13045550100",
        Body: "Here is a screenshot",
        NumMedia: "2",
        MediaUrl0: "https://api.twilio.example/media/one",
        OptOutType: "STOP",
        FutureTwilioField: ["one", "two"],
      },
    };
    const envelope = await adapter().parseInboundRequest(request);
    expect(envelope).toMatchObject({
      provider: "TWILIO_SMS",
      providerMessageSid: "SM111",
      messageSid: "SM111",
      smsSid: "SM111-legacy",
      accountSid,
      from: "+13045550101",
      to: "+13045550100",
      body: "Here is a screenshot",
      numMedia: 2,
      optOutType: "STOP",
    });
    expect(envelope.parameters).toMatchObject({
      MediaUrl0: "https://api.twilio.example/media/one",
      FutureTwilioField: ["one", "two"],
    });
  });

  it("accepts the legacy SmsSid alias and parses status diagnostics", async () => {
    const inbound = await adapter().parseInboundRequest({
      callbackKind: "INBOUND_MESSAGE",
      form: {
        SmsSid: "SMlegacy",
        AccountSid: accountSid,
        From: "+13045550101",
        To: "+13045550100",
        Body: "Hello",
        NumMedia: "0",
      },
    });
    expect(inbound.providerMessageSid).toBe("SMlegacy");

    const status = await adapter().parseStatusCallback({
      callbackKind: "STATUS_CALLBACK",
      form: {
        MessageSid: "SM111",
        AccountSid: accountSid,
        MessageStatus: "undelivered",
        ErrorCode: "30003",
        ErrorMessage: "Unreachable destination handset",
        To: "+13045550101",
        ExtraStatusField: "preserved",
      },
    });
    expect(status).toMatchObject({
      providerMessageSid: "SM111",
      accountSid,
      status: "undelivered",
      errorCode: "30003",
      errorMessage: "Unreachable destination handset",
      to: "+13045550101",
      parameters: { ExtraStatusField: "preserved" },
    });
  });

  it("constructs REST sends with a Messaging Service in preference to a From number", async () => {
    const create = vi.fn().mockResolvedValue({ sid: "SM222", status: "queued" });
    const client: TwilioMessageClient = { messages: { create } };
    const sms = adapter({
      client,
      messagingServiceSid: "MG11111111111111111111111111111111",
      fromNumber: "+13045550100",
    });
    await expect(sms.sendText({ messageId: "message-1", to: "+13045550101", body: "Calling now." })).resolves.toEqual({
      providerMessageId: "SM222",
      status: "queued",
    });
    expect(create).toHaveBeenCalledWith({
      to: "+13045550101",
      body: "Calling now.",
      messagingServiceSid: "MG11111111111111111111111111111111",
      statusCallback: statusCallbackUrl,
    });
  });

  it("uses the configured From number when no Messaging Service exists", async () => {
    const create = vi.fn().mockResolvedValue({ sid: "SM333", status: null });
    const client: TwilioMessageClient = { messages: { create } };
    const sms = adapter({ client, messagingServiceSid: " " });
    await expect(sms.sendText({ messageId: "message-2", to: "+13045550101", body: "Update" })).resolves.toEqual({
      providerMessageId: "SM333",
      status: "accepted",
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ from: "+13045550100" }));
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("messagingServiceSid");
  });

  it("returns valid empty TwiML and rejects missing sender configuration", () => {
    expect(createEmptyTwilioMessagingResponse()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response/>');
    expect(() => adapter({ fromNumber: " ", messagingServiceSid: undefined })).toThrow("TWILIO_SMS_SENDER_REQUIRED");
  });
});
