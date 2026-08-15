import { createHmac, timingSafeEqual } from "node:crypto";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import type {
  AgentDecision,
  ApprovalRequest,
  AuthorityEnvelope,
  CallState,
  OutcomeReport,
  TranscriptTurn,
} from "../../shared/domain.js";
import { agentDecisionSchema, defaultAuthority } from "../../shared/domain.js";
import { redactInboundSmsSecrets } from "../messaging/secrets.js";

export const prohibitedSecretRefusalText =
  "I can't provide passwords or one-time codes. Is there another permitted way to authenticate?";

const transitions: Record<CallState, ReadonlySet<CallState>> = {
  PREPARING: new Set(["DIALING", "FAILED"]),
  DIALING: new Set(["CONNECTED", "FAILED", "ENDING"]),
  CONNECTED: new Set(["IVR", "WAITING_FOR_REPRESENTATIVE", "DISCLOSING_ASSISTANT", "ENDING", "FAILED"]),
  IVR: new Set(["IVR", "ON_HOLD", "WAITING_FOR_REPRESENTATIVE", "DISCLOSING_ASSISTANT", "ENDING", "FAILED"]),
  ON_HOLD: new Set([
    "ON_HOLD",
    "WAITING_FOR_REPRESENTATIVE",
    "DISCLOSING_ASSISTANT",
    "NEGOTIATING",
    "NEEDS_USER",
    "ENDING",
    "FAILED",
  ]),
  WAITING_FOR_REPRESENTATIVE: new Set(["ON_HOLD", "DISCLOSING_ASSISTANT", "ENDING", "FAILED"]),
  DISCLOSING_ASSISTANT: new Set(["DISCLOSING_ASSISTANT", "EXPLAINING_ISSUE", "ENDING", "FAILED"]),
  EXPLAINING_ISSUE: new Set([
    "AUTHENTICATING",
    "NEGOTIATING",
    "ON_HOLD",
    "NEEDS_USER",
    "VERIFYING_OUTCOME",
    "ENDING",
    "FAILED",
  ]),
  AUTHENTICATING: new Set(["AUTHENTICATING", "NEGOTIATING", "NEEDS_USER", "ON_HOLD", "ENDING", "FAILED"]),
  NEGOTIATING: new Set([
    "NEGOTIATING",
    "AUTHENTICATING",
    "NEEDS_USER",
    "ON_HOLD",
    "VERIFYING_OUTCOME",
    "ENDING",
    "FAILED",
  ]),
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

const hardKeys = [
  "makePurchase",
  "discloseCredential",
  "discloseOtp",
  "discloseFullSsn",
  "disclosePaymentCard",
  "waiveLegalRight",
  "impersonateUser",
] as const;

export function enforceAuthority(input: Partial<AuthorityEnvelope>): AuthorityEnvelope {
  const merged = { ...defaultAuthority, ...input };
  for (const key of hardKeys) merged[key] = "DENY";
  return merged;
}

export function normalizeUsPhone(input: string): string {
  const compact = input.trim();
  if (/^(911|988|211|311|411|511|611|711|811)$/.test(compact.replace(/\D/g, "")))
    throw new Error("SHORT_OR_EMERGENCY_NUMBER");
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

const prohibitedUserActionPatterns: Array<[string, RegExp]> = [
  [
    "PURCHASE",
    /\b(?:please|kindly|go ahead and|you may|i authorize you to|i approve you to|i want you to) (?:buy|purchase|order)\b/g,
  ],
  [
    "PURCHASE",
    /\b(?:make|complete|authorize|approve|accept|proceed with|go ahead with) (?:an? |the )?(?:purchase|order)\b/g,
  ],
  ["PURCHASE", /\bplace (?:an? |the )?order\b/g],
  [
    "PURCHASE",
    /\b(?:buy|purchase|order) (?:it|this|that|one|the (?:item|product|upgrade|plan|service|subscription)|an? (?:item|product|upgrade|plan|service|subscription))\b/g,
  ],
  ["PURCHASE", /\b(?:charge|bill) (?:me|my account|the account)\b/g],
  [
    "PURCHASE",
    /\b(?:accept|approve|authorize|agree to|go ahead with)(?: [a-z0-9$]+){0,8} (?:purchase|paid upgrade|fee|charge|order)\b/g,
  ],
  [
    "NEW_CONTRACT",
    /\b(?:accept|approve|authorize|agree to|enter into|sign|sign up for|enroll in|renew|start)(?: [a-z0-9$]+){0,8} (?:new contract|contract|service agreement|subscription|membership|recurring plan|recurring commitment|term agreement)\b/g,
  ],
  [
    "NEW_CONTRACT",
    /\b(?:create|open|take out)(?: [a-z0-9$]+){0,8} (?:new contract|contract|subscription|membership|recurring plan|recurring commitment)\b/g,
  ],
  [
    "IMPERSONATION",
    /\b(?:impersonate|pretend to be|pose as|claim to be|say (?:that )?(?:you are|you re)|tell (?:them|the representative) (?:that )?(?:you are|you re))(?: [a-z0-9]+){0,8} (?:me|account holder|customer|user)\b/g,
  ],
  [
    "IMPERSONATION",
    /\b(?:pretend (?:that )?you (?:are|re)|speak as|act as|represent yourself as)(?: [a-z0-9]+){0,8} (?:me|account holder|customer|user)\b/g,
  ],
  ["IMPERSONATION", /\bi am (?:the )?(?:account holder|customer|user)\b/g],
  [
    "LEGAL_WAIVER",
    /\b(?:waive|give up|relinquish|surrender|release)(?: [a-z0-9]+){0,6} (?:right|rights|claim|claims|remedy|remedies|liability)\b/g,
  ],
  [
    "MATERIAL_FINANCIAL_OUTCOME",
    /\b(?:accept(?:s|ed)?|approv(?:e|es|ed)|authoriz(?:e|es|ed)|agree(?:s|d)? to|take(?:s|n)?|appl(?:y|ies|ied)|receiv(?:e|es|ed))(?: [a-z0-9$]+){0,8} (?:credit|refund|discount|financial outcome)\b/g,
  ],
  [
    "MATERIAL_ACCOUNT_CHANGE",
    /\b(?:accept|approve|authorize|agree to|change|switch|move|upgrade|downgrade)(?: [a-z0-9$]+){0,8} (?:plan|account|service tier|subscription)\b/g,
  ],
  [
    "MATERIAL_CANCELLATION",
    /\b(?:cancel|terminate|close|disconnect)(?: [a-z0-9$]+){0,6} (?:service|account|plan|subscription|membership)\b/g,
  ],
  [
    "MATERIAL_SCHEDULING",
    /\b(?:book|schedule|reschedule|confirm|accept)(?: [a-z0-9$]+){0,8} (?:appointment|visit|service window|time slot)\b/g,
  ],
  [
    "AMBIGUOUS_MATERIAL_ASSENT",
    /\b(?:yes i agree to that|that works for me|please (?:apply|accept|approve|confirm|cancel|change|schedule) (?:it|that|the offer)|please go ahead with (?:it|that|the offer)|go ahead and (?:apply|accept|approve|confirm|cancel|change|schedule) (?:it|that))\b/g,
  ],
];

function foldPolicyText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9$]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function actionIsExplicitlyDenied(text: string, actionIndex: number): boolean {
  const prefix = text.slice(Math.max(0, actionIndex - 100), actionIndex).trimEnd();
  return /\b(?:do not|don t|never|must not|cannot|can t|not authorized to|not approve(?:d)? to|decline(?:d)?|reject(?:ed)?|refuse(?:d)? to)(?: [a-z0-9$]+){0,6}$/.test(
    prefix,
  );
}

/** Screens user-authored speech and steering before it can become persisted or externally executed. */
export function prohibitedUserActionReason(text: string, forbiddenActions: readonly string[] = []): string | null {
  const folded = foldPolicyText(text);
  if (!folded) return null;
  for (const [reason, pattern] of prohibitedUserActionPatterns) {
    pattern.lastIndex = 0;
    for (const match of folded.matchAll(pattern)) {
      if (!actionIsExplicitlyDenied(folded, match.index ?? 0)) return reason;
    }
  }
  for (const forbiddenAction of forbiddenActions) {
    const forbidden = foldPolicyText(forbiddenAction).replace(
      /^(?:do not|don t|never|must not|cannot|can t|not authorized to)\s+/,
      "",
    );
    if (!forbidden) continue;
    let index = folded.indexOf(forbidden);
    while (index >= 0) {
      if (!actionIsExplicitlyDenied(folded, index)) return "AUTHORITY_FORBIDDEN_ACTION";
      index = folded.indexOf(forbidden, index + forbidden.length);
    }
  }
  return null;
}

export type RequestedDisclosureCategory = "ACCOUNT_NUMBER" | "ORDER_NUMBER" | "ADDRESS" | "DATE_OF_BIRTH";

const disclosureRequestPatterns: Array<[RequestedDisclosureCategory, RegExp]> = [
  ["DATE_OF_BIRTH", /\b(?:date of birth|birth date|birthdate|\bdob\b)\b/i],
  // "confirmation number" is deliberately excluded: representatives usually *give* one rather than
  // request it, and treating it as a disclosure request would misroute terminal scenario turns.
  ["ORDER_NUMBER", /\b(?:order|booking|reservation)\s*(?:number|no\.?|id|lookup)\b|\blook up (?:the |my )?order\b/i],
  [
    "ADDRESS",
    /\b(?:billing|mailing|service|street|home)\s+address\b|\baddress (?:on|for) (?:the |your |my )?(?:account|file)\b/i,
  ],
  // The category word is always required. Bare "identification" or "verification" matches nothing,
  // which is what stops one card's policy wording from unlocking a different card's category.
  [
    "ACCOUNT_NUMBER",
    /\baccount\s*(?:number|no\.?|id|identification|verification|authentication)\b|\b(?:member|customer)\s*(?:number|no\.?|id)\b|\b(?:authenticate|verify)\s+(?:the |your |my )?account\b/i,
  ],
];

/**
 * Classifies which sensitive category a representative is asking for, using only a closed set of
 * disjoint patterns. Remote speech can therefore *narrow* which disclosure card is releasable but
 * can never widen it: unrecognised text yields null, and null denies. Deliberately not a similarity
 * or term-overlap match, because the input is attacker-controlled.
 */
export function classifyRequestedDisclosureCategory(text: string): RequestedDisclosureCategory | null {
  const folded = text.normalize("NFKC");
  return disclosureRequestPatterns.find(([, pattern]) => pattern.test(folded))?.[0] ?? null;
}

export function validateDtmf(digits: string, sensitive = false): boolean {
  if (!/^[0-9w#*]+$/.test(digits)) return false;
  return sensitive ? digits.length <= 64 : digits.length <= 4;
}

export interface PolicyContext {
  state: CallState;
  authority: AuthorityEnvelope;
  paused: boolean;
  pendingApproval: ApprovalRequest | null;
  disclosureDelivered: boolean;
  consentStatus: "UNKNOWN" | "ACCEPTED" | "REFUSED" | "AMBIGUOUS";
  durationSeconds: number;
  maximumDurationSeconds: number;
  generation: number;
  expectedGeneration: number;
  executedKeys: ReadonlySet<string>;
  decisionSource?: "MODEL" | "SIMULATOR";
}

export type PolicyResult =
  | { allowed: true; normalizedAction: AgentDecision }
  | {
      allowed: false;
      violationCode: string;
      safeFallback: "REQUEST_USER" | "REFUSE_REMOTE_REQUEST" | "WAIT" | "END_CALL";
    };

export function validateDecision(raw: unknown, context: PolicyContext): PolicyResult {
  const parsed = agentDecisionSchema.safeParse(raw);
  if (!parsed.success) return { allowed: false, violationCode: "MALFORMED_DECISION", safeFallback: "REQUEST_USER" };
  const decision = parsed.data;
  if (context.generation !== context.expectedGeneration)
    return { allowed: false, violationCode: "STALE_GENERATION", safeFallback: "WAIT" };
  if (context.durationSeconds >= context.maximumDurationSeconds)
    return { allowed: false, violationCode: "MAX_DURATION", safeFallback: "END_CALL" };
  if (!canTransition(context.state, decision.nextState))
    return { allowed: false, violationCode: "ILLEGAL_TRANSITION", safeFallback: "REQUEST_USER" };
  if (context.pendingApproval && decision.action !== "WAIT")
    return { allowed: false, violationCode: "APPROVAL_PENDING", safeFallback: "WAIT" };
  if (context.paused && decision.action !== "WAIT")
    return { allowed: false, violationCode: "USER_PAUSED", safeFallback: "WAIT" };
  if (decision.action === "SPEAK") {
    const isControlledSecretRefusal =
      decision.policyReasonCode === "PROHIBITED_SECRET_REFUSAL" && decision.text === prohibitedSecretRefusalText;
    if (!isControlledSecretRefusal && redactInboundSmsSecrets(decision.text).blocked)
      return {
        allowed: false,
        violationCode: "SENSITIVE_VALUE_REQUIRES_SECURE_DISCLOSURE",
        safeFallback: "REFUSE_REMOTE_REQUEST",
      };
    if (prohibitedSecretReason(decision.text))
      return { allowed: false, violationCode: "PROHIBITED_SECRET", safeFallback: "REFUSE_REMOTE_REQUEST" };
    const prohibitedAction = prohibitedUserActionReason(decision.text, context.authority.forbiddenActions);
    if (prohibitedAction)
      return {
        allowed: false,
        violationCode: `PROHIBITED_USER_ACTION:${prohibitedAction}`,
        safeFallback: "REFUSE_REMOTE_REQUEST",
      };
    if (context.consentStatus === "REFUSED")
      return { allowed: false, violationCode: "CONSENT_REFUSED", safeFallback: "END_CALL" };
    if (!context.disclosureDelivered && decision.policyReasonCode !== "DISCLOSE_ACCESSIBILITY_ASSISTANT")
      return { allowed: false, violationCode: "DISCLOSURE_REQUIRED", safeFallback: "END_CALL" };
    if (
      context.disclosureDelivered &&
      context.consentStatus !== "ACCEPTED" &&
      !["EXPLAIN_APPROVED_BRIEF", "CLARIFY_CONSENT"].includes(decision.policyReasonCode)
    )
      return { allowed: false, violationCode: "CONSENT_REQUIRED", safeFallback: "END_CALL" };
    if (
      !context.disclosureDelivered &&
      !["CONNECTED", "IVR", "ON_HOLD", "WAITING_FOR_REPRESENTATIVE", "DISCLOSING_ASSISTANT"].includes(context.state)
    )
      return { allowed: false, violationCode: "DISCLOSURE_REQUIRED", safeFallback: "END_CALL" };
  }
  if (decision.action === "SEND_DIGITS") {
    if (!validateDtmf(decision.digits))
      return { allowed: false, violationCode: "INVALID_DTMF", safeFallback: "REQUEST_USER" };
    if (!["IVR_NAVIGATION", "IVR_MENU_SELECTION"].includes(decision.policyReasonCode))
      return { allowed: false, violationCode: "DTMF_PURPOSE_NOT_ALLOWLISTED", safeFallback: "REQUEST_USER" };
  }
  if (decision.action === "REQUEST_APPROVAL") {
    if (redactInboundSmsSecrets(decision.approval.proposedSpeech).blocked)
      return {
        allowed: false,
        violationCode: "SENSITIVE_VALUE_REQUIRES_SECURE_DISCLOSURE",
        safeFallback: "REFUSE_REMOTE_REQUEST",
      };
    if (prohibitedSecretReason(decision.approval.proposedSpeech))
      return { allowed: false, violationCode: "PROHIBITED_SECRET", safeFallback: "REFUSE_REMOTE_REQUEST" };
    const prohibitedAction = prohibitedUserActionReason(
      decision.approval.proposedSpeech,
      context.authority.forbiddenActions,
    );
    if (prohibitedAction)
      return {
        allowed: false,
        violationCode: `PROHIBITED_USER_ACTION:${prohibitedAction}`,
        safeFallback: "REFUSE_REMOTE_REQUEST",
      };
    const permission = {
      PERSONAL_DATA: context.authority.disclosePersonalData,
      FINANCIAL: context.authority.acceptFinancialOutcome,
      ACCOUNT_CHANGE: context.authority.modifyAccount,
      CANCELLATION: context.authority.cancelService,
      SCHEDULING: context.authority.scheduleCommitment,
      ALTERNATIVE_OUTCOME: context.authority.acceptAlternativeOutcome,
      END_UNRESOLVED: context.authority.endWithoutResolution,
    }[decision.approval.category];
    if (permission === "DENY")
      return { allowed: false, violationCode: "AUTHORITY_DENIED", safeFallback: "REFUSE_REMOTE_REQUEST" };
    if (
      decision.approval.category === "FINANCIAL" &&
      (decision.approval.amountCents ?? 0) > context.authority.maximumAuthorizedCostCents
    ) {
      return { allowed: false, violationCode: "MONETARY_CAP_EXCEEDED", safeFallback: "REQUEST_USER" };
    }
  }
  if (
    decision.action === "END_CALL" &&
    ["UNRESOLVED", "PARTIALLY_RESOLVED", "USER_REQUESTED"].includes(decision.reason) &&
    context.authority.endWithoutResolution !== "ALLOW"
  ) {
    const trustedSimulatorTerminal =
      context.decisionSource === "SIMULATOR" &&
      decision.policyReasonCode === "TERMINAL_SCENARIO_RESULT" &&
      decision.reason !== "USER_REQUESTED";
    if (!trustedSimulatorTerminal)
      return { allowed: false, violationCode: "END_CALL_REQUIRES_APPROVAL", safeFallback: "REQUEST_USER" };
  }
  const key = `${decision.action}:${decision.action === "SPEAK" ? decision.text : decision.action === "SEND_DIGITS" ? decision.digits : decision.policyReasonCode}`;
  if (context.executedKeys.has(key))
    return { allowed: false, violationCode: "DUPLICATE_EXTERNAL_ACTION", safeFallback: "WAIT" };
  return { allowed: true, normalizedAction: decision };
}

function variants(value: string): string[] {
  const raw = value.trim();
  const compact = raw.replace(/[\s().-]/g, "");
  const digits = raw.replace(/\D/g, "");
  const grouped = digits.length >= 6 ? (digits.match(/.{1,4}/g)?.join(" ") ?? "") : "";
  return [...new Set([raw, compact, digits, grouped].filter((v) => v.length >= 3))].sort((a, b) => b.length - a.length);
}

export function redactText(text: string, secrets: Array<{ label: string; category: string; value: string }>): string {
  let result = text;
  for (const secret of secrets) {
    for (const variant of variants(secret.value))
      result = result.split(variant).join(`[REDACTED:${secret.category}:${secret.label}]`);
  }
  return result;
}

export function sanitizePayload(
  value: unknown,
  secrets: Array<{ label: string; category: string; value: string }>,
): unknown {
  return JSON.parse(redactText(JSON.stringify(value), secrets)) as unknown;
}

export function estimateCost(durationSeconds: number, perMinuteUsd: number): number {
  return Number(((durationSeconds / 60) * perMinuteUsd).toFixed(4));
}

function normalizeQuote(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}
function foldedEvidenceText(text: string): string {
  return normalizeQuote(text)
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9$]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function groundedValue(
  value: unknown,
  evidence: Array<{ turnId: string; exactQuote: string }>,
  turnMap: Map<string, string>,
  allowContainedValue = false,
): boolean {
  if (evidence.length === 0) return false;
  const valueText = foldedEvidenceText(typeof value === "string" ? value : JSON.stringify(value));
  if (!valueText) return false;
  return evidence.some((ref) => {
    const turn = turnMap.get(ref.turnId);
    if (!turn) return false;
    const quote = foldedEvidenceText(ref.exactQuote);
    return Boolean(
      quote &&
        foldedEvidenceText(turn).includes(quote) &&
        (quote === valueText || (allowContainedValue && quote.includes(valueText))),
    );
  });
}

export function validateOutcome(report: OutcomeReport, turns: TranscriptTurn[]): OutcomeReport {
  const turnMap = new Map(turns.map((turn) => [turn.id, normalizeQuote(turn.text)]));
  const evidenceValid = (evidence: Array<{ turnId: string; exactQuote: string }>) =>
    evidence.length > 0 && evidence.every((ref) => turnMap.get(ref.turnId)?.includes(normalizeQuote(ref.exactQuote)));
  const cleanGrounded = <T>(
    field: { value: T; evidence: Array<{ turnId: string; exactQuote: string }> } | null,
    allowContainedValue = false,
  ) =>
    field && evidenceValid(field.evidence) && groundedValue(field.value, field.evidence, turnMap, allowContainedValue)
      ? field
      : null;
  const cleanArray = <T>(items: Array<{ value: T; evidence: Array<{ turnId: string; exactQuote: string }> }>) =>
    items.filter((item) => evidenceValid(item.evidence) && groundedValue(item.value, item.evidence, turnMap));
  const weak = /\b(look into|submit(?:ted)? a request|make|made a note|review|consider|investigat|escalat)\b/i;
  const resolution = cleanGrounded(report.resolution);
  const concreteResolution = resolution && !weak.test(String(resolution.value));
  return {
    ...report,
    status: report.status === "RESOLVED" && !concreteResolution ? "PARTIAL" : report.status,
    summary: cleanGrounded(report.summary),
    representativeName: cleanGrounded(report.representativeName, true),
    department: cleanGrounded(report.department, true),
    caseNumber: cleanGrounded(report.caseNumber, true),
    resolution,
    monetaryOutcomes: cleanArray(report.monetaryOutcomes),
    companyCommitments: cleanArray(report.companyCommitments),
    userActions: cleanArray(report.userActions),
    deadlines: cleanArray(report.deadlines),
    unresolvedItems: cleanArray(report.unresolvedItems),
  };
}

export function signToken(payload: object, secret: string, ttlSeconds = 300): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString(
    "base64url",
  );
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function verifyToken<T extends object>(token: string, secret: string): T | null {
  const [body, given] = token.split(".");
  if (!body || !given) return null;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const value = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & { exp?: number };
    if (!value.exp || value.exp < Math.floor(Date.now() / 1000)) return null;
    return value;
  } catch {
    return null;
  }
}

export function safeKeyEqual(input: string, expected: string): boolean {
  const a = createHmac("sha256", "liaison-access-compare").update(input).digest();
  const b = createHmac("sha256", "liaison-access-compare").update(expected).digest();
  return timingSafeEqual(a, b);
}
