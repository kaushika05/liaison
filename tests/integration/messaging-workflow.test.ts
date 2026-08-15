import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp, type AppContext } from "../../src/server/app.js";
import type { MessagingThreadSnapshot } from "../../src/shared/api.js";

const completeIssue =
  "Call Xfinity at +18009346489. They charged me a $35 installation fee even though installation was promised free. I want the fee removed. Account credit is acceptable only if it is at least $35. Do not change my plan or accept any new charge.";

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
      OWNER_DISPLAY_NAME: "Avery",
      PUBLIC_BASE_URL: "http://localhost:3000",
      PUBLIC_WSS_URL: "ws://localhost:3000",
      SMS_MAX_SEGMENTS_PER_MESSAGE: 3,
    },
    { serveClient: false, databasePath: ":memory:" },
  );
  return context;
}

async function waitFor(
  app: AppContext,
  predicate: (snapshot: MessagingThreadSnapshot) => boolean,
  timeoutMs = 5_000,
): Promise<MessagingThreadSnapshot> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await app.messaging.flush();
    const snapshot = app.messaging.snapshot();
    if (predicate(snapshot)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`Timed out waiting for messaging state: ${JSON.stringify(app.messaging.snapshot())}`);
}

function callCode(snapshot: MessagingThreadSnapshot): string {
  const match = [...snapshot.messages]
    .reverse()
    .find((message) => message.direction === "OUTBOUND")
    ?.redactedBody.match(/CALL ([23456789A-HJ-NP-Z]{6})/);
  if (!match) throw new Error("Call code was not issued");
  return match[1];
}

describe("SMS-first messaging workflow", () => {
  it("runs one issue through plan, exact call authorization, both attention tiers, and grounded commitments", async () => {
    const app = await createContext();
    let snapshot = await app.messaging.receiveWebText(completeIssue);
    expect(snapshot.thread.state).toBe("AWAITING_INFORMATION");
    snapshot = await app.messaging.receiveWebText("YES");
    expect(snapshot.thread.state).toBe("AWAITING_PLAN_APPROVAL");
    expect(snapshot.case?.brief?.desiredOutcome).toBe("the fee removed");
    const planMessage = [...snapshot.messages].reverse().find((message) => message.direction === "OUTBOUND")!;
    expect(planMessage.redactedBody).toContain("APPROVE PLAN");
    expect(planMessage.redactedBody).toContain("EDIT");
    expect(planMessage.segmentEstimate).toBeLessThanOrEqual(3);
    expect(snapshot.conditionalAuthorityRules).toHaveLength(4);
    expect(snapshot.conditionalAuthorityRules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subject: "CREDIT", comparison: "AT_LEAST", amountCents: 3_500, decision: "ALLOW" }),
        expect.objectContaining({ subject: "CREDIT", comparison: "AT_MOST", amountCents: 3_499, decision: "DENY" }),
        expect.objectContaining({ subject: "PLAN_CHANGE", comparison: "ANY", decision: "DENY" }),
        expect.objectContaining({ subject: "CHARGE", comparison: "ANY", decision: "DENY" }),
      ]),
    );

    snapshot = await app.messaging.receiveWebText("APPROVE PLAN");
    const code = callCode(snapshot);
    const rawDatabaseAfterAuthorization = JSON.stringify(
      app.database.db.prepare("SELECT * FROM outbound_messages").all(),
    );
    expect(rawDatabaseAfterAuthorization).not.toContain(code);
    expect(rawDatabaseAfterAuthorization).toContain("[CALL_CODE]");
    expect(snapshot.thread.state).toBe("AWAITING_AVAILABILITY");
    await app.messaging.receiveWebText(`CALL ${code}`);
    expect(JSON.stringify(app.database.db.prepare("SELECT * FROM inbound_messages").all())).not.toContain(code);

    snapshot = await waitFor(app, (value) => value.attention?.tier === "LOW_CONSEQUENCE");
    expect(snapshot.attention?.choices.map((choice) => choice.shortCode)).toEqual(["A", "B", "C"]);
    expect(snapshot.call?.paused).toBe(true);

    await app.messaging.receiveWebText("A");
    snapshot = await waitFor(app, (value) => value.attention?.tier === "SENSITIVE");
    const secureMessage = [...snapshot.messages]
      .reverse()
      .find((message) => message.direction === "OUTBOUND" && message.redactedBody.includes("/a/"));
    const token = secureMessage?.redactedBody.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1];
    expect(token).toBeTruthy();
    expect(JSON.stringify(app.database.db.prepare("SELECT * FROM outbound_messages").all())).not.toContain(token);
    expect(JSON.stringify(app.database.db.prepare("SELECT * FROM secure_action_tokens").all())).not.toContain(token);
    expect(app.messaging.secureAction(token!).representativeRequest).toContain("billing ZIP");

    await app.messaging.resolveSecureAction(token!, { decision: "REJECT" });
    await expect(app.messaging.resolveSecureAction(token!, { decision: "REJECT" })).rejects.toThrow(
      "ACTION_LINK_INVALID_OR_EXPIRED",
    );
    snapshot = await waitFor(app, (value) => value.attention?.tier === "MATERIAL");
    const materialToken = [...snapshot.messages]
      .reverse()
      .find((message) => message.direction === "OUTBOUND" && message.redactedBody.includes("/a/"))
      ?.redactedBody.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1];
    expect(materialToken).toBeTruthy();
    expect(app.messaging.secureAction(materialToken!).approvalPermitted).toBe(false);
    await expect(
      app.messaging.resolveSecureAction(materialToken!, { decision: "APPROVE", confirmation: "CONFIRM" }),
    ).rejects.toThrow("CONDITIONAL_AUTHORITY_DENIED");
    expect(app.messaging.secureAction(materialToken!).tokenState).toBe("VALID");
    expect(
      (
        app.database.db
          .prepare("SELECT used_at FROM secure_action_tokens WHERE attention_request_id=?")
          .get(snapshot.attention!.id) as { used_at: string | null }
      ).used_at,
    ).toBeNull();
    expect(app.database.getAttentionRequest(snapshot.attention!.id)?.status).toBe("PENDING");
    await app.messaging.resolveSecureAction(materialToken!, { decision: "REJECT" });
    await expect(app.messaging.resolveSecureAction(materialToken!, { decision: "REJECT" })).rejects.toThrow(
      "ACTION_LINK_INVALID_OR_EXPIRED",
    );
    snapshot = await waitFor(app, (value) => value.thread.state === "COMPLETED" && value.commitments.length === 1);
    expect(snapshot.commitments[0].description).toContain("$35 account credit");
    expect(snapshot.commitments[0].evidence[0].exactQuote).toContain("Case number B-19382");
    expect(
      snapshot.messages.some((message) => message.direction === "OUTBOUND" && message.redactedBody.includes("Result:")),
    ).toBe(true);

    const terminalCall = app.database.db
      .prepare("SELECT id,case_id FROM calls ORDER BY started_at DESC LIMIT 1")
      .get() as { id: string; case_id: string };
    const commitmentCountBefore = (
      app.database.db.prepare("SELECT COUNT(*) AS count FROM commitments WHERE call_id=?").get(terminalCall.id) as {
        count: number;
      }
    ).count;
    const finalMessageCountBefore = (
      app.database.db
        .prepare("SELECT COUNT(*) AS count FROM outbound_messages WHERE idempotency_key=?")
        .get(`outcome:${terminalCall.id}`) as { count: number }
    ).count;
    app.database.updateSupportThread(snapshot.thread.id, { state: "CALL_ENDING", activeCallId: terminalCall.id });
    app.service.events.emit("call:any", {
      sequence: 99_999,
      callId: terminalCall.id,
      caseId: terminalCall.case_id,
      type: "OUTCOME_GENERATED",
      data: { replayed: true },
      timestamp: new Date().toISOString(),
    });
    await waitFor(app, (value) => value.thread.state === "COMPLETED" && value.thread.activeCallId === null);
    expect(
      (
        app.database.db.prepare("SELECT COUNT(*) AS count FROM commitments WHERE call_id=?").get(terminalCall.id) as {
          count: number;
        }
      ).count,
    ).toBe(commitmentCountBefore);
    expect(
      (
        app.database.db
          .prepare("SELECT COUNT(*) AS count FROM outbound_messages WHERE idempotency_key=?")
          .get(`outcome:${terminalCall.id}`) as { count: number }
      ).count,
    ).toBe(finalMessageCountBefore);

    await app.messaging.receiveWebText(`CALL ${code}`);
    const calls = (app.database.db.prepare("SELECT COUNT(*) AS count FROM calls").get() as { count: number }).count;
    expect(calls).toBe(1);
  });

  it("asks for a missing destination and never invents or dials one", async () => {
    const app = await createContext();
    const snapshot = await app.messaging.receiveWebText(
      "Company: Northstar. My order arrived broken. I want a no-cost replacement.",
    );
    expect(snapshot.thread.state).toBe("AWAITING_INFORMATION");
    expect(snapshot.case).toBeNull();
    expect(snapshot.messages.at(-1)?.redactedBody).toContain("official US support number");
    expect((app.database.db.prepare("SELECT COUNT(*) AS count FROM calls").get() as { count: number }).count).toBe(0);
  });

  it("redacts prohibited credentials before persistence and does not invoke planning", async () => {
    const app = await createContext();
    const rawSecret = "hunter2-super-secret";
    const snapshot = await app.messaging.receiveWebText(`My password is ${rawSecret}`);
    expect(JSON.stringify(snapshot)).not.toContain(rawSecret);
    const inbound = app.database.db.prepare("SELECT redacted_body,error_code FROM inbound_messages LIMIT 1").get() as {
      redacted_body: string;
      error_code: string;
    };
    expect(inbound.redacted_body).toContain("[REDACTED_PROHIBITED_PASSWORD]");
    expect(inbound.error_code).toContain("PROHIBITED_SECRET");
    expect((app.database.db.prepare("SELECT COUNT(*) AS count FROM cases").get() as { count: number }).count).toBe(0);
  });

  it("invalidates an issued code when autonomy changes", async () => {
    const app = await createContext();
    await app.messaging.receiveWebText(completeIssue);
    await app.messaging.receiveWebText("YES");
    const approved = await app.messaging.receiveWebText("APPROVE PLAN");
    const oldCode = callCode(approved);
    const changed = await app.messaging.receiveWebText("MODE DELEGATE");
    expect(changed.thread.autonomyMode).toBe("DELEGATE");
    expect(changed.thread.state).toBe("PLAN_DRAFTED");
    const denied = await app.messaging.receiveWebText(`CALL ${oldCode}`);
    expect(denied.messages.at(-1)?.redactedBody).toContain("invalid, expired, stale");
    expect((app.database.db.prepare("SELECT COUNT(*) AS count FROM calls").get() as { count: number }).count).toBe(0);
  });

  it("resumes a checkpointed inbound plan after a crash without duplicating its case or plan version", async () => {
    const app = await createContext();
    await app.messaging.receiveWebText(completeIssue);
    const generatePlan = app.service.generatePlan.bind(app.service);
    let injectCrash = true;
    const planning = vi.spyOn(app.service, "generatePlan").mockImplementation(async (caseId) => {
      const brief = await generatePlan(caseId);
      if (injectCrash) {
        injectCrash = false;
        throw new Error("INJECTED_CRASH_AFTER_PLAN_SAVE");
      }
      return brief;
    });

    await expect(app.messaging.receiveWebText("YES")).rejects.toThrow("INBOUND_PROCESSING_DID_NOT_SETTLE");
    expect((app.database.db.prepare("SELECT COUNT(*) AS count FROM cases").get() as { count: number }).count).toBe(1);
    expect(
      (
        app.database.db.prepare("SELECT json_extract(brief_json,'$.version') AS version FROM cases").get() as {
          version: number;
        }
      ).version,
    ).toBe(1);
    expect(
      (
        app.database.db
          .prepare("SELECT COUNT(*) AS count FROM outbound_messages WHERE redacted_body LIKE 'PLAN %'")
          .get() as { count: number }
      ).count,
    ).toBe(0);

    planning.mockRestore();
    app.database.db
      .prepare("UPDATE messaging_work_items SET next_eligible_at=? WHERE state='PENDING'")
      .run(new Date(0).toISOString());
    await app.messaging.flush();
    const recovered = app.messaging.snapshot();
    expect(recovered.thread.state).toBe("AWAITING_PLAN_APPROVAL");
    expect(recovered.case?.brief?.version).toBe(1);
    expect((app.database.db.prepare("SELECT COUNT(*) AS count FROM cases").get() as { count: number }).count).toBe(1);
    expect(
      (
        app.database.db
          .prepare("SELECT COUNT(*) AS count FROM outbound_messages WHERE redacted_body LIKE 'PLAN %'")
          .get() as { count: number }
      ).count,
    ).toBe(1);
    expect(
      (
        app.database.db
          .prepare(
            "SELECT state FROM messaging_work_items WHERE inbound_message_id=(SELECT id FROM inbound_messages WHERE redacted_body='YES')",
          )
          .get() as { state: string }
      ).state,
    ).toBe("COMPLETED");
  });

  it("reuses the deterministic case binding when a crash lands after case insertion", async () => {
    const app = await createContext();
    await app.messaging.receiveWebText(completeIssue);
    const createCase = app.service.createCase.bind(app.service);
    let injectCrash = true;
    const creation = vi.spyOn(app.service, "createCase").mockImplementation(async (raw, options) => {
      const item = await createCase(raw, options);
      if (injectCrash) {
        injectCrash = false;
        throw new Error("INJECTED_CRASH_AFTER_CASE_INSERT");
      }
      return item;
    });

    await expect(app.messaging.receiveWebText("YES")).rejects.toThrow("INBOUND_PROCESSING_DID_NOT_SETTLE");
    expect((app.database.db.prepare("SELECT COUNT(*) AS count FROM cases").get() as { count: number }).count).toBe(1);
    expect(
      (app.database.db.prepare("SELECT brief_json FROM cases").get() as { brief_json: string | null }).brief_json,
    ).toBeNull();

    creation.mockRestore();
    app.database.db
      .prepare("UPDATE messaging_work_items SET next_eligible_at=? WHERE state='PENDING'")
      .run(new Date(0).toISOString());
    const recovered = await waitFor(
      app,
      (value) => value.thread.state === "AWAITING_PLAN_APPROVAL" && value.case?.brief?.version === 1,
    );
    expect(recovered.thread.state).toBe("AWAITING_PLAN_APPROVAL");
    expect(recovered.case?.brief?.version).toBe(1);
    expect((app.database.db.prepare("SELECT COUNT(*) AS count FROM cases").get() as { count: number }).count).toBe(1);
    expect(
      (
        app.database.db.prepare("SELECT COUNT(*) AS count FROM events WHERE type='CASE_CREATED'").get() as {
          count: number;
        }
      ).count,
    ).toBe(1);
  });

  it("revises the current plan for ordinary added context and revokes an issued call authorization", async () => {
    const app = await createContext();
    await app.messaging.receiveWebText(completeIssue);
    let snapshot = await app.messaging.receiveWebText("YES");
    const caseId = snapshot.case!.id;

    snapshot = await app.messaging.receiveWebText(
      "Also ask the representative to confirm in writing that this fee will not recur.",
    );
    expect(snapshot.thread.state).toBe("AWAITING_PLAN_APPROVAL");
    expect(snapshot.case?.id).toBe(caseId);
    expect(snapshot.case?.brief?.version).toBe(2);
    expect(snapshot.case?.brief?.issueSummary).toContain("confirm in writing");
    expect((app.database.db.prepare("SELECT COUNT(*) AS count FROM cases").get() as { count: number }).count).toBe(1);

    snapshot = await app.messaging.receiveWebText("APPROVE PLAN");
    const staleCode = callCode(snapshot);
    expect(snapshot.thread.state).toBe("AWAITING_AVAILABILITY");
    expect(
      (
        app.database.db.prepare("SELECT COUNT(*) AS count FROM call_authorizations WHERE revoked_at IS NULL").get() as {
          count: number;
        }
      ).count,
    ).toBe(1);

    snapshot = await app.messaging.receiveWebText("Please also ask for the representative's department name.");
    expect(snapshot.thread.state).toBe("AWAITING_PLAN_APPROVAL");
    expect(snapshot.thread.approvedPlanVersion).toBeNull();
    expect(snapshot.case?.id).toBe(caseId);
    expect(snapshot.case?.approvedVersion).toBeNull();
    expect(snapshot.case?.brief?.version).toBe(3);
    expect(
      (
        app.database.db.prepare("SELECT COUNT(*) AS count FROM call_authorizations WHERE revoked_at IS NULL").get() as {
          count: number;
        }
      ).count,
    ).toBe(0);
    expect(
      (
        app.database.db
          .prepare("SELECT revoke_reason FROM call_authorizations ORDER BY created_at DESC LIMIT 1")
          .get() as { revoke_reason: string }
      ).revoke_reason,
    ).toBe("PLAN_REVISED_BY_MESSAGE");

    const denied = await app.messaging.receiveWebText(`CALL ${staleCode}`);
    expect([...denied.messages].reverse().find((message) => message.direction === "OUTBOUND")?.redactedBody).toContain(
      "invalid or stale",
    );
    expect((app.database.db.prepare("SELECT COUNT(*) AS count FROM calls").get() as { count: number }).count).toBe(0);
  });

  it.each(["COMPLETED", "FAILED", "CANCELLED"] as const)(
    "completes ordinary free text in terminal %s state with deterministic NEW guidance",
    async (state) => {
      const app = await createContext();
      const thread = app.database.getActiveSupportThread("owner") ?? app.messaging.snapshot().thread;
      app.database.updateSupportThread(thread.id, { state });
      const snapshot = await app.messaging.receiveWebText("Can you try something else?");
      const response = [...snapshot.messages].reverse().find((message) => message.direction === "OUTBOUND");
      expect(snapshot.thread.state).toBe(state);
      expect(response?.redactedBody).toBe("This support request is closed. Send NEW to begin another support request.");
      expect(snapshot.deadLetterWork).toBe(0);
      expect(
        (
          app.database.db
            .prepare("SELECT processing_state FROM inbound_messages ORDER BY created_at DESC LIMIT 1")
            .get() as { processing_state: string }
        ).processing_state,
      ).toBe("COMPLETED");
    },
  );
});
