import { z } from "zod";

export const permissionLevelSchema = z.enum(["ALLOW", "ASK", "DENY"]);
export const hardDenySchema = z.literal("DENY");

export const authorityEnvelopeSchema = z.object({
  navigateIvr: permissionLevelSchema,
  explainIssue: permissionLevelSchema,
  askQuestions: permissionLevelSchema,
  requestEscalation: permissionLevelSchema,
  requestCaseNumber: permissionLevelSchema,
  requestWrittenConfirmation: permissionLevelSchema,
  disclosePersonalData: permissionLevelSchema,
  acceptFinancialOutcome: permissionLevelSchema,
  acceptAlternativeOutcome: permissionLevelSchema,
  modifyAccount: permissionLevelSchema,
  cancelService: permissionLevelSchema,
  scheduleCommitment: permissionLevelSchema,
  endWithoutResolution: permissionLevelSchema,
  makePurchase: hardDenySchema,
  discloseCredential: hardDenySchema,
  discloseOtp: hardDenySchema,
  discloseFullSsn: hardDenySchema,
  disclosePaymentCard: hardDenySchema,
  waiveLegalRight: hardDenySchema,
  impersonateUser: hardDenySchema,
  maximumAuthorizedCostCents: z.number().int().min(0).max(1_000_000),
  forbiddenActions: z.array(z.string().trim().min(1).max(200)).max(30),
});

export type AuthorityEnvelope = z.infer<typeof authorityEnvelopeSchema>;

export { defaultAuthority } from "./authority-defaults.js";
import { defaultAuthority } from "./authority-defaults.js";

export const chronologyItemSchema = z.object({
  id: z.string().min(1),
  date: z.string().max(40).optional(),
  event: z.string().trim().min(1).max(1_000),
});

export const callBriefSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive().default(1),
  companyName: z.string().trim().min(1).max(120),
  phoneNumberE164: z.string().regex(/^\+1\d{10}$/),
  userFirstName: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(160),
  issueSummary: z.string().trim().min(1).max(4_000),
  chronology: z.array(chronologyItemSchema).max(30),
  desiredOutcome: z.string().trim().min(1).max(2_000),
  acceptableAlternatives: z.array(z.string().trim().min(1).max(500)).max(15),
  unacceptableOutcomes: z.array(z.string().trim().min(1).max(500)).max(15),
  knownFacts: z.array(z.string().trim().min(1).max(1_000)).max(40),
  unresolvedQuestions: z.array(z.string().trim().min(1).max(500)).max(20),
  openingIssueStatement: z.string().trim().min(1).max(1_000),
  strategySteps: z.array(z.string().trim().min(1).max(500)).max(8),
  likelyApprovalPoints: z.array(z.string().trim().min(1).max(500)).max(6),
  warnings: z.array(z.string().trim().min(1).max(500)).max(20),
  authority: authorityEnvelopeSchema,
});

export type CallBrief = z.infer<typeof callBriefSchema>;

export const disclosureCategorySchema = z.enum([
  "ACCOUNT_NUMBER",
  "ORDER_NUMBER",
  "ADDRESS",
  "DATE_OF_BIRTH",
  "EMAIL",
  "PHONE",
  "ZIP_CODE",
  "OTHER_ALLOWED",
]);
export const disclosureCardMetadataSchema = z.object({
  id: z.string().min(1),
  label: z.string().trim().min(1).max(100),
  category: disclosureCategorySchema,
  permission: z.enum(["ASK", "DENY"]),
  allowedChannels: z.array(z.enum(["SPEECH", "DTMF"])).min(1),
  allowedPurposes: z.array(z.string().trim().min(1).max(180)).min(1).max(10),
  redactInLogs: z.literal(true),
});
export type DisclosureCardMetadata = z.infer<typeof disclosureCardMetadataSchema>;

export const intakeDisclosureSchema = disclosureCardMetadataSchema.omit({ id: true, redactInLogs: true }).extend({
  value: z.string().min(1).max(300),
});

export const secureDisclosureInputSchema = z
  .object({
    category: z.enum(["ACCOUNT_NUMBER", "ORDER_NUMBER", "ADDRESS", "DATE_OF_BIRTH"]),
    value: z.string().trim().min(1).max(300),
    allowedChannels: z
      .array(z.enum(["SPEECH", "DTMF"]))
      .min(1)
      .max(2),
  })
  .strict()
  .superRefine((input, context) => {
    if (new Set(input.allowedChannels).size !== input.allowedChannels.length) {
      context.addIssue({
        code: "custom",
        path: ["allowedChannels"],
        message: "Choose each delivery channel at most once.",
      });
    }
    if (input.category === "ADDRESS" && (input.allowedChannels.length !== 1 || input.allowedChannels[0] !== "SPEECH")) {
      context.addIssue({
        code: "custom",
        path: ["allowedChannels"],
        message: "An address can only be delivered by speech.",
      });
    }
    if (input.allowedChannels.includes("DTMF") && (!/^[0-9w#*]+$/.test(input.value) || input.value.length > 64)) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "DTMF values may contain only digits, w, #, or *, up to 64 characters.",
      });
    }
  });
export type SecureDisclosureInput = z.infer<typeof secureDisclosureInputSchema>;

export const caseIntakeSchema = z.object({
  userFirstName: z.string().trim().min(1).max(80),
  companyName: z.string().trim().min(1).max(120),
  phoneNumber: z.string().trim().min(1).max(40),
  issueDescription: z.string().trim().min(20).max(6_000),
  chronologyText: z.string().max(4_000).default(""),
  desiredOutcome: z.string().trim().min(3).max(2_000),
  acceptableAlternativesText: z.string().max(2_000).default(""),
  unacceptableOutcomesText: z.string().max(2_000).default(""),
  knownFactsText: z.string().max(4_000).default(""),
  disclosures: z.array(intakeDisclosureSchema).max(12).default([]),
  authority: authorityEnvelopeSchema.default(defaultAuthority),
  officialNumberConfirmed: z.literal(true),
  authorizedAccountConfirmed: z.literal(true),
  lowRiskConfirmed: z.literal(true),
});
export type CaseIntake = z.infer<typeof caseIntakeSchema>;

export const callStateSchema = z.enum([
  "PREPARING",
  "DIALING",
  "CONNECTED",
  "IVR",
  "ON_HOLD",
  "WAITING_FOR_REPRESENTATIVE",
  "DISCLOSING_ASSISTANT",
  "EXPLAINING_ISSUE",
  "AUTHENTICATING",
  "NEGOTIATING",
  "NEEDS_USER",
  "VERIFYING_OUTCOME",
  "ENDING",
  "COMPLETED",
  "FAILED",
]);
export type CallState = z.infer<typeof callStateSchema>;

export const capturedFactSchema = z.object({
  kind: z.enum(["REPRESENTATIVE_NAME", "DEPARTMENT", "CASE_NUMBER", "COMMITMENT", "DEADLINE", "OTHER"]),
  value: z.string().max(500),
  turnId: z.string(),
});

const baseDecision = {
  policyReasonCode: z.string().regex(/^[A-Z0-9_]{2,64}$/),
  capturedFacts: z.array(capturedFactSchema).max(10),
};
export const approvalCategorySchema = z.enum([
  "PERSONAL_DATA",
  "FINANCIAL",
  "ACCOUNT_CHANGE",
  "CANCELLATION",
  "SCHEDULING",
  "ALTERNATIVE_OUTCOME",
  "END_UNRESOLVED",
]);
export const agentDecisionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("SPEAK"),
    text: z.string().trim().min(1).max(400),
    nextState: callStateSchema,
    ...baseDecision,
  }),
  z.object({
    action: z.literal("SEND_DIGITS"),
    digits: z.string().regex(/^[0-9w#*]{1,64}$/),
    nextState: callStateSchema,
    ...baseDecision,
  }),
  z.object({
    action: z.literal("REQUEST_APPROVAL"),
    nextState: z.literal("NEEDS_USER"),
    ...baseDecision,
    approval: z.object({
      category: approvalCategorySchema,
      question: z.string().min(1).max(500),
      representativeRequest: z.string().min(1).max(500),
      proposedSpeech: z.string().max(400),
      consequences: z.string().min(1).max(500),
      amountCents: z.number().int().min(0).optional(),
      disclosureCardId: z.string().optional(),
      executionChannel: z.enum(["SPEECH", "DTMF"]).optional(),
    }),
  }),
  z.object({
    action: z.literal("WAIT"),
    reason: z.enum(["HOLD", "SILENCE", "TRANSFER", "REPRESENTATIVE_WORKING", "USER_PAUSED"]),
    nextState: callStateSchema,
    ...baseDecision,
  }),
  z.object({
    action: z.literal("END_CALL"),
    reason: z.enum([
      "RESOLVED",
      "PARTIALLY_RESOLVED",
      "UNRESOLVED",
      "REPRESENTATIVE_REFUSED_AUTOMATION",
      "AUTHENTICATION_REQUIRED",
      "USER_REQUESTED",
      "TECHNICAL_FAILURE",
      "POLICY_BLOCKED",
    ]),
    proposedOutcomeStatus: z.enum([
      "RESOLVED",
      "PARTIAL",
      "UNRESOLVED",
      "REFUSED_AUTOMATION",
      "AUTHENTICATION_REQUIRED",
      "TECHNICAL_FAILURE",
    ]),
    closingText: z.string().max(400).optional(),
    nextState: z.literal("ENDING"),
    ...baseDecision,
  }),
]);
export type AgentDecision = z.infer<typeof agentDecisionSchema>;

export const evidenceReferenceSchema = z.object({ turnId: z.string(), exactQuote: z.string().min(1).max(1_000) });
const grounded = <T extends z.ZodType>(value: T) =>
  z.object({ value, evidence: z.array(evidenceReferenceSchema).min(1) });
export const outcomeReportSchema = z.object({
  status: z.enum([
    "RESOLVED",
    "PARTIAL",
    "UNRESOLVED",
    "REFUSED_AUTOMATION",
    "AUTHENTICATION_REQUIRED",
    "DISCONNECTED",
    "TECHNICAL_FAILURE",
  ]),
  summary: grounded(z.string()).nullable(),
  representativeName: grounded(z.string()).nullable(),
  department: grounded(z.string()).nullable(),
  caseNumber: grounded(z.string()).nullable(),
  resolution: grounded(z.string()).nullable(),
  monetaryOutcomes: z.array(
    grounded(z.object({ kind: z.enum(["REFUND", "CREDIT", "FEE", "CHARGE", "OTHER"]), amountCents: z.number().int() })),
  ),
  companyCommitments: z.array(grounded(z.string())),
  userActions: z.array(grounded(z.string())),
  deadlines: z.array(grounded(z.string())),
  unresolvedItems: z.array(grounded(z.string())),
  endedAt: z.string(),
  durationSeconds: z.number().int().min(0),
  estimatedTelephonyCostUsd: z.number().min(0),
  llmUsage: z
    .object({
      inputTokens: z.number().int().min(0),
      outputTokens: z.number().int().min(0),
      totalTokens: z.number().int().min(0),
    })
    .optional(),
});
export type OutcomeReport = z.infer<typeof outcomeReportSchema>;

export const transcriptTurnSchema = z.object({
  id: z.string(),
  sequence: z.number().int().positive(),
  speaker: z.enum(["REMOTE", "LIAISON", "USER_EXACT", "SYSTEM"]),
  text: z.string().max(4_000),
  timestamp: z.string(),
});
export type TranscriptTurn = z.infer<typeof transcriptTurnSchema>;

export const approvalStatusSchema = z.enum([
  "PENDING",
  "APPROVED",
  "REJECTED",
  "REPLACED",
  "EXPIRED",
  "EXECUTION_FAILED",
]);
export const approvalRequestSchema = z.object({
  id: z.string(),
  callId: z.string(),
  status: approvalStatusSchema,
  category: approvalCategorySchema,
  question: z.string(),
  representativeRequest: z.string(),
  proposedSpeech: z.string(),
  consequences: z.string(),
  amountCents: z.number().int().optional(),
  disclosureCardId: z.string().optional(),
  executionChannel: z.enum(["SPEECH", "DTMF"]).optional(),
  createdAt: z.string(),
  expiresAt: z.string(),
});
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;

export const eventTypeSchema = z.enum([
  "CASE_CREATED",
  "CASE_UPDATED",
  "PLAN_GENERATED",
  "PLAN_APPROVED",
  "CALL_CREATED",
  "CALL_DIALING",
  "CALL_CONNECTED",
  "CALL_STATE_CHANGED",
  "REMOTE_TRANSCRIPT_FINAL",
  "AGENT_DECISION_PROPOSED",
  "AGENT_DECISION_REJECTED",
  "AGENT_SPEECH_STARTED",
  "AGENT_SPEECH_INTERRUPTED",
  "AGENT_SPEECH_COMPLETED",
  "DTMF_SENT",
  "DISCLOSURE_DELIVERED",
  "CONSENT_RECORDED",
  "APPROVAL_REQUESTED",
  "APPROVAL_APPROVED",
  "APPROVAL_REJECTED",
  "PRIVATE_INSTRUCTION_ADDED",
  "USER_EXACT_TEXT_SENT",
  "AGENT_PAUSED",
  "AGENT_RESUMED",
  "CALL_END_REQUESTED",
  "CALL_ENDED",
  "OUTCOME_GENERATED",
  "MODEL_RESPONSE_RECEIVED",
  "TECHNICAL_ERROR",
]);
export type EventType = z.infer<typeof eventTypeSchema>;

export interface PublicConfig {
  telephonyMode: "simulator" | "twilio";
  llmMode: "mock" | "openai";
  twilioConfigured: boolean;
  openaiConfigured: boolean;
  allowRealCalls: boolean;
  maxDurationMinutes: number;
  estimatedCostPerMinuteUsd: number;
  developmentBypass: boolean;
  appName: string;
  instanceMode: "personal";
  ownerConfigured: boolean;
  messagingMode: "web" | "twilio_sms";
  messagingConfigured: boolean;
  allowRealMessaging: boolean;
  messagingDetail: "MINIMAL" | "STANDARD" | "VERBOSE";
  estimatedSmsCostPerSegmentUsd: number;
  inboundMessagingWebhookUrl: string;
  messagingStatusWebhookUrl: string;
  messagingRegistrationConfirmed: boolean;
}
