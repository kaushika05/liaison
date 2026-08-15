/**
 * Storage record shapes and row mappers.
 *
 * Split from db.ts so the query layer contains queries and this file contains the
 * translation between SQLite rows and the record types the application consumes.
 * Row interfaces mirror column names exactly; record interfaces are camelCase.
 */
import type { CallState } from "../../shared/domain.js";

export interface CallRow {
  id: string;
  case_id: string;
  mode: "SIMULATOR" | "TWILIO";
  scenario_id: string | null;
  state: CallState;
  activity: string;
  objective: string;
  paused: number;
  human_detected: number;
  disclosure_delivered: number;
  consent_status: "UNKNOWN" | "ACCEPTED" | "REFUSED" | "AMBIGUOUS";
  generation: number;
  twilio_call_sid: string | null;
  authorization_id: string | null;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number;
  estimated_cost_usd: number;
  llm_input_tokens: number;
  llm_output_tokens: number;
  terminal_reason: string | null;
}
export interface CaseRow {
  id: string;
  company_name: string;
  title: string;
  status: string;
  intake_json: string;
  brief_json: string | null;
  disclosure_metadata_json: string;
  approved_version: number | null;
  created_at: string;
  updated_at: string;
}

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
export type MessageDeliveryState =
  | "RECEIVED"
  | "PENDING"
  | "QUEUED"
  | "SENT"
  | "DELIVERED"
  | "UNDELIVERED"
  | "FAILED"
  | "UNKNOWN";
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

export interface InboundMessageRecord
  extends Omit<
    InboundMessageInput,
    "providerMessageId" | "caseId" | "callId" | "attentionRequestId" | "createdAt" | "errorCode"
  > {
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

export interface OutboundMessageRecord
  extends Omit<
    OutboundMessageInput,
    "providerMessageId" | "caseId" | "callId" | "attentionRequestId" | "createdAt" | "errorCode" | "nextEligibleAt"
  > {
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

export type DeliveryStatusReducer = (
  events: readonly MessageDeliveryEventRecord[],
  current: OutboundMessageRecord,
) => DeliveryReduction;

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

export interface EvidenceReferenceRecord {
  turnId: string;
  exactQuote: string;
}

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

export interface SupportThreadRow {
  id: string;
  principal_id: string;
  state: SupportThreadState;
  autonomy_mode: AutonomyMode;
  current_case_id: string | null;
  approved_plan_version: number | null;
  active_call_id: string | null;
  pending_attention_request_id: string | null;
  messaging_opt_state: MessagingOptState;
  draft_json: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}
export interface InboundMessageRow {
  id: string;
  thread_id: string;
  provider_kind: MessagingProviderKind;
  provider_message_id: string | null;
  direction: "INBOUND";
  redacted_body: string;
  sender: string;
  recipient: string;
  case_id: string | null;
  call_id: string | null;
  attention_request_id: string | null;
  created_at: string;
  processing_state: MessageProcessingState;
  delivery_state: MessageDeliveryState;
  status_updated_at: string;
  processed_at: string | null;
  segment_estimate: number;
  error_code: string | null;
  idempotency_key: string;
}
export interface OutboundMessageRow {
  id: string;
  thread_id: string;
  provider_kind: MessagingProviderKind;
  provider_message_id: string | null;
  direction: "OUTBOUND";
  redacted_body: string;
  sender: string;
  recipient: string;
  case_id: string | null;
  call_id: string | null;
  attention_request_id: string | null;
  created_at: string;
  processing_state: MessageProcessingState;
  delivery_state: MessageDeliveryState;
  status_updated_at: string;
  processed_at: string | null;
  delivered_at: string | null;
  segment_estimate: number;
  error_code: string | null;
  idempotency_key: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  attempt_count: number;
  last_error: string | null;
  next_eligible_at: string;
}
export interface WorkItemRow {
  id: string;
  kind: string;
  inbound_message_id: string | null;
  outbound_message_id: string | null;
  payload_json: string;
  state: WorkState;
  lease_owner: string | null;
  lease_expires_at: string | null;
  attempt_count: number;
  last_error: string | null;
  next_eligible_at: string;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}
export interface DeliveryEventRow {
  id: string;
  outbound_message_id: string;
  provider_message_id: string | null;
  provider_status: string;
  error_code: string | null;
  occurred_at: string;
  received_at: string;
  event_key: string;
}
export interface AttentionRequestRow {
  id: string;
  thread_id: string;
  case_id: string | null;
  call_id: string | null;
  tier: AttentionTier;
  status: AttentionStatus;
  blocking: number;
  question: string;
  choices_json: string;
  proposed_action_json: string | null;
  resolution_json: string | null;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
  superseded_by: string | null;
}
export interface SecureActionTokenRow {
  id: string;
  token_hash: string;
  action_type: string;
  thread_id: string;
  case_id: string | null;
  call_id: string | null;
  attention_request_id: string | null;
  single_use: number;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
}
export interface CallAuthorizationRow {
  id: string;
  thread_id: string;
  case_id: string;
  plan_version: number;
  destination_e164: string | null;
  telephony_mode: "simulator" | "twilio" | null;
  code_hash: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
}
export interface ProviderSecurityEventRow {
  id: string;
  provider_kind: MessagingProviderKind;
  provider_message_id: string;
  event_type: string;
  reason_code: string;
  thread_id: string | null;
  case_id: string | null;
  call_id: string | null;
  redacted_metadata_json: string;
  created_at: string;
}
export interface CommitmentRow {
  id: string;
  thread_id: string;
  case_id: string;
  call_id: string | null;
  party: CommitmentParty;
  status: CommitmentStatus;
  description: string;
  amount_cents: number | null;
  deadline: string | null;
  recurring: number | null;
  evidence_json: string;
  created_at: string;
  updated_at: string;
}
export interface SemanticCallEventRow {
  id: string;
  thread_id: string;
  case_id: string;
  call_id: string;
  event_type: string;
  semantic_key: string;
  payload_json: string;
  occurred_at: string;
  created_at: string;
}
export interface ConditionalAuthorityRuleRow {
  id: string;
  thread_id: string;
  case_id: string | null;
  action_type: string;
  condition_json: string;
  permission: "ALLOW" | "ASK" | "DENY";
  priority: number;
  active: number;
  created_at: string;
  updated_at: string;
}
export interface ApprovalExecutionRow {
  approval_id: string;
  call_id: string;
  decision: "APPROVE" | "REJECT";
  payload_fingerprint: string;
  target_status: "APPROVED" | "REJECTED" | "REPLACED";
  execution_id: string;
  state: ApprovalExecutionState;
  reserved_at: string;
  completed_at: string | null;
  error_code: string | null;
}

export const parseJson = (value: string): unknown => JSON.parse(value) as unknown;
export const leaseExpiry = (now: string, leaseSeconds: number): string => {
  if (!Number.isInteger(leaseSeconds) || leaseSeconds <= 0) throw new Error("INVALID_LEASE_SECONDS");
  const milliseconds = Date.parse(now);
  if (!Number.isFinite(milliseconds)) throw new Error("INVALID_LEASE_TIME");
  return new Date(milliseconds + leaseSeconds * 1_000).toISOString();
};
export const supportThreadFromRow = (row: SupportThreadRow): SupportThreadRecord => ({
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
export const inboundMessageFromRow = (row: InboundMessageRow): InboundMessageRecord => ({
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
export const outboundMessageFromRow = (row: OutboundMessageRow): OutboundMessageRecord => ({
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
export const workItemFromRow = (row: WorkItemRow): MessagingWorkItemRecord => ({
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
export const deliveryEventFromRow = (row: DeliveryEventRow): MessageDeliveryEventRecord => ({
  id: row.id,
  outboundMessageId: row.outbound_message_id,
  providerMessageId: row.provider_message_id,
  providerStatus: row.provider_status,
  errorCode: row.error_code,
  occurredAt: row.occurred_at,
  receivedAt: row.received_at,
  eventKey: row.event_key,
});
export const attentionRequestFromRow = (row: AttentionRequestRow): AttentionRequestRecord => ({
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
export const secureActionTokenFromRow = (row: SecureActionTokenRow): SecureActionTokenRecord => ({
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
export const callAuthorizationFromRow = (row: CallAuthorizationRow): CallAuthorizationRecord => ({
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
export const providerSecurityEventFromRow = (row: ProviderSecurityEventRow): ProviderSecurityEventRecord => ({
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
export const commitmentFromRow = (row: CommitmentRow): CommitmentRecord => ({
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
export const semanticCallEventFromRow = (row: SemanticCallEventRow): SemanticCallEventRecord => ({
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
export const conditionalAuthorityRuleFromRow = (row: ConditionalAuthorityRuleRow): ConditionalAuthorityRuleRecord => ({
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
export const approvalExecutionFromRow = (row: ApprovalExecutionRow): ApprovalExecutionRecord => ({
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
