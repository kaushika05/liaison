import type { ApprovalRequest, CallBrief, CallState, OutcomeReport, PublicConfig, TranscriptTurn } from "./domain.js";

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
