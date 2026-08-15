import { createHash } from "node:crypto";
import {
  conditionalAuthorityRulesSchema,
  type ConditionalAuthorityComparison,
  type ConditionalAuthorityRule,
  type ConditionalAuthoritySubject,
} from "../../shared/protocol.js";

interface RuleSeed {
  subject: ConditionalAuthoritySubject;
  comparison: ConditionalAuthorityComparison;
  amountCents?: number;
  decision: "ALLOW" | "ASK" | "DENY";
}

function cents(raw: string): number {
  return Math.round(Number(raw.replaceAll(",", "")) * 100);
}

function stableRuleId(caseId: string, planVersion: number, rule: RuleSeed): string {
  const fingerprint = createHash("sha256").update(JSON.stringify(rule)).digest("hex").slice(0, 12);
  return `rule-${caseId.slice(0, 24)}-v${planVersion}-${fingerprint}`.slice(0, 120);
}

function subjectFromText(value: string): ConditionalAuthoritySubject | null {
  if (/\brefund\b/i.test(value)) return "REFUND";
  if (/\b(?:account |service )?credit\b/i.test(value)) return "CREDIT";
  if (/\bfee\b/i.test(value)) return "FEE";
  if (/\b(?:new )?charge\b/i.test(value)) return "CHARGE";
  return null;
}

function addRule(target: RuleSeed[], rule: RuleSeed): void {
  if (!target.some((item) => JSON.stringify(item) === JSON.stringify(rule))) target.push(rule);
}

/**
 * Extracts only narrow, explicit predelegation phrases. Ambiguous prose is not
 * converted into authority. The resulting rules are shown in the plan before
 * approval and remain subordinate to hard policy and attention-tier rules.
 */
export function extractConditionalAuthorityRules(
  caseId: string,
  planVersion: number,
  texts: readonly string[],
): ConditionalAuthorityRule[] {
  const seeds: RuleSeed[] = [];
  const text = texts.filter(Boolean).join("\n");

  for (const sentence of text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((item) => item.trim())
    .filter(Boolean)) {
    const monetary = subjectFromText(sentence);
    const threshold = /\b(?:at least|minimum(?: of)?)\s*\$([\d,]+(?:\.\d{1,2})?)/i.exec(sentence);
    if (monetary && threshold && /\b(?:accept|acceptable|authorized|allow|okay|ok)\b/i.test(sentence)) {
      const amountCents = cents(threshold[1]);
      addRule(seeds, { subject: monetary, comparison: "AT_LEAST", amountCents, decision: "ALLOW" });
      if (amountCents > 0)
        addRule(seeds, { subject: monetary, comparison: "AT_MOST", amountCents: amountCents - 1, decision: "DENY" });
    }

    const maximum = /\b(?:at most|no more than|maximum(?: of)?)\s*\$([\d,]+(?:\.\d{1,2})?)/i.exec(sentence);
    if (monetary && maximum && /\b(?:accept|acceptable|authorized|allow|okay|ok)\b/i.test(sentence)) {
      const amountCents = cents(maximum[1]);
      addRule(seeds, { subject: monetary, comparison: "AT_MOST", amountCents, decision: "ALLOW" });
      addRule(seeds, { subject: monetary, comparison: "AT_LEAST", amountCents: amountCents + 1, decision: "DENY" });
    }

    if (/\b(?:do not|don't|never|must not|unacceptable)\b/i.test(sentence)) {
      if (/\b(?:change (?:my|the|our) plan|plan change|upgrade|downgrade)\b/i.test(sentence))
        addRule(seeds, { subject: "PLAN_CHANGE", comparison: "ANY", decision: "DENY" });
      if (/\b(?:new |additional )?charge\b/i.test(sentence))
        addRule(seeds, { subject: "CHARGE", comparison: "ANY", decision: "DENY" });
      if (/\b(?:cancel|cancellation)\b/i.test(sentence))
        addRule(seeds, { subject: "CANCELLATION", comparison: "ANY", decision: "DENY" });
      if (/\b(?:appointment|reschedule|schedule change)\b/i.test(sentence))
        addRule(seeds, { subject: "APPOINTMENT", comparison: "ANY", decision: "DENY" });
    }
  }

  return conditionalAuthorityRulesSchema.parse(
    seeds.map((rule) => ({
      id: stableRuleId(caseId, planVersion, rule),
      ...rule,
    })),
  );
}

export function conditionalRuleSummary(rule: ConditionalAuthorityRule): string {
  const subject = rule.subject.replaceAll("_", " ").toLowerCase();
  const amount = rule.amountCents === undefined ? "" : ` $${(rule.amountCents / 100).toFixed(2)}`;
  const comparison =
    rule.comparison === "AT_LEAST"
      ? "at least"
      : rule.comparison === "AT_MOST"
        ? "at most"
        : rule.comparison === "EXACTLY"
          ? "exactly"
          : "any";
  return `${rule.decision}: ${subject} ${comparison}${amount}`.trim();
}
