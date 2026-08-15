import type { CaseDetail } from "../../shared/api.js";
import type {
  AttentionRequestRecord,
  CommitmentRecord,
  ConditionalAuthorityRuleRecord,
  SupportThreadRecord,
} from "../database/db.js";
import {
  attentionRequestSchema,
  commitmentSchema,
  disclosureEventSchema,
  executionPlanFromCallBrief,
  type AttentionRequest,
  type AttentionStatus,
  type Commitment,
  type DisclosureEvent,
  type ExecutionPlan,
} from "../../shared/protocol.js";
import { canonicalRuntimeRules } from "../core/runtime-authority.js";

/**
 * Projects internal runtime records onto Liaison Universal Support Protocol documents.
 *
 * Every function here ends in a `schema.parse(...)`, so an invalid projection throws rather than
 * shipping a malformed document. That is the point of the module: the protocol types are the
 * published contract, and this is the single boundary where the implementation commits to them.
 * Internal storage stays free to evolve as long as it can still be projected.
 */

/** Stable across regeneration so a consumer can correlate a plan document with a plan version. */
export function executionPlanId(caseId: string, planVersion: number): string {
  return `plan-${caseId}-v${planVersion}`.slice(0, 120);
}

function planObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function projectExecutionPlan(input: {
  caseItem: CaseDetail;
  thread: SupportThreadRecord | null;
  conditionalAuthorityRules: readonly ConditionalAuthorityRuleRecord[];
}): ExecutionPlan | null {
  const brief = input.caseItem.brief;
  if (!brief) return null;
  const approved = input.caseItem.approvedVersion === brief.version;
  return executionPlanFromCallBrief(brief, {
    planId: executionPlanId(input.caseItem.id, brief.version),
    autonomyMode: input.thread?.autonomyMode ?? "COPILOT",
    // Only rules bound to this exact plan version are part of the plan. Stale rows are dropped by
    // `canonicalRuntimeRules` rather than published as if they were in force.
    conditionalAuthorityRules: canonicalRuntimeRules(input.conditionalAuthorityRules, brief.version),
    createdAt: input.caseItem.createdAt,
    ...(approved ? { approvedAt: input.caseItem.updatedAt } : {}),
  });
}

/**
 * The stored status is an execution-oriented enum; the protocol status describes the owner's
 * decision. A resolved request therefore reports what the owner actually chose.
 */
function protocolAttentionStatus(record: AttentionRequestRecord): AttentionStatus {
  if (record.status === "PENDING") return "PENDING";
  if (record.status === "EXPIRED") return "EXPIRED";
  if (record.status === "CANCELLED") return "CANCELLED";
  if (record.status === "SUPERSEDED") return "SUPERSEDED";
  const resolution = planObject(record.resolution);
  if (resolution.decision === "REJECT") return "REJECTED";
  if (typeof resolution.replacement === "string" && resolution.replacement.length > 0) return "REPLACED";
  // A resolved low-consequence choice is an approval of the option the owner selected.
  return "APPROVED";
}

function attentionTitle(question: string, tier: AttentionRequestRecord["tier"]): string {
  const firstLine = question
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  return (firstLine ?? `${tier} decision`).slice(0, 200);
}

function resolutionChannel(record: AttentionRequestRecord): "SMS" | "WEB" | undefined {
  const channel = planObject(record.resolution).channel;
  return channel === "SMS" || channel === "WEB" ? channel : undefined;
}

/**
 * Returns null when the record is not addressable as a protocol document — an attention request
 * without a case or call has no meaning to an external consumer, and inventing identifiers to
 * satisfy the schema would be worse than omitting it.
 */
export function projectAttentionRequest(input: {
  record: AttentionRequestRecord;
  currentGoal: string;
}): AttentionRequest | null {
  const { record } = input;
  if (!record.caseId || !record.callId) return null;
  const proposed = planObject(record.proposedAction);
  const channel = resolutionChannel(record);
  const resolutionMessageId = planObject(record.resolution).messageId;
  const amountCents = proposed.amountCents;
  const disclosureCardId = proposed.disclosureCardId;
  return attentionRequestSchema.parse({
    protocolVersion: 1,
    id: record.id,
    caseId: record.caseId,
    callId: record.callId,
    tier: record.tier,
    status: protocolAttentionStatus(record),
    title: attentionTitle(record.question, record.tier),
    representativeRequest: String(proposed.representativeRequest ?? record.question).slice(0, 1_000),
    currentGoal: (String(proposed.currentGoal ?? input.currentGoal) || "Goal not yet established").slice(0, 1_000),
    proposedAction: String(proposed.proposedAction ?? record.question).slice(0, 1_000),
    consequences: String(proposed.consequences ?? "The call remains paused until this is resolved.").slice(0, 1_000),
    choices: record.choices,
    ...(typeof amountCents === "number" ? { amountCents } : {}),
    ...(typeof disclosureCardId === "string" && disclosureCardId ? { disclosureCardId } : {}),
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    ...(record.resolvedAt ? { resolvedAt: record.resolvedAt } : {}),
    // Only low-consequence requests may report an SMS resolution channel, which the schema enforces.
    ...(channel ? { resolutionChannel: channel } : {}),
    ...(typeof resolutionMessageId === "string" && resolutionMessageId ? { resolutionMessageId } : {}),
  });
}

export function projectCommitment(record: CommitmentRecord): Commitment {
  return commitmentSchema.parse({
    protocolVersion: 1,
    id: record.id,
    party: record.party,
    status: record.status,
    description: record.description,
    ...(record.amountCents === null ? {} : { amountCents: record.amountCents }),
    ...(record.deadline === null ? {} : { deadline: record.deadline }),
    ...(record.recurring === null ? {} : { recurring: record.recurring }),
    evidence: record.evidence,
    createdAt: record.createdAt,
  });
}

/** Metadata only. The disclosed value is deliberately absent and never reaches this function. */
export function projectDisclosureEvent(input: {
  id: string;
  caseId: string;
  callId: string;
  disclosureCardId: string;
  category: string;
  channel: "SPEECH" | "DTMF";
  purpose: string;
  occurredAt: string;
}): DisclosureEvent {
  return disclosureEventSchema.parse({
    protocolVersion: 1,
    id: input.id,
    caseId: input.caseId,
    callId: input.callId,
    disclosureCardId: input.disclosureCardId,
    category: input.category,
    channel: input.channel,
    purpose: input.purpose.slice(0, 180) || "Approved disclosure",
    consentRecorded: true,
    occurredAt: input.occurredAt,
  });
}
