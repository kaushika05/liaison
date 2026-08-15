import twilio from "twilio";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp, type AppContext } from "../../src/server/app.js";
import { signToken } from "../../src/server/core/policy.js";

const accountSid = "AC11111111111111111111111111111111";
const authToken = "voice-route-auth-token";
const publicBaseUrl = "https://liaison.example";
const callTokenSecret = "voice-route-call-token-secret";
const callSid = "CA11111111111111111111111111111111";

let context: AppContext | undefined;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  const active = context?.database.getActiveCall();
  if (active) context!.database.updateCall(active.id, { state: "FAILED", endedAt: new Date().toISOString() });
  await context?.app.close();
  context = undefined;
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function app(databasePath = ":memory:"): Promise<AppContext> {
  context = await buildApp(
    {
      NODE_ENV: "test",
      LLM_MODE: "mock",
      TELEPHONY_MODE: "simulator",
      ALLOW_REAL_CALLS: false,
      DATABASE_PATH: databasePath,
      PUBLIC_BASE_URL: publicBaseUrl,
      PUBLIC_WSS_URL: "wss://liaison.example",
      APP_ACCESS_KEY: "",
      SESSION_SECRET: "voice-route-session-secret",
      CALL_TOKEN_SECRET: callTokenSecret,
      ACTION_LINK_SECRET: "voice-route-action-secret",
      TWILIO_ACCOUNT_SID: accountSid,
      TWILIO_AUTH_TOKEN: authToken,
    },
    { serveClient: false, databasePath },
  );
  await context.app.ready();
  await context.messaging.stop();
  return context;
}

async function seedTwilioCall(
  options: {
    providerCallSid?: string | null;
    state?: "DIALING" | "ENDING";
    terminalReason?: string | null;
    threadState?: "CALL_STARTING" | "CALL_ACTIVE";
  } = {},
): Promise<{ caseId: string; callId: string; threadId: string }> {
  const item = await context!.service.createCase({
    userFirstName: "Avery",
    companyName: "Northstar Goods",
    phoneNumber: "(212) 555-0198",
    issueDescription: "A delivered item arrived defective.",
    chronologyText: "The item arrived yesterday.",
    desiredOutcome: "Replace the defective item.",
    acceptableAlternativesText: "Refund the item.",
    unacceptableOutcomesText: "No paid upgrade.",
    knownFactsText: "The item was defective on arrival.",
    officialNumberConfirmed: true,
    authorizedAccountConfirmed: true,
    lowRiskConfirmed: true,
    disclosures: [],
  });
  await context!.service.generatePlan(item.id);
  context!.service.approvePlan(item.id);
  const callId = `call-${Math.random().toString(16).slice(2)}`;
  context!.database.createCall({
    id: callId,
    caseId: item.id,
    mode: "SIMULATOR",
    scenarioId: null,
    state: options.state ?? "ENDING",
    activity: "Call state unconfirmed",
    objective: "Check Twilio",
  });
  context!.database.db
    .prepare("UPDATE calls SET mode='TWILIO',twilio_call_sid=?,terminal_reason=? WHERE id=?")
    .run(options.providerCallSid ?? null, options.terminalReason ?? "AMBIGUOUS_START:network timeout", callId);
  const thread = context!.database.getOrCreateActiveSupportThread({
    id: `thread-${callId}`,
    principalId: "owner",
    currentCaseId: item.id,
  });
  context!.database.updateSupportThread(thread.id, {
    state: options.threadState ?? "CALL_STARTING",
    currentCaseId: item.id,
    activeCallId: callId,
  });
  return { caseId: item.id, callId, threadId: thread.id };
}

function signedStatusPath(callId: string): string {
  const token = signToken({ callId }, callTokenSecret, 600);
  return `/webhooks/twilio/status/${encodeURIComponent(token)}`;
}

async function postStatus(path: string, form: Record<string, string>, signature?: string) {
  const actualSignature = signature ?? twilio.getExpectedTwilioSignature(authToken, `${publicBaseUrl}${path}`, form);
  return context!.app.inject({
    method: "POST",
    url: path,
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": actualSignature },
    payload: new URLSearchParams(form).toString(),
  });
}

describe("ambiguous Twilio call recovery", () => {
  it("preserves and adopts a DIALING call when restart lands before provider SID persistence", async () => {
    await app();
    const { callId, threadId } = await seedTwilioCall({ state: "DIALING", terminalReason: null });
    await context!.service.recoverInterruptedCall();
    expect(context!.database.getCall(callId)).toMatchObject({
      state: "ENDING",
      twilio_call_sid: null,
      terminal_reason: "AMBIGUOUS_START:SERVER_RESTART_BEFORE_PROVIDER_ID",
    });
    expect(context!.database.getActiveCall()?.id).toBe(callId);
    expect(context!.database.getSupportThread(threadId)).toMatchObject({ state: "CALL_ENDING", activeCallId: callId });
    context!.service.assertTwilioCallbackIdentity(callId, { CallSid: callSid, AccountSid: accountSid });
    expect(context!.database.getCall(callId)?.twilio_call_sid).toBe(callSid);
    await context!.service.twilioStatus(callId, "completed");
    expect(context!.database.getCall(callId)?.state).toBe("COMPLETED");
    expect(context!.database.getActiveCall()).toBeNull();
  });

  it("preserves an unbound ambiguous start as the active-call guard after restart", async () => {
    await app();
    const { callId, threadId } = await seedTwilioCall();
    await context!.service.recoverInterruptedCall();
    expect(context!.database.getCall(callId)).toMatchObject({
      state: "ENDING",
      twilio_call_sid: null,
      terminal_reason: "AMBIGUOUS_START:network timeout",
    });
    expect(context!.database.getActiveCall()?.id).toBe(callId);
    expect(context!.database.getOutcome(callId)).toBeNull();
    expect(context!.service.snapshot(callId)).toMatchObject({ id: callId, state: "ENDING", outcome: null });
    expect(context!.database.getSupportThread(threadId)).toMatchObject({ state: "CALL_ENDING", activeCallId: callId });
    await expect(context!.service.relayMessage(callId, { type: "setup", accountSid, callSid })).rejects.toThrow(
      "RELAY_CALL_IDENTITY_MISMATCH",
    );
    expect(context!.database.getCall(callId)?.twilio_call_sid).toBeNull();
  });

  it("preserves a SID-known orphan when the provider end update fails, then accepts provider terminal confirmation", async () => {
    await app();
    const { callId, threadId } = await seedTwilioCall({
      providerCallSid: callSid,
      state: "DIALING",
      terminalReason: null,
      threadState: "CALL_ACTIVE",
    });
    vi.spyOn(context!.service.twilioAdapter, "endOrphanedCall").mockRejectedValueOnce(new Error("provider timeout"));
    await context!.service.recoverInterruptedCall();
    expect(context!.database.getCall(callId)).toMatchObject({
      state: "ENDING",
      twilio_call_sid: callSid,
      terminal_reason: "AMBIGUOUS_ORPHAN_TERMINATION:provider timeout",
    });
    expect(context!.database.getActiveCall()?.id).toBe(callId);
    expect(context!.database.getOutcome(callId)).toBeNull();
    expect(context!.database.getSupportThread(threadId)).toMatchObject({ state: "CALL_ENDING", activeCallId: callId });

    context!.service.assertTwilioCallbackIdentity(callId, { CallSid: callSid, AccountSid: accountSid });
    await context!.service.twilioStatus(callId, "failed");
    expect(context!.database.getCall(callId)?.state).toBe("FAILED");
    expect(context!.database.getOutcome(callId)?.status).toBe("TECHNICAL_FAILURE");
    expect(context!.database.getActiveCall()).toBeNull();
  });

  it("keeps the ambiguous guard and thread pointer intact across clean shutdown and restart", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "liaison-twilio-recovery-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "liaison.db");
    await app(databasePath);
    const { callId, threadId } = await seedTwilioCall();
    await context!.service.recoverInterruptedCall();
    await context!.app.close();
    context = undefined;

    await app(databasePath);
    expect(context!.database.getActiveCall()?.id).toBe(callId);
    expect(context!.service.snapshot(callId)).toMatchObject({ id: callId, state: "ENDING", outcome: null });
    expect(context!.database.getSupportThread(threadId)).toMatchObject({ state: "CALL_ENDING", activeCallId: callId });
  });

  it("binds only after valid HTTP token, signature, and exact account identity, then finalizes on completion", async () => {
    await app();
    const { callId } = await seedTwilioCall();
    const path = signedStatusPath(callId);
    const initiated = { AccountSid: accountSid, CallSid: callSid, CallStatus: "initiated" };

    expect((await postStatus(path, initiated, "invalid-signature")).statusCode).toBe(403);
    expect(context!.database.getCall(callId)?.twilio_call_sid).toBeNull();

    const wrongAccount = { ...initiated, AccountSid: "AC22222222222222222222222222222222" };
    expect((await postStatus(path, wrongAccount)).statusCode).toBe(400);
    expect(context!.database.getCall(callId)?.twilio_call_sid).toBeNull();

    expect((await postStatus(path, initiated)).statusCode).toBe(204);
    expect(context!.database.getCall(callId)).toMatchObject({ state: "ENDING", twilio_call_sid: callSid });

    const otherSid = { ...initiated, CallSid: "CA22222222222222222222222222222222" };
    expect((await postStatus(path, otherSid)).statusCode).toBe(400);
    expect(context!.database.getCall(callId)?.twilio_call_sid).toBe(callSid);

    expect((await postStatus(path, { ...initiated, CallStatus: "completed" })).statusCode).toBe(204);
    expect(context!.database.getCall(callId)?.state).toBe("COMPLETED");
    expect(context!.database.getOutcome(callId)?.status).toBe("UNRESOLVED");
    expect(context!.database.getActiveCall()).toBeNull();
  });
});
