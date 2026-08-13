import type { ApprovalRequest } from "../../shared/domain.js";
import {
  assignAttentionTier,
  conditionalAuthorityRuleSchema,
  evaluateConditionalAuthority,
  type AttentionAction,
  type AttentionTier,
  type ConditionalAuthorityEvaluation,
  type ConditionalAuthorityRule,
  type ConditionalAuthoritySubject,
} from "../../shared/protocol.js";
import type { ConditionalAuthorityRuleRecord } from "../database/db.js";

const approvalAction: Readonly<Record<ApprovalRequest["category"], AttentionAction>> = Object.freeze({
  PERSONAL_DATA: "DISCLOSE_PERSONAL_DATA",
  FINANCIAL: "ACCEPT_FINANCIAL_OUTCOME",
  ACCOUNT_CHANGE: "MODIFY_ACCOUNT",
  CANCELLATION: "CANCEL_SERVICE",
  SCHEDULING: "CHANGE_APPOINTMENT",
  ALTERNATIVE_OUTCOME: "ACCEPT_ALTERNATIVE_OUTCOME",
  END_UNRESOLVED: "ACCEPT_ALTERNATIVE_OUTCOME",
});

export function attentionActionForApproval(approval: ApprovalRequest): AttentionAction {
  return approvalAction[approval.category];
}

export function attentionTierForApproval(approval: ApprovalRequest): AttentionTier {
  return assignAttentionTier(attentionActionForApproval(approval));
}

function financialSubject(text: string): ConditionalAuthoritySubject {
  if (/\brefund\b/i.test(text)) return "REFUND";
  if (/\bcredit\b/i.test(text)) return "CREDIT";
  if (/\bfee\b/i.test(text)) return "FEE";
  if (/\b(?:charge|cost|payment|pay)\b/i.test(text)) return "CHARGE";
  return "OTHER";
}

export function conditionalSubjectForApproval(approval: ApprovalRequest): ConditionalAuthoritySubject {
  const text = `${approval.representativeRequest}\n${approval.proposedSpeech}\n${approval.consequences}`;
  if (approval.category === "FINANCIAL") return financialSubject(text);
  if (approval.category === "CANCELLATION") return "CANCELLATION";
  if (approval.category === "SCHEDULING") return "APPOINTMENT";
  if (approval.category === "ACCOUNT_CHANGE" || /\b(?:plan change|change (?:the |your )?plan|upgrade|downgrade)\b/i.test(text)) return "PLAN_CHANGE";
  if (approval.category === "ALTERNATIVE_OUTCOME") {
    const monetary = financialSubject(text);
    return monetary === "OTHER" ? "OTHER" : monetary;
  }
  return "OTHER";
}

function conditionObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * Database rules are accepted only when they are canonical and bound to the
 * currently approved plan version. Malformed or stale rows fail closed by not
 * becoming executable policy.
 */
export function canonicalRuntimeRules(
  records: readonly ConditionalAuthorityRuleRecord[],
  approvedPlanVersion: number,
): ConditionalAuthorityRule[] {
  const rules: ConditionalAuthorityRule[] = [];
  for (const record of records) {
    const condition = conditionObject(record.condition);
    if (condition.planVersion !== approvedPlanVersion) continue;
    const parsed = conditionalAuthorityRuleSchema.safeParse({
      id: record.id,
      subject: record.actionType,
      comparison: condition.comparison,
      amountCents: condition.amountCents,
      decision: record.permission,
    });
    if (parsed.success) rules.push(parsed.data);
  }
  return rules;
}

export type RuntimeConditionalAuthorityEvaluation = ConditionalAuthorityEvaluation & {
  subject: ConditionalAuthoritySubject;
  amountCents?: number;
};

export function evaluateApprovalConditionalAuthority(
  approval: ApprovalRequest,
  records: readonly ConditionalAuthorityRuleRecord[],
  approvedPlanVersion: number,
): RuntimeConditionalAuthorityEvaluation {
  const subject = conditionalSubjectForApproval(approval);
  const amountCents = approval.amountCents;
  return {
    ...evaluateConditionalAuthority(canonicalRuntimeRules(records, approvedPlanVersion), { subject, amountCents }),
    subject,
    ...(amountCents === undefined ? {} : { amountCents }),
  };
}
