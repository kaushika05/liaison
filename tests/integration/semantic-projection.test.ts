import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type AppContext } from "../../src/server/app.js";
import type { OutcomeReport, TranscriptTurn } from "../../src/shared/domain.js";

let context: AppContext | undefined;

afterEach(async () => {
  await context?.app.close();
  context = undefined;
});

async function createContext(): Promise<AppContext> {
  context = await buildApp(
    {
      NODE_ENV: "test",
      DATABASE_PATH: ":memory:",
      LLM_MODE: "mock",
      TELEPHONY_MODE: "simulator",
      MESSAGING_MODE: "web",
      APP_ACCESS_KEY: "test-access-key",
      SESSION_SECRET: "test-session-secret-that-is-long-enough",
      CALL_TOKEN_SECRET: "test-call-secret-that-is-long-enough",
      ACTION_LINK_SECRET: "test-action-secret-that-is-long-enough",
      PUBLIC_BASE_URL: "http://localhost:3000",
      PUBLIC_WSS_URL: "ws://localhost:3000",
    },
    { serveClient: false, databasePath: ":memory:" },
  );
  return context;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for semantic projection");
}

async function prepareCall(
  app: AppContext,
  callId: string,
): Promise<{ caseId: string; threadId: string; turn: TranscriptTurn }> {
  const item = await app.service.createCase({
    userFirstName: "Avery",
    companyName: "Northstar Goods",
    phoneNumber: "+12125550198",
    issueDescription: "A delivered item arrived defective.",
    chronologyText: "The item arrived yesterday.",
    desiredOutcome: "A no-cost replacement",
    acceptableAlternativesText: "A full refund",
    unacceptableOutcomesText: "Any new fee",
    knownFactsText: "The item was defective on arrival.",
    disclosures: [],
    officialNumberConfirmed: true,
    authorizedAccountConfirmed: true,
    lowRiskConfirmed: true,
  });
  const thread = app.database.getOrCreateActiveSupportThread({
    id: "semantic-thread",
    principalId: "owner",
    state: "CALL_ACTIVE",
    currentCaseId: item.id,
    messagingOptState: "OPTED_IN",
  });
  app.database.createCall({
    id: callId,
    caseId: item.id,
    mode: "SIMULATOR",
    scenarioId: "semantic-test",
    state: "CONNECTED",
    activity: "Listening",
    objective: "Resolve the support request",
  });
  app.database.updateSupportThread(thread.id, { state: "CALL_ACTIVE", activeCallId: callId });
  const turn: TranscriptTurn = {
    id: `${callId}-turn`,
    sequence: 1,
    speaker: "REMOTE",
    text: "I will ship a no-cost replacement by Friday. Please return the defective item. Confirmation R-4821.",
    timestamp: "2026-08-12T20:00:00.000Z",
  };
  app.database.addTranscript(callId, turn);
  return { caseId: item.id, threadId: thread.id, turn };
}

describe("runtime semantic projection", () => {
  it("grounds structured facts and atomically records confirmed-commitment events", async () => {
    const app = await createContext();
    const callId = "00000000-0000-4000-8000-000000000071";
    const { caseId, threadId, turn } = await prepareCall(app, callId);

    app.service.events.emit("call:any", {
      sequence: 10,
      callId,
      caseId,
      type: "AGENT_DECISION_PROPOSED",
      data: {
        capturedFacts: [
          { kind: "COMMITMENT", value: "ship a no-cost replacement", turnId: turn.id },
          { kind: "OTHER", value: "an invented refund", turnId: turn.id },
        ],
      },
      timestamp: turn.timestamp,
    });
    await waitUntil(() =>
      app.database.listSemanticCallEvents(callId).some((event) => event.eventType === "FACT_CONFIRMED"),
    );
    const captured = app.database
      .listSemanticCallEvents(callId)
      .filter((event) => event.eventType === "FACT_CONFIRMED");
    expect(captured).toHaveLength(1);
    expect(JSON.stringify(captured)).toContain("ship a no-cost replacement");
    expect(JSON.stringify(captured)).not.toContain("invented refund");

    const evidence = [{ turnId: turn.id, exactQuote: turn.text }];
    const report = {
      status: "RESOLVED",
      summary: { value: "A no-cost replacement was confirmed.", evidence },
      representativeName: null,
      department: null,
      caseNumber: { value: "R-4821", evidence: [{ turnId: turn.id, exactQuote: "Confirmation R-4821" }] },
      resolution: { value: "The company will ship a no-cost replacement.", evidence },
      monetaryOutcomes: [],
      companyCommitments: [{ value: "Ship a no-cost replacement.", evidence }],
      userActions: [{ value: "Return the defective item.", evidence }],
      deadlines: [{ value: "By Friday", evidence: [{ turnId: turn.id, exactQuote: "by Friday" }] }],
      unresolvedItems: [],
      endedAt: "2026-08-12T20:01:00.000Z",
      durationSeconds: 60,
      estimatedTelephonyCostUsd: 0,
    } satisfies OutcomeReport;
    app.database.saveOutcome(callId, report);
    app.database.updateCall(callId, { state: "COMPLETED", activity: "Completed", endedAt: report.endedAt });
    const outcomeEvent = {
      sequence: 11,
      callId,
      caseId,
      type: "OUTCOME_GENERATED",
      data: { grounded: true },
      timestamp: report.endedAt,
    } as const;
    app.service.events.emit("call:any", outcomeEvent);

    await waitUntil(() => app.database.getSupportThread(threadId)?.state === "COMPLETED");
    expect(app.database.listCommitments({ callId })).toHaveLength(2);
    expect(
      app.database.listSemanticCallEvents(callId).filter((event) => event.eventType === "COMMITMENT_CONFIRMED"),
    ).toHaveLength(2);

    app.service.events.emit("call:any", { ...outcomeEvent, sequence: 12 });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(app.database.listCommitments({ callId })).toHaveLength(2);
    expect(
      app.database.listSemanticCallEvents(callId).filter((event) => event.eventType === "COMMITMENT_CONFIRMED"),
    ).toHaveLength(2);
  });

  it("deduplicates a disconnect semantic event from call end and outcome", async () => {
    const app = await createContext();
    const callId = "00000000-0000-4000-8000-000000000072";
    const { caseId, threadId, turn } = await prepareCall(app, callId);
    app.database.updateCall(callId, { state: "FAILED", activity: "Failed", endedAt: turn.timestamp });

    app.service.events.emit("call:any", {
      sequence: 20,
      callId,
      caseId,
      type: "CALL_ENDED",
      data: { status: "DISCONNECTED" },
      timestamp: turn.timestamp,
    });
    await waitUntil(() =>
      app.database.listSemanticCallEvents(callId).some((event) => event.eventType === "CALL_DISCONNECTED"),
    );
    expect(app.database.getSupportThread(threadId)?.state).toBe("CALL_ENDING");

    const evidence = [{ turnId: turn.id, exactQuote: turn.text }];
    app.database.saveOutcome(callId, {
      status: "DISCONNECTED",
      summary: { value: turn.text, evidence },
      representativeName: null,
      department: null,
      caseNumber: null,
      resolution: null,
      monetaryOutcomes: [],
      companyCommitments: [],
      userActions: [],
      deadlines: [],
      unresolvedItems: [{ value: turn.text, evidence }],
      endedAt: turn.timestamp,
      durationSeconds: 10,
      estimatedTelephonyCostUsd: 0,
    });
    app.service.events.emit("call:any", {
      sequence: 21,
      callId,
      caseId,
      type: "OUTCOME_GENERATED",
      data: { grounded: true },
      timestamp: turn.timestamp,
    });
    await waitUntil(() => app.database.getSupportThread(threadId)?.state === "FAILED");
    expect(
      app.database.listSemanticCallEvents(callId).filter((event) => event.eventType === "CALL_DISCONNECTED"),
    ).toHaveLength(1);
  });

  it("rolls back commitments, confirmation events, completion outbox, and thread completion together", async () => {
    const app = await createContext();
    const callId = "00000000-0000-4000-8000-000000000073";
    const { caseId, threadId, turn } = await prepareCall(app, callId);
    const invalidReport = {
      status: "RESOLVED",
      summary: null,
      representativeName: null,
      department: null,
      caseNumber: null,
      resolution: null,
      monetaryOutcomes: [],
      companyCommitments: [{ value: "Ship a replacement", evidence: [] }],
      userActions: [],
      deadlines: [],
      unresolvedItems: [],
      endedAt: turn.timestamp,
      durationSeconds: 10,
      estimatedTelephonyCostUsd: 0,
    } as unknown as OutcomeReport;
    app.database.saveOutcome(callId, invalidReport);
    app.database.updateCall(callId, { state: "COMPLETED", activity: "Completed", endedAt: turn.timestamp });
    app.service.events.emit("call:any", {
      sequence: 30,
      callId,
      caseId,
      type: "OUTCOME_GENERATED",
      data: { grounded: true },
      timestamp: turn.timestamp,
    });

    await waitUntil(() =>
      app.database
        .listEvents(callId)
        .some(
          (event) =>
            event.type === "TECHNICAL_ERROR" &&
            JSON.stringify(event.payload).includes("MESSAGING_EVENT_PROJECTION_FAILED"),
        ),
    );
    expect(app.database.listCommitments({ callId })).toHaveLength(0);
    expect(
      app.database.listSemanticCallEvents(callId).filter((event) => event.eventType === "COMMITMENT_CONFIRMED"),
    ).toHaveLength(0);
    expect(
      (
        app.database.db
          .prepare("SELECT COUNT(*) AS count FROM outbound_messages WHERE idempotency_key=?")
          .get(`outcome:${callId}`) as { count: number }
      ).count,
    ).toBe(0);
    expect(app.database.getSupportThread(threadId)).toMatchObject({ state: "CALL_ACTIVE", activeCallId: callId });
  });
});
