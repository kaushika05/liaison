import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type AppContext } from "../../src/server/app.js";
import {
  attentionRequestSchema,
  commitmentSchema,
  executionPlanSchema,
} from "../../src/shared/protocol.js";

let context: AppContext | undefined;

afterEach(async () => {
  await context?.app.close();
  context = undefined;
});

async function signedIn(): Promise<{ cookie: string }> {
  context = await buildApp(
    { NODE_ENV: "test", APP_ACCESS_KEY: "", SESSION_SECRET: "protocol-session-secret-long-enough", CALL_TOKEN_SECRET: "protocol-call-secret-long-enough", ACTION_LINK_SECRET: "protocol-action-secret-long-enough" },
    { serveClient: false, databasePath: ":memory:" },
  );
  const login = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { accessKey: "" } });
  expect(login.statusCode).toBe(200);
  return { cookie: login.headers["set-cookie"] as string };
}

const intake = {
  userFirstName: "Avery",
  companyName: "Northwind Utilities",
  phoneNumber: "+12025550123",
  issueDescription: "A promotional rate ended early and the bill increased without notice.",
  desiredOutcome: "Restore the prior rate and credit the difference",
  acceptableAlternativesText: "I will accept a refund of at least $50",
  unacceptableOutcomesText: "Do not change my plan",
  knownFactsText: "The promotion was confirmed in writing in March",
  officialNumberConfirmed: true,
  authorizedAccountConfirmed: true,
  lowRiskConfirmed: true,
};

describe("Universal Support Protocol v1 surface", () => {
  it("returns an ExecutionPlan that validates against the published schema", async () => {
    const { cookie } = await signedIn();
    const created = await context!.app.inject({ method: "POST", url: "/api/cases", headers: { cookie }, payload: intake });
    expect(created.statusCode).toBe(201);
    const caseId = created.json().id as string;
    await context!.app.inject({ method: "POST", url: `/api/cases/${caseId}/plan`, headers: { cookie } });

    const response = await context!.app.inject({ method: "GET", url: `/api/cases/${caseId}/execution-plan`, headers: { cookie } });
    expect(response.statusCode).toBe(200);

    // The route is the contract boundary: whatever it returns must parse as an ExecutionPlan.
    const plan = executionPlanSchema.parse(response.json());
    expect(plan.protocolVersion).toBe(1);
    expect(plan.caseId).toBe(caseId);
    expect(plan.planId).toBe(`plan-${caseId}-v1`);
    expect(plan.version).toBe(plan.callBrief.version);
    expect(plan.intent.caseId).toBe(caseId);
    expect(plan.intent.autonomyMode).toBe(plan.autonomyMode);
    expect(plan.authority).toEqual(plan.callBrief.authority);
    // Hard-denied capabilities survive the projection unchanged.
    expect(plan.authority.makePurchase).toBe("DENY");
    expect(plan.authority.discloseOtp).toBe("DENY");
    expect(plan.approvedAt).toBeUndefined();
  });

  it("marks the plan approved and keeps the id stable across plan versions", async () => {
    const { cookie } = await signedIn();
    const created = await context!.app.inject({ method: "POST", url: "/api/cases", headers: { cookie }, payload: intake });
    const caseId = created.json().id as string;
    await context!.app.inject({ method: "POST", url: `/api/cases/${caseId}/plan`, headers: { cookie } });
    await context!.app.inject({ method: "POST", url: `/api/cases/${caseId}/plan/approve`, headers: { cookie } });

    const approved = executionPlanSchema.parse((await context!.app.inject({ method: "GET", url: `/api/cases/${caseId}/execution-plan`, headers: { cookie } })).json());
    expect(approved.approvedAt).toBeTruthy();

    // Editing the plan produces a new version, a new plan id, and drops the approval.
    const edited = await context!.app.inject({ method: "PATCH", url: `/api/cases/${caseId}/plan`, headers: { cookie }, payload: { ...approved.callBrief, desiredOutcome: "Restore the prior rate only" } });
    expect(edited.statusCode).toBe(200);
    const revised = executionPlanSchema.parse((await context!.app.inject({ method: "GET", url: `/api/cases/${caseId}/execution-plan`, headers: { cookie } })).json());
    expect(revised.version).toBe(2);
    expect(revised.planId).toBe(`plan-${caseId}-v2`);
    expect(revised.approvedAt).toBeUndefined();
  });

  it("publishes only conditional rules bound to the current plan version", async () => {
    const { cookie } = await signedIn();
    const created = await context!.app.inject({ method: "POST", url: "/api/cases", headers: { cookie }, payload: intake });
    const caseId = created.json().id as string;
    await context!.app.inject({ method: "POST", url: `/api/cases/${caseId}/plan`, headers: { cookie } });
    const plan = executionPlanSchema.parse((await context!.app.inject({ method: "GET", url: `/api/cases/${caseId}/execution-plan`, headers: { cookie } })).json());
    for (const rule of plan.conditionalAuthorityRules) {
      expect(["REFUND", "CREDIT", "FEE", "CHARGE", "PLAN_CHANGE", "CANCELLATION", "APPOINTMENT", "OTHER"]).toContain(rule.subject);
    }
  });

  it("rejects unauthenticated protocol requests and unknown identifiers", async () => {
    const { cookie } = await signedIn();
    const anonymous = await context!.app.inject({ method: "GET", url: "/api/cases/00000000-0000-4000-8000-000000000000/execution-plan" });
    expect(anonymous.statusCode).toBe(401);

    const missingCase = await context!.app.inject({ method: "GET", url: "/api/cases/00000000-0000-4000-8000-000000000000/execution-plan", headers: { cookie } });
    expect(missingCase.statusCode).toBe(404);

    const missingAttention = await context!.app.inject({ method: "GET", url: "/api/attention/00000000-0000-4000-8000-000000000000", headers: { cookie } });
    expect(missingAttention.statusCode).toBe(404);
  });

  it("returns a plan-not-found error before a brief exists", async () => {
    const { cookie } = await signedIn();
    const created = await context!.app.inject({ method: "POST", url: "/api/cases", headers: { cookie }, payload: intake });
    const caseId = created.json().id as string;
    const response = await context!.app.inject({ method: "GET", url: `/api/cases/${caseId}/execution-plan`, headers: { cookie } });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("PLAN_NOT_FOUND");
  });

  it("projects attention requests and commitments through the published schemas", async () => {
    const { cookie } = await signedIn();
    const created = await context!.app.inject({ method: "POST", url: "/api/cases", headers: { cookie }, payload: intake });
    const caseId = created.json().id as string;
    const thread = context!.database.getOrCreateActiveSupportThread({ id: crypto.randomUUID(), principalId: "owner", state: "IDLE", autonomyMode: "COPILOT", messagingOptState: "OPTED_IN", draft: null });
    context!.database.updateSupportThread(thread.id, { currentCaseId: caseId });
    context!.database.createCall({ id: "11111111-1111-4111-8111-111111111111", caseId, mode: "SIMULATOR", scenarioId: null, state: "ON_HOLD", activity: "On hold", objective: "Wait" });

    const attention = context!.database.createAttentionRequest({
      id: crypto.randomUUID(), threadId: thread.id, caseId, callId: "11111111-1111-4111-8111-111111111111",
      tier: "LOW_CONSEQUENCE",
      question: "DECISION NEEDED\nThe call is on hold.\nA - Continue waiting",
      choices: [
        { id: "continue", shortCode: "A", label: "Continue waiting", effect: "Keep waiting." },
        { id: "estimate", shortCode: "B", label: "Ask for an estimate", effect: "Ask how long." },
      ],
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    });

    const response = await context!.app.inject({ method: "GET", url: `/api/attention/${attention.request.id}`, headers: { cookie } });
    expect(response.statusCode).toBe(200);
    const projected = attentionRequestSchema.parse(response.json());
    expect(projected.protocolVersion).toBe(1);
    expect(projected.tier).toBe("LOW_CONSEQUENCE");
    expect(projected.status).toBe("PENDING");
    // The multi-line question collapses to a usable title without losing the full request text.
    expect(projected.title).toBe("DECISION NEEDED");
    expect(projected.choices.map((choice) => choice.shortCode)).toEqual(["A", "B"]);
    expect(Date.parse(projected.expiresAt)).toBeGreaterThan(Date.parse(projected.createdAt));

    context!.database.createCommitment({
      id: "commitment-1", threadId: thread.id, caseId, callId: "11111111-1111-4111-8111-111111111111",
      party: "COMPANY", status: "CONFIRMED", description: "A $35 account credit will be applied.",
      evidence: [{ turnId: "turn-1", exactQuote: "I approved a full $35 account credit" }],
    });
    const commitments = await context!.app.inject({ method: "GET", url: `/api/cases/${caseId}/commitments`, headers: { cookie } });
    expect(commitments.statusCode).toBe(200);
    const parsed = (commitments.json().commitments as unknown[]).map((item) => commitmentSchema.parse(item));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].status).toBe("CONFIRMED");
    // A confirmed commitment without evidence cannot exist in the protocol, and does not here.
    expect(parsed[0].evidence.length).toBeGreaterThan(0);
  });
});
