import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type AppContext } from "../../src/server/app.js";

let context: AppContext | undefined;

afterEach(async () => {
  await context?.app.close();
  context = undefined;
});

const intake = {
  userFirstName: "Avery",
  companyName: "Northstar Goods",
  phoneNumber: "(212) 555-0198",
  issueDescription: "A delivered item arrived defective and support needs to correct the order.",
  chronologyText: "Item arrived defective yesterday",
  desiredOutcome: "Replace the defective item at no charge",
  acceptableAlternativesText: "Refund the item",
  unacceptableOutcomesText: "Pay a new fee",
  knownFactsText: "The item was defective on arrival",
  disclosures: [],
  officialNumberConfirmed: true,
  authorizedAccountConfirmed: true,
  lowRiskConfirmed: true,
};

describe("authenticated case deletion", () => {
  it("requires exact confirmation, refuses an active call, and returns not found after erasure", async () => {
    context = await buildApp({
      NODE_ENV: "test",
      LLM_MODE: "mock",
      TELEPHONY_MODE: "simulator",
      DATABASE_PATH: ":memory:",
      APP_ACCESS_KEY: "correct-key",
      SESSION_SECRET: "test-session",
      CALL_TOKEN_SECRET: "test-call",
      PUBLIC_BASE_URL: "http://localhost:3000",
    }, { serveClient: false, databasePath: ":memory:" });
    await context.app.ready();

    const item = await context.service.createCase(intake);
    const url = `/api/cases/${item.id}`;
    const correctPayload = { confirmation: "DELETE", acknowledged: true };

    expect((await context.app.inject({ method: "DELETE", url, payload: correctPayload })).statusCode).toBe(401);
    const login = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { accessKey: "correct-key" } });
    const cookie = login.headers["set-cookie"]?.toString().split(";")[0];
    expect(cookie).toContain("liaison_session=");

    for (const payload of [
      { confirmation: "delete", acknowledged: true },
      { confirmation: "DELETE", acknowledged: false },
      { confirmation: "DELETE", acknowledged: true, surprise: "field" },
    ]) {
      expect((await context.app.inject({ method: "DELETE", url, headers: { cookie: cookie! }, payload })).statusCode).toBe(400);
    }

    const callId = "00000000-0000-4000-8000-000000000091";
    context.database.createCall({ id: callId, caseId: item.id, mode: "SIMULATOR", scenarioId: "resolved", state: "CONNECTED", activity: "Calling", objective: "Resolve issue" });
    const blocked = await context.app.inject({ method: "DELETE", url, headers: { cookie: cookie! }, payload: correctPayload });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ error: { code: "ACTIVE_CALL_CANNOT_BE_DELETED" } });
    expect(context.database.getCase(item.id)).not.toBeNull();

    context.database.updateCall(callId, { state: "COMPLETED", endedAt: new Date().toISOString() });
    expect((await context.app.inject({ method: "DELETE", url, headers: { cookie: cookie! }, payload: correctPayload })).statusCode).toBe(204);
    expect(context.database.getCase(item.id)).toBeNull();
    expect((await context.app.inject({ method: "DELETE", url, headers: { cookie: cookie! }, payload: correctPayload })).statusCode).toBe(404);
  });
});
