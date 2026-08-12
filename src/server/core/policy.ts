import { createHmac, timingSafeEqual } from "node:crypto";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import type { AgentDecision, ApprovalRequest, AuthorityEnvelope, CallState, OutcomeReport, TranscriptTurn } from "../../shared/domain.js";
import { agentDecisionSchema, defaultAuthority } from "../../shared/domain.js";

const transitions: Record<CallState, ReadonlySet<CallState>> = {
  PREPARING: new Set(["DIALING", "FAILED"]),
  DIALING: new Set(["CONNECTED", "FAILED", "ENDING"]),
  CONNECTED: new Set(["IVR", "WAITING_FOR_REPRESENTATIVE", "DISCLOSING_ASSISTANT", "ENDING", "FAILED"]),
  IVR: new Set(["IVR", "ON_HOLD", "WAITING_FOR_REPRESENTATIVE", "DISCLOSING_ASSISTANT", "ENDING", "FAILED"]),
  ON_HOLD: new Set(["ON_HOLD", "WAITING_FOR_REPRESENTATIVE", "DISCLOSING_ASSISTANT", "NEGOTIATING", "ENDING", "FAILED"]),
  WAITING_FOR_REPRESENTATIVE: new Set(["ON_HOLD", "DISCLOSING_ASSISTANT", "ENDING", "FAILED"]),
  DISCLOSING_ASSISTANT: new Set(["DISCLOSING_ASSISTANT", "EXPLAINING_ISSUE", "ENDING", "FAILED"]),
  EXPLAINING_ISSUE: new Set(["AUTHENTICATING", "NEGOTIATING", "ON_HOLD", "NEEDS_USER", "VERIFYING_OUTCOME", "ENDING", "FAILED"]),
  AUTHENTICATING: new Set(["AUTHENTICATING", "NEGOTIATING", "NEEDS_USER", "ON_HOLD", "ENDING", "FAILED"]),
  NEGOTIATING: new Set(["NEGOTIATING", "AUTHENTICATING", "NEEDS_USER", "ON_HOLD", "VERIFYING_OUTCOME", "ENDING", "FAILED"]),
  NEEDS_USER: new Set(["AUTHENTICATING", "NEGOTIATING", "EXPLAINING_ISSUE", "VERIFYING_OUTCOME", "ENDING", "FAILED"]),
  VERIFYING_OUTCOME: new Set(["VERIFYING_OUTCOME", "NEGOTIATING", "NEEDS_USER", "ENDING", "FAILED"]),
  ENDING: new Set(["COMPLETED", "FAILED"]),
  COMPLETED: new Set(),
  FAILED: new Set(),
};

export function canTransition(from: CallState, to: CallState): boolean {
  return transitions[from].has(to);
}

export function transitionState(from: CallState, to: CallState): CallState {
  if (!canTransition(from, to)) throw new Error(`ILLEGAL_STATE_TRANSITION:${from}:${to}`);
  return to;
}

const hardKeys = ["makePurchase", "discloseCredential", "discloseOtp", "discloseFullSsn", "disclosePaymentCard", "waiveLegalRight", "impersonateUser"] as const;

export function enforceAuthority(input: Partial<AuthorityEnvelope>): AuthorityEnvelope {
  const merged = { ...defaultAuthority, ...input };
  for (const key of hardKeys) merged[key] = "DENY";
  return merged;
}

export function normalizeUsPhone(input: string): string {
  const compact = input.trim();
  if (/^(911|988|211|311|411|511|611|711|811)$/.test(compact.replace(/\D/g, ""))) throw new Error("SHORT_OR_EMERGENCY_NUMBER");
  const parsed = parsePhoneNumberFromString(compact, "US");
  if (!parsed?.isValid() || parsed.country !== "US") throw new Error("INVALID_US_PHONE_NUMBER");
  const national = parsed.nationalNumber;
  if (/^900/.test(national) || /^976/.test(national)) throw new Error("PREMIUM_RATE_NUMBER");
  return parsed.number;
}

const riskPatterns: Array<[string, RegExp]> = [
  ["emergency", /\b(emergency|911|urgent danger|suicid|overdose)\b/i],
  ["medical", /\b(doctor|hospital|medical|diagnos|prescription|pharmacy|healthcare)\b/i],
  ["legal", /\b(lawyer|attorney|court|lawsuit|legal advice|immigration)\b/i],
  ["financial", /\b(bank|credit card|loan|investment|mortgage|brokerage|insurance|debt collector)\b/i],
  ["government", /\b(irs|social security administration|government agency|police|law enforcement)\b/i],
  ["employment", /\b(job interview|hiring|employer|employment|termination from work)\b/i],
];

export function detectHighRisk(text: string): string[] {
  return riskPatterns.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
}

const prohibitedSecretPatterns: Array<[string, RegExp]> = [
  ["ONE_TIME_CODE", /\b(?:otp|one[- ]?time|verification|security)\s*(?:code)?\s*[:#-]?\s*\d{4,8}\b/i],
  ["PASSWORD", /\bpassword\s*[:#-]?\s*\S{4,}/i],
  ["FULL_SSN", /\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/],
  ["PAYMENT_CARD", /\b(?:\d[ -]*?){13,19}\b/],
  ["CVV_OR_PIN", /\b(?:cvv|cvc|pin)\s*[:#-]?\s*\d{3,6}\b/i],
];

export function prohibitedSecretReason(text: string): string | null {
  return prohibitedSecretPatterns.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
}

export function validateDtmf(digits: string, sensitive = false): boolean {
  if (!/^[0-9w#*]+$/.test(digits)) return false;
  return sensitive ? digits.length <= 64 : digits.length <= 4;
}

export interface PolicyContext {
  state: CallState; authority: AuthorityEnvelope; paused: boolean; pendingApproval: ApprovalRequest | null;
  disclosureDelivered: boolean; consentStatus: "UNKNOWN" | "ACCEPTED" | "REFUSED" | "AMBIGUOUS";
  durationSeconds: number; maximumDurationSeconds: number; generation: number; expectedGeneration: number;
  executedKeys: ReadonlySet<string>;
}

export type PolicyResult = { allowed: true; normalizedAction: AgentDecision } | { allowed: false; violationCode: string; safeFallback: "REQUEST_USER" | "REFUSE_REMOTE_REQUEST" | "WAIT" | "END_CALL" };

export function validateDecision(raw: unknown, context: PolicyContext): PolicyResult {
  const parsed = agentDecisionSchema.safeParse(raw);
  if (!parsed.success) return { allowed: false, violationCode: "MALFORMED_DECISION", safeFallback: "REQUEST_USER" };
  const decision = parsed.data;
  if (context.generation !== context.expectedGeneration) return { allowed: false, violationCode: "STALE_GENERATION", safeFallback: "WAIT" };
  if (context.durationSeconds >= context.maximumDurationSeconds) return { allowed: false, violationCode: "MAX_DURATION", safeFallback: "END_CALL" };
  if (!canTransition(context.state, decision.nextState)) return { allowed: false, violationCode: "ILLEGAL_TRANSITION", safeFallback: "REQUEST_USER" };
  if (context.pendingApproval && decision.action !== "WAIT") return { allowed: false, violationCode: "APPROVAL_PENDING", safeFallback: "WAIT" };
  if (context.paused && decision.action !== "WAIT") return { allowed: false, violationCode: "USER_PAUSED", safeFallback: "WAIT" };
  if (decision.action === "SPEAK") {
    if (prohibitedSecretReason(decision.text)) return { allowed: false, violationCode: "PROHIBITED_SECRET", safeFallback: "REFUSE_REMOTE_REQUEST" };
    if (context.consentStatus === "REFUSED") return { allowed: false, violationCode: "CONSENT_REFUSED", safeFallback: "END_CALL" };
    if (!context.disclosureDelivered && decision.policyReasonCode !== "DISCLOSE_ACCESSIBILITY_ASSISTANT") return { allowed: false, violationCode: "DISCLOSURE_REQUIRED", safeFallback: "END_CALL" };
    if (context.disclosureDelivered && context.consentStatus !== "ACCEPTED" && !["EXPLAIN_APPROVED_BRIEF","CLARIFY_CONSENT"].includes(decision.policyReasonCode)) return { allowed: false, violationCode: "CONSENT_REQUIRED", safeFallback: "END_CALL" };
    if (!context.disclosureDelivered && !["CONNECTED", "IVR", "ON_HOLD", "WAITING_FOR_REPRESENTATIVE", "DISCLOSING_ASSISTANT"].includes(context.state)) return { allowed: false, violationCode: "DISCLOSURE_REQUIRED", safeFallback: "END_CALL" };
  }
  if (decision.action === "SEND_DIGITS" && !validateDtmf(decision.digits)) return { allowed: false, violationCode: "INVALID_DTMF", safeFallback: "REQUEST_USER" };
  if (decision.action === "REQUEST_APPROVAL") {
    const permission={PERSONAL_DATA:context.authority.disclosePersonalData,FINANCIAL:context.authority.acceptFinancialOutcome,ACCOUNT_CHANGE:context.authority.modifyAccount,CANCELLATION:context.authority.cancelService,SCHEDULING:context.authority.scheduleCommitment,ALTERNATIVE_OUTCOME:context.authority.acceptAlternativeOutcome,END_UNRESOLVED:context.authority.endWithoutResolution}[decision.approval.category];
    if(permission==="DENY") return { allowed:false, violationCode:"AUTHORITY_DENIED", safeFallback:"REFUSE_REMOTE_REQUEST" };
    if (decision.approval.category === "FINANCIAL" && (decision.approval.amountCents ?? 0) > context.authority.maximumAuthorizedCostCents) {
      return { allowed: false, violationCode: "MONETARY_CAP_EXCEEDED", safeFallback: "REQUEST_USER" };
    }
  }
  const key = `${decision.action}:${decision.action === "SPEAK" ? decision.text : decision.action === "SEND_DIGITS" ? decision.digits : decision.policyReasonCode}`;
  if (context.executedKeys.has(key)) return { allowed: false, violationCode: "DUPLICATE_EXTERNAL_ACTION", safeFallback: "WAIT" };
  return { allowed: true, normalizedAction: decision };
}

function variants(value: string): string[] {
  const raw = value.trim();
  const compact = raw.replace(/[\s().-]/g, "");
  const digits = raw.replace(/\D/g, "");
  const grouped = digits.length >= 6 ? digits.match(/.{1,4}/g)?.join(" ") ?? "" : "";
  return [...new Set([raw, compact, digits, grouped].filter((v) => v.length >= 3))].sort((a, b) => b.length - a.length);
}

export function redactText(text: string, secrets: Array<{ label: string; category: string; value: string }>): string {
  let result = text;
  for (const secret of secrets) {
    for (const variant of variants(secret.value)) result = result.split(variant).join(`[REDACTED:${secret.category}:${secret.label}]`);
  }
  return result;
}

export function sanitizePayload(value: unknown, secrets: Array<{ label: string; category: string; value: string }>): unknown {
  return JSON.parse(redactText(JSON.stringify(value), secrets)) as unknown;
}

export function estimateCost(durationSeconds: number, perMinuteUsd: number): number {
  return Number(((durationSeconds / 60) * perMinuteUsd).toFixed(4));
}

function normalizeQuote(text: string): string { return text.normalize("NFKC").replace(/\s+/g, " ").trim(); }

export function validateOutcome(report: OutcomeReport, turns: TranscriptTurn[]): OutcomeReport {
  const turnMap = new Map(turns.map((turn) => [turn.id, normalizeQuote(turn.text)]));
  const evidenceValid = (evidence: Array<{ turnId: string; exactQuote: string }>) => evidence.length > 0 && evidence.every((ref) => turnMap.get(ref.turnId)?.includes(normalizeQuote(ref.exactQuote)));
  const cleanGrounded = <T>(field: { value: T; evidence: Array<{ turnId: string; exactQuote: string }> } | null) => field && evidenceValid(field.evidence) ? field : null;
  const cleanArray = <T>(items: Array<{ value: T; evidence: Array<{ turnId: string; exactQuote: string }> }>) => items.filter((item) => evidenceValid(item.evidence));
  const weak = /\b(look into|submit(?:ted)? a request|make|made a note|review|consider|investigat|escalat)\b/i;
  const resolution = cleanGrounded(report.resolution);
  const concreteResolution = resolution && !weak.test(String(resolution.value));
  return {
    ...report,
    status: report.status === "RESOLVED" && !concreteResolution ? "PARTIAL" : report.status,
    summary: cleanGrounded(report.summary), representativeName: cleanGrounded(report.representativeName), department: cleanGrounded(report.department),
    caseNumber: cleanGrounded(report.caseNumber), resolution,
    monetaryOutcomes: cleanArray(report.monetaryOutcomes), companyCommitments: cleanArray(report.companyCommitments),
    userActions: cleanArray(report.userActions), deadlines: cleanArray(report.deadlines), unresolvedItems: cleanArray(report.unresolvedItems),
  };
}

export function signToken(payload: object, secret: string, ttlSeconds = 300): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function verifyToken<T extends object>(token: string, secret: string): T | null {
  const [body, given] = token.split(".");
  if (!body || !given) return null;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(given); const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const value = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & { exp?: number };
    if (!value.exp || value.exp < Math.floor(Date.now() / 1000)) return null;
    return value;
  } catch { return null; }
}

export function safeKeyEqual(input: string, expected: string): boolean {
  const a = createHmac("sha256", "liaison-access-compare").update(input).digest();
  const b = createHmac("sha256", "liaison-access-compare").update(expected).digest();
  return timingSafeEqual(a, b);
}
