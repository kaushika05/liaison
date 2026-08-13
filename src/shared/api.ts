import type { ApprovalRequest, CallBrief, CallState, OutcomeReport, PublicConfig, TranscriptTurn } from "./domain.js";
import type { AttentionTier, AutonomyMode, ConditionalAuthorityRule, SupportThreadState } from "./protocol.js";

export interface CaseSummary { id: string; companyName: string; title: string; status: string; updatedAt: string }
export interface CaseDetail extends CaseSummary { intake: Record<string, unknown>; brief: CallBrief | null; approvedVersion: number | null; disclosures: Array<{ id: string; label: string; category: string; permission: string; allowedChannels: string[]; allowedPurposes: string[]; redactInLogs: true }> }
export interface CallSnapshot {
  id: string; caseId: string; mode: "SIMULATOR" | "TWILIO"; scenarioId: string | null; state: CallState; activity: string;
  currentObjective: string; paused: boolean; humanDetected: boolean; disclosureDelivered: boolean; consentStatus: "UNKNOWN" | "ACCEPTED" | "REFUSED" | "AMBIGUOUS";
  startedAt: string; endedAt: string | null; durationSeconds: number; estimatedCostUsd: number; generation: number;
  llmInputTokens:number; llmOutputTokens:number;
  transcript: TranscriptTurn[]; pendingApproval: ApprovalRequest | null; outcome: OutcomeReport | null;
  disclosureLedger: Array<{ label: string; marker: string; channel: string; timestamp: string }>;
}
export interface SessionResponse { authenticated: boolean; config: PublicConfig }

export interface MessagingThreadSummary {
  id:string; state:SupportThreadState; autonomyMode:AutonomyMode; currentCaseId:string|null; approvedPlanVersion:number|null;
  activeCallId:string|null; pendingAttentionRequestId:string|null; messagingOptState:"UNKNOWN"|"OPTED_IN"|"OPTED_OUT";
}
export interface MessagingThreadMessage {
  id:string; direction:"INBOUND"|"OUTBOUND"; providerKind:"WEB"|"TWILIO_SMS"|"SIMULATOR"; redactedBody:string; createdAt:string;
  processingState:string; deliveryState:string; errorCode:string|null; segmentEstimate:number; caseId:string|null; callId:string|null; attentionRequestId:string|null;
}
export interface MessagingAttentionSummary {
  id:string; tier:AttentionTier; status:string; question:string; choices:Array<{id:string;shortCode:string;label:string;effect:string}>;
  expiresAt:string; secureActionRequired:boolean;
}
export interface MessagingCommitmentSummary {
  id:string; party:"COMPANY"|"USER"|"AGENT"|"UNKNOWN"; status:string; description:string; amountCents:number|null; deadline:string|null; recurring:boolean|null;
  evidence:Array<{turnId:string;exactQuote:string}>;
}
export interface MessagingThreadSnapshot {
  thread:MessagingThreadSummary; messages:MessagingThreadMessage[]; case:CaseDetail|null; call:CallSnapshot|null;
  attention:MessagingAttentionSummary|null; commitments:MessagingCommitmentSummary[]; conditionalAuthorityRules:ConditionalAuthorityRule[]; configuration:PublicConfig;
  failedDeliveries:number; deadLetterWork:number;
}
export interface SecureActionDetail {
  tokenState:"VALID"; actionType:string; attention:MessagingAttentionSummary; case:CaseDetail|null; call:CallSnapshot|null;
  representativeRequest:string; currentGoal:string; proposedAction:string; consequences:string; amountCents:number|null; expiresAt:string; approvalPermitted:boolean;
}
