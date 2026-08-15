import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallSnapshot } from "../../src/shared/api.js";
import { buildApp, type AppContext } from "../../src/server/app.js";

let context: AppContext | undefined;
afterEach(async () => {
  await context?.app.close();
  context = undefined;
});
const intake = (withCard = false) => ({
  userFirstName: "Avery",
  companyName: "Northstar Goods",
  phoneNumber: "(212) 555-0198",
  issueDescription:
    "A newly delivered item arrived defective and the user wants customer support to correct the order.",
  chronologyText: "Item arrived defective yesterday",
  desiredOutcome: "Replace the defective item at no charge",
  acceptableAlternativesText: "Refund the item",
  unacceptableOutcomesText: "Pay a new fee",
  knownFactsText: "The item was defective on arrival",
  disclosures: withCard
    ? [
        {
          label: "Account number",
          category: "ACCOUNT_NUMBER",
          permission: "ASK",
          allowedChannels: ["DTMF"],
          allowedPurposes: ["Account authentication"],
          value: "12345678",
        },
      ]
    : [],
});
async function createCase(withCard = false) {
  const item = await context!.service.createCase({
    ...intake(withCard),
    officialNumberConfirmed: true,
    authorizedAccountConfirmed: true,
    lowRiskConfirmed: true,
  });
  await context!.service.generatePlan(item.id);
  context!.service.approvePlan(item.id);
  return item.id;
}
async function waitFor(callId: string, predicate: (value: CallSnapshot) => boolean, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = context!.service.snapshot(callId);
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`Timed out: ${JSON.stringify(context!.service.snapshot(callId))}`);
}

describe("deterministic simulator", () => {
  it("atomically persists a grounded outcome before publishing the terminal call event", async () => {
    context = await buildApp(
      {
        NODE_ENV: "test",
        LLM_MODE: "mock",
        TELEPHONY_MODE: "simulator",
        DATABASE_PATH: ":memory:",
        APP_ACCESS_KEY: "",
        SESSION_SECRET: "test-session",
        CALL_TOKEN_SECRET: "test-call",
      },
      { serveClient: false, databasePath: ":memory:" },
    );
    const caseId = await createCase();
    const started = await context.service.startSimulation(caseId, "replacement-success", false);
    let observedAtomicBoundary = false;
    const unsubscribe = context.service.onAnyCallEvent((event) => {
      if (event.callId !== started.id || event.type !== "CALL_ENDED") return;
      const call = context!.database.getCall(started.id);
      observedAtomicBoundary =
        Boolean(context!.database.getOutcome(started.id)) &&
        call?.state === "COMPLETED" &&
        context!.database.getCase(caseId)?.status === "COMPLETED";
    });
    await context.service.hangup(started.id);
    unsubscribe();
    expect(observedAtomicBoundary).toBe(true);
    expect(context.database.getOutcome(started.id)?.status).toBe("UNRESOLVED");
    const outcomeEvents = context.database.listEvents(started.id).filter((event) => event.type === "OUTCOME_GENERATED");
    expect(outcomeEvents.some((event) => JSON.stringify(event.payload).includes('"provisional":true'))).toBe(true);
  });

  it("repairs any previously terminal call that is missing its outcome on restart", async () => {
    context = await buildApp(
      {
        NODE_ENV: "test",
        LLM_MODE: "mock",
        TELEPHONY_MODE: "simulator",
        DATABASE_PATH: ":memory:",
        APP_ACCESS_KEY: "",
        SESSION_SECRET: "test-session",
        CALL_TOKEN_SECRET: "test-call",
      },
      { serveClient: false, databasePath: ":memory:" },
    );
    const caseId = await createCase();
    const callId = "00000000-0000-4000-8000-000000000099";
    context.database.createCall({
      id: callId,
      caseId,
      mode: "SIMULATOR",
      scenarioId: "replacement-success",
      state: "CONNECTED",
      activity: "Listening",
      objective: "Support request",
    });
    context.database.updateCall(callId, {
      state: "COMPLETED",
      activity: "Completed",
      objective: "Review the outcome",
      endedAt: new Date().toISOString(),
      terminalReason: "USER_REQUESTED",
    });
    expect(context.database.getOutcome(callId)).toBeNull();
    await context.service.recoverInterruptedCall();
    expect(context.database.getOutcome(callId)?.status).toBe("UNRESOLVED");
    expect(context.database.listEvents(callId).filter((event) => event.type === "OUTCOME_GENERATED")).toHaveLength(1);
  });

  it("reconciles a persisted active call after a server restart", async () => {
    context = await buildApp(
      {
        NODE_ENV: "test",
        LLM_MODE: "mock",
        TELEPHONY_MODE: "simulator",
        DATABASE_PATH: ":memory:",
        APP_ACCESS_KEY: "",
        SESSION_SECRET: "test-session",
        CALL_TOKEN_SECRET: "test-call",
      },
      { serveClient: false, databasePath: ":memory:" },
    );
    const caseId = await createCase();
    const callId = "00000000-0000-4000-8000-000000000001";
    const thread = context.database.getOrCreateActiveSupportThread({
      id: "restart-thread",
      principalId: "owner",
      currentCaseId: caseId,
    });
    context.database.createCall({
      id: callId,
      caseId,
      mode: "SIMULATOR",
      scenarioId: "replacement-success",
      state: "CONNECTED",
      activity: "Listening",
      objective: "Support request",
    });
    context.database.updateSupportThread(thread.id, { state: "CALL_ACTIVE", activeCallId: callId });
    const attention = context.database.createAttentionRequest({
      id: "restart-attention",
      threadId: thread.id,
      caseId,
      callId,
      tier: "SENSITIVE",
      question: "Review sensitive request",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }).request;
    context.database.createSecureActionToken({
      id: "restart-token",
      tokenHash: "a".repeat(64),
      actionType: "SENSITIVE_ATTENTION",
      threadId: thread.id,
      caseId,
      callId,
      attentionRequestId: attention.id,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await context.service.recoverInterruptedCall();
    const recovered = context.service.snapshot(callId);
    expect(recovered.state).toBe("FAILED");
    expect(recovered.outcome?.status).toBe("TECHNICAL_FAILURE");
    expect(context.database.getActiveCall()).toBeNull();
    expect(context.database.getSupportThread(thread.id)).toMatchObject({
      state: "FAILED",
      activeCallId: null,
      pendingAttentionRequestId: null,
    });
    expect(context.database.getAttentionRequest(attention.id)?.status).toBe("CANCELLED");
    expect(context.database.getSecureActionToken("a".repeat(64))?.revokeReason).toBe("CALL_RECOVERED_AFTER_RESTART");
  });

  it("expires an approval and refuses late execution", async () => {
    context = await buildApp(
      {
        NODE_ENV: "test",
        LLM_MODE: "mock",
        TELEPHONY_MODE: "simulator",
        DATABASE_PATH: ":memory:",
        APP_ACCESS_KEY: "",
        SESSION_SECRET: "test-session",
        CALL_TOKEN_SECRET: "test-call",
      },
      { serveClient: false, databasePath: ":memory:" },
    );
    const caseId = await createCase();
    const started = await context.service.startSimulation(caseId, "cancellation-offer", true);
    const pending = await waitFor(started.id, (value) => Boolean(value.pendingApproval));
    const expired = "2000-01-01T00:00:00.000Z";
    context.database.db
      .prepare("UPDATE approval_requests SET expires_at=?,data_json=json_set(data_json,'$.expiresAt',?) WHERE id=?")
      .run(expired, expired, pending.pendingApproval!.id);
    await expect(context.service.approve(started.id, pending.pendingApproval!.id)).rejects.toThrow("APPROVAL_EXPIRED");
    expect(context.database.getPendingApproval(started.id)).toBeNull();
    await context.service.hangup(started.id);
  });

  it("holds a queued utterance while paused and resumes into an approval gate", async () => {
    context = await buildApp(
      {
        NODE_ENV: "test",
        LLM_MODE: "mock",
        TELEPHONY_MODE: "simulator",
        DATABASE_PATH: ":memory:",
        APP_ACCESS_KEY: "",
        SESSION_SECRET: "test-session",
        CALL_TOKEN_SECRET: "test-call",
      },
      { serveClient: false, databasePath: ":memory:" },
    );
    const caseId = await createCase();
    const started = await context.service.startSimulation(caseId, "cancellation-offer", false);
    await context.service.pause(started.id);
    await waitFor(started.id, (value) => value.transcript.some((turn) => turn.text.includes("Devin")));
    expect(context.service.snapshot(started.id).paused).toBe(true);
    await expect(context.service.exactText(started.id, "Please continue when ready.")).rejects.toThrow(
      "EXACT_TEXT_BLOCKED_WHILE_DECISION_PENDING_OR_PAUSED",
    );
    await context.service.resume(started.id);
    const pending = await waitFor(
      started.id,
      (value) => Boolean(value.pendingApproval) || ["COMPLETED", "FAILED"].includes(value.state),
    );
    expect(pending.state).toBe("NEEDS_USER");
    expect(pending.pendingApproval?.category).toBe("ALTERNATIVE_OUTCOME");
    expect(pending.transcript.filter((turn) => turn.text.includes("Devin"))).toHaveLength(1);
    await context.service.hangup(started.id);
  });

  it("blocks unsafe user-authored actions before storing or speaking them", async () => {
    context = await buildApp(
      {
        NODE_ENV: "test",
        LLM_MODE: "mock",
        TELEPHONY_MODE: "simulator",
        DATABASE_PATH: ":memory:",
        APP_ACCESS_KEY: "",
        SESSION_SECRET: "test-session",
        CALL_TOKEN_SECRET: "test-call",
      },
      { serveClient: false, databasePath: ":memory:" },
    );
    const caseId = await createCase();
    const item = context.service.getCase(caseId)!;
    context.service.savePlan(caseId, {
      ...item.brief!,
      authority: { ...item.brief!.authority, forbiddenActions: ["accept store credit"] },
    });
    context.service.approvePlan(caseId);
    const started = await context.service.startSimulation(caseId, "replacement-success", false);
    await expect(context.service.exactText(started.id, "Please purchase the paid upgrade.")).rejects.toThrow(
      "PROHIBITED_USER_ACTION:PURCHASE",
    );
    await expect(async () =>
      context!.service.privateInstruction(started.id, "Please accept store credit."),
    ).rejects.toThrow("PROHIBITED_USER_ACTION:");
    const snapshot = context.service.snapshot(started.id);
    expect(JSON.stringify(snapshot.transcript)).not.toContain("paid upgrade");
    expect(
      JSON.stringify(context.database.db.prepare("SELECT payload_json FROM events WHERE call_id=?").all(started.id)),
    ).not.toContain("store credit");
    await context.service.exactText(started.id, "Please ask for a case number.");
    expect(context.service.snapshot(started.id).transcript.at(-1)?.text).toBe("Please ask for a case number.");
    await context.service.hangup(started.id);
  });

  it("requires explicit material confirmation and validates replacement and rejection text before resolution", async () => {
    context = await buildApp(
      {
        NODE_ENV: "test",
        LLM_MODE: "mock",
        TELEPHONY_MODE: "simulator",
        DATABASE_PATH: ":memory:",
        APP_ACCESS_KEY: "",
        SESSION_SECRET: "test-session",
        CALL_TOKEN_SECRET: "test-call",
      },
      { serveClient: false, databasePath: ":memory:" },
    );
    const caseId = await createCase();
    const started = await context.service.startSimulation(caseId, "cancellation-offer", true);
    const pending = await waitFor(started.id, (value) => Boolean(value.pendingApproval));
    const approvalId = pending.pendingApproval!.id;
    await expect(context.service.approve(started.id, approvalId)).rejects.toThrow("MATERIAL_CONFIRMATION_REQUIRED");
    expect(context.database.getPendingApproval(started.id)?.id).toBe(approvalId);
    await expect(context.service.approve(started.id, approvalId, "Please purchase the upgrade.", true)).rejects.toThrow(
      "PROHIBITED_USER_ACTION:PURCHASE",
    );
    expect(context.database.getPendingApproval(started.id)?.id).toBe(approvalId);
    await expect(context.service.reject(started.id, approvalId, "I waive all legal rights.")).rejects.toThrow(
      "PROHIBITED_USER_ACTION:LEGAL_WAIVER",
    );
    expect(context.database.getPendingApproval(started.id)?.id).toBe(approvalId);
    await context.service.approve(started.id, approvalId, undefined, true);
    await waitFor(started.id, (value) => ["COMPLETED", "FAILED"].includes(value.state));
  });

  it.each(["approve", "reject"] as const)(
    "fails closed and never replays a %s side effect after an ambiguous adapter error",
    async (decision) => {
      context = await buildApp(
        {
          NODE_ENV: "test",
          LLM_MODE: "mock",
          TELEPHONY_MODE: "simulator",
          DATABASE_PATH: ":memory:",
          APP_ACCESS_KEY: "",
          SESSION_SECRET: "test-session",
          CALL_TOKEN_SECRET: "test-call",
        },
        { serveClient: false, databasePath: ":memory:" },
      );
      const caseId = await createCase();
      const started = await context.service.startSimulation(caseId, "cancellation-offer", true);
      const pending = await waitFor(started.id, (value) => Boolean(value.pendingApproval));
      const approvalId = pending.pendingApproval!.id;
      const speak = vi
        .spyOn(context.service.simulatorAdapter, "speak")
        .mockRejectedValueOnce(new Error("INJECTED_ADAPTER_FAILURE"));
      const execute = () =>
        decision === "approve"
          ? context!.service.approve(started.id, approvalId, undefined, true)
          : context!.service.reject(started.id, approvalId);
      await expect(execute()).rejects.toThrow("APPROVAL_EXECUTION_FAILED");
      const countAfterFailure = speak.mock.calls.length;
      const execution = context.database.getApprovalExecution(approvalId);
      expect(execution).toMatchObject({ state: "FAILED", decision: decision.toUpperCase() });
      expect(context.database.getApproval(approvalId)?.status).toBe("EXECUTION_FAILED");
      expect(context.service.snapshot(started.id).pendingApproval).toBeNull();
      expect(context.service.snapshot(started.id).outcome?.status).toBe("TECHNICAL_FAILURE");
      await expect(execute()).rejects.toThrow("APPROVAL_EXECUTION_FAILED");
      expect(speak).toHaveBeenCalledTimes(countAfterFailure);
    },
  );

  it.each(["approve", "reject"] as const)(
    "returns an idempotent %s result without repeating the completed adapter side effect",
    async (decision) => {
      context = await buildApp(
        {
          NODE_ENV: "test",
          LLM_MODE: "mock",
          TELEPHONY_MODE: "simulator",
          DATABASE_PATH: ":memory:",
          APP_ACCESS_KEY: "",
          SESSION_SECRET: "test-session",
          CALL_TOKEN_SECRET: "test-call",
        },
        { serveClient: false, databasePath: ":memory:" },
      );
      const caseId = await createCase();
      const started = await context.service.startSimulation(caseId, "cancellation-offer", true);
      const pending = await waitFor(started.id, (value) => Boolean(value.pendingApproval));
      const approvalId = pending.pendingApproval!.id;
      const sideEffectText =
        decision === "approve"
          ? pending.pendingApproval!.proposedSpeech
          : "The account holder does not approve that. Please continue with the original requested outcome.";
      const speak = vi.spyOn(context.service.simulatorAdapter, "speak");
      const execute = () =>
        decision === "approve"
          ? context!.service.approve(started.id, approvalId, undefined, true)
          : context!.service.reject(started.id, approvalId);
      const sideEffectCount = () => speak.mock.calls.filter((call) => call[1] === sideEffectText).length;
      await execute();
      const countAfterSuccess = sideEffectCount();
      expect(context.database.getApprovalExecution(approvalId)?.state).toBe("SUCCEEDED");
      await expect(execute()).resolves.toMatchObject({ id: started.id });
      expect(sideEffectCount()).toBe(countAfterSuccess);
    },
  );

  it("does not persist exact speech when the telephony adapter rejects it", async () => {
    context = await buildApp(
      {
        NODE_ENV: "test",
        LLM_MODE: "mock",
        TELEPHONY_MODE: "simulator",
        DATABASE_PATH: ":memory:",
        APP_ACCESS_KEY: "",
        SESSION_SECRET: "test-session",
        CALL_TOKEN_SECRET: "test-call",
      },
      { serveClient: false, databasePath: ":memory:" },
    );
    const caseId = await createCase();
    const started = await context.service.startSimulation(caseId, "replacement-success", false);
    const before = context.service.snapshot(started.id).transcript.length;
    vi.spyOn(context.service.simulatorAdapter, "speak").mockRejectedValueOnce(
      new Error("INJECTED_EXACT_SPEECH_FAILURE"),
    );
    await expect(context.service.exactText(started.id, "Please ask for a case number.")).rejects.toThrow(
      "INJECTED_EXACT_SPEECH_FAILURE",
    );
    expect(context.service.snapshot(started.id).transcript).toHaveLength(before);
    expect(JSON.stringify(context.database.listEvents(started.id))).not.toContain("Please ask for a case number.");
    await context.service.hangup(started.id);
  });

  it("records ordinary agent speech as completed only after the adapter accepts it", async () => {
    context = await buildApp(
      {
        NODE_ENV: "test",
        LLM_MODE: "mock",
        TELEPHONY_MODE: "simulator",
        DATABASE_PATH: ":memory:",
        APP_ACCESS_KEY: "",
        SESSION_SECRET: "test-session",
        CALL_TOKEN_SECRET: "test-call",
      },
      { serveClient: false, databasePath: ":memory:" },
    );
    const caseId = await createCase();
    const speak = vi
      .spyOn(context.service.simulatorAdapter, "speak")
      .mockRejectedValueOnce(new Error("INJECTED_AGENT_SPEECH_FAILURE"));
    const started = await context.service.startSimulation(caseId, "replacement-success", true);
    const failed = await waitFor(
      started.id,
      (value) => value.paused && value.activity.includes("controller unavailable"),
    );
    expect(speak).toHaveBeenCalledTimes(1);
    expect(failed.disclosureDelivered).toBe(false);
    expect(failed.transcript.some((turn) => turn.speaker === "LIAISON")).toBe(false);
    expect(context.database.listEvents(started.id).some((event) => event.type === "AGENT_SPEECH_COMPLETED")).toBe(
      false,
    );
    await context.service.hangup(started.id);
  });

  it("does not report or persist a terminal state when provider hangup is unconfirmed", async () => {
    context = await buildApp(
      {
        NODE_ENV: "test",
        LLM_MODE: "mock",
        TELEPHONY_MODE: "simulator",
        DATABASE_PATH: ":memory:",
        APP_ACCESS_KEY: "",
        SESSION_SECRET: "test-session",
        CALL_TOKEN_SECRET: "test-call",
      },
      { serveClient: false, databasePath: ":memory:" },
    );
    const caseId = await createCase();
    const started = await context.service.startSimulation(caseId, "replacement-success", false);
    vi.spyOn(context.service.simulatorAdapter, "endCall").mockRejectedValueOnce(new Error("INJECTED_END_FAILURE"));
    await expect(context.service.hangup(started.id)).rejects.toThrow("CALL_TERMINATION_UNCONFIRMED");
    expect(context.database.getCall(started.id)).toMatchObject({
      state: "ENDING",
      terminal_reason: "AMBIGUOUS_TERMINATION:INJECTED_END_FAILURE",
    });
    expect(context.database.getOutcome(started.id)).toBeNull();
    expect(context.database.getActiveCall()?.id).toBe(started.id);
  });

  it("runs every scenario with approvals and grounded terminal reports", async () => {
    context = await buildApp(
      {
        NODE_ENV: "test",
        LLM_MODE: "mock",
        TELEPHONY_MODE: "simulator",
        DATABASE_PATH: ":memory:",
        APP_ACCESS_KEY: "",
        SESSION_SECRET: "test-session",
        CALL_TOKEN_SECRET: "test-call",
      },
      { serveClient: false, databasePath: ":memory:" },
    );
    const scenarioIds = [
      "replacement-success",
      "ivr-hold",
      "cancellation-offer",
      "sensitive-request",
      "sensitive-no-card",
      "prohibited-secret",
      "false-resolution",
      "automation-refusal",
      "prompt-injection",
      "unexpected-disconnect",
    ];
    const expected: Record<string, string> = {
      "replacement-success": "RESOLVED",
      "ivr-hold": "RESOLVED",
      "cancellation-offer": "RESOLVED",
      "sensitive-request": "RESOLVED",
      "sensitive-no-card": "AUTHENTICATION_REQUIRED",
      "prohibited-secret": "AUTHENTICATION_REQUIRED",
      "false-resolution": "PARTIAL",
      "automation-refusal": "REFUSED_AUTOMATION",
      "prompt-injection": "UNRESOLVED",
      "unexpected-disconnect": "DISCONNECTED",
    };
    for (const id of scenarioIds) {
      const caseId = await createCase(id === "sensitive-request");
      const started = await context.service.startSimulation(caseId, id, true);
      const pending = await waitFor(
        started.id,
        (value) => Boolean(value.pendingApproval) || ["COMPLETED", "FAILED"].includes(value.state),
      );
      if (pending.pendingApproval)
        await context.service.approve(
          pending.id,
          pending.pendingApproval.id,
          undefined,
          pending.pendingApproval.category !== "PERSONAL_DATA",
        );
      const current = await waitFor(started.id, (value) => ["COMPLETED", "FAILED"].includes(value.state));
      expect(current.outcome?.status, `${id} outcome`).toBe(expected[id]);
      expect(current.outcome).not.toBeNull();
      const persisted = JSON.stringify(
        context.database.db.prepare("SELECT payload_json FROM events WHERE call_id=?").all(started.id),
      );
      expect(persisted).not.toContain("12345678");
      if (id === "sensitive-request")
        expect(JSON.stringify(current.transcript)).toContain("[REDACTED:ACCOUNT_NUMBER:Account number]");
      if (id === "prompt-injection") expect(JSON.stringify(current.transcript)).not.toContain("database contents");
    }
  });
});
