import { describe, expect, it } from "vitest";
import { defaultAuthority, type CallBrief } from "../../src/shared/domain.js";
import {
  AUTONOMY_PRESETS,
  DEFAULT_AUTONOMY_MODE,
  assignAttentionTier,
  attentionRequestSchema,
  commitmentSchema,
  conditionalAuthorityRuleSchema,
  conditionalAuthorityRulesSchema,
  evaluateConditionalAuthority,
  executionPlanFromCallBrief,
  findConditionalAuthorityConflicts,
  isSmsEligibleAttentionRequest,
  isSmsResolvableTier,
  semanticCallEventDedupKey,
  semanticCallEventSchema,
  supportIntentFromCallBrief,
  type AttentionAction,
  type AttentionRequest,
  type ConditionalAuthorityRule,
} from "../../src/shared/protocol.js";

const now = "2026-08-12T20:00:00.000Z";

function lowConsequenceRequest(overrides: Partial<AttentionRequest> = {}): AttentionRequest {
  return attentionRequestSchema.parse({
    protocolVersion: 1,
    id: "attention-1",
    caseId: "case-1",
    callId: "call-1",
    tier: "LOW_CONSEQUENCE",
    status: "PENDING",
    title: "Continue waiting?",
    representativeRequest: "The representative asked for more time.",
    currentGoal: "Obtain a billing correction.",
    proposedAction: "Wait for another five minutes.",
    consequences: "The call will remain connected.",
    choices: [
      { id: "wait", shortCode: "A", label: "Keep waiting", effect: "Wait five more minutes." },
      { id: "stop", shortCode: "B", label: "End call", effect: "End without a resolution." },
    ],
    createdAt: now,
    expiresAt: "2026-08-12T20:05:00.000Z",
    ...overrides,
  });
}

function exampleBrief(): CallBrief {
  return {
    id: "case-1",
    version: 2,
    companyName: "Example Wireless",
    phoneNumberE164: "+12025550124",
    userFirstName: "Alex",
    title: "Correct a duplicate fee",
    issueSummary: "A duplicate fee appears on the latest statement.",
    chronology: [{ id: "chronology-1", date: "2026-08-10", event: "The statement showed two identical fees." }],
    desiredOutcome: "Remove the duplicate fee and provide a case number.",
    acceptableAlternatives: ["Apply an equal account credit."],
    unacceptableOutcomes: ["A new recurring charge."],
    knownFacts: ["Only one service change was requested."],
    unresolvedQuestions: [],
    openingIssueStatement: "I am calling about a duplicate fee on Alex's account.",
    strategySteps: ["Explain the duplicate fee.", "Request a correction and case number."],
    likelyApprovalPoints: ["Any account change beyond removing the duplicate."],
    warnings: [],
    authority: defaultAuthority,
  };
}

describe("autonomy presets", () => {
  it("defaults to Copilot and keeps each preset's substantive-response boundary explicit", () => {
    expect(DEFAULT_AUTONOMY_MODE).toBe("COPILOT");
    expect(AUTONOMY_PRESETS.ASSIST).toMatchObject({
      mayExplainIssue: false,
      mayNegotiateWithinAuthority: false,
      substantiveResponsePolicy: "USER_AUTHORED",
    });
    expect(AUTONOMY_PRESETS.COPILOT.substantiveResponsePolicy).toBe("REQUEST_ON_CONSEQUENTIAL_OR_AMBIGUOUS");
    expect(AUTONOMY_PRESETS.DELEGATE.substantiveResponsePolicy).toBe("REQUEST_AT_HARD_BOUNDARIES");
    expect(defaultAuthority.makePurchase).toBe("DENY");
    expect(defaultAuthority.discloseOtp).toBe("DENY");
  });
});

describe("deterministic attention policy", () => {
  it("assigns every action to its policy tier without a model suggestion", () => {
    const groups: Record<string, AttentionAction[]> = {
      INFORMATIONAL: ["STATUS_UPDATE", "DEPARTMENT_REACHED", "HOLD_STARTED", "CASE_NUMBER_RECEIVED", "FACT_CONFIRMED"],
      LOW_CONSEQUENCE: ["CONTINUE_WAITING", "ASK_FOR_SUPERVISOR", "REPEAT_EXPLANATION", "KEEP_NEGOTIATING", "ZERO_COST_PROCEDURAL_STEP"],
      SENSITIVE: ["DISCLOSE_PERSONAL_DATA", "SUBMIT_SENSITIVE_DTMF"],
      MATERIAL: ["ACCEPT_FINANCIAL_OUTCOME", "MODIFY_ACCOUNT", "CANCEL_SERVICE", "CHANGE_APPOINTMENT", "ACCEPT_ALTERNATIVE_OUTCOME", "CREATE_RECURRING_COMMITMENT"],
      PROHIBITED: ["DISCLOSE_CREDENTIAL", "DISCLOSE_OTP", "DISCLOSE_FULL_SSN", "DISCLOSE_PAYMENT_CARD", "DISCLOSE_SECURITY_ANSWER", "DISCLOSE_PIN", "MAKE_PURCHASE", "ENTER_NEW_CONTRACT", "IMPERSONATE_USER", "WAIVE_LEGAL_RIGHT"],
    };
    for (const [tier, actions] of Object.entries(groups)) {
      for (const action of actions) expect(assignAttentionTier(action)).toBe(tier);
    }
  });

  it("allows SMS resolution only for current, pending, unexpired low-consequence choices", () => {
    expect(isSmsResolvableTier("LOW_CONSEQUENCE")).toBe(true);
    expect(isSmsResolvableTier("INFORMATIONAL")).toBe(false);
    expect(isSmsResolvableTier("SENSITIVE")).toBe(false);
    expect(isSmsResolvableTier("MATERIAL")).toBe(false);
    expect(isSmsResolvableTier("PROHIBITED")).toBe(false);

    const current = lowConsequenceRequest();
    expect(isSmsEligibleAttentionRequest(current, new Date("2026-08-12T20:01:00.000Z"))).toBe(true);
    expect(isSmsEligibleAttentionRequest(current, new Date("2026-08-12T20:05:00.000Z"))).toBe(false);
    expect(isSmsEligibleAttentionRequest(lowConsequenceRequest({ status: "REJECTED" }), new Date("2026-08-12T20:01:00.000Z"))).toBe(false);
  });

  it("rejects SMS resolution metadata for sensitive or material requests", () => {
    for (const tier of ["SENSITIVE", "MATERIAL"] as const) {
      const result = attentionRequestSchema.safeParse({
        ...lowConsequenceRequest(),
        tier,
        resolutionChannel: "SMS",
      });
      expect(result.success).toBe(false);
    }
  });

  it("rejects duplicate choice codes and approval of a prohibited action", () => {
    const duplicate = attentionRequestSchema.safeParse({
      ...lowConsequenceRequest(),
      choices: [
        { id: "one", shortCode: "A", label: "One", effect: "First effect" },
        { id: "two", shortCode: "A", label: "Two", effect: "Second effect" },
      ],
    });
    expect(duplicate.success).toBe(false);

    const prohibited = attentionRequestSchema.safeParse({
      ...lowConsequenceRequest(),
      tier: "PROHIBITED",
      status: "APPROVED",
      choices: [],
    });
    expect(prohibited.success).toBe(false);
  });
});

describe("conditional authority", () => {
  const refundRules: ConditionalAuthorityRule[] = [
    { id: "refund-allow-35", subject: "REFUND", comparison: "AT_LEAST", amountCents: 3_500, decision: "ALLOW" },
    { id: "refund-ask-20", subject: "REFUND", comparison: "AT_LEAST", amountCents: 2_000, decision: "ASK" },
    { id: "refund-deny-fallback", subject: "REFUND", comparison: "ANY", decision: "DENY" },
  ];

  it("evaluates monetary threshold ladders using integer cents", () => {
    expect(evaluateConditionalAuthority(refundRules, { subject: "REFUND", amountCents: 4_000 })).toMatchObject({ decision: "ALLOW" });
    expect(evaluateConditionalAuthority(refundRules, { subject: "REFUND", amountCents: 2_500 })).toMatchObject({ decision: "ASK" });
    expect(evaluateConditionalAuthority(refundRules, { subject: "REFUND", amountCents: 1_999 })).toMatchObject({ decision: "DENY" });
    expect(evaluateConditionalAuthority(refundRules, { subject: "CREDIT", amountCents: 4_000 })).toEqual({ source: "NO_MATCH", decision: null, matchedRuleIds: [] });
  });

  it("lets exact rules override a threshold and hard denial override every rule", () => {
    const rules: ConditionalAuthorityRule[] = [
      ...refundRules,
      { id: "exact-review", subject: "REFUND", comparison: "EXACTLY", amountCents: 3_500, decision: "ASK" },
    ];
    expect(evaluateConditionalAuthority(rules, { subject: "REFUND", amountCents: 3_500 })).toMatchObject({ decision: "ASK" });
    expect(evaluateConditionalAuthority(rules, { subject: "REFUND", amountCents: 9_999, hardDenied: true })).toEqual({
      source: "HARD_POLICY",
      decision: "DENY",
      matchedRuleIds: [],
    });
  });

  it("surfaces ambiguous contradictory predicates and rejects them as a rule set", () => {
    const conflicting: ConditionalAuthorityRule[] = [
      { id: "first", subject: "CREDIT", comparison: "EXACTLY", amountCents: 2_000, decision: "ALLOW" },
      { id: "second", subject: "CREDIT", comparison: "EXACTLY", amountCents: 2_000, decision: "DENY" },
    ];
    expect(findConditionalAuthorityConflicts(conflicting)).toEqual([
      { firstRuleId: "first", secondRuleId: "second", reason: "CONTRADICTORY_PREDICATE" },
    ]);
    expect(conditionalAuthorityRulesSchema.safeParse(conflicting).success).toBe(false);
    expect(evaluateConditionalAuthority(conflicting, { subject: "CREDIT", amountCents: 2_000 })).toMatchObject({
      source: "CONFLICT",
      decision: null,
      matchedRuleIds: ["first", "second"],
    });
  });

  it("rejects invalid monetary and non-monetary rule shapes", () => {
    expect(conditionalAuthorityRuleSchema.safeParse({ id: "bad-1", subject: "REFUND", comparison: "AT_LEAST", decision: "ALLOW" }).success).toBe(false);
    expect(conditionalAuthorityRuleSchema.safeParse({ id: "bad-2", subject: "PLAN_CHANGE", comparison: "AT_LEAST", amountCents: 1, decision: "DENY" }).success).toBe(false);
  });
});

describe("commitment and semantic event evidence", () => {
  it("requires evidence before a commitment can be confirmed", () => {
    const base = {
      protocolVersion: 1,
      id: "commitment-1",
      party: "COMPANY",
      description: "Issue a $35 credit.",
      evidence: [],
      createdAt: now,
    };
    expect(commitmentSchema.safeParse({ ...base, status: "UNVERIFIED" }).success).toBe(true);
    expect(commitmentSchema.safeParse({ ...base, status: "CONFIRMED" }).success).toBe(false);
    expect(commitmentSchema.safeParse({
      ...base,
      status: "CONFIRMED",
      evidence: [{ turnId: "turn-14", exactQuote: "I have applied a $35 account credit." }],
    }).success).toBe(true);
  });

  it("requires evidence for verified facts, case numbers, and deadlines", () => {
    expect(semanticCallEventSchema.safeParse({ kind: "FACT_CONFIRMED", fact: "The duplicate fee exists.", evidence: [] }).success).toBe(false);
    expect(semanticCallEventSchema.safeParse({ kind: "CASE_NUMBER_RECEIVED", evidence: [] }).success).toBe(false);
    expect(semanticCallEventSchema.safeParse({ kind: "DEADLINE_RECEIVED", evidence: [] }).success).toBe(false);
  });

  it("deduplicates semantically equivalent events without merging different offers", () => {
    const first = semanticCallEventDedupKey({ kind: "DEPARTMENT_REACHED", department: " Billing   Support " });
    const second = semanticCallEventDedupKey({ kind: "DEPARTMENT_REACHED", department: "billing support" });
    expect(first).toBe(second);
    expect(semanticCallEventDedupKey({ kind: "OFFER_MADE", description: "Account credit", amountCents: 3_500 }))
      .not.toBe(semanticCallEventDedupKey({ kind: "OFFER_MADE", description: "Account credit", amountCents: 2_000 }));
  });
});

describe("protocol compatibility wrappers", () => {
  it("constructs a support intent and execution plan from an existing call brief", () => {
    const brief = exampleBrief();
    const intent = supportIntentFromCallBrief(brief, "COPILOT");
    expect(intent).toMatchObject({ protocolVersion: 1, caseId: brief.id, desiredOutcome: brief.desiredOutcome });

    const plan = executionPlanFromCallBrief(brief, {
      planId: "plan-1",
      autonomyMode: "COPILOT",
      createdAt: now,
      approvedAt: "2026-08-12T20:01:00.000Z",
    });
    expect(plan.callBrief).toEqual(brief);
    expect(plan.authority).toEqual(brief.authority);
    expect(plan.version).toBe(brief.version);
  });
});
