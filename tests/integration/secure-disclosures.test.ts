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

describe("authenticated secure disclosure attachment", () => {
  it("keeps plaintext only in volatile memory and returns and persists metadata only", async () => {
    context = await buildApp(
      {
        NODE_ENV: "test",
        LLM_MODE: "mock",
        TELEPHONY_MODE: "simulator",
        DATABASE_PATH: ":memory:",
        APP_ACCESS_KEY: "correct-key",
        SESSION_SECRET: "test-session",
        CALL_TOKEN_SECRET: "test-call",
        PUBLIC_BASE_URL: "http://localhost:3000",
      },
      { serveClient: false, databasePath: ":memory:" },
    );
    await context.app.ready();

    const item = await context.service.createCase(intake);
    const url = `/api/cases/${item.id}/disclosures`;
    const payload = { category: "ACCOUNT_NUMBER", value: "AC-2048", allowedChannels: ["SPEECH"] };

    expect((await context.app.inject({ method: "POST", url, payload })).statusCode).toBe(401);
    const login = await context.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { accessKey: "correct-key" },
    });
    const cookie = login.headers["set-cookie"]?.toString().split(";")[0];
    expect(cookie).toContain("liaison_session=");

    const response = await context.app.inject({ method: "POST", url, headers: { cookie: cookie! }, payload });
    expect(response.statusCode).toBe(201);
    expect(response.body).not.toContain(payload.value);
    const updated = response.json();
    expect(updated.disclosures).toHaveLength(1);
    expect(updated.disclosures[0]).toMatchObject({
      label: "Account number",
      category: "ACCOUNT_NUMBER",
      permission: "ASK",
      allowedChannels: ["SPEECH"],
      allowedPurposes: ["Account-number identification or authentication"],
      redactInLogs: true,
    });

    const fetched = await context.app.inject({
      method: "GET",
      url: `/api/cases/${item.id}`,
      headers: { cookie: cookie! },
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.body).not.toContain(payload.value);
    const persisted = context.database.db
      .prepare("SELECT intake_json,disclosure_metadata_json FROM cases WHERE id=?")
      .get(item.id) as { intake_json: string; disclosure_metadata_json: string };
    const auditPayloads = context.database.db
      .prepare("SELECT payload_json FROM events WHERE case_id=?")
      .all(item.id) as Array<{ payload_json: string }>;
    expect(JSON.stringify({ persisted, auditPayloads })).not.toContain(payload.value);
    expect(
      context.disclosures.resolve(
        item.id,
        updated.disclosures[0].id,
        "SPEECH",
        "account identification for authentication",
      )?.value,
    ).toBe(payload.value);
  });

  it("rejects prohibited secrets and delivery channels that cannot safely carry the value", async () => {
    context = await buildApp(
      {
        NODE_ENV: "test",
        LLM_MODE: "mock",
        TELEPHONY_MODE: "simulator",
        DATABASE_PATH: ":memory:",
        APP_ACCESS_KEY: "correct-key",
        SESSION_SECRET: "test-session",
        CALL_TOKEN_SECRET: "test-call",
        PUBLIC_BASE_URL: "http://localhost:3000",
      },
      { serveClient: false, databasePath: ":memory:" },
    );
    await context.app.ready();
    const item = await context.service.createCase(intake);
    const login = await context.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { accessKey: "correct-key" },
    });
    const cookie = login.headers["set-cookie"]?.toString().split(";")[0];
    const url = `/api/cases/${item.id}/disclosures`;

    const invalidDtmf = await context.app.inject({
      method: "POST",
      url,
      headers: { cookie: cookie! },
      payload: { category: "ORDER_NUMBER", value: "ORDER-77", allowedChannels: ["DTMF"] },
    });
    expect(invalidDtmf.statusCode).toBe(400);
    expect(invalidDtmf.body).not.toContain("ORDER-77");
    const addressDtmf = await context.app.inject({
      method: "POST",
      url,
      headers: { cookie: cookie! },
      payload: { category: "ADDRESS", value: "15 Main Street", allowedChannels: ["DTMF"] },
    });
    expect(addressDtmf.statusCode).toBe(400);
    expect(addressDtmf.body).not.toContain("15 Main Street");
    const prohibited = await context.app.inject({
      method: "POST",
      url,
      headers: { cookie: cookie! },
      payload: { category: "ACCOUNT_NUMBER", value: "password: hunter2", allowedChannels: ["SPEECH"] },
    });
    expect(prohibited.statusCode).toBe(400);
    expect(prohibited.body).not.toContain("hunter2");
    expect(context.database.getCase(item.id)?.disclosures).toEqual([]);
  });
});
