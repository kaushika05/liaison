import { describe, expect, it } from "vitest";
import type { ApprovalRequest, OutcomeReport, TranscriptTurn } from "../../src/shared/domain.js";
import type { ConditionalAuthorityRuleRecord } from "../../src/server/database/db.js";
import { attentionTierForApproval, evaluateApprovalConditionalAuthority } from "../../src/server/core/runtime-authority.js";
import { extractConditionalAuthorityRules } from "../../src/server/messaging/conditional-rules.js";
import { semanticEventsFromCapturedFacts, semanticEventsFromFinalTurn, semanticEventsFromOutcome } from "../../src/server/messaging/semantic-extraction.js";

const approval = (overrides: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  id: "approval-1", callId: "call-1", status: "PENDING", category: "ALTERNATIVE_OUTCOME",
  question: "Accept the offer?", representativeRequest: "Upgrade the plan for six months?",
  proposedSpeech: "The account holder approves the plan upgrade.", consequences: "This changes the service plan.",
  createdAt: "2026-08-12T20:00:00.000Z", expiresAt: "2026-08-12T20:05:00.000Z", ...overrides,
});

function record(rule: ReturnType<typeof extractConditionalAuthorityRules>[number]): ConditionalAuthorityRuleRecord {
  return {
    id: rule.id, threadId: "thread-1", caseId: "case-1", actionType: rule.subject,
    condition: { planVersion: 3, comparison: rule.comparison, amountCents: rule.amountCents },
    permission: rule.decision, priority: 0, active: true,
    createdAt: "2026-08-12T20:00:00.000Z", updatedAt: "2026-08-12T20:00:00.000Z",
  };
}

describe("runtime conditional authority", () => {
  it("extracts explicit monetary and prohibited plan-change rules for plan review", () => {
    const rules = extractConditionalAuthorityRules("case-1", 3, [
      "Account credit is acceptable only if it is at least $35. Do not change my plan or accept any new charge.",
    ]);
    expect(rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ subject: "CREDIT", comparison: "AT_LEAST", amountCents: 3500, decision: "ALLOW" }),
      expect.objectContaining({ subject: "CREDIT", comparison: "AT_MOST", amountCents: 3499, decision: "DENY" }),
      expect.objectContaining({ subject: "PLAN_CHANGE", comparison: "ANY", decision: "DENY" }),
      expect.objectContaining({ subject: "CHARGE", comparison: "ANY", decision: "DENY" }),
    ]));
  });

  it("uses only rules bound to the approved version and never downgrades the material tier", () => {
    const rules = extractConditionalAuthorityRules("case-1", 3, ["Do not change my plan."]);
    expect(evaluateApprovalConditionalAuthority(approval(), rules.map(record), 3)).toMatchObject({ decision: "DENY", subject: "PLAN_CHANGE" });
    expect(evaluateApprovalConditionalAuthority(approval(), rules.map(record), 4)).toMatchObject({ decision: null, source: "NO_MATCH" });
    expect(attentionTierForApproval(approval())).toBe("MATERIAL");
    expect(attentionTierForApproval(approval({ category: "PERSONAL_DATA" }))).toBe("SENSITIVE");
  });
});

describe("semantic extraction", () => {
  const turn: TranscriptTurn = { id: "turn-7", sequence: 7, speaker: "REMOTE", timestamp: "2026-08-12T20:00:00.000Z", text: "I approved a full $35 account credit. It will appear on the next billing statement. Case number B-19382." };
  it("extracts only stable finalized facts with narrow evidence quotes", () => {
    const events = semanticEventsFromFinalTurn(turn).map((item) => item.event);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "CASE_NUMBER_RECEIVED", evidence: [{ turnId: "turn-7", exactQuote: "Case number B-19382" }] }),
      expect.objectContaining({ kind: "DEADLINE_RECEIVED" }),
    ]));
    expect(semanticEventsFromFinalTurn({ ...turn, speaker: "LIAISON" })).toEqual([]);
  });

  it("does not turn refusals into positive transfer or offer updates", () => {
    for (const text of ["No refund can be offered.", "We do not offer account credits.", "I cannot transfer you to billing."]) {
      const events=semanticEventsFromFinalTurn({ ...turn, text }).map((item)=>item.event.kind);
      expect(events).not.toContain("OFFER_MADE");expect(events).not.toContain("TRANSFER_STARTED");
    }
  });

  it("accepts structured facts only when a final remote turn contains the exact value", () => {
    const remote: TranscriptTurn = {
      id: "turn-9", sequence: 9, speaker: "REMOTE", timestamp: turn.timestamp,
      text: "My name is Devin. Reference B-19382. We will issue a replacement. Deadline Friday.",
    };
    const liaison: TranscriptTurn = { ...remote, id: "turn-10", sequence: 10, speaker: "LIAISON", text: "Internal-only value" };
    const events = semanticEventsFromCapturedFacts([
      { kind: "REPRESENTATIVE_NAME", value: "Devin", turnId: remote.id },
      { kind: "CASE_NUMBER", value: "B-19382", turnId: remote.id },
      { kind: "COMMITMENT", value: "will issue a replacement", turnId: remote.id },
      { kind: "DEADLINE", value: "Friday", turnId: remote.id },
      { kind: "OTHER", value: "invented refund", turnId: remote.id },
      { kind: "OTHER", value: "Internal-only value", turnId: liaison.id },
      { kind: "OTHER", value: "bad", turnId: "missing-turn" },
    ], [remote, liaison]).map((item) => item.event);

    expect(events).toEqual(expect.arrayContaining([
      { kind: "FACT_CONFIRMED", fact: "Devin", evidence: [{ turnId: remote.id, exactQuote: "Devin" }] },
      { kind: "CASE_NUMBER_RECEIVED", evidence: [{ turnId: remote.id, exactQuote: "B-19382" }] },
      { kind: "FACT_CONFIRMED", fact: "will issue a replacement", evidence: [{ turnId: remote.id, exactQuote: "will issue a replacement" }] },
      { kind: "DEADLINE_RECEIVED", evidence: [{ turnId: remote.id, exactQuote: "Friday" }] },
    ]));
    expect(events.some((event) => event.kind === "COMMITMENT_CONFIRMED")).toBe(false);
    expect(JSON.stringify(events)).not.toContain("invented refund");
    expect(JSON.stringify(events)).not.toContain("Internal-only value");
  });

  it("projects verified resolution fields without inventing commitments", () => {
    const evidence = [{ turnId: turn.id, exactQuote: "Case number B-19382" }];
    const report = {
      status: "RESOLVED", summary: { value: "Resolved", evidence }, representativeName: null, department: null,
      caseNumber: { value: "B-19382", evidence }, resolution: { value: "A credit was applied", evidence },
      monetaryOutcomes: [], companyCommitments: [], userActions: [], deadlines: [], unresolvedItems: [],
      endedAt: turn.timestamp, durationSeconds: 10, estimatedTelephonyCostUsd: 0,
    } satisfies OutcomeReport;
    expect(semanticEventsFromOutcome(report).map((item) => item.event.kind)).toEqual(["CASE_NUMBER_RECEIVED", "RESOLUTION_VERIFIED"]);
  });

  it("reports a grounded disconnect outcome as a semantic disconnect", () => {
    const evidence = [{ turnId: turn.id, exactQuote: turn.text }];
    const report = {
      status: "DISCONNECTED", summary: { value: "The remote call disconnected", evidence }, representativeName: null,
      department: null, caseNumber: null, resolution: null, monetaryOutcomes: [], companyCommitments: [],
      userActions: [], deadlines: [], unresolvedItems: [{ value: "The support request remains unresolved", evidence }],
      endedAt: turn.timestamp, durationSeconds: 10, estimatedTelephonyCostUsd: 0,
    } satisfies OutcomeReport;
    expect(semanticEventsFromOutcome(report).map((item) => item.event)).toEqual([{ kind: "CALL_DISCONNECTED" }]);
  });
});
