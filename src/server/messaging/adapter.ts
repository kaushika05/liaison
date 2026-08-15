import { randomUUID } from "node:crypto";
import twilio from "twilio";
import type { MessageListInstanceCreateOptions } from "twilio/lib/rest/api/v2010/account/message.js";

export type MessagingAdapterKind = "WEB" | "TWILIO_SMS";
export type ProviderCallbackKind = "INBOUND_MESSAGE" | "STATUS_CALLBACK";
export type ProviderFormValue = string | readonly string[];
export type ProviderFormParameters = Readonly<Record<string, ProviderFormValue>>;

export interface OutboundTextMessage {
  messageId: string;
  to: string;
  body: string;
}

export interface OutboundMessageResult {
  providerMessageId: string;
  status: string;
}

export interface InboundProviderRequest {
  callbackKind: ProviderCallbackKind;
  signature?: string | null;
  form: ProviderFormParameters;
}

export interface InboundValidationResult {
  valid: boolean;
  reason?: "MISSING_SIGNATURE" | "INVALID_SIGNATURE";
}

export interface InboundMessageEnvelope {
  provider: "TWILIO_SMS";
  providerMessageSid: string;
  messageSid?: string;
  smsSid?: string;
  accountSid: string;
  from: string;
  to: string;
  body: string;
  numMedia: number;
  optOutType?: string;
  parameters: ProviderFormParameters;
}

export interface MessageStatusEnvelope {
  provider: "TWILIO_SMS";
  providerMessageSid: string;
  messageSid?: string;
  smsSid?: string;
  accountSid: string;
  status: string;
  messageStatus?: string;
  smsStatus?: string;
  from?: string;
  to?: string;
  errorCode?: string;
  errorMessage?: string;
  parameters: ProviderFormParameters;
}

export interface MessagingAdapter {
  readonly kind: MessagingAdapterKind;
  sendText(input: OutboundTextMessage): Promise<OutboundMessageResult>;
  validateInboundRequest?(input: InboundProviderRequest): Promise<InboundValidationResult>;
  parseInboundRequest?(input: InboundProviderRequest): Promise<InboundMessageEnvelope>;
  parseStatusCallback?(input: InboundProviderRequest): Promise<MessageStatusEnvelope>;
}

export type WebMessageSink = (input: OutboundTextMessage) => void | Promise<void>;

export class WebMessagingAdapter implements MessagingAdapter {
  readonly kind = "WEB" as const;

  constructor(
    private readonly sink?: WebMessageSink,
    private readonly createProviderId: () => string = randomUUID,
  ) {}

  async sendText(input: OutboundTextMessage): Promise<OutboundMessageResult> {
    await this.sink?.(input);
    return {
      providerMessageId: `WEB-${this.createProviderId()}`,
      status: "delivered",
    };
  }
}

interface TwilioMessageCreateResult {
  sid: string;
  status?: string | null;
}

/** The deliberately small surface used from Twilio's generated REST client. */
export interface TwilioMessageClient {
  messages: {
    create(input: MessageListInstanceCreateOptions): Promise<TwilioMessageCreateResult>;
  };
}

export interface TwilioSmsMessagingAdapterOptions {
  accountSid: string;
  authToken: string;
  inboundWebhookUrl: string;
  statusCallbackUrl: string;
  messagingServiceSid?: string;
  fromNumber?: string;
  client?: TwilioMessageClient;
}

function copyFormParameters(input: ProviderFormParameters): Record<string, string | string[]> {
  const copy: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(input)) {
    copy[key] = typeof value === "string" ? value : [...value];
  }
  return copy;
}

function firstValue(parameters: ProviderFormParameters, key: string): string | undefined {
  const value = parameters[key];
  return typeof value === "string" ? value : value?.[0];
}

function requireValue(parameters: ProviderFormParameters, key: string): string {
  const value = firstValue(parameters, key);
  if (value === undefined || value.length === 0) throw new Error(`MISSING_TWILIO_FIELD:${key}`);
  return value;
}

function requireBody(parameters: ProviderFormParameters): string {
  const value = firstValue(parameters, "Body");
  if (value === undefined) throw new Error("MISSING_TWILIO_FIELD:Body");
  return value;
}

function parseNumMedia(parameters: ProviderFormParameters): number {
  const raw = firstValue(parameters, "NumMedia") ?? "0";
  if (!/^\d+$/.test(raw)) throw new Error("INVALID_TWILIO_FIELD:NumMedia");
  return Number.parseInt(raw, 10);
}

function optionalValue(parameters: ProviderFormParameters, key: string): string | undefined {
  const value = firstValue(parameters, key);
  return value === undefined || value.length === 0 ? undefined : value;
}

function providerMessageSid(parameters: ProviderFormParameters): string {
  return optionalValue(parameters, "MessageSid") ?? requireValue(parameters, "SmsSid");
}

export function createEmptyTwilioMessagingResponse(): string {
  return new twilio.twiml.MessagingResponse().toString();
}

export class TwilioSmsMessagingAdapter implements MessagingAdapter {
  readonly kind = "TWILIO_SMS" as const;
  private readonly client: TwilioMessageClient;
  private readonly messagingServiceSid?: string;
  private readonly fromNumber?: string;

  constructor(private readonly options: TwilioSmsMessagingAdapterOptions) {
    this.messagingServiceSid = optionalConfiguredValue(options.messagingServiceSid);
    this.fromNumber = optionalConfiguredValue(options.fromNumber);
    if (!this.messagingServiceSid && !this.fromNumber) {
      throw new Error("TWILIO_SMS_SENDER_REQUIRED");
    }
    this.client = options.client ?? twilio(options.accountSid, options.authToken);
  }

  async sendText(input: OutboundTextMessage): Promise<OutboundMessageResult> {
    const request: MessageListInstanceCreateOptions = {
      to: input.to,
      body: input.body,
      statusCallback: this.options.statusCallbackUrl,
      ...(this.messagingServiceSid ? { messagingServiceSid: this.messagingServiceSid } : { from: this.fromNumber }),
    };
    const message = await this.client.messages.create(request);
    return {
      providerMessageId: message.sid,
      status: message.status ?? "accepted",
    };
  }

  async validateInboundRequest(input: InboundProviderRequest): Promise<InboundValidationResult> {
    if (!input.signature) return { valid: false, reason: "MISSING_SIGNATURE" };
    const canonicalUrl =
      input.callbackKind === "INBOUND_MESSAGE" ? this.options.inboundWebhookUrl : this.options.statusCallbackUrl;
    const valid = twilio.validateRequest(
      this.options.authToken,
      input.signature,
      canonicalUrl,
      copyFormParameters(input.form),
    );
    return valid ? { valid: true } : { valid: false, reason: "INVALID_SIGNATURE" };
  }

  async parseInboundRequest(input: InboundProviderRequest): Promise<InboundMessageEnvelope> {
    if (input.callbackKind !== "INBOUND_MESSAGE") throw new Error("TWILIO_CALLBACK_KIND_MISMATCH");
    const messageSid = optionalValue(input.form, "MessageSid");
    const smsSid = optionalValue(input.form, "SmsSid");
    return {
      provider: "TWILIO_SMS",
      providerMessageSid: providerMessageSid(input.form),
      ...(messageSid ? { messageSid } : {}),
      ...(smsSid ? { smsSid } : {}),
      accountSid: requireValue(input.form, "AccountSid"),
      from: requireValue(input.form, "From"),
      to: requireValue(input.form, "To"),
      body: requireBody(input.form),
      numMedia: parseNumMedia(input.form),
      ...(optionalValue(input.form, "OptOutType") ? { optOutType: optionalValue(input.form, "OptOutType") } : {}),
      parameters: copyFormParameters(input.form),
    };
  }

  async parseStatusCallback(input: InboundProviderRequest): Promise<MessageStatusEnvelope> {
    if (input.callbackKind !== "STATUS_CALLBACK") throw new Error("TWILIO_CALLBACK_KIND_MISMATCH");
    const messageSid = optionalValue(input.form, "MessageSid");
    const smsSid = optionalValue(input.form, "SmsSid");
    const messageStatus = optionalValue(input.form, "MessageStatus");
    const smsStatus = optionalValue(input.form, "SmsStatus");
    return {
      provider: "TWILIO_SMS",
      providerMessageSid: providerMessageSid(input.form),
      ...(messageSid ? { messageSid } : {}),
      ...(smsSid ? { smsSid } : {}),
      accountSid: requireValue(input.form, "AccountSid"),
      status: messageStatus ?? requireValue(input.form, "SmsStatus"),
      ...(messageStatus ? { messageStatus } : {}),
      ...(smsStatus ? { smsStatus } : {}),
      ...(optionalValue(input.form, "From") ? { from: optionalValue(input.form, "From") } : {}),
      ...(optionalValue(input.form, "To") ? { to: optionalValue(input.form, "To") } : {}),
      ...(optionalValue(input.form, "ErrorCode") ? { errorCode: optionalValue(input.form, "ErrorCode") } : {}),
      ...(optionalValue(input.form, "ErrorMessage") ? { errorMessage: optionalValue(input.form, "ErrorMessage") } : {}),
      parameters: copyFormParameters(input.form),
    };
  }
}

function optionalConfiguredValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
