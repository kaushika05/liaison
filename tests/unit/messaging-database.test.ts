import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { LiaisonDatabase, type InboundMessageInput, type OutboundMessageInput } from "../../src/server/database/db.js";
import { defaultAuthority, type CallBrief } from "../../src/shared/domain.js";

const T0 = "2026-08-12T12:00:00.000Z";
const T30 = "2026-08-12T12:00:30.000Z";
const T61 = "2026-08-12T12:01:01.000Z";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

const plan = (version = 1): CallBrief => ({
  id: `plan-${version}`,
  version,
  companyName: "Example Company",
  phoneNumberE164: "+13045550123",
  userFirstName: "Kay",
  title: "Resolve billing problem",
  issueSummary: "A recurring billing problem needs a low-risk support call.",
  chronology: [],
  desiredOutcome: "Correct the billing error",
  acceptableAlternatives: [],
  unacceptableOutcomes: [],
  knownFacts: [],
  unresolvedQuestions: [],
  openingIssueStatement: "I am calling about a billing error.",
  strategySteps: ["Explain the issue"],
  likelyApprovalPoints: [],
  warnings: [],
  authority: defaultAuthority,
});

const seed = (db: LiaisonDatabase, options: { call?: boolean; caseId?: string; threadId?: string } = {}) => {
  const caseId = options.caseId ?? "case-1";
  const threadId = options.threadId ?? "thread-1";
  db.createCase({ id: caseId, companyName: "Example Company", title: "Issue", intake: {}, disclosureMetadata: [] });
  db.savePlan(caseId, plan());
  db.getOrCreateActiveSupportThread({ id: threadId, principalId: "owner", currentCaseId: caseId, now: T0 });
  if (options.call) {
    db.createCall({ id: "call-1", caseId, mode: "SIMULATOR", scenarioId: "resolved", state: "CONNECTED", activity: "Calling", objective: "Resolve issue" });
    db.updateSupportThread(threadId, { activeCallId: "call-1", state: "CALL_ACTIVE", updatedAt: T0 });
  }
  return { caseId, threadId, callId: options.call ? "call-1" : null };
};

const inbound = (overrides: Partial<InboundMessageInput> = {}): InboundMessageInput => ({
  id: "in-1",
  threadId: "thread-1",
  providerKind: "TWILIO_SMS",
  providerMessageId: "SM123",
  redactedBody: "Already redacted inbound text",
  sender: "+13045550111",
  recipient: "+13045550122",
  segmentEstimate: 1,
  idempotencyKey: "twilio:SM123",
  createdAt: T0,
  ...overrides,
});

const outbound = (overrides: Partial<OutboundMessageInput> = {}): OutboundMessageInput => ({
  id: "out-1",
  threadId: "thread-1",
  providerKind: "TWILIO_SMS",
  redactedBody: "Already redacted outbound text",
  sender: "+13045550122",
  recipient: "+13045550111",
  segmentEstimate: 1,
  idempotencyKey: "outcome:case-1",
  createdAt: T0,
  nextEligibleAt: T0,
  ...overrides,
});

const temporaryDatabasePath = (): string => path.join(os.tmpdir(), `liaison-${randomUUID()}.sqlite`);
const removeDatabaseFiles = (filename: string): void => {
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = `${filename}${suffix}`;
    if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
  }
};

describe("durable messaging database", () => {
  it("migrates an existing database without losing old-schema rows", () => {
    const filename = temporaryDatabasePath();
    const old = new Database(filename);
    old.exec("CREATE TABLE cases (id TEXT PRIMARY KEY, company_name TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, intake_json TEXT NOT NULL, brief_json TEXT, disclosure_metadata_json TEXT NOT NULL DEFAULT '[]', approved_version INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
    old.exec("CREATE TABLE call_authorizations (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, case_id TEXT NOT NULL, plan_version INTEGER NOT NULL, code_hash TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT, revoked_at TEXT, revoke_reason TEXT)");
    old.prepare("INSERT INTO cases VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run("legacy", "Company", "Legacy", "DRAFT", "{}", null, "[]", null, T0, T0);
    old.prepare("INSERT INTO call_authorizations VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run("legacy-auth", "legacy-thread", "legacy", 1, HASH_A, T0, T61, T30, null, null);
    old.close();

    const migrated = new LiaisonDatabase(filename);
    expect(migrated.getCase("legacy")?.title).toBe("Legacy");
    expect((migrated.db.prepare("SELECT name FROM schema_migrations WHERE version=1").get() as {name:string}).name)
      .toBe("sms_first_durable_messaging");
    expect((migrated.db.prepare("SELECT name FROM schema_migrations WHERE version=2").get() as {name:string}).name)
      .toBe("provider_security_and_authorization_binding");
    expect(migrated.db.prepare("SELECT destination_e164,telephony_mode FROM call_authorizations WHERE id='legacy-auth'").get())
      .toEqual({ destination_e164: null, telephony_mode: null });
    expect((migrated.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('support_threads','inbound_messages','outbound_messages','messaging_work_items')").get() as {count:number}).count)
      .toBe(4);
    migrated.close();
    removeDatabaseFiles(filename);
  });

  it("deduplicates inbound provider messages and creates exactly one work item", () => {
    const db = new LiaisonDatabase(":memory:");
    seed(db);
    const first = db.insertInboundMessageAndSchedule(inbound(), { id: "work-1", kind: "PROCESS_INBOUND", idempotencyKey: "work:SM123" });
    const duplicate = db.insertInboundMessageAndSchedule(inbound({ id: "in-duplicate" }), { id: "work-duplicate", kind: "PROCESS_INBOUND", idempotencyKey: "work:SM123" });
    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.message.id).toBe("in-1");
    expect(duplicate.workItem.id).toBe("work-1");
    expect((db.db.prepare("SELECT COUNT(*) AS count FROM messaging_work_items").get() as {count:number}).count).toBe(1);
    db.close();
  });

  it("persists pending work across close and reopen", () => {
    const filename = temporaryDatabasePath();
    const before = new LiaisonDatabase(filename);
    seed(before);
    before.insertInboundMessageAndSchedule(inbound(), { id: "work-1", kind: "PROCESS_INBOUND", idempotencyKey: "work:SM123" });
    before.close();

    const after = new LiaisonDatabase(filename);
    const claimed = after.claimMessagingWork({ workerId: "worker-a", now: T0, leaseSeconds: 60 });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ id: "work-1", state: "PROCESSING", attemptCount: 1 });
    after.close();
    removeDatabaseFiles(filename);
  });

  it("recovers expired inbox leases without allowing the stale worker to complete", () => {
    const db = new LiaisonDatabase(":memory:");
    seed(db);
    db.insertInboundMessageAndSchedule(inbound(), { id: "work-1", kind: "PROCESS_INBOUND", idempotencyKey: "work:SM123" });
    expect(db.claimMessagingWork({ workerId: "worker-a", now: T0, leaseSeconds: 60 })).toHaveLength(1);
    expect(db.claimMessagingWork({ workerId: "worker-b", now: T30, leaseSeconds: 60 })).toHaveLength(0);
    const recovered = db.claimMessagingWork({ workerId: "worker-b", now: T61, leaseSeconds: 60 });
    expect(recovered[0]).toMatchObject({ id: "work-1", attemptCount: 2, leaseOwner: "worker-b" });
    expect(db.completeMessagingWork("work-1", "worker-a", T61)).toBe(false);
    expect(db.completeMessagingWork("work-1", "worker-b", T61)).toBe(true);
    expect(db.getInboundMessage("in-1")?.processingState).toBe("COMPLETED");
    db.close();
  });

  it("deduplicates the outbox and dead-letters an ambiguous expired send lease without retry", () => {
    const db = new LiaisonDatabase(":memory:");
    seed(db);
    expect(db.enqueueOutboundMessage(outbound()).created).toBe(true);
    const duplicate = db.enqueueOutboundMessage(outbound({ id: "out-duplicate" }));
    expect(duplicate).toMatchObject({ created: false, message: { id: "out-1" } });
    expect(db.claimOutboundMessages({ workerId: "worker-a", now: T0, leaseSeconds: 60 })[0]?.attemptCount).toBe(1);
    const recovered = db.claimOutboundMessages({ workerId: "worker-b", now: T61, leaseSeconds: 60 });
    expect(recovered).toEqual([]);
    expect(db.markOutboundSent({ id: "out-1", workerId: "worker-a", providerMessageId: "SM-out", now: T61 })).toBe(false);
    expect(db.markOutboundSent({ id: "out-1", workerId: "worker-b", providerMessageId: "SM-out", now: T61 })).toBe(false);
    expect(db.getOutboundMessage("out-1")).toMatchObject({ processingState: "DEAD_LETTER", deliveryState: "UNKNOWN", errorCode: "AMBIGUOUS_PROVIDER_ACCEPTANCE", attemptCount: 1 });
    db.close();
  });

  it("atomically opts out a thread and cancels every locally queued outbound send", () => {
    const db = new LiaisonDatabase(":memory:");
    const { threadId } = seed(db);
    db.enqueueOutboundMessage(outbound({ id: "a-sent", idempotencyKey: "sent" }));
    expect(db.claimOutboundMessages({ workerId: "sender", now: T0, leaseSeconds: 60, limit: 1 })[0]?.id).toBe("a-sent");
    expect(db.markOutboundSent({ id: "a-sent", workerId: "sender", providerMessageId: "SM-sent", now: T0 })).toBe(true);
    db.enqueueOutboundMessage(outbound({ id: "b-processing", idempotencyKey: "processing" }));
    db.enqueueOutboundMessage(outbound({ id: "c-pending", idempotencyKey: "pending" }));
    db.enqueueOutboundMessage(outbound({ id: "d-web", idempotencyKey: "web", providerKind: "WEB", recipient: "WEB_OWNER" }));
    expect(db.claimOutboundMessages({ workerId: "sender", now: T0, leaseSeconds: 60, limit: 1 })[0]?.id).toBe("b-processing");

    expect(db.optOutSupportThreadAndCancelOutbound(threadId, { now: T30 })).toEqual({ threadUpdated: true, cancelledCount: 2 });
    expect(db.getSupportThread(threadId)?.messagingOptState).toBe("OPTED_OUT");
    expect(db.getOutboundMessage("b-processing")).toMatchObject({ processingState: "DEAD_LETTER", deliveryState: "FAILED", errorCode: "OWNER_OPTED_OUT", leaseOwner: null });
    expect(db.getOutboundMessage("c-pending")).toMatchObject({ processingState: "DEAD_LETTER", deliveryState: "FAILED", errorCode: "OWNER_OPTED_OUT" });
    expect(db.getOutboundMessage("a-sent")).toMatchObject({ processingState: "COMPLETED", deliveryState: "QUEUED", providerMessageId: "SM-sent" });
    expect(db.getOutboundMessage("d-web")).toMatchObject({ processingState: "PENDING", deliveryState: "PENDING", errorCode: null });
    expect(db.claimOutboundMessages({ workerId: "sender", now: T61, leaseSeconds: 60 }).map((message) => message.id)).toEqual(["d-web"]);
    db.close();
  });

  it("records provider rejection events globally once when no call exists", () => {
    const db = new LiaisonDatabase(":memory:");
    const first = db.recordProviderSecurityEvent({
      id: "security-1",
      providerKind: "TWILIO_SMS",
      providerMessageId: "SM-rejected",
      eventType: "INBOUND_REJECTED",
      reasonCode: "UNAUTHORIZED_SENDER",
      redactedMetadata: { destination: "+1********22" },
      createdAt: T0,
    });
    const duplicate = db.recordProviderSecurityEvent({
      id: "security-duplicate",
      providerKind: "TWILIO_SMS",
      providerMessageId: "SM-rejected",
      eventType: "INBOUND_REJECTED_AGAIN",
      reasonCode: "BAD_SIGNATURE",
      createdAt: T30,
    });
    expect(first.created).toBe(true);
    expect(first.event.callId).toBeNull();
    expect(duplicate).toMatchObject({ created: false, event: { id: "security-1", reasonCode: "UNAUTHORIZED_SENDER" } });
    expect(db.listProviderSecurityEvents()).toHaveLength(1);
    db.close();
  });

  it("consumes call authorization only once for the exact current plan before expiry", () => {
    const db = new LiaisonDatabase(":memory:");
    const { caseId, threadId } = seed(db);
    db.createCallAuthorization({ id: "auth-1", threadId, caseId, planVersion: 1, destinationE164: "+13045550123", telephonyMode: "simulator", codeHash: HASH_A, now: T0, expiresAt: T61 });
    expect(db.consumeCallAuthorization({ threadId, caseId, planVersion: 2, codeHash: HASH_A, now: T30 })).toBeNull();
    expect(db.consumeCallAuthorization({ threadId, caseId, planVersion: 1, destinationE164: "+13045550999", telephonyMode: "simulator", codeHash: HASH_A, now: T30 })).toBeNull();
    expect(db.consumeCallAuthorization({ threadId, caseId, planVersion: 1, destinationE164: "+13045550123", telephonyMode: "twilio", codeHash: HASH_A, now: T30 })).toBeNull();
    expect(db.consumeCallAuthorization({ threadId, caseId, planVersion: 1, destinationE164: "+13045550123", telephonyMode: "simulator", codeHash: HASH_A, now: T30 })?.id).toBe("auth-1");
    expect(db.consumeCallAuthorization({ threadId, caseId, planVersion: 1, destinationE164: "+13045550123", telephonyMode: "simulator", codeHash: HASH_A, now: T30 })).toBeNull();

    db.createCallAuthorization({ id: "auth-expired", threadId, caseId, planVersion: 1, codeHash: HASH_B, now: T0, expiresAt: T30 });
    expect(db.consumeCallAuthorization({ threadId, caseId, planVersion: 1, codeHash: HASH_B, now: T30 })).toBeNull();

    db.createCallAuthorization({ id: "auth-invalidated", threadId, caseId, planVersion: 1, codeHash: HASH_C, now: T0, expiresAt: T61 });
    db.savePlan(caseId, plan(2));
    expect(db.consumeCallAuthorization({ threadId, caseId, planVersion: 1, codeHash: HASH_C, now: T30 })).toBeNull();
    expect((db.db.prepare("SELECT revoke_reason FROM call_authorizations WHERE id='auth-invalidated'").get() as {revoke_reason:string}).revoke_reason).toBe("PLAN_CHANGED");
    db.close();
  });

  it("enforces secure-token expiry, revocation, exact binding, and single use", () => {
    const db = new LiaisonDatabase(":memory:");
    const { caseId, threadId } = seed(db);
    const create = (id: string, hash: string, expiresAt: string) => db.createSecureActionToken({
      id, tokenHash: hash, actionType: "APPROVE_PLAN", threadId, caseId, singleUse: true, now: T0, expiresAt,
    });
    create("token-1", HASH_A, T61);
    expect(db.consumeSecureActionToken({ tokenHash: HASH_A, actionType: "WRONG", threadId, caseId, now: T30 })).toBeNull();
    expect(db.consumeSecureActionToken({ tokenHash: HASH_A, actionType: "APPROVE_PLAN", threadId, caseId, now: T30 })?.id).toBe("token-1");
    expect(db.consumeSecureActionToken({ tokenHash: HASH_A, actionType: "APPROVE_PLAN", threadId, caseId, now: T30 })).toBeNull();

    create("token-expired", HASH_B, T30);
    expect(db.consumeSecureActionToken({ tokenHash: HASH_B, actionType: "APPROVE_PLAN", threadId, caseId, now: T30 })).toBeNull();
    create("token-revoked", HASH_C, T61);
    expect(db.revokeSecureActionTokens({ tokenHash: HASH_C, reason: "TEST", now: T30 })).toBe(1);
    expect(db.consumeSecureActionToken({ tokenHash: HASH_C, actionType: "APPROVE_PLAN", threadId, caseId, now: T30 })).toBeNull();
    db.close();
  });

  it("allows only one blocking attention request and rejects stale resolution", () => {
    const db = new LiaisonDatabase(":memory:");
    const { caseId, threadId, callId } = seed(db, { call: true });
    const first = db.createAttentionRequest({
      id: "attention-1", threadId, caseId, callId, tier: "LOW_CONSEQUENCE", question: "Choose A or B", choices: ["A", "B"], expiresAt: T61, now: T0,
    });
    db.createSecureActionToken({ id: "attention-token", tokenHash: HASH_A, actionType: "DECIDE", threadId, caseId, callId, attentionRequestId: first.request.id, expiresAt: T61, now: T0 });
    const second = db.createAttentionRequest({
      id: "attention-2", threadId, caseId, callId, tier: "SENSITIVE", question: "Review securely", expiresAt: T61, now: T30,
    });
    expect(second.supersededId).toBe("attention-1");
    expect(db.getAttentionRequest("attention-1")).toMatchObject({ status: "SUPERSEDED", supersededBy: "attention-2" });
    expect(db.getSecureActionToken(HASH_A)?.revokeReason).toBe("ATTENTION_SUPERSEDED");
    expect(db.resolveAttentionRequest({ id: "attention-1", expectedCallId: callId, resolution: { choice: "A" }, now: T30 })).toBeNull();
    expect(db.resolveAttentionRequest({ id: "attention-2", expectedCallId: callId, resolution: { reviewed: true }, now: T30 })?.status).toBe("RESOLVED");
    expect(db.resolveAttentionRequest({ id: "attention-2", expectedCallId: callId, resolution: { reviewed: true }, now: T30 })).toBeNull();
    expect(db.getPendingAttentionRequest(callId as string)).toBeNull();
    db.close();
  });

  it("requires commitment evidence and deduplicates semantic call events", () => {
    const db = new LiaisonDatabase(":memory:");
    const { caseId, threadId, callId } = seed(db, { call: true });
    const base = {
      id: "commitment-1", threadId, caseId, callId, party: "COMPANY" as const, status: "CONFIRMED" as const,
      description: "Company will issue a $35 credit.", amountCents: 3500, now: T0,
    };
    expect(() => db.createCommitment({ ...base, evidence: [] })).toThrow("COMMITMENT_EVIDENCE_REQUIRED");
    const stored = db.createCommitment({ ...base, evidence: [{ turnId: "turn-4", exactQuote: "I can issue a $35 credit." }] });
    expect(stored).toMatchObject({ amountCents: 3500, evidence: [{ turnId: "turn-4" }] });
    const event = { id: "semantic-1", threadId, caseId, callId: callId as string, eventType: "COMMITMENT_CAPTURED", semanticKey: "credit-35", payload: { commitmentId: stored.id }, occurredAt: T0 };
    expect(db.insertSemanticCallEvent(event).created).toBe(true);
    expect(db.insertSemanticCallEvent({ ...event, id: "semantic-duplicate" }).created).toBe(false);
    expect(db.listSemanticCallEvents(callId as string)).toHaveLength(1);
    db.close();
  });

  it("deletes correlated records without orphaning legacy events and retains nonterminal cases", () => {
    const db = new LiaisonDatabase(":memory:");
    const { caseId, threadId, callId } = seed(db, { call: true });
    db.updateSupportThread(threadId, {
      messagingOptState: "OPTED_OUT",
      draft: { issueDescription: "private pre-case draft copy" },
      updatedAt: T0,
    });
    db.insertInboundMessageAndSchedule(inbound({
      id: "in-pre-case",
      providerMessageId: "SM-pre-case",
      caseId: null,
      callId: null,
      redactedBody: "private pre-case inbound copy",
      idempotencyKey: "twilio:SM-pre-case",
    }), { id: "work-pre-case", kind: "PROCESS_INBOUND", idempotencyKey: "work:SM-pre-case" });
    db.enqueueOutboundMessage(outbound({
      id: "out-pre-case",
      caseId: null,
      callId: null,
      redactedBody: "private pre-case outbound copy",
      idempotencyKey: "out:pre-case",
    }));
    db.enqueueOutboundMessage(outbound({
      id: "out-case",
      providerMessageId: "SM-out-case",
      caseId,
      callId,
      redactedBody: "private case outbound copy",
      idempotencyKey: "out:case",
    }));
    db.db.prepare(`INSERT INTO message_delivery_events
      (id,outbound_message_id,provider_message_id,provider_status,error_code,occurred_at,received_at,event_key)
      VALUES (?,?,?,?,?,?,?,?)`).run("delivery-1", "out-case", "SM-out-case", "delivered", null, T0, T0, "delivery:private-case-copy");
    db.appendEvent({ id: "event-1", callId: callId as string, caseId, type: "CASE_CREATED", payload: {}, origin: "TEST" });
    db.insertInboundMessageAndSchedule(inbound({ id: "in-case", providerMessageId: "SM-case", caseId, callId, idempotencyKey: "twilio:SM-case" }), { id: "work-1", kind: "PROCESS_INBOUND", idempotencyKey: "work:SM-case" });
    const attention = db.createAttentionRequest({ id: "attention-delete", threadId, caseId, callId, tier: "SENSITIVE", question: "private decision copy", expiresAt: T61, now: T0 }).request;
    db.createSecureActionToken({ id: "token-delete", tokenHash: HASH_A, actionType: "SENSITIVE_ATTENTION", threadId, caseId, callId, attentionRequestId: attention.id, expiresAt: T61, now: T0 });
    db.createCallAuthorization({ id: "auth-delete", threadId, caseId, planVersion: 1, destinationE164: "+13045550123", telephonyMode: "simulator", codeHash: HASH_B, expiresAt: T61, now: T0 });
    db.createConditionalAuthorityRule({ id: "rule-delete", threadId, caseId, actionType: "private action copy", condition: { note: "private condition copy" }, permission: "ASK", now: T0 });
    db.createCommitment({ id: "commitment-1", threadId, caseId, callId, party: "COMPANY", status: "CONFIRMED", description: "Replacement ships", evidence: [{ turnId: "turn-1", exactQuote: "We will ship it." }], now: T0 });
    db.insertSemanticCallEvent({ id: "semantic-delete", threadId, caseId, callId: callId as string, eventType: "PRIVATE_EVENT", semanticKey: "private-event", payload: { note: "private semantic copy" }, occurredAt: T0 });
    db.recordProviderSecurityEvent({ id: "security-delete", providerKind: "TWILIO_SMS", providerMessageId: "SM-security-delete", eventType: "CALLBACK_REJECTED", reasonCode: "TEST", threadId, caseId, callId, redactedMetadata: { note: "private provider copy" }, createdAt: T0 });
    db.addTranscript(callId as string, { id: "turn-1", sequence: 1, speaker: "REMOTE", text: "private transcript copy", timestamp: T0 });
    db.db.prepare("INSERT INTO approval_requests (id,call_id,status,data_json,created_at,expires_at) VALUES (?,?,?,?,?,?)")
      .run("approval-delete", callId, "REJECTED", JSON.stringify({ private: "private approval copy" }), T0, T61);
    db.db.prepare("INSERT INTO outcome_reports (call_id,report_json,created_at) VALUES (?,?,?)")
      .run(callId, JSON.stringify({ private: "private outcome copy" }), T0);

    expect(() => db.deleteCase(caseId)).toThrow("ACTIVE_CALL_CANNOT_BE_DELETED");
    expect(db.getCase(caseId)).not.toBeNull();
    db.updateCall(callId as string, { state: "COMPLETED", endedAt: T30 });
    const deleted = db.deleteCase(caseId);
    expect(deleted).toEqual({
      caseId,
      callIds: [callId],
      threadIds: [threadId],
      inboundMessageIds: ["in-case", "in-pre-case"],
      outboundMessageIds: ["out-case", "out-pre-case"],
    });
    const erasedTables = [
      "events", "calls", "transcript_turns", "approval_requests", "outcome_reports",
      "inbound_messages", "outbound_messages", "message_delivery_events", "messaging_work_items",
      "attention_requests", "secure_action_tokens", "conditional_authority_rules", "commitments",
      "semantic_call_events", "call_authorizations", "provider_security_events",
    ];
    for (const table of erasedTables) {
      expect((db.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {count:number}).count, table).toBe(0);
    }
    expect(db.getSupportThread(threadId)).toBeNull();
    const replacement = db.getActiveSupportThread("owner");
    expect(replacement).toMatchObject({
      state: "IDLE",
      autonomyMode: "COPILOT",
      currentCaseId: null,
      activeCallId: null,
      messagingOptState: "OPTED_OUT",
      draft: null,
    });
    expect(replacement?.id).not.toBe(threadId);
    expect(JSON.stringify(db.db.prepare("SELECT * FROM support_threads").all())).not.toContain("private pre-case draft copy");
    expect(JSON.stringify(db.db.prepare("SELECT * FROM inbound_messages").all())).not.toContain("private pre-case inbound copy");
    expect(JSON.stringify(db.db.prepare("SELECT * FROM outbound_messages").all())).not.toContain("private pre-case outbound copy");
    expect(() => db.deleteCase(caseId)).toThrow("CASE_NOT_FOUND");

    db.createCase({ id: "draft-old", companyName: "Company", title: "Draft", intake: {}, disclosureMetadata: [] });
    db.db.prepare("UPDATE cases SET updated_at='2000-01-01T00:00:00.000Z' WHERE id='draft-old'").run();
    expect(db.deleteExpired(30)).toBe(0);
    expect(db.getCase("draft-old")).not.toBeNull();
    db.close();
  });
});
