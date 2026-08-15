import { z } from "zod";
import {
  authorityEnvelopeSchema,
  callBriefSchema,
  chronologyItemSchema,
  disclosureCategorySchema,
  evidenceReferenceSchema,
  outcomeReportSchema,
  permissionLevelSchema,
  type AuthorityEnvelope,
  type CallBrief,
} from "./domain.js";

/** Liaison Universal Support Protocol, major version 1. */
export const protocolVersionSchema = z.literal(1).describe("Liaison Universal Support Protocol major version.");

export const messagingDetailLevelSchema = z.enum(["MINIMAL", "STANDARD", "VERBOSE"]);
export type MessagingDetailLevel = z.infer<typeof messagingDetailLevelSchema>;
export const DEFAULT_MESSAGING_DETAIL_LEVEL: MessagingDetailLevel = "STANDARD";

export const autonomyModeSchema = z.enum(["ASSIST", "COPILOT", "DELEGATE"]);
export type AutonomyMode = z.infer<typeof autonomyModeSchema>;
export const DEFAULT_AUTONOMY_MODE: AutonomyMode = "COPILOT";

export const autonomyPresetSchema = z.object({
  mayExplainIssue: z.boolean(),
  mayAskFactualQuestions: z.boolean(),
  mayNegotiateWithinAuthority: z.boolean(),
  substantiveResponsePolicy: z.enum([
    "USER_AUTHORED",
    "REQUEST_ON_CONSEQUENTIAL_OR_AMBIGUOUS",
    "REQUEST_AT_HARD_BOUNDARIES",
  ]),
});
export type AutonomyPreset = z.infer<typeof autonomyPresetSchema>;

/**
 * Interaction presets only. Every action remains subject to the approved
 * AuthorityEnvelope, conditional authority, and hard policy.
 */
export const AUTONOMY_PRESETS: Readonly<Record<AutonomyMode, Readonly<AutonomyPreset>>> = Object.freeze({
  ASSIST: Object.freeze({
    mayExplainIssue: false,
    mayAskFactualQuestions: false,
    mayNegotiateWithinAuthority: false,
    substantiveResponsePolicy: "USER_AUTHORED",
  }),
  COPILOT: Object.freeze({
    mayExplainIssue: true,
    mayAskFactualQuestions: true,
    mayNegotiateWithinAuthority: true,
    substantiveResponsePolicy: "REQUEST_ON_CONSEQUENTIAL_OR_AMBIGUOUS",
  }),
  DELEGATE: Object.freeze({
    mayExplainIssue: true,
    mayAskFactualQuestions: true,
    mayNegotiateWithinAuthority: true,
    substantiveResponsePolicy: "REQUEST_AT_HARD_BOUNDARIES",
  }),
});

export function autonomyPreset(mode: AutonomyMode): Readonly<AutonomyPreset> {
  return AUTONOMY_PRESETS[autonomyModeSchema.parse(mode)];
}

export const attentionTierSchema = z.enum([
  "INFORMATIONAL",
  "LOW_CONSEQUENCE",
  "SENSITIVE",
  "MATERIAL",
  "PROHIBITED",
]);
export type AttentionTier = z.infer<typeof attentionTierSchema>;

export const attentionStatusSchema = z.enum([
  "PENDING",
  "APPROVED",
  "REJECTED",
  "REPLACED",
  "EXPIRED",
  "SUPERSEDED",
  "CANCELLED",
]);
export type AttentionStatus = z.infer<typeof attentionStatusSchema>;

export const attentionChoiceSchema = z.object({
  id: z.string().trim().min(1).max(120),
  shortCode: z.string().trim().toUpperCase().regex(/^[A-C]$/, "Choice code must be A, B, or C."),
  label: z.string().trim().min(1).max(160),
  effect: z.string().trim().min(1).max(500),
});
export type AttentionChoice = z.infer<typeof attentionChoiceSchema>;

const isoDateTimeSchema = z.string().datetime({ offset: true });

export const attentionRequestSchema = z.object({
  protocolVersion: protocolVersionSchema.default(1),
  id: z.string().trim().min(1).max(120),
  caseId: z.string().trim().min(1).max(120),
  callId: z.string().trim().min(1).max(120),
  tier: attentionTierSchema,
  status: attentionStatusSchema,
  title: z.string().trim().min(1).max(200),
  representativeRequest: z.string().trim().min(1).max(1_000),
  currentGoal: z.string().trim().min(1).max(1_000),
  proposedAction: z.string().trim().min(1).max(1_000),
  consequences: z.string().trim().min(1).max(1_000),
  choices: z.array(attentionChoiceSchema).max(3),
  amountCents: z.number().int().min(0).optional(),
  disclosureCardId: z.string().trim().min(1).max(120).optional(),
  createdAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
  resolvedAt: isoDateTimeSchema.optional(),
  resolutionChannel: z.enum(["SMS", "WEB"]).optional(),
  resolutionMessageId: z.string().trim().min(1).max(120).optional(),
}).superRefine((request, context) => {
  const codes = request.choices.map((choice) => choice.shortCode);
  if (new Set(codes).size !== codes.length) {
    context.addIssue({ code: "custom", path: ["choices"], message: "Choice codes must be unambiguous." });
  }
  if (request.status === "PENDING" && request.tier === "LOW_CONSEQUENCE" && request.choices.length < 2) {
    context.addIssue({ code: "custom", path: ["choices"], message: "A pending low-consequence request needs at least two choices." });
  }
  if (request.tier === "INFORMATIONAL" && request.choices.length > 0) {
    context.addIssue({ code: "custom", path: ["choices"], message: "Informational updates do not accept choices." });
  }
  if (request.tier === "PROHIBITED" && request.status === "APPROVED") {
    context.addIssue({ code: "custom", path: ["status"], message: "A prohibited action cannot be approved." });
  }
  if (request.resolutionChannel === "SMS" && request.tier !== "LOW_CONSEQUENCE") {
    context.addIssue({ code: "custom", path: ["resolutionChannel"], message: "Only low-consequence requests may be resolved by SMS." });
  }
  if (Date.parse(request.expiresAt) <= Date.parse(request.createdAt)) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "Expiration must be after creation." });
  }
});
export type AttentionRequest = z.infer<typeof attentionRequestSchema>;

export const attentionActionSchema = z.enum([
  "STATUS_UPDATE",
  "DEPARTMENT_REACHED",
  "HOLD_STARTED",
  "CASE_NUMBER_RECEIVED",
  "FACT_CONFIRMED",
  "CONTINUE_WAITING",
  "ASK_FOR_SUPERVISOR",
  "REPEAT_EXPLANATION",
  "KEEP_NEGOTIATING",
  "ZERO_COST_PROCEDURAL_STEP",
  "DISCLOSE_PERSONAL_DATA",
  "SUBMIT_SENSITIVE_DTMF",
  "ACCEPT_FINANCIAL_OUTCOME",
  "MODIFY_ACCOUNT",
  "CANCEL_SERVICE",
  "CHANGE_APPOINTMENT",
  "ACCEPT_ALTERNATIVE_OUTCOME",
  "CREATE_RECURRING_COMMITMENT",
  "DISCLOSE_CREDENTIAL",
  "DISCLOSE_OTP",
  "DISCLOSE_FULL_SSN",
  "DISCLOSE_PAYMENT_CARD",
  "DISCLOSE_SECURITY_ANSWER",
  "DISCLOSE_PIN",
  "MAKE_PURCHASE",
  "ENTER_NEW_CONTRACT",
  "IMPERSONATE_USER",
  "WAIVE_LEGAL_RIGHT",
]);
export type AttentionAction = z.infer<typeof attentionActionSchema>;

const attentionTierByAction: Readonly<Record<AttentionAction, AttentionTier>> = Object.freeze({
  STATUS_UPDATE: "INFORMATIONAL",
  DEPARTMENT_REACHED: "INFORMATIONAL",
  HOLD_STARTED: "INFORMATIONAL",
  CASE_NUMBER_RECEIVED: "INFORMATIONAL",
  FACT_CONFIRMED: "INFORMATIONAL",
  CONTINUE_WAITING: "LOW_CONSEQUENCE",
  ASK_FOR_SUPERVISOR: "LOW_CONSEQUENCE",
  REPEAT_EXPLANATION: "LOW_CONSEQUENCE",
  KEEP_NEGOTIATING: "LOW_CONSEQUENCE",
  ZERO_COST_PROCEDURAL_STEP: "LOW_CONSEQUENCE",
  DISCLOSE_PERSONAL_DATA: "SENSITIVE",
  SUBMIT_SENSITIVE_DTMF: "SENSITIVE",
  ACCEPT_FINANCIAL_OUTCOME: "MATERIAL",
  MODIFY_ACCOUNT: "MATERIAL",
  CANCEL_SERVICE: "MATERIAL",
  CHANGE_APPOINTMENT: "MATERIAL",
  ACCEPT_ALTERNATIVE_OUTCOME: "MATERIAL",
  CREATE_RECURRING_COMMITMENT: "MATERIAL",
  DISCLOSE_CREDENTIAL: "PROHIBITED",
  DISCLOSE_OTP: "PROHIBITED",
  DISCLOSE_FULL_SSN: "PROHIBITED",
  DISCLOSE_PAYMENT_CARD: "PROHIBITED",
  DISCLOSE_SECURITY_ANSWER: "PROHIBITED",
  DISCLOSE_PIN: "PROHIBITED",
  MAKE_PURCHASE: "PROHIBITED",
  ENTER_NEW_CONTRACT: "PROHIBITED",
  IMPERSONATE_USER: "PROHIBITED",
  WAIVE_LEGAL_RIGHT: "PROHIBITED",
});

/** Final attention tier assignment is deterministic; a model suggestion is not an input. */
export function assignAttentionTier(action: AttentionAction): AttentionTier {
  return attentionTierByAction[attentionActionSchema.parse(action)];
}

export function isSmsResolvableTier(tier: AttentionTier): boolean {
  return attentionTierSchema.parse(tier) === "LOW_CONSEQUENCE";
}

export function isSmsEligibleAttentionRequest(
  request: AttentionRequest,
  now: Date = new Date(),
): boolean {
  const parsed = attentionRequestSchema.safeParse(request);
  return parsed.success
    && parsed.data.status === "PENDING"
    && isSmsResolvableTier(parsed.data.tier)
    && parsed.data.choices.length >= 2
    && Date.parse(parsed.data.expiresAt) > now.getTime();
}

export const supportThreadStateSchema = z.enum([
  "IDLE",
  "COLLECTING_ISSUE",
  "AWAITING_INFORMATION",
  "PLAN_DRAFTED",
  "AWAITING_PLAN_APPROVAL",
  "AWAITING_AVAILABILITY",
  "CALL_STARTING",
  "CALL_ACTIVE",
  "AWAITING_USER_DECISION",
  "CALL_ENDING",
  "COMPLETED",
  "CANCELLED",
  "FAILED",
]);
export type SupportThreadState = z.infer<typeof supportThreadStateSchema>;

export const messagingIntentSchema = z.enum([
  "CREATE_CASE",
  "ADD_CONTEXT",
  "ANSWER_QUESTION",
  "EDIT_GOAL",
  "EDIT_AUTHORITY",
  "PRIVATE_CALL_INSTRUCTION",
  "EXACT_SPEECH_REQUEST",
  "REQUEST_STATUS",
  "UNCLEAR",
]);
export type MessagingIntent = z.infer<typeof messagingIntentSchema>;

export const messagingIntentClassificationSchema = z.object({
  intent: messagingIntentSchema,
  companyName: z.string().trim().max(120).nullable(),
  phoneNumber: z.string().trim().max(40).nullable(),
  desiredOutcome: z.string().trim().max(2_000).nullable(),
  contextToAdd: z.string().trim().max(4_000).nullable(),
  privateInstruction: z.string().trim().max(1_000).nullable(),
  exactSpeech: z.string().trim().max(400).nullable(),
  confidence: z.number().min(0).max(1),
});
export type MessagingIntentClassification = z.infer<typeof messagingIntentClassificationSchema>;

export const conditionalAuthoritySubjectSchema = z.enum([
  "REFUND",
  "CREDIT",
  "FEE",
  "CHARGE",
  "PLAN_CHANGE",
  "CANCELLATION",
  "APPOINTMENT",
  "OTHER",
]);
export type ConditionalAuthoritySubject = z.infer<typeof conditionalAuthoritySubjectSchema>;

export const conditionalAuthorityComparisonSchema = z.enum(["AT_LEAST", "AT_MOST", "EXACTLY", "ANY"]);
export type ConditionalAuthorityComparison = z.infer<typeof conditionalAuthorityComparisonSchema>;

const monetarySubjects = new Set<ConditionalAuthoritySubject>(["REFUND", "CREDIT", "FEE", "CHARGE"]);

export const conditionalAuthorityRuleSchema = z.object({
  id: z.string().trim().min(1).max(120),
  subject: conditionalAuthoritySubjectSchema,
  comparison: conditionalAuthorityComparisonSchema.optional(),
  amountCents: z.number().int().min(0).max(100_000_000).optional(),
  decision: permissionLevelSchema,
}).superRefine((rule, context) => {
  const monetary = monetarySubjects.has(rule.subject);
  if (monetary && rule.comparison === undefined) {
    context.addIssue({ code: "custom", path: ["comparison"], message: "A monetary rule requires a comparison." });
  }
  if (monetary && rule.comparison !== undefined && rule.comparison !== "ANY" && rule.amountCents === undefined) {
    context.addIssue({ code: "custom", path: ["amountCents"], message: "This monetary comparison requires an amount." });
  }
  if (rule.comparison === "ANY" && rule.amountCents !== undefined) {
    context.addIssue({ code: "custom", path: ["amountCents"], message: "An ANY rule cannot include an amount." });
  }
  if (!monetary && rule.amountCents !== undefined) {
    context.addIssue({ code: "custom", path: ["amountCents"], message: "A non-monetary rule cannot include an amount." });
  }
  if (!monetary && rule.comparison !== undefined && rule.comparison !== "ANY") {
    context.addIssue({ code: "custom", path: ["comparison"], message: "A non-monetary rule may use only ANY." });
  }
});
export type ConditionalAuthorityRule = z.infer<typeof conditionalAuthorityRuleSchema>;

export interface ConditionalAuthorityConflict {
  firstRuleId: string;
  secondRuleId: string;
  reason: "DUPLICATE_RULE_ID" | "CONTRADICTORY_PREDICATE" | "CROSSING_THRESHOLDS";
}

function comparisonOf(rule: ConditionalAuthorityRule): ConditionalAuthorityComparison {
  return rule.comparison ?? "ANY";
}

function crossingThresholds(first: ConditionalAuthorityRule, second: ConditionalAuthorityRule): boolean {
  const firstComparison = comparisonOf(first);
  const secondComparison = comparisonOf(second);
  const lower = firstComparison === "AT_LEAST" ? first : secondComparison === "AT_LEAST" ? second : undefined;
  const upper = firstComparison === "AT_MOST" ? first : secondComparison === "AT_MOST" ? second : undefined;
  return lower?.amountCents !== undefined
    && upper?.amountCents !== undefined
    && lower.amountCents <= upper.amountCents;
}

/**
 * Thresholds pointing in the same direction form an ordered ladder: the most
 * specific matching threshold wins. ANY is a fallback and EXACTLY is an
 * override. Equal contradictory predicates and contradictory crossing ranges
 * are ambiguous and therefore surfaced as conflicts.
 */
export function findConditionalAuthorityConflicts(
  rules: readonly ConditionalAuthorityRule[],
): ConditionalAuthorityConflict[] {
  const conflicts: ConditionalAuthorityConflict[] = [];
  for (let firstIndex = 0; firstIndex < rules.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < rules.length; secondIndex += 1) {
      const first = rules[firstIndex];
      const second = rules[secondIndex];
      if (first.id === second.id) {
        conflicts.push({ firstRuleId: first.id, secondRuleId: second.id, reason: "DUPLICATE_RULE_ID" });
        continue;
      }
      if (first.subject !== second.subject || first.decision === second.decision) continue;
      const samePredicate = comparisonOf(first) === comparisonOf(second) && first.amountCents === second.amountCents;
      if (samePredicate) {
        conflicts.push({ firstRuleId: first.id, secondRuleId: second.id, reason: "CONTRADICTORY_PREDICATE" });
      } else if (crossingThresholds(first, second)) {
        conflicts.push({ firstRuleId: first.id, secondRuleId: second.id, reason: "CROSSING_THRESHOLDS" });
      }
    }
  }
  return conflicts;
}

export const conditionalAuthorityRulesSchema = z.array(conditionalAuthorityRuleSchema).max(50).superRefine((rules, context) => {
  for (const conflict of findConditionalAuthorityConflicts(rules)) {
    context.addIssue({
      code: "custom",
      message: `Conflicting conditional authority rules: ${conflict.firstRuleId}, ${conflict.secondRuleId} (${conflict.reason}).`,
    });
  }
});

export type ConditionalAuthorityEvaluation =
  | { source: "HARD_POLICY"; decision: "DENY"; matchedRuleIds: [] }
  | { source: "NO_MATCH"; decision: null; matchedRuleIds: [] }
  | { source: "CONFLICT"; decision: null; matchedRuleIds: string[]; conflicts: ConditionalAuthorityConflict[] }
  | { source: "CONDITIONAL_RULE"; decision: "ALLOW" | "ASK" | "DENY"; matchedRuleIds: string[] };

function matchesConditionalRule(rule: ConditionalAuthorityRule, amountCents: number | undefined): boolean {
  const comparison = comparisonOf(rule);
  if (comparison === "ANY") return true;
  if (amountCents === undefined || rule.amountCents === undefined) return false;
  if (comparison === "EXACTLY") return amountCents === rule.amountCents;
  if (comparison === "AT_LEAST") return amountCents >= rule.amountCents;
  return amountCents <= rule.amountCents;
}

function rulePriority(rule: ConditionalAuthorityRule): [number, number, string] {
  const comparison = comparisonOf(rule);
  if (comparison === "EXACTLY") return [4, 0, rule.id];
  if (comparison === "AT_LEAST") return [3, -(rule.amountCents ?? 0), rule.id];
  if (comparison === "AT_MOST") return [3, rule.amountCents ?? 0, rule.id];
  return [1, 0, rule.id];
}

function comparePriority(first: ConditionalAuthorityRule, second: ConditionalAuthorityRule): number {
  const a = rulePriority(first);
  const b = rulePriority(second);
  return b[0] - a[0] || a[1] - b[1] || a[2].localeCompare(b[2]);
}

export function evaluateConditionalAuthority(
  rulesInput: readonly ConditionalAuthorityRule[],
  input: { subject: ConditionalAuthoritySubject; amountCents?: number; hardDenied?: boolean },
): ConditionalAuthorityEvaluation {
  if (input.hardDenied) return { source: "HARD_POLICY", decision: "DENY", matchedRuleIds: [] };
  const rules = z.array(conditionalAuthorityRuleSchema).max(50).parse(rulesInput);
  const subject = conditionalAuthoritySubjectSchema.parse(input.subject);
  const amountCents = input.amountCents === undefined ? undefined : z.number().int().min(0).parse(input.amountCents);
  const conflicts = findConditionalAuthorityConflicts(rules);
  if (conflicts.length > 0) {
    return {
      source: "CONFLICT",
      decision: null,
      matchedRuleIds: [...new Set(conflicts.flatMap((conflict) => [conflict.firstRuleId, conflict.secondRuleId]))].sort(),
      conflicts,
    };
  }
  const matches = rules
    .filter((rule) => rule.subject === subject && matchesConditionalRule(rule, amountCents))
    .sort(comparePriority);
  const selected = matches[0];
  if (!selected) return { source: "NO_MATCH", decision: null, matchedRuleIds: [] };
  return {
    source: "CONDITIONAL_RULE",
    decision: selected.decision,
    matchedRuleIds: matches.map((rule) => rule.id),
  };
}

export const commitmentPartySchema = z.enum(["COMPANY", "USER", "AGENT", "UNKNOWN"]);
export type CommitmentParty = z.infer<typeof commitmentPartySchema>;

export const commitmentStatusSchema = z.enum(["PROPOSED", "CONFIRMED", "REJECTED", "SUPERSEDED", "UNVERIFIED"]);
export type CommitmentStatus = z.infer<typeof commitmentStatusSchema>;

export const commitmentSchema = z.object({
  protocolVersion: protocolVersionSchema.default(1),
  id: z.string().trim().min(1).max(120),
  party: commitmentPartySchema,
  status: commitmentStatusSchema,
  description: z.string().trim().min(1).max(1_000),
  amountCents: z.number().int().min(0).optional(),
  deadline: z.string().trim().min(1).max(200).optional(),
  recurring: z.boolean().optional(),
  evidence: z.array(evidenceReferenceSchema).max(20),
  createdAt: isoDateTimeSchema,
}).superRefine((commitment, context) => {
  if (commitment.status === "CONFIRMED" && commitment.evidence.length === 0) {
    context.addIssue({ code: "custom", path: ["evidence"], message: "A confirmed commitment requires transcript evidence." });
  }
});
export type Commitment = z.infer<typeof commitmentSchema>;

export const semanticCallEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("DEPARTMENT_REACHED"), department: z.string().trim().min(1).max(200) }),
  z.object({ kind: z.literal("HUMAN_REACHED") }),
  z.object({ kind: z.literal("ON_HOLD"), startedAt: isoDateTimeSchema }),
  z.object({ kind: z.literal("TRANSFER_STARTED"), destination: z.string().trim().min(1).max(200).optional() }),
  z.object({ kind: z.literal("AUTHENTICATION_REQUESTED"), category: z.string().trim().min(1).max(200) }),
  z.object({ kind: z.literal("FACT_CONFIRMED"), fact: z.string().trim().min(1).max(1_000), evidence: z.array(evidenceReferenceSchema).min(1).max(20) }),
  z.object({ kind: z.literal("OFFER_MADE"), description: z.string().trim().min(1).max(1_000), amountCents: z.number().int().optional() }),
  z.object({ kind: z.literal("COMMITMENT_CONFIRMED"), commitmentId: z.string().trim().min(1).max(120) }),
  z.object({ kind: z.literal("CASE_NUMBER_RECEIVED"), evidence: z.array(evidenceReferenceSchema).min(1).max(20) }),
  z.object({ kind: z.literal("DEADLINE_RECEIVED"), evidence: z.array(evidenceReferenceSchema).min(1).max(20) }),
  z.object({ kind: z.literal("RESOLUTION_VERIFIED") }),
  z.object({ kind: z.literal("CALL_DISCONNECTED") }),
]);
export type SemanticCallEvent = z.infer<typeof semanticCallEventSchema>;

function normalizedText(value: string | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function normalizedEvidence(event: Extract<SemanticCallEvent, { evidence: unknown }>): string {
  return event.evidence
    .map((item) => `${item.turnId}:${normalizedText(item.exactQuote)}`)
    .sort()
    .join("|");
}

/** Stable within a call. Prefix with the call id when storing it globally. */
export function semanticCallEventDedupKey(eventInput: SemanticCallEvent): string {
  const event = semanticCallEventSchema.parse(eventInput);
  switch (event.kind) {
    case "DEPARTMENT_REACHED": return `${event.kind}:${normalizedText(event.department)}`;
    case "HUMAN_REACHED": return event.kind;
    case "ON_HOLD": return `${event.kind}:${event.startedAt}`;
    case "TRANSFER_STARTED": return `${event.kind}:${normalizedText(event.destination)}`;
    case "AUTHENTICATION_REQUESTED": return `${event.kind}:${normalizedText(event.category)}`;
    case "FACT_CONFIRMED": return `${event.kind}:${normalizedText(event.fact)}`;
    case "OFFER_MADE": return `${event.kind}:${normalizedText(event.description)}:${event.amountCents ?? ""}`;
    case "COMMITMENT_CONFIRMED": return `${event.kind}:${event.commitmentId}`;
    case "CASE_NUMBER_RECEIVED": return `${event.kind}:${normalizedEvidence(event)}`;
    case "DEADLINE_RECEIVED": return `${event.kind}:${normalizedEvidence(event)}`;
    case "RESOLUTION_VERIFIED": return event.kind;
    case "CALL_DISCONNECTED": return event.kind;
  }
}

export const disclosureEventSchema = z.object({
  protocolVersion: protocolVersionSchema.default(1),
  id: z.string().trim().min(1).max(120),
  caseId: z.string().trim().min(1).max(120),
  callId: z.string().trim().min(1).max(120),
  disclosureCardId: z.string().trim().min(1).max(120),
  category: disclosureCategorySchema,
  channel: z.enum(["SPEECH", "DTMF"]),
  purpose: z.string().trim().min(1).max(180),
  consentRecorded: z.literal(true),
  occurredAt: isoDateTimeSchema,
}).describe("Metadata-only disclosure event. The disclosed value is deliberately excluded.");
export type DisclosureEvent = z.infer<typeof disclosureEventSchema>;

export const supportIntentSchema = z.object({
  protocolVersion: protocolVersionSchema.default(1),
  caseId: z.string().trim().min(1).max(120),
  userFirstName: callBriefSchema.shape.userFirstName,
  companyName: callBriefSchema.shape.companyName,
  phoneNumberE164: callBriefSchema.shape.phoneNumberE164,
  issueSummary: callBriefSchema.shape.issueSummary,
  chronology: z.array(chronologyItemSchema).max(30),
  desiredOutcome: callBriefSchema.shape.desiredOutcome,
  acceptableAlternatives: callBriefSchema.shape.acceptableAlternatives,
  unacceptableOutcomes: callBriefSchema.shape.unacceptableOutcomes,
  knownFacts: callBriefSchema.shape.knownFacts,
  unresolvedQuestions: callBriefSchema.shape.unresolvedQuestions,
  autonomyMode: autonomyModeSchema.default(DEFAULT_AUTONOMY_MODE),
});
export type SupportIntent = z.infer<typeof supportIntentSchema>;

export const executionPlanSchema = z.object({
  protocolVersion: protocolVersionSchema.default(1),
  planId: z.string().trim().min(1).max(120),
  caseId: z.string().trim().min(1).max(120),
  version: z.number().int().positive(),
  intent: supportIntentSchema,
  callBrief: callBriefSchema,
  authority: authorityEnvelopeSchema,
  autonomyMode: autonomyModeSchema,
  conditionalAuthorityRules: conditionalAuthorityRulesSchema.default([]),
  createdAt: isoDateTimeSchema,
  approvedAt: isoDateTimeSchema.optional(),
}).superRefine((plan, context) => {
  if (plan.version !== plan.callBrief.version) {
    context.addIssue({ code: "custom", path: ["version"], message: "Plan version must match the wrapped call brief." });
  }
  if (plan.caseId !== plan.intent.caseId || plan.caseId !== plan.callBrief.id) {
    context.addIssue({ code: "custom", path: ["caseId"], message: "Case identifiers must match across the plan." });
  }
  if (plan.autonomyMode !== plan.intent.autonomyMode) {
    context.addIssue({ code: "custom", path: ["autonomyMode"], message: "Autonomy mode must match the support intent." });
  }
  if (JSON.stringify(plan.authority) !== JSON.stringify(plan.callBrief.authority)) {
    context.addIssue({ code: "custom", path: ["authority"], message: "Authority must match the wrapped call brief." });
  }
});
export type ExecutionPlan = z.infer<typeof executionPlanSchema>;

export function supportIntentFromCallBrief(
  briefInput: CallBrief,
  mode: AutonomyMode = DEFAULT_AUTONOMY_MODE,
): SupportIntent {
  const brief = callBriefSchema.parse(briefInput);
  return supportIntentSchema.parse({
    protocolVersion: 1,
    caseId: brief.id,
    userFirstName: brief.userFirstName,
    companyName: brief.companyName,
    phoneNumberE164: brief.phoneNumberE164,
    issueSummary: brief.issueSummary,
    chronology: brief.chronology,
    desiredOutcome: brief.desiredOutcome,
    acceptableAlternatives: brief.acceptableAlternatives,
    unacceptableOutcomes: brief.unacceptableOutcomes,
    knownFacts: brief.knownFacts,
    unresolvedQuestions: brief.unresolvedQuestions,
    autonomyMode: mode,
  });
}

export function executionPlanFromCallBrief(
  briefInput: CallBrief,
  input: {
    planId: string;
    autonomyMode?: AutonomyMode;
    conditionalAuthorityRules?: ConditionalAuthorityRule[];
    createdAt: string;
    approvedAt?: string;
  },
): ExecutionPlan {
  const brief = callBriefSchema.parse(briefInput);
  const autonomyMode = input.autonomyMode ?? DEFAULT_AUTONOMY_MODE;
  return executionPlanSchema.parse({
    protocolVersion: 1,
    planId: input.planId,
    caseId: brief.id,
    version: brief.version,
    intent: supportIntentFromCallBrief(brief, autonomyMode),
    callBrief: brief,
    authority: brief.authority,
    autonomyMode,
    conditionalAuthorityRules: input.conditionalAuthorityRules ?? [],
    createdAt: input.createdAt,
    approvedAt: input.approvedAt,
  });
}

// Re-export the canonical existing protocol components for one import surface.
export {
  authorityEnvelopeSchema,
  evidenceReferenceSchema,
  outcomeReportSchema,
};
export type { AuthorityEnvelope };
