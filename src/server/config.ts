import "dotenv/config";
import { z } from "zod";
import type { PublicConfig } from "../shared/domain.js";

const bool = z.preprocess((value) => value === true || value === "true", z.boolean());
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),
  PUBLIC_WSS_URL: z.string().url().default("ws://localhost:3000"),
  DATABASE_PATH: z.string().min(1).default("./data/liaison.db"),
  APP_ACCESS_KEY: z.string().default(""), SESSION_SECRET: z.string().default(""), CALL_TOKEN_SECRET: z.string().default(""),
  LLM_MODE: z.enum(["mock", "openai"]).default("mock"), OPENAI_API_KEY: z.string().default(""),
  PLANNER_MODEL: z.string().default("gpt-5.6-luna"), CONTROLLER_MODEL: z.string().default("gpt-5.6-luna"), OUTCOME_MODEL: z.string().default("gpt-5.6-luna"),
  OPENAI_REASONING_EFFORT: z.enum(["none", "low", "medium", "high", "xhigh", "max"]).default("low"), OPENAI_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(12_000),
  TELEPHONY_MODE: z.enum(["simulator", "twilio"]).default("simulator"), ALLOW_REAL_CALLS: bool.default(false),
  TWILIO_ACCOUNT_SID: z.string().default(""), TWILIO_AUTH_TOKEN: z.string().default(""), TWILIO_FROM_NUMBER: z.string().default(""),
  MAX_CALL_DURATION_MINUTES: z.coerce.number().positive().max(120).default(30), MAX_CALLS_PER_DAY: z.coerce.number().int().positive().max(100).default(5),
  MAX_CONCURRENT_CALLS: z.coerce.number().int().min(1).max(1).default(1), ALLOWED_DESTINATION_PREFIXES: z.string().default("+1"),
  ESTIMATED_TELEPHONY_COST_PER_MINUTE_USD: z.coerce.number().min(0).default(0.084), DATA_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
  LOG_LEVEL: z.string().default("info"), TRUST_PROXY: bool.default(false),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config = schema.parse(env);
  if (config.NODE_ENV === "production") {
    const missing = ["APP_ACCESS_KEY", "SESSION_SECRET", "CALL_TOKEN_SECRET"].filter((key) => !config[key as keyof Config]);
    if (missing.length) throw new Error(`Missing production configuration: ${missing.join(", ")}`);
    if (config.PUBLIC_BASE_URL.startsWith("http://") || config.PUBLIC_WSS_URL.startsWith("ws://")) throw new Error("Production requires HTTPS and WSS public URLs");
  }
  if (config.LLM_MODE === "openai" && !config.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required when LLM_MODE=openai");
  if (config.TELEPHONY_MODE === "twilio" && config.ALLOW_REAL_CALLS && (!config.TWILIO_ACCOUNT_SID || !config.TWILIO_AUTH_TOKEN || !config.TWILIO_FROM_NUMBER)) throw new Error("Complete Twilio credentials are required when real calls are enabled");
  return config;
}

export function publicConfig(config: Config): PublicConfig {
  const twilioConfigured = Boolean(config.TWILIO_ACCOUNT_SID && config.TWILIO_AUTH_TOKEN && config.TWILIO_FROM_NUMBER && config.PUBLIC_BASE_URL.startsWith("https://") && config.PUBLIC_WSS_URL.startsWith("wss://"));
  return {
    telephonyMode: config.TELEPHONY_MODE, llmMode: config.LLM_MODE, twilioConfigured, openaiConfigured: Boolean(config.OPENAI_API_KEY),
    allowRealCalls: config.ALLOW_REAL_CALLS && twilioConfigured, maxDurationMinutes: config.MAX_CALL_DURATION_MINUTES,
    estimatedCostPerMinuteUsd: config.ESTIMATED_TELEPHONY_COST_PER_MINUTE_USD, developmentBypass: config.NODE_ENV !== "production" && !config.APP_ACCESS_KEY,
  };
}
