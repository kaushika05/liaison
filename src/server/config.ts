import "dotenv/config";
import { z } from "zod";
import type { PublicConfig } from "../shared/domain.js";

const bool = z.preprocess((value) => value === true || value === "true", z.boolean());
const schema = z.object({
  APP_NAME: z.string().trim().min(1).max(80).default("Liaison"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),
  PUBLIC_WSS_URL: z.string().url().default("ws://localhost:3000"),
  DATABASE_PATH: z.string().min(1).default("./data/liaison.db"),
  INSTANCE_MODE: z.literal("personal").default("personal"), OWNER_DISPLAY_NAME: z.string().trim().max(80).default(""), OWNER_PHONE_E164: z.string().trim().default(""),
  APP_ACCESS_KEY: z.string().default(""), SESSION_SECRET: z.string().default(""), CALL_TOKEN_SECRET: z.string().default(""), ACTION_LINK_SECRET: z.string().default(""),
  LLM_MODE: z.enum(["mock", "openai"]).default("mock"), OPENAI_API_KEY: z.string().default(""), OPENAI_BASE_URL: z.string().url().or(z.literal("")).default(""),
  PLANNER_MODEL: z.string().default("gpt-5.6-luna"), CONTROLLER_MODEL: z.string().default("gpt-5.6-luna"), OUTCOME_MODEL: z.string().default("gpt-5.6-luna"),
  OPENAI_REASONING_EFFORT: z.enum(["none", "low", "medium", "high", "xhigh", "max"]).default("low"), OPENAI_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(12_000),
  MESSAGING_MODE: z.enum(["web", "twilio_sms"]).default("web"), ALLOW_REAL_MESSAGING: bool.default(false),
  TWILIO_MESSAGING_SERVICE_SID: z.string().trim().default(""), TWILIO_SMS_FROM_NUMBER: z.string().trim().default(""),
  MESSAGING_REGISTRATION_CONFIRMED: bool.default(false),
  SMS_UPDATE_DETAIL: z.enum(["MINIMAL", "STANDARD", "VERBOSE"]).default("STANDARD"), SMS_DECISION_TIMEOUT_SECONDS: z.coerce.number().int().min(15).max(3_600).default(90),
  MAX_USER_WAIT_SECONDS: z.coerce.number().int().min(30).max(7_200).default(180), SMS_MAX_SEGMENTS_PER_MESSAGE: z.coerce.number().int().min(1).max(10).default(3),
  ESTIMATED_SMS_COST_PER_SEGMENT_USD: z.coerce.number().min(0).default(0),
  TELEPHONY_MODE: z.enum(["simulator", "twilio"]).default("simulator"), ALLOW_REAL_CALLS: bool.default(false),
  TWILIO_ACCOUNT_SID: z.string().default(""), TWILIO_AUTH_TOKEN: z.string().default(""), TWILIO_FROM_NUMBER: z.string().default(""), TWILIO_VOICE_FROM_NUMBER: z.string().default(""),
  MAX_CALL_DURATION_MINUTES: z.coerce.number().positive().max(120).default(30), MAX_CALLS_PER_DAY: z.coerce.number().int().positive().max(100).default(5),
  ALLOWED_DESTINATION_PREFIXES: z.string().default("+1"),
  ESTIMATED_TELEPHONY_COST_PER_MINUTE_USD: z.coerce.number().min(0).default(0.084), SECURE_ACTION_LINK_TTL_MINUTES: z.coerce.number().int().min(1).max(1_440).default(10), DATA_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
  LOG_LEVEL: z.string().default("info"), TRUST_PROXY: bool.default(false),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.parse(env);
  const config: Config = {
    ...parsed,
    TWILIO_VOICE_FROM_NUMBER: parsed.TWILIO_VOICE_FROM_NUMBER || parsed.TWILIO_FROM_NUMBER,
    TWILIO_FROM_NUMBER: parsed.TWILIO_FROM_NUMBER || parsed.TWILIO_VOICE_FROM_NUMBER,
  };
  if (config.NODE_ENV === "production") {
    const missing = ["APP_ACCESS_KEY", "SESSION_SECRET", "CALL_TOKEN_SECRET", "ACTION_LINK_SECRET"].filter((key) => !config[key as keyof Config]);
    if (missing.length) throw new Error(`Missing production configuration: ${missing.join(", ")}`);
    const weak = ["APP_ACCESS_KEY", "SESSION_SECRET", "CALL_TOKEN_SECRET", "ACTION_LINK_SECRET"].filter((key) => String(config[key as keyof Config]).length < 32);
    if (weak.length) throw new Error(`Production secrets must be at least 32 characters: ${weak.join(", ")}`);
    const secretValues = [config.APP_ACCESS_KEY,config.SESSION_SECRET,config.CALL_TOKEN_SECRET,config.ACTION_LINK_SECRET];
    if (new Set(secretValues).size !== secretValues.length) throw new Error("Production access and signing secrets must be independent");
    const publicHttp=new URL(config.PUBLIC_BASE_URL);const publicWs=new URL(config.PUBLIC_WSS_URL);
    if (publicHttp.protocol!=="https:"||publicWs.protocol!=="wss:"||publicHttp.pathname!=="/"||publicWs.pathname!=="/"||publicHttp.search||publicWs.search||publicHttp.hash||publicWs.hash||publicHttp.username||publicWs.username) throw new Error("Production requires path-free HTTPS and WSS public origins");
    if(config.PUBLIC_BASE_URL.endsWith("/")||config.PUBLIC_WSS_URL.endsWith("/"))throw new Error("Production public origins must not end with a slash");
  }
  if (config.LLM_MODE === "openai" && !config.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required when LLM_MODE=openai");
  if (config.OWNER_PHONE_E164 && !/^\+[1-9]\d{7,14}$/.test(config.OWNER_PHONE_E164)) throw new Error("OWNER_PHONE_E164 must use E.164 format");
  for(const [name,value] of [["TWILIO_SMS_FROM_NUMBER",config.TWILIO_SMS_FROM_NUMBER],["TWILIO_VOICE_FROM_NUMBER",config.TWILIO_VOICE_FROM_NUMBER],["TWILIO_FROM_NUMBER",config.TWILIO_FROM_NUMBER]] as const)if(value&&!/^\+[1-9]\d{7,14}$/.test(value))throw new Error(`${name} must use E.164 format`);
  if (config.MAX_USER_WAIT_SECONDS < config.SMS_DECISION_TIMEOUT_SECONDS) throw new Error("MAX_USER_WAIT_SECONDS must be at least SMS_DECISION_TIMEOUT_SECONDS");
  if (config.TELEPHONY_MODE === "twilio" && config.ALLOW_REAL_CALLS && (!config.TWILIO_ACCOUNT_SID || !config.TWILIO_AUTH_TOKEN || !config.TWILIO_VOICE_FROM_NUMBER)) throw new Error("Complete Twilio credentials are required when real calls are enabled");
  if (config.MESSAGING_MODE === "twilio_sms" && config.ALLOW_REAL_MESSAGING && (!config.TWILIO_ACCOUNT_SID || !config.TWILIO_AUTH_TOKEN || !config.OWNER_PHONE_E164 || (!config.TWILIO_MESSAGING_SERVICE_SID && !config.TWILIO_SMS_FROM_NUMBER))) throw new Error("Owner number, Twilio credentials, and a Messaging Service or SMS sender are required when real messaging is enabled");
  if(config.MESSAGING_MODE==="twilio_sms"&&config.ALLOW_REAL_MESSAGING&&!config.MESSAGING_REGISTRATION_CONFIRMED)throw new Error("MESSAGING_REGISTRATION_CONFIRMED must be true before real SMS is enabled");
  return config;
}

export function publicConfig(config: Config): PublicConfig {
  const twilioConfigured = Boolean(config.TWILIO_ACCOUNT_SID && config.TWILIO_AUTH_TOKEN && config.TWILIO_VOICE_FROM_NUMBER && config.PUBLIC_BASE_URL.startsWith("https://") && config.PUBLIC_WSS_URL.startsWith("wss://"));
  const messagingConfigured = Boolean(config.OWNER_PHONE_E164 && config.TWILIO_ACCOUNT_SID && config.TWILIO_AUTH_TOKEN && (config.TWILIO_MESSAGING_SERVICE_SID || config.TWILIO_SMS_FROM_NUMBER) && config.PUBLIC_BASE_URL.startsWith("https://"));
  return {
    telephonyMode: config.TELEPHONY_MODE, llmMode: config.LLM_MODE, twilioConfigured, openaiConfigured: Boolean(config.OPENAI_API_KEY),
    allowRealCalls: config.ALLOW_REAL_CALLS && twilioConfigured, maxDurationMinutes: config.MAX_CALL_DURATION_MINUTES,
    estimatedCostPerMinuteUsd: config.ESTIMATED_TELEPHONY_COST_PER_MINUTE_USD, developmentBypass: config.NODE_ENV !== "production" && !config.APP_ACCESS_KEY,
    appName: config.APP_NAME, instanceMode: config.INSTANCE_MODE, ownerConfigured: Boolean(config.OWNER_PHONE_E164), messagingMode: config.MESSAGING_MODE,
    messagingConfigured, allowRealMessaging: config.ALLOW_REAL_MESSAGING && messagingConfigured && config.MESSAGING_REGISTRATION_CONFIRMED, messagingDetail: config.SMS_UPDATE_DETAIL,
    estimatedSmsCostPerSegmentUsd: config.ESTIMATED_SMS_COST_PER_SEGMENT_USD,
    inboundMessagingWebhookUrl: `${config.PUBLIC_BASE_URL}/webhooks/twilio/messaging/inbound`, messagingStatusWebhookUrl: `${config.PUBLIC_BASE_URL}/webhooks/twilio/messaging/status`, messagingRegistrationConfirmed: config.MESSAGING_REGISTRATION_CONFIRMED,
  };
}
