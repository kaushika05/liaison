import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { ApprovalRequest, CallBrief, CallState, EventType, OutcomeReport, TranscriptTurn } from "../../shared/domain.js";
import type { CaseDetail, CaseSummary } from "../../shared/api.js";

interface CallRow { id: string; case_id: string; mode: "SIMULATOR" | "TWILIO"; scenario_id: string | null; state: CallState; activity: string; objective: string; paused: number; human_detected: number; disclosure_delivered: number; consent_status: "UNKNOWN" | "ACCEPTED" | "REFUSED" | "AMBIGUOUS"; generation: number; twilio_call_sid: string | null; authorization_id: string | null; started_at: string; ended_at: string | null; duration_seconds: number; estimated_cost_usd: number; llm_input_tokens:number; llm_output_tokens:number; terminal_reason: string | null; }
interface CaseRow { id: string; company_name: string; title: string; status: string; intake_json: string; brief_json: string | null; disclosure_metadata_json: string; approved_version: number | null; created_at: string; updated_at: string }

export type SupportThreadState =
  | "IDLE"
  | "COLLECTING_ISSUE"
  | "AWAITING_INFORMATION"
  | "PLAN_DRAFTED"
  | "AWAITING_PLAN_APPROVAL"
  | "AWAITING_AVAILABILITY"
  | "CALL_STARTING"
  | "CALL_ACTIVE"
  | "AWAITING_USER_DECISION"
  | "CALL_ENDING"
  | "COMPLETED"
  | "CANCELLED"
  | "FAILED";
export type AutonomyMode = "ASSIST" | "COPILOT" | "DELEGATE";
export type MessagingOptState = "UNKNOWN" | "OPTED_IN" | "OPTED_OUT";
export type MessagingProviderKind = "WEB" | "TWILIO_SMS" | "SIMULATOR";
export type MessageProcessingState = "RECEIVED" | "PENDING" | "PROCESSING" | "COMPLETED" | "DEAD_LETTER" | "REJECTED";
export type MessageDeliveryState = "RECEIVED" | "PENDING" | "QUEUED" | "SENT" | "DELIVERED" | "UNDELIVERED" | "FAILED" | "UNKNOWN";
export type WorkState = "PENDING" | "PROCESSING" | "COMPLETED" | "DEAD_LETTER";
export type AttentionTier = "INFORMATIONAL" | "LOW_CONSEQUENCE" | "SENSITIVE" | "MATERIAL" | "PROHIBITED";
export type AttentionStatus = "PENDING" | "RESOLVED" | "EXPIRED" | "SUPERSEDED" | "CANCELLED";
export type CommitmentParty = "COMPANY" | "USER" | "AGENT" | "UNKNOWN";
export type CommitmentStatus = "PROPOSED" | "CONFIRMED" | "REJECTED" | "SUPERSEDED" | "UNVERIFIED";

export interface SupportThreadRecord {
  id: string;
  principalId: string;
  state: SupportThreadState;
  autonomyMode: AutonomyMode;
  currentCaseId: string | null;
  approvedPlanVersion: number | null;
  activeCallId: string | null;
  pendingAttentionRequestId: string | null;
  messagingOptState: MessagingOptState;
  draft: unknown | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CaseDeletionResult {
  caseId: string;
  callIds: string[];
  threadIds: string[];
  inboundMessageIds: string[];
  outboundMessageIds: string[];
}

export interface InboundMessageInput {
  id: string;
  threadId: string;
  providerKind: MessagingProviderKind;
  providerMessageId?: string | null;
  redactedBody: string;
  sender: string;
  recipient: string;
  caseId?: string | null;
  callId?: string | null;
  attentionRequestId?: string | null;
  createdAt?: string;
  segmentEstimate: number;
  errorCode?: string | null;
  idempotencyKey: string;
}

export interface InboundMessageRecord extends Omit<InboundMessageInput, "providerMessageId" | "caseId" | "callId" | "attentionRequestId" | "createdAt" | "errorCode"> {
  providerMessageId: string | null;
  direction: "INBOUND";
  caseId: string | null;
  callId: string | null;
  attentionRequestId: string | null;
  createdAt: string;
  processingState: MessageProcessingState;
  deliveryState: MessageDeliveryState;
  statusUpdatedAt: string;
  processedAt: string | null;
  errorCode: string | null;
}

export interface MessagingWorkItemRecord {
  id: string;
  kind: string;
  inboundMessageId: string | null;
  outboundMessageId: string | null;
  payload: unknown;
  state: WorkState;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  attemptCount: number;
  lastError: string | null;
  nextEligibleAt: string;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface OutboundMessageInput {
  id: string;
  threadId: string;
  providerKind: MessagingProviderKind;
  providerMessageId?: string | null;
  redactedBody: string;
  sender: string;
  recipient: string;
  caseId?: string | null;
  callId?: string | null;
  attentionRequestId?: string | null;
  createdAt?: string;
  segmentEstimate: number;
  errorCode?: string | null;
  idempotencyKey: string;
  nextEligibleAt?: string;
}

export interface OutboundMessageRecord extends Omit<OutboundMessageInput, "providerMessageId" | "caseId" | "callId" | "attentionRequestId" | "createdAt" | "errorCode" | "nextEligibleAt"> {
  providerMessageId: string | null;
  direction: "OUTBOUND";
  caseId: string | null;
  callId: string | null;
  attentionRequestId: string | null;
  createdAt: string;
  processingState: MessageProcessingState;
  deliveryState: MessageDeliveryState;
  statusUpdatedAt: string;
  processedAt: string | null;
  deliveredAt: string | null;
  errorCode: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  attemptCount: number;
  lastError: string | null;
  nextEligibleAt: string;
}
export type ThreadMessageRecord = InboundMessageRecord | OutboundMessageRecord;

export interface MessageDeliveryEventRecord {
  id: string;
  outboundMessageId: string;
  providerMessageId: string | null;
  providerStatus: string;
  errorCode: string | null;
  occurredAt: string;
  receivedAt: string;
  eventKey: string;
}

export interface DeliveryReduction {
  deliveryState: MessageDeliveryState;
  errorCode?: string | null;
  deliveredAt?: string | null;
}

export type DeliveryStatusReducer = (events: readonly MessageDeliveryEventRecord[], current: OutboundMessageRecord) => DeliveryReduction;

export interface AttentionRequestRecord {
  id: string;
  threadId: string;
  caseId: string | null;
  callId: string | null;
  tier: AttentionTier;
  status: AttentionStatus;
  blocking: boolean;
  question: string;
  choices: unknown[];
  proposedAction: unknown | null;
  resolution: unknown | null;
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  supersededBy: string | null;
}

export interface SecureActionTokenRecord {
  id: string;
  tokenHash: string;
  actionType: string;
  threadId: string;
  caseId: string | null;
  callId: string | null;
  attentionRequestId: string | null;
  singleUse: boolean;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
}

export interface CallAuthorizationRecord {
  id: string;
  threadId: string;
  caseId: string;
  planVersion: number;
  destinationE164: string | null;
  telephonyMode: "simulator" | "twilio" | null;
  codeHash: string;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
}

export interface ProviderSecurityEventRecord {
  id: string;
  providerKind: MessagingProviderKind;
  providerMessageId: string;
  eventType: string;
  reasonCode: string;
  threadId: string | null;
  caseId: string | null;
  callId: string | null;
  redactedMetadata: unknown;
  createdAt: string;
}

export interface EvidenceReferenceRecord { turnId: string; exactQuote: string }

export interface CommitmentRecord {
  id: string;
  threadId: string;
  caseId: string;
  callId: string | null;
  party: CommitmentParty;
  status: CommitmentStatus;
  description: string;
  amountCents: number | null;
  deadline: string | null;
  recurring: boolean | null;
  evidence: EvidenceReferenceRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface SemanticCallEventRecord {
  id: string;
  threadId: string;
  caseId: string;
  callId: string;
  eventType: string;
  semanticKey: string;
  payload: unknown;
  occurredAt: string;
  createdAt: string;
}

export interface ConditionalAuthorityRuleRecord {
  id: string;
  threadId: string;
  caseId: string | null;
  actionType: string;
  condition: unknown;
  permission: "ALLOW" | "ASK" | "DENY";
  priority: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ApprovalExecutionState = "RESERVED" | "SUCCEEDED" | "FAILED";
export interface ApprovalExecutionRecord {
  approvalId: string;
  callId: string;
  decision: "APPROVE" | "REJECT";
  payloadFingerprint: string;
  targetStatus: "APPROVED" | "REJECTED" | "REPLACED";
  executionId: string;
  state: ApprovalExecutionState;
  reservedAt: string;
  completedAt: string | null;
  errorCode: string | null;
}

interface SupportThreadRow { id:string; principal_id:string; state:SupportThreadState; autonomy_mode:AutonomyMode; current_case_id:string|null; approved_plan_version:number|null; active_call_id:string|null; pending_attention_request_id:string|null; messaging_opt_state:MessagingOptState; draft_json:string|null; is_active:number; created_at:string; updated_at:string }
interface InboundMessageRow { id:string; thread_id:string; provider_kind:MessagingProviderKind; provider_message_id:string|null; direction:"INBOUND"; redacted_body:string; sender:string; recipient:string; case_id:string|null; call_id:string|null; attention_request_id:string|null; created_at:string; processing_state:MessageProcessingState; delivery_state:MessageDeliveryState; status_updated_at:string; processed_at:string|null; segment_estimate:number; error_code:string|null; idempotency_key:string }
interface OutboundMessageRow { id:string; thread_id:string; provider_kind:MessagingProviderKind; provider_message_id:string|null; direction:"OUTBOUND"; redacted_body:string; sender:string; recipient:string; case_id:string|null; call_id:string|null; attention_request_id:string|null; created_at:string; processing_state:MessageProcessingState; delivery_state:MessageDeliveryState; status_updated_at:string; processed_at:string|null; delivered_at:string|null; segment_estimate:number; error_code:string|null; idempotency_key:string; lease_owner:string|null; lease_expires_at:string|null; attempt_count:number; last_error:string|null; next_eligible_at:string }
interface WorkItemRow { id:string; kind:string; inbound_message_id:string|null; outbound_message_id:string|null; payload_json:string; state:WorkState; lease_owner:string|null; lease_expires_at:string|null; attempt_count:number; last_error:string|null; next_eligible_at:string; idempotency_key:string; created_at:string; updated_at:string; completed_at:string|null }
interface DeliveryEventRow { id:string; outbound_message_id:string; provider_message_id:string|null; provider_status:string; error_code:string|null; occurred_at:string; received_at:string; event_key:string }
interface AttentionRequestRow { id:string; thread_id:string; case_id:string|null; call_id:string|null; tier:AttentionTier; status:AttentionStatus; blocking:number; question:string; choices_json:string; proposed_action_json:string|null; resolution_json:string|null; created_at:string; expires_at:string; resolved_at:string|null; superseded_by:string|null }
interface SecureActionTokenRow { id:string; token_hash:string; action_type:string; thread_id:string; case_id:string|null; call_id:string|null; attention_request_id:string|null; single_use:number; created_at:string; expires_at:string; used_at:string|null; revoked_at:string|null; revoke_reason:string|null }
interface CallAuthorizationRow { id:string; thread_id:string; case_id:string; plan_version:number; destination_e164:string|null; telephony_mode:"simulator"|"twilio"|null; code_hash:string; created_at:string; expires_at:string; consumed_at:string|null; revoked_at:string|null; revoke_reason:string|null }
interface ProviderSecurityEventRow { id:string; provider_kind:MessagingProviderKind; provider_message_id:string; event_type:string; reason_code:string; thread_id:string|null; case_id:string|null; call_id:string|null; redacted_metadata_json:string; created_at:string }
interface CommitmentRow { id:string; thread_id:string; case_id:string; call_id:string|null; party:CommitmentParty; status:CommitmentStatus; description:string; amount_cents:number|null; deadline:string|null; recurring:number|null; evidence_json:string; created_at:string; updated_at:string }
interface SemanticCallEventRow { id:string; thread_id:string; case_id:string; call_id:string; event_type:string; semantic_key:string; payload_json:string; occurred_at:string; created_at:string }
interface ConditionalAuthorityRuleRow { id:string; thread_id:string; case_id:string|null; action_type:string; condition_json:string; permission:"ALLOW"|"ASK"|"DENY"; priority:number; active:number; created_at:string; updated_at:string }
interface ApprovalExecutionRow { approval_id:string; call_id:string; decision:"APPROVE"|"REJECT"; payload_fingerprint:string; target_status:"APPROVED"|"REJECTED"|"REPLACED"; execution_id:string; state:ApprovalExecutionState; reserved_at:string; completed_at:string|null; error_code:string|null }

const parseJson = (value: string): unknown => JSON.parse(value) as unknown;
const leaseExpiry = (now: string, leaseSeconds: number): string => {
  if (!Number.isInteger(leaseSeconds) || leaseSeconds <= 0) throw new Error("INVALID_LEASE_SECONDS");
  const milliseconds = Date.parse(now);
  if (!Number.isFinite(milliseconds)) throw new Error("INVALID_LEASE_TIME");
  return new Date(milliseconds + leaseSeconds * 1_000).toISOString();
};
const supportThreadFromRow = (row: SupportThreadRow): SupportThreadRecord => ({
  id: row.id,
  principalId: row.principal_id,
  state: row.state,
  autonomyMode: row.autonomy_mode,
  currentCaseId: row.current_case_id,
  approvedPlanVersion: row.approved_plan_version,
  activeCallId: row.active_call_id,
  pendingAttentionRequestId: row.pending_attention_request_id,
  messagingOptState: row.messaging_opt_state,
  draft: row.draft_json === null ? null : parseJson(row.draft_json),
  isActive: row.is_active === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
const inboundMessageFromRow = (row: InboundMessageRow): InboundMessageRecord => ({
  id: row.id,
  threadId: row.thread_id,
  providerKind: row.provider_kind,
  providerMessageId: row.provider_message_id,
  direction: row.direction,
  redactedBody: row.redacted_body,
  sender: row.sender,
  recipient: row.recipient,
  caseId: row.case_id,
  callId: row.call_id,
  attentionRequestId: row.attention_request_id,
  createdAt: row.created_at,
  processingState: row.processing_state,
  deliveryState: row.delivery_state,
  statusUpdatedAt: row.status_updated_at,
  processedAt: row.processed_at,
  segmentEstimate: row.segment_estimate,
  errorCode: row.error_code,
  idempotencyKey: row.idempotency_key,
});
const outboundMessageFromRow = (row: OutboundMessageRow): OutboundMessageRecord => ({
  id: row.id,
  threadId: row.thread_id,
  providerKind: row.provider_kind,
  providerMessageId: row.provider_message_id,
  direction: row.direction,
  redactedBody: row.redacted_body,
  sender: row.sender,
  recipient: row.recipient,
  caseId: row.case_id,
  callId: row.call_id,
  attentionRequestId: row.attention_request_id,
  createdAt: row.created_at,
  processingState: row.processing_state,
  deliveryState: row.delivery_state,
  statusUpdatedAt: row.status_updated_at,
  processedAt: row.processed_at,
  deliveredAt: row.delivered_at,
  segmentEstimate: row.segment_estimate,
  errorCode: row.error_code,
  idempotencyKey: row.idempotency_key,
  leaseOwner: row.lease_owner,
  leaseExpiresAt: row.lease_expires_at,
  attemptCount: row.attempt_count,
  lastError: row.last_error,
  nextEligibleAt: row.next_eligible_at,
});
const workItemFromRow = (row: WorkItemRow): MessagingWorkItemRecord => ({
  id: row.id,
  kind: row.kind,
  inboundMessageId: row.inbound_message_id,
  outboundMessageId: row.outbound_message_id,
  payload: parseJson(row.payload_json),
  state: row.state,
  leaseOwner: row.lease_owner,
  leaseExpiresAt: row.lease_expires_at,
  attemptCount: row.attempt_count,
  lastError: row.last_error,
  nextEligibleAt: row.next_eligible_at,
  idempotencyKey: row.idempotency_key,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  completedAt: row.completed_at,
});
const deliveryEventFromRow = (row: DeliveryEventRow): MessageDeliveryEventRecord => ({
  id: row.id,
  outboundMessageId: row.outbound_message_id,
  providerMessageId: row.provider_message_id,
  providerStatus: row.provider_status,
  errorCode: row.error_code,
  occurredAt: row.occurred_at,
  receivedAt: row.received_at,
  eventKey: row.event_key,
});
const attentionRequestFromRow = (row: AttentionRequestRow): AttentionRequestRecord => ({
  id: row.id,
  threadId: row.thread_id,
  caseId: row.case_id,
  callId: row.call_id,
  tier: row.tier,
  status: row.status,
  blocking: row.blocking === 1,
  question: row.question,
  choices: parseJson(row.choices_json) as unknown[],
  proposedAction: row.proposed_action_json === null ? null : parseJson(row.proposed_action_json),
  resolution: row.resolution_json === null ? null : parseJson(row.resolution_json),
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  resolvedAt: row.resolved_at,
  supersededBy: row.superseded_by,
});
const secureActionTokenFromRow = (row: SecureActionTokenRow): SecureActionTokenRecord => ({
  id: row.id,
  tokenHash: row.token_hash,
  actionType: row.action_type,
  threadId: row.thread_id,
  caseId: row.case_id,
  callId: row.call_id,
  attentionRequestId: row.attention_request_id,
  singleUse: row.single_use === 1,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  usedAt: row.used_at,
  revokedAt: row.revoked_at,
  revokeReason: row.revoke_reason,
});
const callAuthorizationFromRow = (row: CallAuthorizationRow): CallAuthorizationRecord => ({
  id: row.id,
  threadId: row.thread_id,
  caseId: row.case_id,
  planVersion: row.plan_version,
  destinationE164: row.destination_e164,
  telephonyMode: row.telephony_mode,
  codeHash: row.code_hash,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  consumedAt: row.consumed_at,
  revokedAt: row.revoked_at,
  revokeReason: row.revoke_reason,
});
const providerSecurityEventFromRow = (row: ProviderSecurityEventRow): ProviderSecurityEventRecord => ({
  id: row.id,
  providerKind: row.provider_kind,
  providerMessageId: row.provider_message_id,
  eventType: row.event_type,
  reasonCode: row.reason_code,
  threadId: row.thread_id,
  caseId: row.case_id,
  callId: row.call_id,
  redactedMetadata: parseJson(row.redacted_metadata_json),
  createdAt: row.created_at,
});
const commitmentFromRow = (row: CommitmentRow): CommitmentRecord => ({
  id: row.id,
  threadId: row.thread_id,
  caseId: row.case_id,
  callId: row.call_id,
  party: row.party,
  status: row.status,
  description: row.description,
  amountCents: row.amount_cents,
  deadline: row.deadline,
  recurring: row.recurring === null ? null : row.recurring === 1,
  evidence: parseJson(row.evidence_json) as EvidenceReferenceRecord[],
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
const semanticCallEventFromRow = (row: SemanticCallEventRow): SemanticCallEventRecord => ({
  id: row.id,
  threadId: row.thread_id,
  caseId: row.case_id,
  callId: row.call_id,
  eventType: row.event_type,
  semanticKey: row.semantic_key,
  payload: parseJson(row.payload_json),
  occurredAt: row.occurred_at,
  createdAt: row.created_at,
});
const conditionalAuthorityRuleFromRow = (row: ConditionalAuthorityRuleRow): ConditionalAuthorityRuleRecord => ({
  id: row.id,
  threadId: row.thread_id,
  caseId: row.case_id,
  actionType: row.action_type,
  condition: parseJson(row.condition_json),
  permission: row.permission,
  priority: row.priority,
  active: row.active === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
const approvalExecutionFromRow = (row: ApprovalExecutionRow): ApprovalExecutionRecord => ({
  approvalId: row.approval_id,
  callId: row.call_id,
  decision: row.decision,
  payloadFingerprint: row.payload_fingerprint,
  targetStatus: row.target_status,
  executionId: row.execution_id,
  state: row.state,
  reservedAt: row.reserved_at,
  completedAt: row.completed_at,
  errorCode: row.error_code,
});

export class LiaisonDatabase {
  readonly db: Database.Database;
  constructor(filename: string) {
    if (filename !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL"); this.db.pragma("foreign_keys = ON"); this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cases (id TEXT PRIMARY KEY, company_name TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, intake_json TEXT NOT NULL, brief_json TEXT, disclosure_metadata_json TEXT NOT NULL DEFAULT '[]', approved_version INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE, mode TEXT NOT NULL, scenario_id TEXT, state TEXT NOT NULL, activity TEXT NOT NULL, objective TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0, human_detected INTEGER NOT NULL DEFAULT 0, disclosure_delivered INTEGER NOT NULL DEFAULT 0, consent_status TEXT NOT NULL DEFAULT 'UNKNOWN', generation INTEGER NOT NULL DEFAULT 0, twilio_call_sid TEXT, started_at TEXT NOT NULL, ended_at TEXT, duration_seconds INTEGER NOT NULL DEFAULT 0, estimated_cost_usd REAL NOT NULL DEFAULT 0, llm_input_tokens INTEGER NOT NULL DEFAULT 0, llm_output_tokens INTEGER NOT NULL DEFAULT 0, terminal_reason TEXT);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, call_id TEXT, case_id TEXT, sequence INTEGER NOT NULL, timestamp TEXT NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL, origin TEXT NOT NULL, idempotency_key TEXT, UNIQUE(call_id, idempotency_key));
      CREATE TABLE IF NOT EXISTS transcript_turns (id TEXT PRIMARY KEY, call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE, sequence INTEGER NOT NULL, speaker TEXT NOT NULL, text TEXT NOT NULL, timestamp TEXT NOT NULL, UNIQUE(call_id, sequence));
      CREATE TABLE IF NOT EXISTS approval_requests (id TEXT PRIMARY KEY, call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE, status TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approval_executions (
        approval_id TEXT PRIMARY KEY REFERENCES approval_requests(id) ON DELETE CASCADE,
        call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
        decision TEXT NOT NULL CHECK (decision IN ('APPROVE','REJECT')),
        payload_fingerprint TEXT NOT NULL CHECK (length(payload_fingerprint) >= 32),
        target_status TEXT NOT NULL CHECK (target_status IN ('APPROVED','REJECTED','REPLACED')),
        execution_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (state IN ('RESERVED','SUCCEEDED','FAILED')),
        reserved_at TEXT NOT NULL,
        completed_at TEXT,
        error_code TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_approval_executions_call ON approval_executions(call_id,state);
      CREATE TABLE IF NOT EXISTS outcome_reports (call_id TEXT PRIMARY KEY REFERENCES calls(id) ON DELETE CASCADE, report_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS daily_call_usage (day TEXT PRIMARY KEY, count INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_cases_updated_at ON cases(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_calls_case_id ON calls(case_id);
      CREATE INDEX IF NOT EXISTS idx_events_call_sequence ON events(call_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_transcript_call_sequence ON transcript_turns(call_id, sequence);
    `);
    const callColumns=new Set((this.db.pragma("table_info(calls)") as Array<{name:string}>).map((column)=>column.name));
    if(!callColumns.has("llm_input_tokens")) this.db.exec("ALTER TABLE calls ADD COLUMN llm_input_tokens INTEGER NOT NULL DEFAULT 0");
    if(!callColumns.has("llm_output_tokens")) this.db.exec("ALTER TABLE calls ADD COLUMN llm_output_tokens INTEGER NOT NULL DEFAULT 0");
    if(!callColumns.has("authorization_id")) this.db.exec("ALTER TABLE calls ADD COLUMN authorization_id TEXT");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS support_threads (
        id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('IDLE','COLLECTING_ISSUE','AWAITING_INFORMATION','PLAN_DRAFTED','AWAITING_PLAN_APPROVAL','AWAITING_AVAILABILITY','CALL_STARTING','CALL_ACTIVE','AWAITING_USER_DECISION','CALL_ENDING','COMPLETED','CANCELLED','FAILED')),
        autonomy_mode TEXT NOT NULL CHECK (autonomy_mode IN ('ASSIST','COPILOT','DELEGATE')),
        current_case_id TEXT REFERENCES cases(id) ON DELETE SET NULL,
        approved_plan_version INTEGER CHECK (approved_plan_version IS NULL OR approved_plan_version > 0),
        active_call_id TEXT REFERENCES calls(id) ON DELETE SET NULL,
        pending_attention_request_id TEXT,
        messaging_opt_state TEXT NOT NULL CHECK (messaging_opt_state IN ('UNKNOWN','OPTED_IN','OPTED_OUT')),
        draft_json TEXT CHECK (draft_json IS NULL OR json_valid(draft_json)),
        is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_support_threads_active_principal ON support_threads(principal_id) WHERE is_active=1;
      CREATE INDEX IF NOT EXISTS idx_support_threads_case ON support_threads(current_case_id);
      CREATE INDEX IF NOT EXISTS idx_support_threads_call ON support_threads(active_call_id);

      CREATE TABLE IF NOT EXISTS attention_requests (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
        case_id TEXT REFERENCES cases(id) ON DELETE CASCADE,
        call_id TEXT REFERENCES calls(id) ON DELETE CASCADE,
        tier TEXT NOT NULL CHECK (tier IN ('INFORMATIONAL','LOW_CONSEQUENCE','SENSITIVE','MATERIAL','PROHIBITED')),
        status TEXT NOT NULL CHECK (status IN ('PENDING','RESOLVED','EXPIRED','SUPERSEDED','CANCELLED')),
        blocking INTEGER NOT NULL DEFAULT 1 CHECK (blocking IN (0,1)),
        question TEXT NOT NULL CHECK (length(question) BETWEEN 1 AND 1000),
        choices_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(choices_json) AND json_type(choices_json)='array'),
        proposed_action_json TEXT CHECK (proposed_action_json IS NULL OR json_valid(proposed_action_json)),
        resolution_json TEXT CHECK (resolution_json IS NULL OR json_valid(resolution_json)),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        resolved_at TEXT,
        superseded_by TEXT REFERENCES attention_requests(id) ON DELETE SET NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_attention_one_blocking_call ON attention_requests(call_id) WHERE blocking=1 AND status='PENDING' AND call_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_attention_one_blocking_thread_without_call ON attention_requests(thread_id) WHERE blocking=1 AND status='PENDING' AND call_id IS NULL;
      CREATE INDEX IF NOT EXISTS idx_attention_thread_created ON attention_requests(thread_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS inbound_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
        provider_kind TEXT NOT NULL CHECK (provider_kind IN ('WEB','TWILIO_SMS','SIMULATOR')),
        provider_message_id TEXT,
        direction TEXT NOT NULL DEFAULT 'INBOUND' CHECK (direction='INBOUND'),
        redacted_body TEXT NOT NULL,
        sender TEXT NOT NULL,
        recipient TEXT NOT NULL,
        case_id TEXT REFERENCES cases(id) ON DELETE CASCADE,
        call_id TEXT REFERENCES calls(id) ON DELETE SET NULL,
        attention_request_id TEXT REFERENCES attention_requests(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        processing_state TEXT NOT NULL CHECK (processing_state IN ('RECEIVED','PENDING','PROCESSING','COMPLETED','DEAD_LETTER','REJECTED')),
        delivery_state TEXT NOT NULL CHECK (delivery_state IN ('RECEIVED','PENDING','QUEUED','SENT','DELIVERED','UNDELIVERED','FAILED','UNKNOWN')),
        status_updated_at TEXT NOT NULL,
        processed_at TEXT,
        segment_estimate INTEGER NOT NULL CHECK (segment_estimate >= 0),
        error_code TEXT,
        idempotency_key TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_provider_message ON inbound_messages(provider_kind, provider_message_id) WHERE provider_message_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_idempotency ON inbound_messages(provider_kind, idempotency_key);
      CREATE INDEX IF NOT EXISTS idx_inbound_thread_created ON inbound_messages(thread_id, created_at, id);

      CREATE TABLE IF NOT EXISTS outbound_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
        provider_kind TEXT NOT NULL CHECK (provider_kind IN ('WEB','TWILIO_SMS','SIMULATOR')),
        provider_message_id TEXT,
        direction TEXT NOT NULL DEFAULT 'OUTBOUND' CHECK (direction='OUTBOUND'),
        redacted_body TEXT NOT NULL,
        sender TEXT NOT NULL,
        recipient TEXT NOT NULL,
        case_id TEXT REFERENCES cases(id) ON DELETE CASCADE,
        call_id TEXT REFERENCES calls(id) ON DELETE SET NULL,
        attention_request_id TEXT REFERENCES attention_requests(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        processing_state TEXT NOT NULL CHECK (processing_state IN ('PENDING','PROCESSING','COMPLETED','DEAD_LETTER')),
        delivery_state TEXT NOT NULL CHECK (delivery_state IN ('PENDING','QUEUED','SENT','DELIVERED','UNDELIVERED','FAILED','UNKNOWN')),
        status_updated_at TEXT NOT NULL,
        processed_at TEXT,
        delivered_at TEXT,
        segment_estimate INTEGER NOT NULL CHECK (segment_estimate >= 0),
        error_code TEXT,
        idempotency_key TEXT NOT NULL UNIQUE,
        lease_owner TEXT,
        lease_expires_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        last_error TEXT,
        next_eligible_at TEXT NOT NULL,
        CHECK ((processing_state='PROCESSING' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL) OR (processing_state<>'PROCESSING' AND lease_owner IS NULL AND lease_expires_at IS NULL))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_outbound_provider_message ON outbound_messages(provider_kind, provider_message_id) WHERE provider_message_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_outbound_claim ON outbound_messages(processing_state, next_eligible_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_outbound_thread_created ON outbound_messages(thread_id, created_at, id);

      CREATE TABLE IF NOT EXISTS message_delivery_events (
        id TEXT PRIMARY KEY,
        outbound_message_id TEXT NOT NULL REFERENCES outbound_messages(id) ON DELETE CASCADE,
        provider_message_id TEXT,
        provider_status TEXT NOT NULL,
        error_code TEXT,
        occurred_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        event_key TEXT NOT NULL UNIQUE
      );
      CREATE INDEX IF NOT EXISTS idx_delivery_message_order ON message_delivery_events(outbound_message_id, occurred_at, received_at, id);

      CREATE TABLE IF NOT EXISTS messaging_work_items (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        inbound_message_id TEXT REFERENCES inbound_messages(id) ON DELETE CASCADE,
        outbound_message_id TEXT REFERENCES outbound_messages(id) ON DELETE CASCADE,
        payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
        state TEXT NOT NULL CHECK (state IN ('PENDING','PROCESSING','COMPLETED','DEAD_LETTER')),
        lease_owner TEXT,
        lease_expires_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        last_error TEXT,
        next_eligible_at TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        CHECK (NOT (inbound_message_id IS NOT NULL AND outbound_message_id IS NOT NULL)),
        CHECK ((state='PROCESSING' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL) OR (state<>'PROCESSING' AND lease_owner IS NULL AND lease_expires_at IS NULL))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_work_inbound_kind ON messaging_work_items(inbound_message_id, kind) WHERE inbound_message_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_work_claim ON messaging_work_items(state, next_eligible_at, created_at);

      CREATE TABLE IF NOT EXISTS secure_action_tokens (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) >= 32),
        action_type TEXT NOT NULL,
        thread_id TEXT NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
        case_id TEXT REFERENCES cases(id) ON DELETE CASCADE,
        call_id TEXT REFERENCES calls(id) ON DELETE CASCADE,
        attention_request_id TEXT REFERENCES attention_requests(id) ON DELETE CASCADE,
        single_use INTEGER NOT NULL DEFAULT 1 CHECK (single_use IN (0,1)),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        revoked_at TEXT,
        revoke_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_secure_tokens_attention ON secure_action_tokens(attention_request_id);
      CREATE INDEX IF NOT EXISTS idx_secure_tokens_expiry ON secure_action_tokens(expires_at);

      CREATE TABLE IF NOT EXISTS conditional_authority_rules (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
        case_id TEXT REFERENCES cases(id) ON DELETE CASCADE,
        action_type TEXT NOT NULL,
        condition_json TEXT NOT NULL CHECK (json_valid(condition_json)),
        permission TEXT NOT NULL CHECK (permission IN ('ALLOW','ASK','DENY')),
        priority INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_authority_rules_scope ON conditional_authority_rules(thread_id, case_id, active, priority DESC);

      CREATE TABLE IF NOT EXISTS commitments (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
        case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
        call_id TEXT REFERENCES calls(id) ON DELETE CASCADE,
        party TEXT NOT NULL CHECK (party IN ('COMPANY','USER','AGENT','UNKNOWN')),
        status TEXT NOT NULL CHECK (status IN ('PROPOSED','CONFIRMED','REJECTED','SUPERSEDED','UNVERIFIED')),
        description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 2000),
        amount_cents INTEGER CHECK (amount_cents IS NULL OR amount_cents >= 0),
        deadline TEXT,
        recurring INTEGER CHECK (recurring IS NULL OR recurring IN (0,1)),
        evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json) AND json_type(evidence_json)='array' AND json_array_length(evidence_json) > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_commitments_call_created ON commitments(call_id, created_at, id);
      CREATE INDEX IF NOT EXISTS idx_commitments_case_created ON commitments(case_id, created_at, id);

      CREATE TABLE IF NOT EXISTS semantic_call_events (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
        case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
        call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        semantic_key TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(call_id, semantic_key)
      );
      CREATE INDEX IF NOT EXISTS idx_semantic_call_order ON semantic_call_events(call_id, occurred_at, id);

      CREATE TABLE IF NOT EXISTS call_authorizations (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
        case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
        plan_version INTEGER NOT NULL CHECK (plan_version > 0),
        destination_e164 TEXT,
        telephony_mode TEXT CHECK (telephony_mode IS NULL OR telephony_mode IN ('simulator','twilio')),
        code_hash TEXT NOT NULL CHECK (length(code_hash) >= 16),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        revoked_at TEXT,
        revoke_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_call_authorization_lookup ON call_authorizations(thread_id, case_id, plan_version, code_hash, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_call_authorization ON call_authorizations(thread_id) WHERE consumed_at IS NULL AND revoked_at IS NULL;

      CREATE TABLE IF NOT EXISTS provider_security_events (
        id TEXT PRIMARY KEY,
        provider_kind TEXT NOT NULL CHECK (provider_kind IN ('WEB','TWILIO_SMS','SIMULATOR')),
        provider_message_id TEXT NOT NULL CHECK (length(provider_message_id) > 0),
        event_type TEXT NOT NULL CHECK (length(event_type) > 0),
        reason_code TEXT NOT NULL CHECK (length(reason_code) > 0),
        thread_id TEXT REFERENCES support_threads(id) ON DELETE SET NULL,
        case_id TEXT REFERENCES cases(id) ON DELETE SET NULL,
        call_id TEXT REFERENCES calls(id) ON DELETE SET NULL,
        redacted_metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(redacted_metadata_json)),
        created_at TEXT NOT NULL,
        UNIQUE(provider_kind, provider_message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_provider_security_created ON provider_security_events(created_at DESC, id DESC);

      CREATE TRIGGER IF NOT EXISTS delete_call_events_before_call
      BEFORE DELETE ON calls
      BEGIN
        DELETE FROM events WHERE call_id=OLD.id;
      END;

      CREATE TRIGGER IF NOT EXISTS delete_case_events_before_case
      BEFORE DELETE ON cases
      BEGIN
        DELETE FROM events WHERE case_id=OLD.id OR call_id IN (SELECT id FROM calls WHERE case_id=OLD.id);
      END;
    `);
    const authorizationColumns = new Set((this.db.pragma("table_info(call_authorizations)") as Array<{name:string}>).map((column) => column.name));
    if (!authorizationColumns.has("destination_e164")) this.db.exec("ALTER TABLE call_authorizations ADD COLUMN destination_e164 TEXT");
    if (!authorizationColumns.has("telephony_mode")) this.db.exec("ALTER TABLE call_authorizations ADD COLUMN telephony_mode TEXT CHECK (telephony_mode IS NULL OR telephony_mode IN ('simulator','twilio'))");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)")
      .run(1, "sms_first_durable_messaging", new Date().toISOString());
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)")
      .run(2, "provider_security_and_authorization_binding", new Date().toISOString());
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)")
      .run(3, "call_authorization_audit_link", new Date().toISOString());
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)")
      .run(4, "durable_approval_execution", new Date().toISOString());
    this.db.pragma("optimize");
  }

  close(): void { this.db.close(); }
  ready(): boolean { return this.db.prepare("SELECT 1 AS ok").get() !== undefined; }

  createCase(input: { id: string; companyName: string; title: string; intake: unknown; disclosureMetadata: unknown[] }): void {
    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO cases (id, company_name, title, status, intake_json, disclosure_metadata_json, created_at, updated_at) VALUES (?, ?, ?, 'DRAFT', ?, ?, ?, ?)")
      .run(input.id, input.companyName, input.title, JSON.stringify(input.intake), JSON.stringify(input.disclosureMetadata), now, now);
  }
  appendCaseDisclosureMetadata(caseId: string, metadata: CaseDetail["disclosures"][number]): CaseDetail["disclosures"] {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT disclosure_metadata_json FROM cases WHERE id=?").get(caseId) as Pick<CaseRow,"disclosure_metadata_json"> | undefined;
      if (!row) throw new Error("CASE_NOT_FOUND");
      const existing = JSON.parse(row.disclosure_metadata_json) as CaseDetail["disclosures"];
      if (existing.length >= 12) throw new Error("DISCLOSURE_LIMIT_REACHED");
      const next = [...existing, metadata];
      this.db.prepare("UPDATE cases SET disclosure_metadata_json=?,updated_at=? WHERE id=?")
        .run(JSON.stringify(next), new Date().toISOString(), caseId);
      return next;
    })();
  }
  listCases(): CaseSummary[] {
    return (this.db.prepare("SELECT id, company_name, title, status, updated_at FROM cases ORDER BY updated_at DESC").all() as Array<Pick<CaseRow,"id"|"company_name"|"title"|"status"|"updated_at">>)
      .map((r) => ({ id: r.id, companyName: r.company_name, title: r.title, status: r.status, updatedAt: r.updated_at }));
  }
  getCase(id: string): CaseDetail | null {
    const r = this.db.prepare("SELECT * FROM cases WHERE id = ?").get(id) as CaseRow | undefined;
    return r ? { id: r.id, companyName: r.company_name, title: r.title, status: r.status, updatedAt: r.updated_at, intake: JSON.parse(r.intake_json) as Record<string, unknown>, brief: r.brief_json ? JSON.parse(r.brief_json) as CallBrief : null, approvedVersion: r.approved_version, disclosures: JSON.parse(r.disclosure_metadata_json) as CaseDetail["disclosures"] } : null;
  }
  savePlan(caseId: string, brief: CallBrief): void {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare("UPDATE cases SET brief_json=?, title=?, status='PLANNED', approved_version=NULL, updated_at=? WHERE id=?")
        .run(JSON.stringify(brief), brief.title, now, caseId);
      this.db.prepare("UPDATE support_threads SET approved_plan_version=NULL,state='PLAN_DRAFTED',updated_at=? WHERE current_case_id=? AND state NOT IN ('CALL_STARTING','CALL_ACTIVE','AWAITING_USER_DECISION','CALL_ENDING')")
        .run(now, caseId);
      this.db.prepare("UPDATE call_authorizations SET revoked_at=?,revoke_reason='PLAN_CHANGED' WHERE case_id=? AND consumed_at IS NULL AND revoked_at IS NULL")
        .run(now, caseId);
    })();
  }
  approvePlan(caseId: string, version: number): void { this.db.prepare("UPDATE cases SET approved_version=?, status='APPROVED', updated_at=? WHERE id=? AND json_extract(brief_json, '$.version')=?").run(version, new Date().toISOString(), caseId, version); }
  deleteCase(id: string): CaseDeletionResult {
    return this.db.transaction(() => {
      const exists = this.db.prepare("SELECT 1 FROM cases WHERE id=?").get(id);
      if (!exists) throw new Error("CASE_NOT_FOUND");
      const activeCall = this.db.prepare("SELECT id FROM calls WHERE case_id=? AND state NOT IN ('COMPLETED','FAILED') LIMIT 1")
        .get(id) as {id:string}|undefined;
      if (activeCall) throw new Error("ACTIVE_CALL_CANNOT_BE_DELETED");

      const callIds = (this.db.prepare("SELECT id FROM calls WHERE case_id=? ORDER BY id").all(id) as Array<{id:string}>)
        .map((row) => row.id);

      const affectedThreads = this.db.prepare(`WITH affected_threads(id) AS (
          SELECT id FROM support_threads WHERE current_case_id=@caseId
          UNION SELECT thread_id FROM inbound_messages WHERE case_id=@caseId OR call_id IN (SELECT id FROM calls WHERE case_id=@caseId)
          UNION SELECT thread_id FROM outbound_messages WHERE case_id=@caseId OR call_id IN (SELECT id FROM calls WHERE case_id=@caseId)
          UNION SELECT thread_id FROM attention_requests WHERE case_id=@caseId OR call_id IN (SELECT id FROM calls WHERE case_id=@caseId)
          UNION SELECT thread_id FROM secure_action_tokens WHERE case_id=@caseId OR call_id IN (SELECT id FROM calls WHERE case_id=@caseId)
          UNION SELECT thread_id FROM conditional_authority_rules WHERE case_id=@caseId
          UNION SELECT thread_id FROM commitments WHERE case_id=@caseId OR call_id IN (SELECT id FROM calls WHERE case_id=@caseId)
          UNION SELECT thread_id FROM semantic_call_events WHERE case_id=@caseId OR call_id IN (SELECT id FROM calls WHERE case_id=@caseId)
          UNION SELECT thread_id FROM call_authorizations WHERE case_id=@caseId
          UNION SELECT id FROM support_threads WHERE active_call_id IN (SELECT id FROM calls WHERE case_id=@caseId)
        )
        SELECT id,principal_id,active_call_id FROM support_threads WHERE id IN (SELECT id FROM affected_threads)`)
        .all({caseId:id}) as Array<{id:string;principal_id:string;active_call_id:string|null}>;

      const inboundMessageIds = affectedThreads.flatMap((thread) =>
        (this.db.prepare("SELECT id FROM inbound_messages WHERE thread_id=? ORDER BY id").all(thread.id) as Array<{id:string}>).map((row) => row.id));
      const outboundMessageIds = affectedThreads.flatMap((thread) =>
        (this.db.prepare("SELECT id FROM outbound_messages WHERE thread_id=? ORDER BY id").all(thread.id) as Array<{id:string}>).map((row) => row.id));

      for (const thread of affectedThreads) {
        if (!thread.active_call_id) continue;
        const call = this.db.prepare("SELECT state FROM calls WHERE id=?").get(thread.active_call_id) as {state:string}|undefined;
        if (call && !["COMPLETED", "FAILED"].includes(call.state)) throw new Error("ACTIVE_CALL_CANNOT_BE_DELETED");
      }

      const principals = [...new Set(affectedThreads.map((thread) => thread.principal_id))].map((principalId) => {
        const optStates = (this.db.prepare("SELECT messaging_opt_state FROM support_threads WHERE principal_id=?").all(principalId) as Array<{messaging_opt_state:MessagingOptState}>)
          .map((row) => row.messaging_opt_state);
        const messagingOptState:MessagingOptState = optStates.includes("OPTED_OUT") ? "OPTED_OUT" : optStates.includes("OPTED_IN") ? "OPTED_IN" : "UNKNOWN";
        return {principalId,messagingOptState};
      });

      const removeThread = this.db.prepare("DELETE FROM support_threads WHERE id=?");
      for (const thread of affectedThreads) {
        this.db.prepare("DELETE FROM provider_security_events WHERE thread_id=? OR case_id=? OR call_id IN (SELECT id FROM calls WHERE case_id=?)")
          .run(thread.id, id, id);
      }
      if (affectedThreads.length === 0) {
        this.db.prepare("DELETE FROM provider_security_events WHERE case_id=? OR call_id IN (SELECT id FROM calls WHERE case_id=?)")
          .run(id, id);
      }
      for (const thread of affectedThreads) removeThread.run(thread.id);
      this.db.prepare("DELETE FROM events WHERE case_id=? OR call_id IN (SELECT id FROM calls WHERE case_id=?)").run(id, id);
      this.db.prepare("DELETE FROM cases WHERE id=?").run(id);

      const now = new Date().toISOString();
      for (const principal of principals) {
        const current = this.db.prepare("SELECT id,messaging_opt_state FROM support_threads WHERE principal_id=? AND is_active=1 LIMIT 1")
          .get(principal.principalId) as {id:string;messaging_opt_state:MessagingOptState}|undefined;
        if (current) {
          if (current.messaging_opt_state !== principal.messagingOptState) {
            this.db.prepare("UPDATE support_threads SET messaging_opt_state=?,updated_at=? WHERE id=?")
              .run(principal.messagingOptState, now, current.id);
          }
          continue;
        }
        this.db.prepare(`INSERT INTO support_threads
          (id,principal_id,state,autonomy_mode,current_case_id,approved_plan_version,active_call_id,pending_attention_request_id,messaging_opt_state,draft_json,is_active,created_at,updated_at)
          VALUES (?,?,'IDLE','COPILOT',NULL,NULL,NULL,NULL,?,NULL,1,?,?)`)
          .run(randomUUID(), principal.principalId, principal.messagingOptState, now, now);
      }
      return {
        caseId: id,
        callIds,
        threadIds: affectedThreads.map((thread) => thread.id),
        inboundMessageIds,
        outboundMessageIds,
      };
    })();
  }

  getSupportThread(id: string): SupportThreadRecord | null {
    const row = this.db.prepare("SELECT * FROM support_threads WHERE id=?").get(id) as SupportThreadRow | undefined;
    return row ? supportThreadFromRow(row) : null;
  }

  getActiveSupportThread(principalId: string): SupportThreadRecord | null {
    const row = this.db.prepare("SELECT * FROM support_threads WHERE principal_id=? AND is_active=1 LIMIT 1").get(principalId) as SupportThreadRow | undefined;
    return row ? supportThreadFromRow(row) : null;
  }

  getThreadForCall(callId: string): SupportThreadRecord | null {
    const row = this.db.prepare("SELECT * FROM support_threads WHERE active_call_id=? ORDER BY is_active DESC,updated_at DESC LIMIT 1").get(callId) as SupportThreadRow | undefined;
    return row ? supportThreadFromRow(row) : null;
  }

  getOrCreateActiveSupportThread(input: {
    id: string;
    principalId: string;
    state?: SupportThreadState;
    autonomyMode?: AutonomyMode;
    currentCaseId?: string | null;
    messagingOptState?: MessagingOptState;
    draft?: unknown | null;
    now?: string;
  }): SupportThreadRecord {
    return this.db.transaction(() => {
      const existing = this.getActiveSupportThread(input.principalId);
      if (existing) return existing;
      const now = input.now ?? new Date().toISOString();
      this.db.prepare(`INSERT INTO support_threads
        (id,principal_id,state,autonomy_mode,current_case_id,messaging_opt_state,draft_json,is_active,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,1,?,?)`)
        .run(
          input.id,
          input.principalId,
          input.state ?? "IDLE",
          input.autonomyMode ?? "COPILOT",
          input.currentCaseId ?? null,
          input.messagingOptState ?? "UNKNOWN",
          input.draft === undefined || input.draft === null ? null : JSON.stringify(input.draft),
          now,
          now,
        );
      return this.getSupportThread(input.id) as SupportThreadRecord;
    })();
  }

  updateSupportThread(id: string, fields: Partial<{
    state: SupportThreadState;
    autonomyMode: AutonomyMode;
    currentCaseId: string | null;
    approvedPlanVersion: number | null;
    activeCallId: string | null;
    pendingAttentionRequestId: string | null;
    messagingOptState: MessagingOptState;
    draft: unknown | null;
    isActive: boolean;
    updatedAt: string;
  }>): SupportThreadRecord | null {
    const mapping: Record<string,string> = {
      state: "state",
      autonomyMode: "autonomy_mode",
      currentCaseId: "current_case_id",
      approvedPlanVersion: "approved_plan_version",
      activeCallId: "active_call_id",
      pendingAttentionRequestId: "pending_attention_request_id",
      messagingOptState: "messaging_opt_state",
      draft: "draft_json",
      isActive: "is_active",
      updatedAt: "updated_at",
    };
    const supplied = Object.entries(fields).filter(([,value]) => value !== undefined && value !== null);
    const explicitNulls = ["currentCaseId", "approvedPlanVersion", "activeCallId", "pendingAttentionRequestId", "draft"]
      .filter((key) => Object.prototype.hasOwnProperty.call(fields, key) && fields[key as keyof typeof fields] === null)
      .map((key) => [key, null] as const);
    const entries: Array<readonly [string, unknown]> = [...supplied, ...explicitNulls];
    if (!Object.prototype.hasOwnProperty.call(fields, "updatedAt")) entries.push(["updatedAt", new Date().toISOString()]);
    const values = entries.map(([key,value]) => {
      if (key === "draft") return value === null ? null : JSON.stringify(value);
      if (typeof value === "boolean") return Number(value);
      return value;
    });
    this.db.prepare(`UPDATE support_threads SET ${entries.map(([key]) => `${mapping[key]}=?`).join(",")} WHERE id=?`)
      .run(...values, id);
    return this.getSupportThread(id);
  }

  optOutSupportThreadAndCancelOutbound(
    threadId: string,
    input: { now?: string; reason?: string } = {},
  ): { threadUpdated: boolean; cancelledCount: number } {
    return this.db.transaction(() => {
      const now = input.now ?? new Date().toISOString();
      const reason = input.reason ?? "OWNER_OPTED_OUT";
      const thread = this.db.prepare("UPDATE support_threads SET messaging_opt_state='OPTED_OUT',updated_at=? WHERE id=?")
        .run(now, threadId);
      this.db.prepare(`UPDATE messaging_work_items
        SET state='DEAD_LETTER',lease_owner=NULL,lease_expires_at=NULL,last_error=?,updated_at=?,completed_at=?
        WHERE outbound_message_id IN (
          SELECT id FROM outbound_messages
          WHERE thread_id=? AND provider_kind='TWILIO_SMS' AND (
            processing_state IN ('PENDING','PROCESSING')
            OR (delivery_state='QUEUED' AND provider_message_id IS NULL)
          )
        ) AND state IN ('PENDING','PROCESSING')`)
        .run(reason, now, now, threadId);
      const cancelled = this.db.prepare(`UPDATE outbound_messages
        SET processing_state='DEAD_LETTER',delivery_state='FAILED',lease_owner=NULL,lease_expires_at=NULL,
            last_error=?,error_code=?,status_updated_at=?,processed_at=?
        WHERE thread_id=? AND provider_kind='TWILIO_SMS' AND (
          processing_state IN ('PENDING','PROCESSING')
          OR (delivery_state='QUEUED' AND provider_message_id IS NULL)
        )`)
        .run(reason, reason, now, now, threadId);
      return { threadUpdated: thread.changes === 1, cancelledCount: cancelled.changes };
    })();
  }

  createCallAuthorization(input: {
    id: string;
    threadId: string;
    caseId: string;
    planVersion: number;
    destinationE164?: string;
    telephonyMode?: "simulator" | "twilio";
    codeHash: string;
    expiresAt: string;
    now?: string;
  }): CallAuthorizationRecord {
    return this.db.transaction(() => {
      const plan = this.db.prepare(`SELECT
          json_extract(brief_json,'$.version') AS version,
          json_extract(brief_json,'$.phoneNumberE164') AS destination
        FROM cases WHERE id=?`)
        .get(input.caseId) as {version:number|null;destination:string|null} | undefined;
      if (!plan || plan.version !== input.planVersion) throw new Error("PLAN_VERSION_MISMATCH");
      if (!plan.destination || (input.destinationE164 !== undefined && input.destinationE164 !== plan.destination)) {
        throw new Error("AUTHORIZATION_DESTINATION_MISMATCH");
      }
      const now = input.now ?? new Date().toISOString();
      this.db.prepare("UPDATE call_authorizations SET revoked_at=?,revoke_reason='REPLACED' WHERE thread_id=? AND consumed_at IS NULL AND revoked_at IS NULL")
        .run(now, input.threadId);
      const approved = this.db.prepare("UPDATE cases SET approved_version=?,status='APPROVED',updated_at=? WHERE id=? AND json_extract(brief_json,'$.version')=?")
        .run(input.planVersion, now, input.caseId, input.planVersion);
      if (approved.changes !== 1) throw new Error("PLAN_VERSION_MISMATCH");
      const thread = this.db.prepare("UPDATE support_threads SET current_case_id=?,approved_plan_version=?,updated_at=? WHERE id=? AND is_active=1")
        .run(input.caseId, input.planVersion, now, input.threadId);
      if (thread.changes !== 1) throw new Error("ACTIVE_THREAD_NOT_FOUND");
      this.db.prepare(`INSERT INTO call_authorizations
        (id,thread_id,case_id,plan_version,destination_e164,telephony_mode,code_hash,created_at,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(input.id, input.threadId, input.caseId, input.planVersion, plan.destination, input.telephonyMode ?? null, input.codeHash, now, input.expiresAt);
      const row = this.db.prepare("SELECT * FROM call_authorizations WHERE id=?").get(input.id) as CallAuthorizationRow;
      return callAuthorizationFromRow(row);
    })();
  }

  consumeCallAuthorization(input: {
    threadId: string;
    caseId: string;
    planVersion: number;
    destinationE164?: string;
    telephonyMode?: "simulator" | "twilio";
    codeHash: string;
    now?: string;
  }): CallAuthorizationRecord | null {
    return this.db.transaction(() => {
      const now = input.now ?? new Date().toISOString();
      const currentPlan = this.db.prepare("SELECT json_extract(brief_json,'$.phoneNumberE164') AS destination FROM cases WHERE id=?")
        .get(input.caseId) as {destination:string|null} | undefined;
      const destination = input.destinationE164 ?? currentPlan?.destination ?? null;
      const row = this.db.prepare(`SELECT a.* FROM call_authorizations a
        JOIN support_threads t ON t.id=a.thread_id
        JOIN cases c ON c.id=a.case_id
        WHERE a.thread_id=? AND a.case_id=? AND a.plan_version=? AND a.code_hash=?
          AND (a.destination_e164 IS NULL OR a.destination_e164 IS ?)
          AND (a.telephony_mode IS NULL OR a.telephony_mode IS ?)
          AND a.consumed_at IS NULL AND a.revoked_at IS NULL AND a.expires_at>?
          AND t.is_active=1 AND t.current_case_id=a.case_id AND t.approved_plan_version=a.plan_version
          AND c.approved_version=a.plan_version AND json_extract(c.brief_json,'$.version')=a.plan_version
        ORDER BY a.created_at DESC LIMIT 1`)
        .get(input.threadId, input.caseId, input.planVersion, input.codeHash, destination, input.telephonyMode ?? null, now) as CallAuthorizationRow | undefined;
      if (!row) return null;
      const result = this.db.prepare("UPDATE call_authorizations SET consumed_at=? WHERE id=? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>?")
        .run(now, row.id, now);
      if (result.changes !== 1) return null;
      return callAuthorizationFromRow({ ...row, consumed_at: now });
    })();
  }

  revokeCallAuthorizations(input: { threadId?: string; caseId?: string; reason: string; now?: string }): number {
    if (!input.threadId && !input.caseId) throw new Error("AUTHORIZATION_SCOPE_REQUIRED");
    const clauses: string[] = ["consumed_at IS NULL", "revoked_at IS NULL"];
    const values: unknown[] = [input.now ?? new Date().toISOString(), input.reason];
    if (input.threadId) { clauses.push("thread_id=?"); values.push(input.threadId); }
    if (input.caseId) { clauses.push("case_id=?"); values.push(input.caseId); }
    return this.db.prepare(`UPDATE call_authorizations SET revoked_at=?,revoke_reason=? WHERE ${clauses.join(" AND ")}`).run(...values).changes;
  }

  recordProviderSecurityEvent(input: {
    id: string;
    providerKind: MessagingProviderKind;
    providerMessageId: string;
    eventType: string;
    reasonCode: string;
    threadId?: string | null;
    caseId?: string | null;
    callId?: string | null;
    redactedMetadata?: unknown;
    createdAt?: string;
  }): { created: boolean; event: ProviderSecurityEventRecord } {
    return this.db.transaction(() => {
      const result = this.db.prepare(`INSERT OR IGNORE INTO provider_security_events
        (id,provider_kind,provider_message_id,event_type,reason_code,thread_id,case_id,call_id,redacted_metadata_json,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(
          input.id,
          input.providerKind,
          input.providerMessageId,
          input.eventType,
          input.reasonCode,
          input.threadId ?? null,
          input.caseId ?? null,
          input.callId ?? null,
          JSON.stringify(input.redactedMetadata ?? {}),
          input.createdAt ?? new Date().toISOString(),
        );
      const row = this.db.prepare("SELECT * FROM provider_security_events WHERE provider_kind=? AND provider_message_id=?")
        .get(input.providerKind, input.providerMessageId) as ProviderSecurityEventRow | undefined;
      if (!row) throw new Error("PROVIDER_SECURITY_EVENT_IDEMPOTENCY_CONFLICT");
      return { created: result.changes === 1, event: providerSecurityEventFromRow(row) };
    })();
  }

  listProviderSecurityEvents(limit = 100): ProviderSecurityEventRecord[] {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    return (this.db.prepare("SELECT * FROM provider_security_events ORDER BY created_at DESC,id DESC LIMIT ?").all(safeLimit) as ProviderSecurityEventRow[])
      .map(providerSecurityEventFromRow);
  }

  getInboundMessage(id: string): InboundMessageRecord | null {
    const row = this.db.prepare("SELECT * FROM inbound_messages WHERE id=?").get(id) as InboundMessageRow | undefined;
    return row ? inboundMessageFromRow(row) : null;
  }

  insertInboundMessageAndSchedule(
    input: InboundMessageInput,
    work: { id: string; kind: string; payload?: unknown; nextEligibleAt?: string; idempotencyKey: string },
  ): { created: boolean; message: InboundMessageRecord; workItem: MessagingWorkItemRecord } {
    return this.db.transaction(() => {
      const now = input.createdAt ?? new Date().toISOString();
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO inbound_messages
        (id,thread_id,provider_kind,provider_message_id,direction,redacted_body,sender,recipient,case_id,call_id,attention_request_id,created_at,processing_state,delivery_state,status_updated_at,segment_estimate,error_code,idempotency_key)
        VALUES (?,?,?,?,'INBOUND',?,?,?,?,?,?,?,'PENDING','RECEIVED',?,?,?,?)`)
        .run(
          input.id,
          input.threadId,
          input.providerKind,
          input.providerMessageId ?? null,
          input.redactedBody,
          input.sender,
          input.recipient,
          input.caseId ?? null,
          input.callId ?? null,
          input.attentionRequestId ?? null,
          now,
          now,
          input.segmentEstimate,
          input.errorCode ?? null,
          input.idempotencyKey,
        );
      const row = (inserted.changes === 1
        ? this.db.prepare("SELECT * FROM inbound_messages WHERE id=?").get(input.id)
        : this.db.prepare(`SELECT * FROM inbound_messages
            WHERE provider_kind=? AND (idempotency_key=? OR (provider_message_id IS NOT NULL AND provider_message_id=?))
            ORDER BY created_at LIMIT 1`)
          .get(input.providerKind, input.idempotencyKey, input.providerMessageId ?? null)) as InboundMessageRow | undefined;
      if (!row) throw new Error("INBOUND_IDEMPOTENCY_CONFLICT");
      this.db.prepare(`INSERT OR IGNORE INTO messaging_work_items
        (id,kind,inbound_message_id,payload_json,state,next_eligible_at,idempotency_key,created_at,updated_at)
        VALUES (?,?,?,?,'PENDING',?,?,?,?)`)
        .run(
          work.id,
          work.kind,
          row.id,
          JSON.stringify(work.payload ?? {}),
          work.nextEligibleAt ?? now,
          work.idempotencyKey,
          now,
          now,
        );
      const workRow = this.db.prepare("SELECT * FROM messaging_work_items WHERE inbound_message_id=? AND kind=?")
        .get(row.id, work.kind) as WorkItemRow | undefined;
      if (!workRow) throw new Error("WORK_IDEMPOTENCY_CONFLICT");
      return { created: inserted.changes === 1, message: inboundMessageFromRow(row), workItem: workItemFromRow(workRow) };
    })();
  }

  claimMessagingWork(input: { workerId: string; now: string; leaseSeconds: number; limit?: number }): MessagingWorkItemRecord[] {
    return this.db.transaction(() => {
      const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 10)));
      const expiresAt = leaseExpiry(input.now, input.leaseSeconds);
      this.db.prepare(`UPDATE messaging_work_items
        SET state='PENDING',lease_owner=NULL,lease_expires_at=NULL,updated_at=?
        WHERE state='PROCESSING' AND lease_expires_at<=?`)
        .run(input.now, input.now);
      const rows = this.db.prepare(`SELECT * FROM messaging_work_items
        WHERE state='PENDING' AND next_eligible_at<=?
        ORDER BY next_eligible_at,created_at,id LIMIT ?`)
        .all(input.now, limit) as WorkItemRow[];
      const claim = this.db.prepare(`UPDATE messaging_work_items
        SET state='PROCESSING',lease_owner=?,lease_expires_at=?,attempt_count=attempt_count+1,updated_at=?
        WHERE id=? AND state='PENDING'`);
      const claimed: MessagingWorkItemRecord[] = [];
      for (const row of rows) {
        if (claim.run(input.workerId, expiresAt, input.now, row.id).changes !== 1) continue;
        this.db.prepare("UPDATE inbound_messages SET processing_state='PROCESSING',status_updated_at=? WHERE id=? AND processing_state IN ('PENDING','RECEIVED','PROCESSING')")
          .run(input.now, row.inbound_message_id);
        const updated = this.db.prepare("SELECT * FROM messaging_work_items WHERE id=?").get(row.id) as WorkItemRow;
        claimed.push(workItemFromRow(updated));
      }
      return claimed;
    })();
  }

  completeMessagingWork(id: string, workerId: string, now = new Date().toISOString()): boolean {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT inbound_message_id FROM messaging_work_items WHERE id=? AND state='PROCESSING' AND lease_owner=?")
        .get(id, workerId) as {inbound_message_id:string|null} | undefined;
      if (!row) return false;
      const result = this.db.prepare(`UPDATE messaging_work_items
        SET state='COMPLETED',lease_owner=NULL,lease_expires_at=NULL,updated_at=?,completed_at=?
        WHERE id=? AND state='PROCESSING' AND lease_owner=?`)
        .run(now, now, id, workerId);
      if (result.changes !== 1) return false;
      if (row.inbound_message_id) {
        this.db.prepare("UPDATE inbound_messages SET processing_state='COMPLETED',status_updated_at=?,processed_at=? WHERE id=?")
          .run(now, now, row.inbound_message_id);
      }
      return true;
    })();
  }

  retryMessagingWork(id: string, workerId: string, error: string, nextEligibleAt: string, now = new Date().toISOString()): boolean {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT inbound_message_id FROM messaging_work_items WHERE id=? AND state='PROCESSING' AND lease_owner=?")
        .get(id, workerId) as {inbound_message_id:string|null} | undefined;
      if (!row) return false;
      const result = this.db.prepare(`UPDATE messaging_work_items
        SET state='PENDING',lease_owner=NULL,lease_expires_at=NULL,last_error=?,next_eligible_at=?,updated_at=?
        WHERE id=? AND state='PROCESSING' AND lease_owner=?`)
        .run(error, nextEligibleAt, now, id, workerId);
      if (result.changes !== 1) return false;
      if (row.inbound_message_id) {
        this.db.prepare("UPDATE inbound_messages SET processing_state='PENDING',status_updated_at=?,error_code=? WHERE id=?")
          .run(now, error, row.inbound_message_id);
      }
      return true;
    })();
  }

  deadLetterMessagingWork(id: string, workerId: string, error: string, now = new Date().toISOString()): boolean {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT inbound_message_id FROM messaging_work_items WHERE id=? AND state='PROCESSING' AND lease_owner=?")
        .get(id, workerId) as {inbound_message_id:string|null} | undefined;
      if (!row) return false;
      const result = this.db.prepare(`UPDATE messaging_work_items
        SET state='DEAD_LETTER',lease_owner=NULL,lease_expires_at=NULL,last_error=?,updated_at=?,completed_at=?
        WHERE id=? AND state='PROCESSING' AND lease_owner=?`)
        .run(error, now, now, id, workerId);
      if (result.changes !== 1) return false;
      if (row.inbound_message_id) {
        this.db.prepare("UPDATE inbound_messages SET processing_state='DEAD_LETTER',status_updated_at=?,processed_at=?,error_code=? WHERE id=?")
          .run(now, now, error, row.inbound_message_id);
      }
      return true;
    })();
  }

  resetExpiredMessagingLeases(now = new Date().toISOString()): number {
    return this.db.transaction(() => {
      const inboundIds = this.db.prepare(`SELECT inbound_message_id FROM messaging_work_items
        WHERE state='PROCESSING' AND lease_expires_at<=? AND inbound_message_id IS NOT NULL`)
        .all(now) as Array<{inbound_message_id:string}>;
      const result = this.db.prepare(`UPDATE messaging_work_items
        SET state='PENDING',lease_owner=NULL,lease_expires_at=NULL,updated_at=?
        WHERE state='PROCESSING' AND lease_expires_at<=?`)
        .run(now, now);
      const updateInbound = this.db.prepare("UPDATE inbound_messages SET processing_state='PENDING',status_updated_at=? WHERE id=? AND processing_state='PROCESSING'");
      for (const row of inboundIds) updateInbound.run(now, row.inbound_message_id);
      return result.changes;
    })();
  }

  getOutboundMessage(id: string): OutboundMessageRecord | null {
    const row = this.db.prepare("SELECT * FROM outbound_messages WHERE id=?").get(id) as OutboundMessageRow | undefined;
    return row ? outboundMessageFromRow(row) : null;
  }

  findOutboundMessageByProviderId(providerMessageId: string): OutboundMessageRecord | null {
    const row = this.db.prepare("SELECT * FROM outbound_messages WHERE provider_message_id=? ORDER BY created_at DESC LIMIT 1").get(providerMessageId) as OutboundMessageRow | undefined;
    return row ? outboundMessageFromRow(row) : null;
  }

  enqueueOutboundMessage(input: OutboundMessageInput): { created: boolean; message: OutboundMessageRecord } {
    return this.db.transaction(() => {
      const now = input.createdAt ?? new Date().toISOString();
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO outbound_messages
        (id,thread_id,provider_kind,provider_message_id,direction,redacted_body,sender,recipient,case_id,call_id,attention_request_id,created_at,processing_state,delivery_state,status_updated_at,segment_estimate,error_code,idempotency_key,next_eligible_at)
        VALUES (?,?,?,?,'OUTBOUND',?,?,?,?,?,?,?,'PENDING','PENDING',?,?,?,?,?)`)
        .run(
          input.id,
          input.threadId,
          input.providerKind,
          input.providerMessageId ?? null,
          input.redactedBody,
          input.sender,
          input.recipient,
          input.caseId ?? null,
          input.callId ?? null,
          input.attentionRequestId ?? null,
          now,
          now,
          input.segmentEstimate,
          input.errorCode ?? null,
          input.idempotencyKey,
          input.nextEligibleAt ?? now,
        );
      const row = this.db.prepare("SELECT * FROM outbound_messages WHERE idempotency_key=?").get(input.idempotencyKey) as OutboundMessageRow | undefined;
      if (!row) throw new Error("OUTBOUND_IDEMPOTENCY_CONFLICT");
      return { created: inserted.changes === 1, message: outboundMessageFromRow(row) };
    })();
  }

  claimOutboundMessages(input: { workerId: string; now: string; leaseSeconds: number; limit?: number }): OutboundMessageRecord[] {
    return this.db.transaction(() => {
      const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 10)));
      const expiresAt = leaseExpiry(input.now, input.leaseSeconds);
      this.db.prepare(`UPDATE outbound_messages
        SET processing_state='DEAD_LETTER',delivery_state='UNKNOWN',lease_owner=NULL,lease_expires_at=NULL,status_updated_at=?,processed_at=?,error_code='AMBIGUOUS_PROVIDER_ACCEPTANCE',last_error='Send lease expired after dispatch may have reached the provider; automatic retry is disabled.'
        WHERE processing_state='PROCESSING' AND lease_expires_at<=?`)
        .run(input.now, input.now, input.now);
      const rows = this.db.prepare(`SELECT * FROM outbound_messages
        WHERE processing_state='PENDING' AND next_eligible_at<=?
        ORDER BY next_eligible_at,created_at,id LIMIT ?`)
        .all(input.now, limit) as OutboundMessageRow[];
      const claim = this.db.prepare(`UPDATE outbound_messages
        SET processing_state='PROCESSING',lease_owner=?,lease_expires_at=?,attempt_count=attempt_count+1,status_updated_at=?
        WHERE id=? AND processing_state='PENDING'`);
      const claimed: OutboundMessageRecord[] = [];
      for (const row of rows) {
        if (claim.run(input.workerId, expiresAt, input.now, row.id).changes !== 1) continue;
        const updated = this.db.prepare("SELECT * FROM outbound_messages WHERE id=?").get(row.id) as OutboundMessageRow;
        claimed.push(outboundMessageFromRow(updated));
      }
      return claimed;
    })();
  }

  markOutboundSent(input: {
    id: string;
    workerId: string;
    providerMessageId?: string | null;
    deliveryState?: MessageDeliveryState;
    now?: string;
  }): boolean {
    const now = input.now ?? new Date().toISOString();
    const state = input.deliveryState ?? "QUEUED";
    if (state === "RECEIVED" || state === "PENDING") throw new Error("INVALID_SENT_DELIVERY_STATE");
    return this.db.prepare(`UPDATE outbound_messages
      SET processing_state='COMPLETED',provider_message_id=COALESCE(?,provider_message_id),delivery_state=?,status_updated_at=?,processed_at=?,delivered_at=CASE WHEN ?='DELIVERED' THEN ? ELSE delivered_at END,lease_owner=NULL,lease_expires_at=NULL,last_error=NULL,error_code=NULL
      WHERE id=? AND processing_state='PROCESSING' AND lease_owner=?`)
      .run(input.providerMessageId ?? null, state, now, now, state, now, input.id, input.workerId).changes === 1;
  }

  retryOutboundMessage(id: string, workerId: string, error: string, nextEligibleAt: string, now = new Date().toISOString()): boolean {
    return this.db.prepare(`UPDATE outbound_messages
      SET processing_state='PENDING',lease_owner=NULL,lease_expires_at=NULL,last_error=?,error_code=?,next_eligible_at=?,status_updated_at=?
      WHERE id=? AND processing_state='PROCESSING' AND lease_owner=?`)
      .run(error, error, nextEligibleAt, now, id, workerId).changes === 1;
  }

  deadLetterOutboundMessage(id: string, workerId: string, error: string, now = new Date().toISOString()): boolean {
    return this.db.prepare(`UPDATE outbound_messages
      SET processing_state='DEAD_LETTER',delivery_state='FAILED',lease_owner=NULL,lease_expires_at=NULL,last_error=?,error_code=?,status_updated_at=?,processed_at=?
      WHERE id=? AND processing_state='PROCESSING' AND lease_owner=?`)
      .run(error, error, now, now, id, workerId).changes === 1;
  }

  markOutboundAmbiguous(id:string,workerId:string,error:string,now=new Date().toISOString()):boolean{
    return this.db.prepare(`UPDATE outbound_messages SET processing_state='DEAD_LETTER',delivery_state='UNKNOWN',lease_owner=NULL,lease_expires_at=NULL,last_error=?,error_code='AMBIGUOUS_PROVIDER_ACCEPTANCE',status_updated_at=?,processed_at=? WHERE id=? AND processing_state='PROCESSING' AND lease_owner=?`).run(error,now,now,id,workerId).changes===1;
  }

  resetExpiredOutboundLeases(now = new Date().toISOString()): number {
    return this.db.prepare(`UPDATE outbound_messages
      SET processing_state='DEAD_LETTER',delivery_state='UNKNOWN',lease_owner=NULL,lease_expires_at=NULL,status_updated_at=?,processed_at=?,error_code='AMBIGUOUS_PROVIDER_ACCEPTANCE',last_error='Send lease expired after dispatch may have reached the provider; automatic retry is disabled.'
      WHERE processing_state='PROCESSING' AND lease_expires_at<=?`)
      .run(now, now, now).changes;
  }

  listMessageDeliveryEvents(outboundMessageId: string): MessageDeliveryEventRecord[] {
    return (this.db.prepare(`SELECT * FROM message_delivery_events
      WHERE outbound_message_id=? ORDER BY occurred_at,received_at,id`).all(outboundMessageId) as DeliveryEventRow[])
      .map(deliveryEventFromRow);
  }

  appendMessageDeliveryEvent(
    input: {
      id: string;
      outboundMessageId: string;
      providerMessageId?: string | null;
      providerStatus: string;
      errorCode?: string | null;
      occurredAt: string;
      receivedAt?: string;
      eventKey: string;
    },
    reducer: DeliveryStatusReducer,
  ): { created: boolean; message: OutboundMessageRecord } {
    return this.db.transaction(() => {
      const receivedAt = input.receivedAt ?? new Date().toISOString();
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO message_delivery_events
        (id,outbound_message_id,provider_message_id,provider_status,error_code,occurred_at,received_at,event_key)
        VALUES (?,?,?,?,?,?,?,?)`)
        .run(
          input.id,
          input.outboundMessageId,
          input.providerMessageId ?? null,
          input.providerStatus,
          input.errorCode ?? null,
          input.occurredAt,
          receivedAt,
          input.eventKey,
        );
      const current = this.getOutboundMessage(input.outboundMessageId);
      if (!current) throw new Error("OUTBOUND_MESSAGE_NOT_FOUND");
      const events = this.listMessageDeliveryEvents(input.outboundMessageId);
      const reduced = reducer(events, current);
      if (reduced.deliveryState === "RECEIVED") throw new Error("INVALID_OUTBOUND_DELIVERY_STATE");
      const deliveredAt = reduced.deliveryState === "DELIVERED"
        ? (reduced.deliveredAt ?? events.filter((event) => event.providerStatus.toLowerCase() === "delivered").at(-1)?.occurredAt ?? receivedAt)
        : null;
      this.db.prepare(`UPDATE outbound_messages SET
          provider_message_id=COALESCE(provider_message_id,?),delivery_state=?,error_code=?,delivered_at=?,status_updated_at=?
        WHERE id=?`)
        .run(input.providerMessageId ?? null, reduced.deliveryState, reduced.errorCode ?? null, deliveredAt, receivedAt, input.outboundMessageId);
      const updated = this.getOutboundMessage(input.outboundMessageId);
      if (!updated) throw new Error("OUTBOUND_MESSAGE_NOT_FOUND");
      return { created: inserted.changes === 1, message: updated };
    })();
  }

  listMessages(threadId: string, options: { limit?: number; before?: string } = {}): ThreadMessageRecord[] {
    const limit = Math.max(1, Math.min(500, Math.trunc(options.limit ?? 100)));
    const before = options.before ?? "9999-12-31T23:59:59.999Z";
    const inbound = (this.db.prepare(`SELECT * FROM inbound_messages
      WHERE thread_id=? AND created_at<? ORDER BY created_at DESC,id DESC LIMIT ?`)
      .all(threadId, before, limit) as InboundMessageRow[]).map(inboundMessageFromRow);
    const outbound = (this.db.prepare(`SELECT * FROM outbound_messages
      WHERE thread_id=? AND created_at<? ORDER BY created_at DESC,id DESC LIMIT ?`)
      .all(threadId, before, limit) as OutboundMessageRow[]).map(outboundMessageFromRow);
    return [...inbound, ...outbound]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || (left.direction === right.direction ? left.id.localeCompare(right.id) : left.direction === "INBOUND" ? -1 : 1))
      .slice(-limit);
  }

  getAttentionRequest(id: string): AttentionRequestRecord | null {
    const row = this.db.prepare("SELECT * FROM attention_requests WHERE id=?").get(id) as AttentionRequestRow | undefined;
    return row ? attentionRequestFromRow(row) : null;
  }

  getPendingAttentionRequest(callId: string): AttentionRequestRecord | null {
    const row = this.db.prepare(`SELECT * FROM attention_requests
      WHERE call_id=? AND status='PENDING' ORDER BY blocking DESC,created_at DESC LIMIT 1`)
      .get(callId) as AttentionRequestRow | undefined;
    return row ? attentionRequestFromRow(row) : null;
  }

  createAttentionRequest(input: {
    id: string;
    threadId: string;
    caseId?: string | null;
    callId?: string | null;
    tier: AttentionTier;
    blocking?: boolean;
    question: string;
    choices?: unknown[];
    proposedAction?: unknown | null;
    expiresAt: string;
    now?: string;
  }): { request: AttentionRequestRecord; supersededId: string | null } {
    return this.db.transaction(() => {
      const now = input.now ?? new Date().toISOString();
      const blocking = input.blocking ?? true;
      let supersededId: string | null = null;
      if (blocking) {
        const prior = (input.callId
          ? this.db.prepare("SELECT id FROM attention_requests WHERE call_id=? AND blocking=1 AND status='PENDING' LIMIT 1").get(input.callId)
          : this.db.prepare("SELECT id FROM attention_requests WHERE thread_id=? AND call_id IS NULL AND blocking=1 AND status='PENDING' LIMIT 1").get(input.threadId)) as {id:string} | undefined;
        if (prior) {
          supersededId = prior.id;
          this.db.prepare("UPDATE attention_requests SET status='SUPERSEDED',resolved_at=? WHERE id=? AND status='PENDING'")
            .run(now, prior.id);
          this.db.prepare("UPDATE secure_action_tokens SET revoked_at=?,revoke_reason='ATTENTION_SUPERSEDED' WHERE attention_request_id=? AND revoked_at IS NULL")
            .run(now, prior.id);
        }
      }
      this.db.prepare(`INSERT INTO attention_requests
        (id,thread_id,case_id,call_id,tier,status,blocking,question,choices_json,proposed_action_json,created_at,expires_at)
        VALUES (?,?,?,?,?,'PENDING',?,?,?,?,?,?)`)
        .run(
          input.id,
          input.threadId,
          input.caseId ?? null,
          input.callId ?? null,
          input.tier,
          Number(blocking),
          input.question,
          JSON.stringify(input.choices ?? []),
          input.proposedAction === undefined || input.proposedAction === null ? null : JSON.stringify(input.proposedAction),
          now,
          input.expiresAt,
        );
      if (supersededId) {
        this.db.prepare("UPDATE attention_requests SET superseded_by=? WHERE id=?").run(input.id, supersededId);
      }
      if (blocking) {
        this.db.prepare("UPDATE support_threads SET pending_attention_request_id=?,state='AWAITING_USER_DECISION',updated_at=? WHERE id=?")
          .run(input.id, now, input.threadId);
      }
      const request = this.getAttentionRequest(input.id);
      if (!request) throw new Error("ATTENTION_REQUEST_NOT_CREATED");
      return { request, supersededId };
    })();
  }

  resolveAttentionRequest(input: {
    id: string;
    resolution: unknown;
    expectedCallId?: string | null;
    status?: "RESOLVED" | "CANCELLED";
    now?: string;
  }): AttentionRequestRecord | null {
    return this.db.transaction(() => {
      const now = input.now ?? new Date().toISOString();
      const row = this.db.prepare("SELECT * FROM attention_requests WHERE id=?").get(input.id) as AttentionRequestRow | undefined;
      if (!row || row.status !== "PENDING") return null;
      if (input.expectedCallId !== undefined && row.call_id !== input.expectedCallId) return null;
      if (row.expires_at <= now) {
        this.db.prepare("UPDATE attention_requests SET status='EXPIRED',resolved_at=? WHERE id=? AND status='PENDING'").run(now, row.id);
        this.db.prepare("UPDATE support_threads SET pending_attention_request_id=NULL,updated_at=? WHERE id=? AND pending_attention_request_id=?")
          .run(now, row.thread_id, row.id);
        this.db.prepare("UPDATE secure_action_tokens SET revoked_at=?,revoke_reason='ATTENTION_EXPIRED' WHERE attention_request_id=? AND revoked_at IS NULL")
          .run(now, row.id);
        return null;
      }
      const status = input.status ?? "RESOLVED";
      const changed = this.db.prepare(`UPDATE attention_requests
        SET status=?,resolution_json=?,resolved_at=? WHERE id=? AND status='PENDING'`)
        .run(status, JSON.stringify(input.resolution), now, row.id);
      if (changed.changes !== 1) return null;
      this.db.prepare("UPDATE support_threads SET pending_attention_request_id=NULL,updated_at=? WHERE id=? AND pending_attention_request_id=?")
        .run(now, row.thread_id, row.id);
      this.db.prepare("UPDATE secure_action_tokens SET revoked_at=?,revoke_reason='ATTENTION_RESOLVED' WHERE attention_request_id=? AND revoked_at IS NULL")
        .run(now, row.id);
      return this.getAttentionRequest(row.id);
    })();
  }

  reserveLowConsequenceAttention(input:{id:string;expectedCallId:string;reservationId:string;choiceId:string;shortCode:string;messageId:string;now?:string}):AttentionRequestRecord|null{
    return this.db.transaction(()=>{const now=input.now??new Date().toISOString();const row=this.db.prepare("SELECT * FROM attention_requests WHERE id=? AND call_id=? AND tier='LOW_CONSEQUENCE' AND status='PENDING' AND resolution_json IS NULL AND expires_at>?").get(input.id,input.expectedCallId,now) as AttentionRequestRow|undefined;if(!row)return null;const resolution={executionState:"RESERVED",reservationId:input.reservationId,choiceId:input.choiceId,shortCode:input.shortCode,messageId:input.messageId,channel:"SMS"};const changed=this.db.prepare("UPDATE attention_requests SET resolution_json=? WHERE id=? AND status='PENDING' AND resolution_json IS NULL").run(JSON.stringify(resolution),input.id);return changed.changes===1?this.getAttentionRequest(input.id):null;})();
  }

  finishLowConsequenceAttention(input:{id:string;expectedCallId:string;reservationId:string;resolution:unknown;now?:string}):AttentionRequestRecord|null{
    return this.db.transaction(()=>{const now=input.now??new Date().toISOString();const changed=this.db.prepare("UPDATE attention_requests SET status='RESOLVED',resolution_json=?,resolved_at=? WHERE id=? AND call_id=? AND status='PENDING' AND json_extract(resolution_json,'$.reservationId')=?").run(JSON.stringify(input.resolution),now,input.id,input.expectedCallId,input.reservationId);if(changed.changes!==1)return null;const row=this.db.prepare("SELECT thread_id FROM attention_requests WHERE id=?").get(input.id) as {thread_id:string};this.db.prepare("UPDATE support_threads SET pending_attention_request_id=NULL,updated_at=? WHERE id=? AND pending_attention_request_id=?").run(now,row.thread_id,input.id);return this.getAttentionRequest(input.id);})();
  }

  cancelLowConsequenceAttention(input:{id:string;expectedCallId:string;reservationId:string;reason:string;now?:string}):boolean{
    return this.db.transaction(()=>{const now=input.now??new Date().toISOString();const changed=this.db.prepare("UPDATE attention_requests SET status='CANCELLED',resolution_json=?,resolved_at=? WHERE id=? AND call_id=? AND status='PENDING' AND json_extract(resolution_json,'$.reservationId')=?").run(JSON.stringify({executionState:"FAILED",reason:input.reason}),now,input.id,input.expectedCallId,input.reservationId);if(changed.changes!==1)return false;const row=this.db.prepare("SELECT thread_id FROM attention_requests WHERE id=?").get(input.id) as {thread_id:string};this.db.prepare("UPDATE support_threads SET pending_attention_request_id=NULL,state='FAILED',updated_at=? WHERE id=? AND pending_attention_request_id=?").run(now,row.thread_id,input.id);return true;})();
  }

  /**
   * Atomically reserves the current attention request and its action token.
   * This is the linearization point shared with the timeout worker: once this
   * succeeds, a timeout can no longer win and execute its fallback.
   */
  beginSecureAttentionResolution(input: {
    tokenHash: string;
    actionType: string;
    threadId: string;
    caseId?: string | null;
    callId: string;
    attentionRequestId: string;
    reservationId: string;
    now?: string;
  }): { token: SecureActionTokenRecord; request: AttentionRequestRecord } | null {
    return this.db.transaction(() => {
      const now = input.now ?? new Date().toISOString();
      const token = this.db.prepare(`SELECT * FROM secure_action_tokens
        WHERE token_hash=? AND action_type=? AND thread_id=? AND case_id IS ? AND call_id=? AND attention_request_id=?
          AND expires_at>? AND revoked_at IS NULL AND (single_use=0 OR used_at IS NULL)`)
        .get(input.tokenHash,input.actionType,input.threadId,input.caseId??null,input.callId,input.attentionRequestId,now) as SecureActionTokenRow | undefined;
      const request = this.db.prepare("SELECT * FROM attention_requests WHERE id=? AND thread_id=? AND call_id=? AND status='PENDING' AND resolution_json IS NULL AND expires_at>?")
        .get(input.attentionRequestId,input.threadId,input.callId,now) as AttentionRequestRow | undefined;
      if (!token || !request) return null;
      const reservation = {executionState:"RESERVED",reservationId:input.reservationId,tokenId:token.id,reservedAt:now};
      const reserved = this.db.prepare(`UPDATE attention_requests SET resolution_json=?
        WHERE id=? AND thread_id=? AND call_id=? AND status='PENDING' AND resolution_json IS NULL AND expires_at>?`)
        .run(JSON.stringify(reservation),request.id,input.threadId,input.callId,now);
      if (reserved.changes !== 1) return null;
      const consumed = this.db.prepare(`UPDATE secure_action_tokens SET used_at=?
        WHERE id=? AND revoked_at IS NULL AND expires_at>? AND (single_use=0 OR used_at IS NULL)`)
        .run(now,token.id,now);
      if (consumed.changes !== 1) throw new Error("ACTION_TOKEN_RESERVATION_FAILED");
      return {token:secureActionTokenFromRow({...token,used_at:now}),request:attentionRequestFromRow({...request,resolution_json:JSON.stringify(reservation)})};
    })();
  }

  finishSecureAttentionResolution(input: {id:string;threadId:string;callId:string;reservationId:string;resolution:unknown;now?:string}): AttentionRequestRecord | null {
    return this.db.transaction(() => {
      const now=input.now??new Date().toISOString();
      const changed=this.db.prepare(`UPDATE attention_requests SET status='RESOLVED',resolution_json=?,resolved_at=?
        WHERE id=? AND thread_id=? AND call_id=? AND status='PENDING' AND json_extract(resolution_json,'$.reservationId')=?`)
        .run(JSON.stringify(input.resolution),now,input.id,input.threadId,input.callId,input.reservationId);
      if(changed.changes!==1)return null;
      this.db.prepare("UPDATE support_threads SET pending_attention_request_id=NULL,updated_at=? WHERE id=? AND pending_attention_request_id=?").run(now,input.threadId,input.id);
      this.db.prepare("UPDATE secure_action_tokens SET revoked_at=?,revoke_reason='ATTENTION_RESOLVED' WHERE attention_request_id=? AND revoked_at IS NULL").run(now,input.id);
      return this.getAttentionRequest(input.id);
    })();
  }

  cancelSecureAttentionResolution(input:{id:string;threadId:string;callId:string;reservationId:string;reason:string;now?:string}):boolean{
    return this.db.transaction(()=>{const now=input.now??new Date().toISOString();const changed=this.db.prepare(`UPDATE attention_requests SET status='CANCELLED',resolution_json=?,resolved_at=?
      WHERE id=? AND thread_id=? AND call_id=? AND status='PENDING' AND json_extract(resolution_json,'$.reservationId')=?`).run(JSON.stringify({executionState:"FAILED",reason:input.reason}),now,input.id,input.threadId,input.callId,input.reservationId);if(changed.changes!==1)return false;this.db.prepare("UPDATE support_threads SET pending_attention_request_id=NULL,updated_at=? WHERE id=? AND pending_attention_request_id=?").run(now,input.threadId,input.id);this.db.prepare("UPDATE secure_action_tokens SET revoked_at=?,revoke_reason='ATTENTION_EXECUTION_FAILED' WHERE attention_request_id=? AND revoked_at IS NULL").run(now,input.id);return true;})();
  }

  expireAttentionRequests(now = new Date().toISOString()): number {
    return this.db.transaction(() => {
      const rows = this.db.prepare("SELECT id,thread_id FROM attention_requests WHERE status='PENDING' AND resolution_json IS NULL AND expires_at<=?")
        .all(now) as Array<{id:string;thread_id:string}>;
      const expire = this.db.prepare("UPDATE attention_requests SET status='EXPIRED',resolved_at=? WHERE id=? AND status='PENDING' AND resolution_json IS NULL");
      const clear = this.db.prepare("UPDATE support_threads SET pending_attention_request_id=NULL,updated_at=? WHERE id=? AND pending_attention_request_id=?");
      const revoke = this.db.prepare("UPDATE secure_action_tokens SET revoked_at=?,revoke_reason='ATTENTION_EXPIRED' WHERE attention_request_id=? AND revoked_at IS NULL");
      let count = 0;
      for (const row of rows) {
        count += expire.run(now, row.id).changes;
        clear.run(now, row.thread_id, row.id);
        revoke.run(now, row.id);
      }
      return count;
    })();
  }

  createSecureActionToken(input: {
    id: string;
    tokenHash: string;
    actionType: string;
    threadId: string;
    caseId?: string | null;
    callId?: string | null;
    attentionRequestId?: string | null;
    singleUse?: boolean;
    expiresAt: string;
    now?: string;
  }): SecureActionTokenRecord {
    const now = input.now ?? new Date().toISOString();
    this.db.prepare(`INSERT INTO secure_action_tokens
      (id,token_hash,action_type,thread_id,case_id,call_id,attention_request_id,single_use,created_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(
        input.id,
        input.tokenHash,
        input.actionType,
        input.threadId,
        input.caseId ?? null,
        input.callId ?? null,
        input.attentionRequestId ?? null,
        Number(input.singleUse ?? true),
        now,
        input.expiresAt,
      );
    const row = this.db.prepare("SELECT * FROM secure_action_tokens WHERE id=?").get(input.id) as SecureActionTokenRow;
    return secureActionTokenFromRow(row);
  }

  getSecureActionToken(tokenHash: string): SecureActionTokenRecord | null {
    const row = this.db.prepare("SELECT * FROM secure_action_tokens WHERE token_hash=?").get(tokenHash) as SecureActionTokenRow | undefined;
    return row ? secureActionTokenFromRow(row) : null;
  }

  consumeSecureActionToken(input: {
    tokenHash: string;
    actionType: string;
    threadId: string;
    caseId?: string | null;
    callId?: string | null;
    attentionRequestId?: string | null;
    now?: string;
  }): SecureActionTokenRecord | null {
    return this.db.transaction(() => {
      const now = input.now ?? new Date().toISOString();
      const row = this.db.prepare(`SELECT * FROM secure_action_tokens
        WHERE token_hash=? AND action_type=? AND thread_id=? AND case_id IS ? AND call_id IS ? AND attention_request_id IS ?
          AND expires_at>? AND revoked_at IS NULL AND (single_use=0 OR used_at IS NULL)`)
        .get(
          input.tokenHash,
          input.actionType,
          input.threadId,
          input.caseId ?? null,
          input.callId ?? null,
          input.attentionRequestId ?? null,
          now,
        ) as SecureActionTokenRow | undefined;
      if (!row) return null;
      const changed = this.db.prepare(`UPDATE secure_action_tokens SET used_at=?
        WHERE id=? AND revoked_at IS NULL AND expires_at>? AND (single_use=0 OR used_at IS NULL)`)
        .run(now, row.id, now);
      if (changed.changes !== 1) return null;
      return secureActionTokenFromRow({ ...row, used_at: now });
    })();
  }

  revokeSecureActionTokens(input: {
    tokenHash?: string;
    threadId?: string;
    caseId?: string;
    callId?: string;
    attentionRequestId?: string;
    reason: string;
    now?: string;
  }): number {
    const scope = [input.tokenHash, input.threadId, input.caseId, input.callId, input.attentionRequestId];
    if (scope.every((value) => value === undefined)) throw new Error("TOKEN_SCOPE_REQUIRED");
    const clauses = ["revoked_at IS NULL"];
    const values: unknown[] = [input.now ?? new Date().toISOString(), input.reason];
    const add = (column: string, value: string | undefined): void => { if (value !== undefined) { clauses.push(`${column}=?`); values.push(value); } };
    add("token_hash", input.tokenHash);
    add("thread_id", input.threadId);
    add("case_id", input.caseId);
    add("call_id", input.callId);
    add("attention_request_id", input.attentionRequestId);
    return this.db.prepare(`UPDATE secure_action_tokens SET revoked_at=?,revoke_reason=? WHERE ${clauses.join(" AND ")}`).run(...values).changes;
  }

  createCommitment(input: {
    id: string;
    threadId: string;
    caseId: string;
    callId?: string | null;
    party: CommitmentParty;
    status: CommitmentStatus;
    description: string;
    amountCents?: number | null;
    deadline?: string | null;
    recurring?: boolean | null;
    evidence: EvidenceReferenceRecord[];
    now?: string;
  }): CommitmentRecord {
    if (input.evidence.length === 0 || input.evidence.some((item) => item.turnId.trim() === "" || item.exactQuote.trim() === "")) {
      throw new Error("COMMITMENT_EVIDENCE_REQUIRED");
    }
    const now = input.now ?? new Date().toISOString();
    this.db.prepare(`INSERT INTO commitments
      (id,thread_id,case_id,call_id,party,status,description,amount_cents,deadline,recurring,evidence_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        input.id,
        input.threadId,
        input.caseId,
        input.callId ?? null,
        input.party,
        input.status,
        input.description.trim(),
        input.amountCents ?? null,
        input.deadline ?? null,
        input.recurring === undefined || input.recurring === null ? null : Number(input.recurring),
        JSON.stringify(input.evidence),
        now,
        now,
      );
    const row = this.db.prepare("SELECT * FROM commitments WHERE id=?").get(input.id) as CommitmentRow;
    return commitmentFromRow(row);
  }

  listCommitments(input: { threadId?: string; caseId?: string; callId?: string } = {}): CommitmentRecord[] {
    const clauses: string[] = [];
    const values: string[] = [];
    if (input.threadId) { clauses.push("thread_id=?"); values.push(input.threadId); }
    if (input.caseId) { clauses.push("case_id=?"); values.push(input.caseId); }
    if (input.callId) { clauses.push("call_id=?"); values.push(input.callId); }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return (this.db.prepare(`SELECT * FROM commitments ${where} ORDER BY created_at,id`).all(...values) as CommitmentRow[])
      .map(commitmentFromRow);
  }

  transitionCommitment(input: {
    id: string;
    from: CommitmentStatus;
    to: CommitmentStatus;
    evidence?: EvidenceReferenceRecord[];
    now?: string;
  }): boolean {
    if (input.evidence && (input.evidence.length === 0 || input.evidence.some((item) => item.turnId.trim() === "" || item.exactQuote.trim() === ""))) {
      throw new Error("COMMITMENT_EVIDENCE_REQUIRED");
    }
    const now = input.now ?? new Date().toISOString();
    const result = input.evidence
      ? this.db.prepare("UPDATE commitments SET status=?,evidence_json=?,updated_at=? WHERE id=? AND status=?")
        .run(input.to, JSON.stringify(input.evidence), now, input.id, input.from)
      : this.db.prepare("UPDATE commitments SET status=?,updated_at=? WHERE id=? AND status=?")
        .run(input.to, now, input.id, input.from);
    return result.changes === 1;
  }

  insertSemanticCallEvent(input: {
    id: string;
    threadId: string;
    caseId: string;
    callId: string;
    eventType: string;
    semanticKey: string;
    payload: unknown;
    occurredAt: string;
    createdAt?: string;
  }): { created: boolean; event: SemanticCallEventRecord } {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const result = this.db.prepare(`INSERT OR IGNORE INTO semantic_call_events
      (id,thread_id,case_id,call_id,event_type,semantic_key,payload_json,occurred_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(
        input.id,
        input.threadId,
        input.caseId,
        input.callId,
        input.eventType,
        input.semanticKey,
        JSON.stringify(input.payload),
        input.occurredAt,
        createdAt,
      );
    const row = this.db.prepare("SELECT * FROM semantic_call_events WHERE call_id=? AND semantic_key=?")
      .get(input.callId, input.semanticKey) as SemanticCallEventRow | undefined;
    if (!row) throw new Error("SEMANTIC_EVENT_IDEMPOTENCY_CONFLICT");
    return { created: result.changes === 1, event: semanticCallEventFromRow(row) };
  }

  getSemanticCallEvent(callId: string, semanticKey: string): SemanticCallEventRecord | null {
    const row = this.db.prepare("SELECT * FROM semantic_call_events WHERE call_id=? AND semantic_key=?").get(callId, semanticKey) as SemanticCallEventRow | undefined;
    return row ? semanticCallEventFromRow(row) : null;
  }

  listSemanticCallEvents(callId: string): SemanticCallEventRecord[] {
    return (this.db.prepare("SELECT * FROM semantic_call_events WHERE call_id=? ORDER BY occurred_at,id").all(callId) as SemanticCallEventRow[])
      .map(semanticCallEventFromRow);
  }

  createConditionalAuthorityRule(input: {
    id: string;
    threadId: string;
    caseId?: string | null;
    actionType: string;
    condition: unknown;
    permission: "ALLOW" | "ASK" | "DENY";
    priority?: number;
    active?: boolean;
    now?: string;
  }): ConditionalAuthorityRuleRecord {
    const now = input.now ?? new Date().toISOString();
    this.db.prepare(`INSERT INTO conditional_authority_rules
      (id,thread_id,case_id,action_type,condition_json,permission,priority,active,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(
        input.id,
        input.threadId,
        input.caseId ?? null,
        input.actionType,
        JSON.stringify(input.condition),
        input.permission,
        input.priority ?? 0,
        Number(input.active ?? true),
        now,
        now,
      );
    const row = this.db.prepare("SELECT * FROM conditional_authority_rules WHERE id=?").get(input.id) as ConditionalAuthorityRuleRow;
    return conditionalAuthorityRuleFromRow(row);
  }

  listConditionalAuthorityRules(threadId: string, caseId?: string | null): ConditionalAuthorityRuleRecord[] {
    const rows = caseId === undefined
      ? this.db.prepare("SELECT * FROM conditional_authority_rules WHERE thread_id=? AND active=1 ORDER BY priority DESC,created_at,id").all(threadId)
      : this.db.prepare("SELECT * FROM conditional_authority_rules WHERE thread_id=? AND active=1 AND (case_id IS NULL OR case_id IS ?) ORDER BY priority DESC,created_at,id").all(threadId, caseId);
    return (rows as ConditionalAuthorityRuleRow[]).map(conditionalAuthorityRuleFromRow);
  }

  deactivateConditionalAuthorityRule(id: string, now = new Date().toISOString()): boolean {
    return this.db.prepare("UPDATE conditional_authority_rules SET active=0,updated_at=? WHERE id=? AND active=1").run(now, id).changes === 1;
  }

  listDeadLetterWork(limit = 100): MessagingWorkItemRecord[] {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    return (this.db.prepare("SELECT * FROM messaging_work_items WHERE state='DEAD_LETTER' ORDER BY updated_at DESC,id DESC LIMIT ?").all(safeLimit) as WorkItemRow[])
      .map(workItemFromRow);
  }

  listFailedOutboundMessages(limit = 100): OutboundMessageRecord[] {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    return (this.db.prepare("SELECT * FROM outbound_messages WHERE processing_state='DEAD_LETTER' OR delivery_state IN ('FAILED','UNDELIVERED') ORDER BY status_updated_at DESC,id DESC LIMIT ?").all(safeLimit) as OutboundMessageRow[])
      .map(outboundMessageFromRow);
  }

  createCall(call: { id: string; caseId: string; mode: "SIMULATOR"|"TWILIO"; scenarioId: string|null; state: CallState; activity: string; objective: string; authorizationId?: string }): void {
    this.db.transaction(() => {
      if (call.mode === "TWILIO" && !call.authorizationId) throw new Error("CALL_AUTHORIZATION_REQUIRED");
      if (call.authorizationId) {
        const authorization = this.db.prepare(`SELECT id FROM call_authorizations
          WHERE id=? AND case_id=? AND consumed_at IS NOT NULL AND revoked_at IS NULL AND telephony_mode IS ?
            AND destination_e164 IS (SELECT json_extract(brief_json,'$.phoneNumberE164') FROM cases WHERE id=?)
            AND plan_version IS (SELECT approved_version FROM cases WHERE id=?)
            AND plan_version IS (SELECT json_extract(brief_json,'$.version') FROM cases WHERE id=?)`).get(call.authorizationId, call.caseId, call.mode.toLowerCase(), call.caseId,call.caseId,call.caseId) as {id:string}|undefined;
        if (!authorization) throw new Error("CONSUMED_CALL_AUTHORIZATION_REQUIRED");
      }
      this.db.prepare("INSERT INTO calls (id,case_id,mode,scenario_id,state,activity,objective,authorization_id,started_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(call.id, call.caseId, call.mode, call.scenarioId, call.state, call.activity, call.objective, call.authorizationId ?? null, new Date().toISOString());
      this.db.prepare("UPDATE cases SET status='IN_CALL', updated_at=? WHERE id=?").run(new Date().toISOString(), call.caseId);
    })();
  }
  getCall(id: string): CallRow | null { return (this.db.prepare("SELECT * FROM calls WHERE id=?").get(id) as CallRow | undefined) ?? null; }
  getActiveCall(): CallRow | null { return (this.db.prepare("SELECT * FROM calls WHERE state NOT IN ('COMPLETED','FAILED') ORDER BY started_at DESC LIMIT 1").get() as CallRow | undefined) ?? null; }
  adoptTwilioCallSidForAmbiguousStart(id:string,providerCallSid:string):boolean {
    if(!providerCallSid)return false;
    const result=this.db.prepare(`UPDATE calls SET twilio_call_sid=?
      WHERE id=? AND mode='TWILIO' AND twilio_call_sid IS NULL
        AND (state='DIALING' OR (state='ENDING' AND terminal_reason LIKE 'AMBIGUOUS_START:%'))
        AND NOT EXISTS (SELECT 1 FROM calls existing WHERE existing.twilio_call_sid=?)`)
      .run(providerCallSid,id,providerCallSid);
    return result.changes===1;
  }
  updateCall(id: string, fields: Partial<{ state: CallState; activity: string; objective: string; paused: boolean; humanDetected: boolean; disclosureDelivered: boolean; consentStatus: CallRow["consent_status"]; generation: number; twilioCallSid: string; endedAt: string; durationSeconds: number; estimatedCostUsd: number; terminalReason: string }>): void {
    const mapping: Record<string,string> = { state:"state", activity:"activity", objective:"objective", paused:"paused", humanDetected:"human_detected", disclosureDelivered:"disclosure_delivered", consentStatus:"consent_status", generation:"generation", twilioCallSid:"twilio_call_sid", endedAt:"ended_at", durationSeconds:"duration_seconds", estimatedCostUsd:"estimated_cost_usd", terminalReason:"terminal_reason" };
    const entries = Object.entries(fields).filter(([,v]) => v !== undefined);
    if (!entries.length) return;
    const values = entries.map(([,v]) => typeof v === "boolean" ? Number(v) : v);
    this.db.prepare(`UPDATE calls SET ${entries.map(([k]) => `${mapping[k]}=?`).join(",")} WHERE id=?`).run(...values, id);
  }
  addModelUsage(callId:string,inputTokens:number,outputTokens:number):void { this.db.prepare("UPDATE calls SET llm_input_tokens=llm_input_tokens+?, llm_output_tokens=llm_output_tokens+? WHERE id=?").run(inputTokens,outputTokens,callId); }
  appendEvent(input: { id: string; callId?: string; caseId?: string; type: EventType; payload: unknown; origin: string; idempotencyKey?: string }): number {
    const sequence = Number((this.db.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS n FROM events WHERE call_id IS ? AND case_id IS ?").get(input.callId ?? null, input.caseId ?? null) as {n:number}).n);
    this.db.prepare("INSERT OR IGNORE INTO events (id,call_id,case_id,sequence,timestamp,type,payload_json,origin,idempotency_key) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(input.id, input.callId ?? null, input.caseId ?? null, sequence, new Date().toISOString(), input.type, JSON.stringify(input.payload), input.origin, input.idempotencyKey ?? null);
    return sequence;
  }
  addTranscript(callId: string, turn: TranscriptTurn): void { this.db.prepare("INSERT INTO transcript_turns (id,call_id,sequence,speaker,text,timestamp) VALUES (?,?,?,?,?,?)").run(turn.id, callId, turn.sequence, turn.speaker, turn.text, turn.timestamp); }
  getTranscript(callId: string): TranscriptTurn[] { return (this.db.prepare("SELECT id,sequence,speaker,text,timestamp FROM transcript_turns WHERE call_id=? ORDER BY sequence").all(callId) as TranscriptTurn[]); }
  saveApproval(approval: ApprovalRequest): void { this.db.prepare("INSERT INTO approval_requests (id,call_id,status,data_json,created_at,expires_at) VALUES (?,?,?,?,?,?)").run(approval.id, approval.callId, approval.status, JSON.stringify(approval), approval.createdAt, approval.expiresAt); }
  getPendingApproval(callId: string): ApprovalRequest | null { const r=this.db.prepare("SELECT data_json,status FROM approval_requests WHERE call_id=? AND status='PENDING' ORDER BY created_at DESC LIMIT 1").get(callId) as {data_json:string;status:string}|undefined; return r ? { ...(JSON.parse(r.data_json) as ApprovalRequest), status: r.status as ApprovalRequest["status"] } : null; }
  updateApproval(id: string, from: string, to: string): boolean { const result=this.db.prepare("UPDATE approval_requests SET status=?, data_json=json_set(data_json,'$.status',?) WHERE id=? AND status=?").run(to,to,id,from); return result.changes===1; }
  getApproval(id:string):ApprovalRequest|null { const r=this.db.prepare("SELECT data_json,status FROM approval_requests WHERE id=?").get(id) as {data_json:string;status:string}|undefined;return r?{...(JSON.parse(r.data_json) as ApprovalRequest),status:r.status as ApprovalRequest["status"]}:null; }
  getApprovalExecution(approvalId:string):ApprovalExecutionRecord|null { const row=this.db.prepare("SELECT * FROM approval_executions WHERE approval_id=?").get(approvalId) as ApprovalExecutionRow|undefined;return row?approvalExecutionFromRow(row):null; }
  reserveApprovalExecution(input:{approvalId:string;callId:string;decision:"APPROVE"|"REJECT";payloadFingerprint:string;targetStatus:"APPROVED"|"REJECTED"|"REPLACED";executionId:string;now?:string}):{kind:"RESERVED"|"EXISTING";execution:ApprovalExecutionRecord} {
    return this.db.transaction(():{kind:"RESERVED"|"EXISTING";execution:ApprovalExecutionRecord}=>{const now=input.now??new Date().toISOString();const existing=this.getApprovalExecution(input.approvalId);if(existing)return{kind:"EXISTING",execution:existing};const approval=this.db.prepare("SELECT status,call_id FROM approval_requests WHERE id=?").get(input.approvalId) as {status:string;call_id:string}|undefined;if(!approval||approval.call_id!==input.callId||approval.status!=="PENDING")throw new Error("APPROVAL_NOT_PENDING");this.db.prepare("INSERT INTO approval_executions (approval_id,call_id,decision,payload_fingerprint,target_status,execution_id,state,reserved_at) VALUES (?,?,?,?,?,?,'RESERVED',?)").run(input.approvalId,input.callId,input.decision,input.payloadFingerprint,input.targetStatus,input.executionId,now);return{kind:"RESERVED",execution:this.getApprovalExecution(input.approvalId)!};})();
  }
  completeApprovalExecution(input:{approvalId:string;executionId:string;targetStatus:"APPROVED"|"REJECTED"|"REPLACED";now?:string}):boolean { return this.db.transaction(()=>{const now=input.now??new Date().toISOString();const execution=this.db.prepare("UPDATE approval_executions SET state='SUCCEEDED',completed_at=?,error_code=NULL WHERE approval_id=? AND execution_id=? AND state='RESERVED'").run(now,input.approvalId,input.executionId);if(execution.changes!==1)return false;const approval=this.db.prepare("UPDATE approval_requests SET status=?,data_json=json_set(data_json,'$.status',?) WHERE id=? AND status='PENDING'").run(input.targetStatus,input.targetStatus,input.approvalId);if(approval.changes!==1)throw new Error("APPROVAL_FINALIZATION_FAILED");return true;})(); }
  failApprovalExecution(input:{approvalId:string;executionId:string;errorCode:string;now?:string}):boolean { return this.db.transaction(()=>{const now=input.now??new Date().toISOString();const execution=this.db.prepare("UPDATE approval_executions SET state='FAILED',completed_at=?,error_code=? WHERE approval_id=? AND execution_id=? AND state='RESERVED'").run(now,input.errorCode,input.approvalId,input.executionId);if(execution.changes!==1)return false;const approval=this.db.prepare("UPDATE approval_requests SET status='EXECUTION_FAILED',data_json=json_set(data_json,'$.status','EXECUTION_FAILED') WHERE id=? AND status='PENDING'").run(input.approvalId);if(approval.changes!==1)throw new Error("APPROVAL_FAILURE_FINALIZATION_FAILED");return true;})(); }
  saveOutcome(callId: string, report: OutcomeReport, now = new Date().toISOString()): boolean { return this.db.prepare("INSERT OR IGNORE INTO outcome_reports (call_id,report_json,created_at) VALUES (?,?,?)").run(callId,JSON.stringify(report),now).changes===1; }
  replaceOutcome(callId: string, report: OutcomeReport): boolean { return this.db.prepare("UPDATE outcome_reports SET report_json=? WHERE call_id=?").run(JSON.stringify(report),callId).changes===1; }
  getOutcome(callId: string): OutcomeReport | null { const r=this.db.prepare("SELECT report_json FROM outcome_reports WHERE call_id=?").get(callId) as {report_json:string}|undefined; return r ? JSON.parse(r.report_json) as OutcomeReport : null; }
  listTerminalCallsWithoutOutcome(): CallRow[] { return this.db.prepare(`SELECT calls.* FROM calls LEFT JOIN outcome_reports ON outcome_reports.call_id=calls.id WHERE calls.state IN ('COMPLETED','FAILED') AND outcome_reports.call_id IS NULL ORDER BY calls.ended_at,calls.id`).all() as CallRow[]; }
  listEvents(callId: string, after=0): Array<{ sequence:number; type:string; payload:unknown; timestamp:string }> { return (this.db.prepare("SELECT sequence,type,payload_json,timestamp FROM events WHERE call_id=? AND sequence>? ORDER BY sequence").all(callId,after) as Array<{sequence:number;type:string;payload_json:string;timestamp:string}>).map((r)=>({sequence:r.sequence,type:r.type,payload:JSON.parse(r.payload_json) as unknown,timestamp:r.timestamp})); }
  incrementDailyUsage(day: string, limit: number): boolean { const tx=this.db.transaction(()=>{ const row=this.db.prepare("SELECT count FROM daily_call_usage WHERE day=?").get(day) as {count:number}|undefined; if ((row?.count??0)>=limit) return false; this.db.prepare("INSERT INTO daily_call_usage(day,count) VALUES (?,1) ON CONFLICT(day) DO UPDATE SET count=count+1").run(day); return true; }); return tx(); }
  deleteExpired(retentionDays: number): number {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
    return this.db.transaction(() => {
      const expired = this.db.prepare(`SELECT id FROM cases
      WHERE updated_at < ?
        AND status IN ('COMPLETED','FAILED','CANCELLED')
        AND NOT EXISTS (
          SELECT 1 FROM calls WHERE calls.case_id=cases.id AND calls.state NOT IN ('COMPLETED','FAILED')
        )
        AND NOT EXISTS (
          SELECT 1 FROM support_threads
          WHERE support_threads.current_case_id=cases.id
            AND support_threads.is_active=1
            AND support_threads.state NOT IN ('COMPLETED','FAILED','CANCELLED')
        )`).all(cutoff) as Array<{id:string}>;
      for (const item of expired) this.deleteCase(item.id);
      return expired.length;
    })();
  }
}

export type StoredCall = NonNullable<ReturnType<LiaisonDatabase["getCall"]>>;
