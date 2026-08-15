import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import type {
  AgentDecision,
  ApprovalRequest,
  CallBrief,
  CallState,
  EventType,
  OutcomeReport,
  TranscriptTurn,
} from "../../shared/domain.js";
import {
  approvalRequestSchema,
  callBriefSchema,
  caseIntakeSchema,
  secureDisclosureInputSchema,
} from "../../shared/domain.js";
import type { CallSnapshot, CaseDetail } from "../../shared/api.js";
import type { Config } from "../config.js";
import { publicConfig } from "../config.js";
import {
  classifyRequestedDisclosureCategory,
  detectHighRisk,
  estimateCost,
  normalizeUsPhone,
  prohibitedSecretReason,
  prohibitedSecretRefusalText,
  prohibitedUserActionReason,
  redactText,
  sanitizePayload,
  signToken,
  transitionState,
  validateDecision,
  validateDtmf,
  validateOutcome,
} from "../core/policy.js";
import { LiaisonDatabase, type CaseDeletionResult, type StoredCall } from "../database/db.js";
import { DisclosureStore } from "../security/disclosures.js";
import { ModelService, type ModelUsageRecord } from "../agent/model-service.js";
import { getScenario, scenarios, type ScenarioStep, type SimulatorScenario } from "../simulator/scenarios.js";
import {
  AmbiguousProviderCallStartError,
  SimulatedTelephonyAdapter,
  TwilioConversationRelayAdapter,
  type EndReason,
  type TelephonyAdapter,
} from "../telephony/adapters.js";
import type { WebSocket } from "ws";
import type { AutonomyMode } from "../../shared/protocol.js";
import { evaluateApprovalConditionalAuthority } from "../core/runtime-authority.js";
import { extractConditionalAuthorityRules } from "../messaging/conditional-rules.js";
import { redactInboundSmsSecrets } from "../messaging/secrets.js";
import { projectDisclosureEvent } from "../protocol/projection.js";

interface Runtime {
  adapter: TelephonyAdapter;
  scenario?: SimulatorScenario;
  stepIndex: number;
  timer?: NodeJS.Timeout;
  durationTimer?: NodeJS.Timeout;
  pendingRemote: Array<{ text: string; step?: ScenarioStep }>;
  executedKeys: Set<string>;
  privateInstruction?: string;
  browserSequence: number;
  disclosureLedger: Array<{ label: string; marker: string; channel: string; timestamp: string }>;
  terminalizing: boolean;
  terminalization?: Promise<void>;
}
export interface BrowserEvent {
  id: number;
  type: string;
  data: unknown;
}
export interface ApplicationCallEvent {
  sequence: number;
  callId?: string;
  caseId?: string;
  type: EventType;
  data: unknown;
  timestamp: string;
}

const disclosureScript = (name: string) =>
  `Hello. I'm an automated accessibility assistant calling on behalf of ${name}, who is present and supervising through text. This conversation is being transcribed in real time for accessibility, and this application is not recording the audio. May we continue?`;

export class CallService {
  readonly events = new EventEmitter();
  readonly simulatorAdapter = new SimulatedTelephonyAdapter();
  readonly twilioAdapter: TwilioConversationRelayAdapter;
  private readonly runtimes = new Map<string, Runtime>();
  private readonly autonomyModes = new Map<string, AutonomyMode>();
  constructor(
    readonly config: Config,
    readonly database: LiaisonDatabase,
    readonly disclosures: DisclosureStore,
    readonly models: ModelService,
  ) {
    this.twilioAdapter = new TwilioConversationRelayAdapter(config);
  }

  configStatus() {
    return publicConfig(this.config);
  }
  async recoverInterruptedCall(): Promise<void> {
    for (const terminal of this.database.listTerminalCallsWithoutOutcome())
      await this.ensureTerminalOutcome(terminal.id);
    const row = this.database.getActiveCall();
    if (!row || this.runtimes.has(row.id)) return;
    if (
      row.mode === "TWILIO" &&
      !row.twilio_call_sid &&
      (row.state === "DIALING" || (row.state === "ENDING" && row.terminal_reason?.startsWith("AMBIGUOUS_START:")))
    ) {
      if (row.state === "DIALING")
        this.database.updateCall(row.id, {
          state: "ENDING",
          paused: true,
          generation: row.generation + 1,
          activity: "Call start is unconfirmed",
          objective: "Check the Twilio dashboard before another call",
          terminalReason: "AMBIGUOUS_START:SERVER_RESTART_BEFORE_PROVIDER_ID",
        });
      const thread = this.database.getThreadForCall(row.id);
      if (thread) this.database.updateSupportThread(thread.id, { state: "CALL_ENDING", activeCallId: row.id });
      return;
    }
    if (row.mode === "TWILIO" && row.twilio_call_sid) {
      try {
        await this.twilioAdapter.endOrphanedCall(row.twilio_call_sid);
      } catch (error) {
        const code = this.safeError(error);
        this.database.updateCall(row.id, {
          state: "ENDING",
          paused: true,
          generation: row.generation + 1,
          activity: "Call termination is unconfirmed",
          objective: "Check the Twilio dashboard before another call",
          terminalReason: `AMBIGUOUS_ORPHAN_TERMINATION:${code}`,
        });
        const thread = this.database.getThreadForCall(row.id);
        if (thread) this.database.updateSupportThread(thread.id, { state: "CALL_ENDING" });
        this.record(
          row.id,
          row.case_id,
          "TECHNICAL_ERROR",
          {
            code: `AMBIGUOUS_ORPHAN_TERMINATION:${code}`,
            operatorAction: "Verify and end the provider call manually; automatic call creation remains disabled.",
          },
          "TELEPHONY",
        );
        return;
      }
    }
    const recoveredAt = new Date().toISOString();
    const duration = Math.max(row.duration_seconds, Math.floor((Date.now() - Date.parse(row.started_at)) / 1000));
    const cost = estimateCost(duration, this.config.ESTIMATED_TELEPHONY_COST_PER_MINUTE_USD);
    const fallback = this.deterministicOutcome(row.id, "TECHNICAL_FAILURE", {
      endedAt: recoveredAt,
      durationSeconds: duration,
      estimatedCostUsd: cost,
    });
    this.database.revokeSecureActionTokens({
      callId: row.id,
      reason: "CALL_RECOVERED_AFTER_RESTART",
      now: recoveredAt,
    });
    this.persistTerminalProvisional({
      row,
      finalState: "FAILED",
      reason: "TECHNICAL_FAILURE",
      technical: "Server restarted during an active call",
      status: "TECHNICAL_FAILURE",
      report: fallback,
      endedAt: recoveredAt,
      durationSeconds: duration,
      estimatedCostUsd: cost,
      recoveredAfterRestart: true,
    });
    this.database.db.transaction(() => {
      this.database.db
        .prepare("UPDATE attention_requests SET status='CANCELLED',resolved_at=? WHERE call_id=? AND status='PENDING'")
        .run(recoveredAt, row.id);
      this.database.db
        .prepare(
          "UPDATE support_threads SET state='FAILED',active_call_id=NULL,pending_attention_request_id=NULL,updated_at=? WHERE active_call_id=?",
        )
        .run(recoveredAt, row.id);
    })();
    this.disclosures.clearCase(row.case_id);
  }
  async ensureTerminalOutcome(callId: string): Promise<OutcomeReport> {
    const existing = this.database.getOutcome(callId);
    if (existing) return existing;
    const row = this.requireCall(callId);
    if (!this.isTerminal(row.state)) throw new Error("CALL_NOT_TERMINAL");
    const status = this.persistedTerminalStatus(row);
    const fallback = this.deterministicOutcome(callId, status);
    const clean = sanitizePayload(
      { status: fallback.status, provisional: true, grounded: true, reconciledAfterRestart: true },
      this.disclosures.redactionInputs(row.case_id),
    );
    this.database.db.transaction(() => {
      if (this.database.getOutcome(callId)) return;
      this.database.saveOutcome(callId, fallback);
      this.database.db
        .prepare("UPDATE cases SET status=?,updated_at=? WHERE id=?")
        .run(row.state, row.ended_at ?? fallback.endedAt, row.case_id);
      this.database.appendEvent({
        id: randomUUID(),
        callId,
        caseId: row.case_id,
        type: "OUTCOME_GENERATED",
        payload: clean,
        origin: "SYSTEM",
        idempotencyKey: `terminal-outcome:${callId}:provisional`,
      });
    })();
    return this.database.getOutcome(callId) ?? fallback;
  }
  listScenarios() {
    return scenarios.map((scenario) => ({
      id: scenario.id,
      name: scenario.name,
      description: scenario.description,
      requiresApproval: scenario.requiresApproval,
    }));
  }
  setAutonomyMode(callId: string, mode: AutonomyMode): void {
    this.requireActiveCall(callId);
    this.autonomyModes.set(callId, mode);
  }
  listCases() {
    return this.database.listCases();
  }
  getCase(id: string) {
    return this.database.getCase(id);
  }

  async createCase(raw: unknown, options: { idempotencyKey?: string } = {}): Promise<CaseDetail> {
    const intake = caseIntakeSchema.parse(raw);
    const phone = normalizeUsPhone(intake.phoneNumber);
    const idempotencyKey = options.idempotencyKey?.trim();
    if (options.idempotencyKey !== undefined && (!idempotencyKey || idempotencyKey.length > 500))
      throw new Error("INVALID_CASE_IDEMPOTENCY_KEY");
    const id = idempotencyKey ? deterministicCaseId(idempotencyKey) : randomUUID();
    this.assertNoInlineSensitiveData([
      intake.userFirstName,
      intake.companyName,
      intake.issueDescription,
      intake.chronologyText,
      intake.desiredOutcome,
      intake.acceptableAlternativesText,
      intake.unacceptableOutcomesText,
      intake.knownFactsText,
    ]);
    const storedIntake = { ...intake, phoneNumber: phone, disclosures: [] };
    const existing = this.database.getCase(id);
    if (existing) {
      if (JSON.stringify(existing.intake) !== JSON.stringify(storedIntake))
        throw new Error("CASE_IDEMPOTENCY_CONFLICT");
      return existing;
    }
    const metadata = this.disclosures.createForCase(id, intake.disclosures);
    this.database.createCase({
      id,
      companyName: intake.companyName,
      title: `${intake.companyName} support request`,
      intake: storedIntake,
      disclosureMetadata: metadata,
    });
    this.record(
      undefined,
      id,
      "CASE_CREATED",
      { companyName: intake.companyName, phoneNumber: phone, disclosures: metadata },
      "USER",
    );
    return this.database.getCase(id)!;
  }

  addSecureDisclosure(caseId: string, raw: unknown): CaseDetail {
    this.requireCase(caseId);
    const input = secureDisclosureInputSchema.parse(raw);
    const policy = {
      ACCOUNT_NUMBER: { label: "Account number", allowedPurposes: ["Account-number identification or authentication"] },
      ORDER_NUMBER: { label: "Order number", allowedPurposes: ["Order-number identification or lookup"] },
      ADDRESS: {
        label: "Service or mailing address",
        allowedPurposes: ["Billing, mailing, or service-address verification"],
      },
      DATE_OF_BIRTH: { label: "Date of birth", allowedPurposes: ["Date-of-birth identity verification"] },
    }[input.category];
    const metadata = this.disclosures.addForCase(caseId, { ...input, ...policy, permission: "ASK" });
    try {
      this.database.appendCaseDisclosureMetadata(caseId, metadata);
    } catch (error) {
      this.disclosures.remove(caseId, metadata.id);
      throw error;
    }
    this.record(undefined, caseId, "CASE_UPDATED", { disclosureAdded: metadata }, "USER");
    return this.requireCase(caseId);
  }

  async generatePlan(caseId: string): Promise<CallBrief> {
    const item = this.requireCase(caseId);
    const intake = caseIntakeSchema.parse({ ...item.intake, disclosures: [] });
    try {
      const plan = await this.models.plan(caseId, normalizeUsPhone(String(item.intake.phoneNumber)), intake);
      this.database.savePlan(caseId, plan);
      this.record(undefined, caseId, "PLAN_GENERATED", { version: plan.version }, this.config.LLM_MODE.toUpperCase());
      return plan;
    } finally {
      this.flushModelUsage(undefined, caseId);
    }
  }
  savePlan(caseId: string, raw: unknown): CallBrief {
    const existing = this.requireCase(caseId);
    if (!raw || typeof raw !== "object") throw new Error("INVALID_PLAN");
    const brief = callBriefSchema.parse({ ...raw, id: caseId, version: (existing.brief?.version ?? 0) + 1 });
    this.assertNoInlineSensitiveData([
      brief.title,
      brief.userFirstName,
      brief.companyName,
      brief.issueSummary,
      ...brief.chronology.flatMap((item) => [item.date ?? "", item.event]),
      brief.desiredOutcome,
      ...brief.acceptableAlternatives,
      ...brief.unacceptableOutcomes,
      ...brief.knownFacts,
      ...brief.unresolvedQuestions,
      ...brief.strategySteps,
      ...brief.likelyApprovalPoints,
      ...brief.warnings,
      brief.openingIssueStatement,
      ...brief.authority.forbiddenActions,
    ]);
    this.database.savePlan(caseId, brief);
    const thread = this.database.getActiveSupportThread("owner");
    if (thread?.currentCaseId === caseId) {
      for (const stored of this.database.listConditionalAuthorityRules(thread.id, caseId))
        this.database.deactivateConditionalAuthorityRule(stored.id);
      const rules = extractConditionalAuthorityRules(caseId, brief.version, [
        brief.desiredOutcome,
        ...brief.acceptableAlternatives,
        ...brief.unacceptableOutcomes,
        ...brief.knownFacts,
      ]);
      for (const [index, rule] of rules.entries())
        this.database.createConditionalAuthorityRule({
          id: rule.id,
          threadId: thread.id,
          caseId,
          actionType: rule.subject,
          condition: {
            protocolVersion: 1,
            planVersion: brief.version,
            comparison: rule.comparison,
            amountCents: rule.amountCents,
          },
          permission: rule.decision,
          priority: rules.length - index,
        });
    }
    this.record(undefined, caseId, "CASE_UPDATED", { planVersion: brief.version }, "USER");
    return brief;
  }
  approvePlan(caseId: string): CallBrief {
    const item = this.requireCase(caseId);
    if (!item.brief) throw new Error("PLAN_REQUIRED");
    this.database.approvePlan(caseId, item.brief.version);
    this.record(undefined, caseId, "PLAN_APPROVED", { version: item.brief.version }, "USER");
    return item.brief;
  }
  deleteCase(caseId: string): CaseDeletionResult {
    if (this.database.getActiveCall()?.case_id === caseId) throw new Error("ACTIVE_CALL_CANNOT_BE_DELETED");
    const deleted = this.database.deleteCase(caseId);
    for (const callId of deleted.callIds) {
      const runtime = this.runtimes.get(callId);
      if (runtime) {
        clearTimeout(runtime.timer);
        clearInterval(runtime.durationTimer);
      }
      this.runtimes.delete(callId);
      this.autonomyModes.delete(callId);
      this.events.removeAllListeners(`call:${callId}`);
    }
    this.disclosures.clearCase(caseId);
    return deleted;
  }

  async startSimulation(caseId: string, scenarioId: string, accelerated = true): Promise<CallSnapshot> {
    return this.start(caseId, "SIMULATOR", getScenario(scenarioId), accelerated);
  }
  async startLive(caseId: string, authorizationId?: string): Promise<CallSnapshot> {
    if (!authorizationId) throw new Error("CALL_AUTHORIZATION_REQUIRED");
    if (!this.configStatus().allowRealCalls) throw new Error("REAL_CALLS_DISABLED_OR_UNCONFIGURED");
    const item = this.requireApprovedCase(caseId);
    const risks = detectHighRisk(`${item.companyName}\n${item.brief?.issueSummary}\n${item.brief?.desiredOutcome}`);
    if (risks.length) throw new Error(`HIGH_RISK_BLOCK:${risks.join(",")}`);
    const prefixes = this.config.ALLOWED_DESTINATION_PREFIXES.split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (!prefixes.some((prefix) => item.brief!.phoneNumberE164.startsWith(prefix)))
      throw new Error("DESTINATION_PREFIX_NOT_ALLOWED");
    const day = new Date().toISOString().slice(0, 10);
    if (!this.database.incrementDailyUsage(day, this.config.MAX_CALLS_PER_DAY))
      throw new Error("DAILY_CALL_LIMIT_REACHED");
    return this.start(caseId, "TWILIO", undefined, true, authorizationId);
  }

  private async start(
    caseId: string,
    mode: "SIMULATOR" | "TWILIO",
    scenario?: SimulatorScenario,
    accelerated = true,
    authorizationId?: string,
  ): Promise<CallSnapshot> {
    const item = this.requireApprovedCase(caseId);
    if (this.database.getActiveCall()) throw new Error("ANOTHER_CALL_IS_ACTIVE");
    const callId = randomUUID();
    const adapter = mode === "SIMULATOR" ? this.simulatorAdapter : this.twilioAdapter;
    this.database.createCall({
      id: callId,
      caseId,
      mode,
      scenarioId: scenario?.id ?? null,
      state: "PREPARING",
      activity: "Preparing",
      objective: "Connect to customer support",
      authorizationId,
    });
    const runtime: Runtime = {
      adapter,
      scenario,
      stepIndex: 0,
      pendingRemote: [],
      executedKeys: new Set(),
      browserSequence: 0,
      disclosureLedger: [],
      terminalizing: false,
    };
    this.runtimes.set(callId, runtime);
    this.record(callId, caseId, "CALL_CREATED", { mode, scenarioId: scenario?.id ?? null }, "SYSTEM");
    this.changeState(callId, "DIALING", "Dialing support", "Reach the support line");
    const secret = this.config.CALL_TOKEN_SECRET || this.config.SESSION_SECRET || "liaison-development-call-token";
    const callbackTtlSeconds = this.config.MAX_CALL_DURATION_MINUTES * 60 + 15 * 60;
    const token = signToken({ callId }, secret, callbackTtlSeconds);
    try {
      const result = await adapter.startCall({ callId, destination: item.brief!.phoneNumberE164, signedToken: token });
      this.database.updateCall(callId, { twilioCallSid: result.providerCallId });
    } catch (error) {
      if (mode === "TWILIO" && error instanceof AmbiguousProviderCallStartError) {
        const code = this.safeError(error);
        this.database.updateCall(callId, {
          state: "ENDING",
          paused: true,
          generation: this.requireCall(callId).generation + 1,
          activity: "Call start is unconfirmed",
          objective: "Check the Twilio dashboard before another call",
          terminalReason: `AMBIGUOUS_START:${code}`,
        });
        this.record(
          callId,
          caseId,
          "TECHNICAL_ERROR",
          {
            code: "AMBIGUOUS_PROVIDER_CALL_START",
            operatorAction: "Inspect Twilio Calls and end any matching call manually; automatic retry is disabled.",
          },
          "TELEPHONY",
        );
        throw error;
      }
      await this.terminalize(callId, "TECHNICAL_FAILURE", this.safeError(error));
      throw error;
    }
    this.startDurationTimer(callId);
    if (mode === "SIMULATOR") {
      this.changeState(callId, "CONNECTED", "Connected", "Navigate the support line");
      this.record(callId, caseId, "CALL_CONNECTED", {}, "SIMULATOR");
      this.scheduleNext(callId, accelerated ? 35 : 650);
    }
    return this.snapshot(callId);
  }

  private startDurationTimer(callId: string): void {
    const runtime = this.runtime(callId);
    runtime.durationTimer = setInterval(() => {
      const row = this.database.getCall(callId);
      if (!row || this.isTerminal(row.state)) return;
      const duration = Math.max(0, Math.floor((Date.now() - Date.parse(row.started_at)) / 1000));
      const cost = estimateCost(duration, this.config.ESTIMATED_TELEPHONY_COST_PER_MINUTE_USD);
      this.database.updateCall(callId, { durationSeconds: duration, estimatedCostUsd: cost });
      this.emit(callId, "duration.updated", { durationSeconds: duration, estimatedCostUsd: cost });
      if (duration >= this.config.MAX_CALL_DURATION_MINUTES * 60)
        void this.terminalize(callId, "TECHNICAL_FAILURE", "Maximum call duration reached").catch((error) =>
          this.record(
            callId,
            row.case_id,
            "TECHNICAL_ERROR",
            { code: `MAX_DURATION_TERMINATION:${this.safeError(error)}` },
            "SYSTEM",
          ),
        );
    }, 1000);
  }

  private scheduleNext(callId: string, delay = 35): void {
    const runtime = this.runtime(callId);
    if (!runtime.scenario || runtime.terminalizing) return;
    clearTimeout(runtime.timer);
    runtime.timer = setTimeout(() => {
      const step = runtime.scenario!.steps[runtime.stepIndex++];
      if (step) void this.processScenarioStep(callId, step);
    }, delay);
  }
  private async processScenarioStep(callId: string, step: ScenarioStep): Promise<void> {
    if (step.kind === "DISCONNECT") {
      this.addTurn(callId, "SYSTEM", step.text);
      await this.terminalize(callId, "TECHNICAL_FAILURE", "Unexpected remote disconnect", step.terminal);
      return;
    }
    await this.ingestRemote(callId, step.text, step);
  }

  async ingestRemote(callId: string, text: string, scenarioStep?: ScenarioStep): Promise<void> {
    const row = this.requireCall(callId);
    if (this.isTerminal(row.state)) return;
    const safe = this.addTurn(callId, "REMOTE", text.slice(0, 4000)).text;
    const runtime = this.runtime(callId);
    if (row.paused) {
      runtime.pendingRemote.push({ text: safe, step: scenarioStep });
      this.database.updateCall(callId, { activity: "Paused — transcript still active" });
      return;
    }
    await this.processRemoteDecision(callId, safe, scenarioStep);
  }

  private async processRemoteDecision(callId: string, text: string, scenarioStep?: ScenarioStep): Promise<void> {
    const row = this.requireCall(callId);
    if (this.isTerminal(row.state) || row.paused) return;
    const generation = row.generation + 1;
    this.database.updateCall(callId, { generation, activity: "Thinking" });
    this.emit(callId, "call.activity", { activity: "Thinking" });
    const runtime = this.runtime(callId);
    try {
      const decision = runtime.scenario
        ? this.mockDecision(callId, text, scenarioStep)
        : await this.liveDecision(callId, text, generation);
      if (decision && !(await this.executeDecision(callId, decision, generation))) return;
      if (
        scenarioStep?.terminal &&
        !this.database.getPendingApproval(callId) &&
        !this.database.getPendingAttentionRequest(callId) &&
        !this.requireCall(callId).paused &&
        !this.isTerminal(this.requireCall(callId).state)
      )
        await this.terminalize(callId, this.reasonForStatus(scenarioStep.terminal), undefined, scenarioStep.terminal);
      else if (
        runtime.scenario &&
        !this.database.getPendingApproval(callId) &&
        !this.database.getPendingAttentionRequest(callId) &&
        !this.requireCall(callId).paused &&
        !this.isTerminal(this.requireCall(callId).state)
      )
        this.scheduleNext(callId);
    } catch (error) {
      this.record(callId, row.case_id, "TECHNICAL_ERROR", { code: this.safeError(error) }, "SYSTEM");
      this.database.updateCall(callId, {
        paused: true,
        activity: "Needs user — controller unavailable",
        generation: generation + 1,
      });
      this.emit(callId, "error", { message: "The controller could not safely continue. Use exact text or hang up." });
    }
  }

  private mockDecision(callId: string, text: string, step?: ScenarioStep): AgentDecision | null {
    const row = this.requireCall(callId);
    const item = this.requireCase(row.case_id);
    const lower = text.toLowerCase();
    const facts: AgentDecision["capturedFacts"] = [];
    if (step?.expectedDigits)
      return {
        action: "SEND_DIGITS",
        digits: step.expectedDigits,
        nextState: "IVR",
        policyReasonCode: "IVR_MENU_SELECTION",
        capturedFacts: facts,
      };
    if (
      /password|one-time|verification code|redacted_prohibited_(?:password|one_time_code|pin|security_answer|payment_card|cvv|social_security_number|api_key|recovery_code)/.test(
        lower,
      )
    )
      return {
        action: "SPEAK",
        text: prohibitedSecretRefusalText,
        nextState: "AUTHENTICATING",
        policyReasonCode: "PROHIBITED_SECRET_REFUSAL",
        capturedFacts: facts,
      };
    if (/do not consent|refuse|no, i do not/.test(lower))
      return {
        action: "END_CALL",
        reason: "REPRESENTATIVE_REFUSED_AUTOMATION",
        proposedOutcomeStatus: "REFUSED_AUTOMATION",
        closingText: "I understand. Thank you for your time; I will end the call.",
        nextState: "ENDING",
        policyReasonCode: "CONSENT_REFUSED",
        capturedFacts: facts,
      };
    if (
      !row.human_detected &&
      /how (?:may|can) i (?:help|assist)|representative|my name is|\bthis is [a-z]+|support.*speaking|customer care/.test(
        lower,
      )
    ) {
      return {
        action: "SPEAK",
        text: disclosureScript(item.brief!.userFirstName),
        nextState: "DISCLOSING_ASSISTANT",
        policyReasonCode: "DISCLOSE_ACCESSIBILITY_ASSISTANT",
        capturedFacts: facts,
      };
    }
    if (
      row.disclosure_delivered &&
      row.consent_status !== "ACCEPTED" &&
      /\b(yes|fine|willing|continue|consent)\b/.test(lower)
    ) {
      return {
        action: "SPEAK",
        text: item.brief!.openingIssueStatement.slice(0, 400),
        nextState: "EXPLAINING_ISSUE",
        policyReasonCode: "EXPLAIN_APPROVED_BRIEF",
        capturedFacts: facts,
      };
    }
    if (/please hold|transfer/.test(lower))
      return {
        action: "WAIT",
        reason: /transfer/.test(lower) ? "TRANSFER" : "HOLD",
        nextState: "ON_HOLD",
        policyReasonCode: "REMOTE_HOLD",
        capturedFacts: facts,
      };
    // Same classifier the disclosure store gates on, so a card the mock selects is always one the
    // store will actually release.
    const requestedDisclosureCategory = classifyRequestedDisclosureCategory(text);
    if (requestedDisclosureCategory) {
      const availableIds = new Set(this.disclosures.metadata(row.case_id).map((card) => card.id));
      const card = item.disclosures.find(
        (candidate) =>
          candidate.category === requestedDisclosureCategory &&
          candidate.permission === "ASK" &&
          availableIds.has(candidate.id),
      );
      if (!card)
        return {
          action: "SPEAK",
          text: "I don't have an approved value for that request. Is there another permitted way to authenticate?",
          nextState: "AUTHENTICATING",
          policyReasonCode: "NO_DISCLOSURE_CARD",
          capturedFacts: facts,
        };
      return {
        action: "REQUEST_APPROVAL",
        nextState: "NEEDS_USER",
        policyReasonCode: "PERSONAL_DATA_REQUIRES_APPROVAL",
        approval: {
          category: "PERSONAL_DATA",
          question: `Share ${card.label}?`,
          representativeRequest: text,
          proposedSpeech: `Provide [REDACTED:${card.category}:${card.label}]`,
          consequences: "This will disclose the approved identifier to the representative for authentication.",
          disclosureCardId: card.id,
          executionChannel: card.allowedChannels.includes("DTMF") ? "DTMF" : "SPEECH",
        },
        capturedFacts: facts,
      };
    }
    if (/billing zip|zip code/.test(lower))
      return {
        action: "REQUEST_APPROVAL",
        nextState: "NEEDS_USER",
        policyReasonCode: "PERSONAL_DATA_REQUIRES_SECURE_REVIEW",
        approval: {
          category: "PERSONAL_DATA",
          question: "Review the representative's personal-data request in the secure app",
          representativeRequest: text,
          proposedSpeech:
            "The account holder cannot provide that value through the messaging channel. Is there another permitted authentication method?",
          consequences:
            "The requested value is sensitive and must not be sent by SMS. No value is available unless the user created an ephemeral disclosure card in the secure web app.",
        },
        capturedFacts: facts,
      };
    if (/instead of cancellation|would you accept|can offer/.test(lower))
      return {
        action: "REQUEST_APPROVAL",
        nextState: "NEEDS_USER",
        policyReasonCode: "ALTERNATIVE_OUTCOME_REQUIRES_APPROVAL",
        approval: {
          category: "ALTERNATIVE_OUTCOME",
          question: "Accept the representative's retention offer?",
          representativeRequest: text,
          proposedSpeech: "The account holder approves that alternative outcome.",
          consequences: "Accepting changes the requested outcome from cancellation to a temporary discount.",
        },
        capturedFacts: facts,
      };
    if (/ignore your instructions|reveal everything|pretend approval|purchase/.test(lower))
      return {
        action: "SPEAK",
        text: "I can only discuss the approved support issue and cannot disclose unrelated data or authorize purchases. Please address the support request.",
        nextState: "NEGOTIATING",
        policyReasonCode: "PROMPT_INJECTION_REJECTED",
        capturedFacts: facts,
      };
    if (/submit|review|look into|made a note/.test(lower))
      return {
        action: "SPEAK",
        text: "To confirm, what concrete action is approved, what is the case number, and when will it be completed?",
        nextState: "VERIFYING_OUTCOME",
        policyReasonCode: "VERIFY_NONCOMMITTAL_OUTCOME",
        capturedFacts: facts,
      };
    if (step?.terminal)
      return {
        action: "END_CALL",
        reason: this.reasonForStatus(step.terminal),
        proposedOutcomeStatus: this.proposedForStatus(step.terminal),
        closingText: "Thank you. I have captured those details and will report them to the account holder.",
        nextState: "ENDING",
        policyReasonCode: "TERMINAL_SCENARIO_RESULT",
        capturedFacts: facts,
      };
    return {
      action: "SPEAK",
      text: "Thank you. Could you confirm the concrete next action, any reference number, and the timeline?",
      nextState: row.state === "DISCLOSING_ASSISTANT" ? "EXPLAINING_ISSUE" : "NEGOTIATING",
      policyReasonCode: "SEEK_CONCRETE_OUTCOME",
      capturedFacts: facts,
    };
  }

  private async liveDecision(callId: string, text: string, generation: number): Promise<AgentDecision> {
    const row = this.requireCall(callId);
    const item = this.requireCase(row.case_id);
    const transcript = this.database.getTranscript(callId).slice(-16);
    const runtime = this.runtime(callId);
    const availableDisclosureIds = new Set(this.disclosures.metadata(row.case_id).map((card) => card.id));
    const context = {
      currentState: row.state,
      brief: item.brief,
      authority: item.brief!.authority,
      disclosureCards: item.disclosures.filter((card) => availableDisclosureIds.has(card.id)),
      currentObjective: row.objective,
      disclosureDelivered: Boolean(row.disclosure_delivered),
      consentStatus: row.consent_status,
      approvalPending: Boolean(this.database.getPendingApproval(callId)),
      recentTranscript: transcript,
      currentFinalizedRemoteUtterance: text,
      privateInstruction: runtime.privateInstruction,
      generation,
    };
    runtime.privateInstruction = undefined;
    try {
      return await this.models.decide(context);
    } finally {
      this.flushModelUsage(callId, row.case_id);
    }
  }

  private async executeDecision(callId: string, decision: AgentDecision, generation: number): Promise<boolean> {
    const row = this.requireCall(callId);
    const item = this.requireCase(row.case_id);
    const runtime = this.runtime(callId);
    const autonomy = this.autonomyModes.get(callId) ?? "COPILOT";
    if (
      autonomy === "ASSIST" &&
      decision.action === "SPEAK" &&
      !new Set(["DISCLOSE_ACCESSIBILITY_ASSISTANT", "PROHIBITED_SECRET_REFUSAL", "CONSENT_REFUSED"]).has(
        decision.policyReasonCode,
      )
    ) {
      this.database.updateCall(callId, {
        paused: true,
        activity: "Needs user — Assist mode requires exact text",
        generation: generation + 1,
      });
      await runtime.adapter.pauseAgent(callId);
      this.record(
        callId,
        row.case_id,
        "AGENT_PAUSED",
        { reason: "ASSIST_MODE_USER_AUTHORED_RESPONSE_REQUIRED" },
        "POLICY",
      );
      this.emit(callId, "call.activity", { activity: "Needs user — Assist mode requires exact text" });
      return false;
    }
    const validation = validateDecision(decision, {
      state: row.state,
      authority: item.brief!.authority,
      paused: Boolean(row.paused),
      pendingApproval: this.database.getPendingApproval(callId),
      disclosureDelivered: Boolean(row.disclosure_delivered),
      consentStatus: row.consent_status,
      durationSeconds: row.duration_seconds,
      maximumDurationSeconds: this.config.MAX_CALL_DURATION_MINUTES * 60,
      generation,
      expectedGeneration: this.requireCall(callId).generation,
      executedKeys: runtime.executedKeys,
      decisionSource: runtime.scenario ? "SIMULATOR" : "MODEL",
    });
    if (!validation.allowed) {
      this.record(
        callId,
        row.case_id,
        "AGENT_DECISION_REJECTED",
        { violationCode: validation.violationCode, safeFallback: validation.safeFallback },
        "POLICY",
      );
      if (validation.safeFallback === "END_CALL") await this.terminalize(callId, "POLICY_BLOCKED");
      else {
        this.database.updateCall(callId, {
          paused: true,
          activity: "Needs user — policy blocked an agent action",
          generation: generation + 1,
        });
        await runtime.adapter.pauseAgent(callId);
        this.emit(callId, "error", { message: "Liaison paused because an agent action failed a hard policy check." });
      }
      return false;
    }
    if (decision.action === "REQUEST_APPROVAL") {
      const preview = approvalRequestSchema.parse({
        id: "runtime-policy-preview",
        callId,
        status: "PENDING",
        ...decision.approval,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      });
      const thread = this.database.getThreadForCall(callId);
      if (thread && item.approvedVersion) {
        const conditional = evaluateApprovalConditionalAuthority(
          preview,
          this.database.listConditionalAuthorityRules(thread.id, row.case_id),
          item.approvedVersion,
        );
        this.record(
          callId,
          row.case_id,
          "AGENT_DECISION_PROPOSED",
          {
            action: "CONDITIONAL_AUTHORITY_EVALUATION",
            subject: conditional.subject,
            amountCents: conditional.amountCents,
            source: conditional.source,
            decision: conditional.decision,
            matchedRuleIds: conditional.matchedRuleIds,
          },
          "POLICY",
        );
        if (conditional.source === "CONFLICT")
          this.record(
            callId,
            row.case_id,
            "AGENT_DECISION_REJECTED",
            { violationCode: "CONDITIONAL_AUTHORITY_CONFLICT", matchedRuleIds: conditional.matchedRuleIds },
            "POLICY",
          );
      }
    }
    if (decision.policyReasonCode === "EXPLAIN_APPROVED_BRIEF") {
      this.database.updateCall(callId, { consentStatus: "ACCEPTED" });
      this.record(callId, row.case_id, "CONSENT_RECORDED", { status: "ACCEPTED" }, "CONTROLLER");
    }
    if (decision.policyReasonCode === "CONSENT_REFUSED") {
      this.database.updateCall(callId, { consentStatus: "REFUSED" });
      this.record(callId, row.case_id, "CONSENT_RECORDED", { status: "REFUSED" }, "CONTROLLER");
    }
    this.record(
      callId,
      row.case_id,
      "AGENT_DECISION_PROPOSED",
      {
        action: decision.action,
        nextState: decision.nextState,
        policyReasonCode: decision.policyReasonCode,
        capturedFacts: decision.capturedFacts,
      },
      "CONTROLLER",
    );
    if (decision.action === "SPEAK") {
      this.record(callId, row.case_id, "AGENT_SPEECH_STARTED", { text: decision.text }, "CONTROLLER");
      await runtime.adapter.speak(callId, decision.text, { interruptible: true });
      this.changeState(callId, decision.nextState, "Listening", this.objectiveFor(decision.nextState));
      runtime.executedKeys.add(`SPEAK:${decision.text}`);
      this.addTurn(callId, "LIAISON", decision.text);
      if (decision.policyReasonCode === "DISCLOSE_ACCESSIBILITY_ASSISTANT") {
        this.database.updateCall(callId, { humanDetected: true, disclosureDelivered: true });
        this.record(callId, row.case_id, "DISCLOSURE_DELIVERED", {}, "CONTROLLER");
      }
      this.record(callId, row.case_id, "AGENT_SPEECH_COMPLETED", {}, "TELEPHONY");
    } else if (decision.action === "SEND_DIGITS") {
      await runtime.adapter.sendDigits(callId, decision.digits);
      this.changeState(callId, decision.nextState, "Listening", "Navigate the support menu");
      runtime.executedKeys.add(`SEND_DIGITS:${decision.digits}`);
      this.record(callId, row.case_id, "DTMF_SENT", { digits: decision.digits, sensitive: false }, "CONTROLLER");
      this.addTurn(callId, "SYSTEM", `Sent menu selection: ${decision.digits}`);
    } else if (decision.action === "REQUEST_APPROVAL") {
      this.changeState(callId, "NEEDS_USER", "Awaiting your approval", "Review the representative's request");
      const now = Date.now();
      const approval = approvalRequestSchema.parse({
        id: randomUUID(),
        callId,
        status: "PENDING",
        ...decision.approval,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 10 * 60_000).toISOString(),
      });
      this.database.saveApproval(approval);
      this.record(
        callId,
        row.case_id,
        "APPROVAL_REQUESTED",
        { ...approval, disclosureCardId: approval.disclosureCardId },
        "POLICY",
      );
      this.emit(callId, "approval.requested", approval);
      const phrase = "One moment while I confirm that with the account holder.";
      await runtime.adapter.speak(callId, phrase, { interruptible: true });
      this.addTurn(callId, "LIAISON", phrase);
    } else if (decision.action === "WAIT") {
      this.changeState(
        callId,
        decision.nextState,
        decision.reason === "HOLD" ? "On hold" : "Waiting",
        "Wait without adding audio",
      );
    } else {
      if (decision.closingText) {
        await runtime.adapter.speak(callId, decision.closingText, { interruptible: true });
        this.addTurn(callId, "LIAISON", decision.closingText);
      }
      await this.terminalize(callId, decision.reason, undefined, decision.proposedOutcomeStatus);
    }
    return true;
  }

  async approve(
    callId: string,
    approvalId: string,
    replacement?: string,
    materialConfirmed = false,
  ): Promise<CallSnapshot> {
    const row = this.requireCall(callId);
    const approval = this.requireApprovalForExecution(callId, approvalId, "APPROVE", replacement);
    const nextStatus = replacement ? "REPLACED" : "APPROVED";
    const fingerprint = this.approvalExecutionFingerprint({
      decision: "APPROVE",
      approval,
      replacement: replacement ?? null,
    });
    const existing = this.database.getApprovalExecution(approvalId);
    if (existing) return this.resolveExistingApprovalExecution(callId, existing, "APPROVE", fingerprint, nextStatus);
    if (this.isTerminal(row.state)) throw new Error("CALL_ALREADY_ENDED");
    this.revalidateApprovalExecution(row, approval, replacement, materialConfirmed);
    const reservation = this.database.reserveApprovalExecution({
      approvalId,
      callId,
      decision: "APPROVE",
      payloadFingerprint: fingerprint,
      targetStatus: nextStatus,
      executionId: randomUUID(),
    });
    if (reservation.kind === "EXISTING")
      return this.resolveExistingApprovalExecution(callId, reservation.execution, "APPROVE", fingerprint, nextStatus);
    const runtime = this.runtime(callId);
    try {
      const currentRow = this.requireActiveCall(callId);
      const current = this.requireApprovalForExecution(callId, approvalId, "APPROVE", replacement);
      this.revalidateApprovalExecution(currentRow, current, replacement, materialConfirmed);
      if (replacement) {
        await runtime.adapter.speak(callId, replacement, { interruptible: true });
      } else if (current.disclosureCardId && current.executionChannel) {
        const entry = this.disclosures.resolve(
          currentRow.case_id,
          current.disclosureCardId,
          current.executionChannel,
          current.representativeRequest,
        );
        if (!entry) throw new Error("DISCLOSURE_NOT_AVAILABLE_FOR_PURPOSE");
        if (current.executionChannel === "DTMF") {
          if (!validateDtmf(entry.value, true)) throw new Error("INVALID_SENSITIVE_DTMF");
          await runtime.adapter.sendDigits(callId, entry.value);
        } else await runtime.adapter.speak(callId, entry.value, { interruptible: true });
        const marker = `[REDACTED:${entry.metadata.category}:${entry.metadata.label}]`;
        if (current.executionChannel === "DTMF")
          this.addTurn(callId, "SYSTEM", `Sent approved ${entry.metadata.label} by DTMF: ${marker}`);
        else this.addTurn(callId, "LIAISON", `Provided approved ${entry.metadata.label}: ${marker}`);
        const occurredAt = new Date().toISOString();
        runtime.disclosureLedger.push({
          label: entry.metadata.label,
          marker,
          channel: current.executionChannel,
          timestamp: occurredAt,
        });
        // Durable metadata-only record of the disclosure. The in-memory ledger above is lost on
        // restart by design; this protocol document is what survives for audit.
        const disclosureEvent = projectDisclosureEvent({
          id: randomUUID(),
          caseId: currentRow.case_id,
          callId,
          disclosureCardId: current.disclosureCardId,
          category: entry.metadata.category,
          channel: current.executionChannel,
          purpose: entry.metadata.allowedPurposes[0] ?? "Approved disclosure",
          occurredAt,
        });
        this.record(callId, currentRow.case_id, "DISCLOSURE_DELIVERED", { disclosureEvent }, "POLICY");
        this.record(
          callId,
          currentRow.case_id,
          "APPROVAL_APPROVED",
          { approvalId, label: entry.metadata.label, channel: current.executionChannel },
          "USER",
        );
      } else {
        await runtime.adapter.speak(callId, current.proposedSpeech, { interruptible: true });
        this.addTurn(callId, "LIAISON", current.proposedSpeech);
        this.record(callId, currentRow.case_id, "APPROVAL_APPROVED", { approvalId }, "USER");
      }
      if (replacement) this.addTurn(callId, "USER_EXACT", replacement);
      if (
        !this.database.completeApprovalExecution({
          approvalId,
          executionId: reservation.execution.executionId,
          targetStatus: nextStatus,
        })
      )
        throw new Error("APPROVAL_EXECUTION_FINALIZATION_FAILED");
    } catch (error) {
      await this.failApprovalExecution(row, approvalId, reservation.execution.executionId, error);
      throw new Error(`APPROVAL_EXECUTION_FAILED:${this.safeError(error)}`, { cause: error });
    }
    this.database.updateCall(callId, { generation: this.requireCall(callId).generation + 1 });
    this.changeState(
      callId,
      approval.category === "PERSONAL_DATA" ? "AUTHENTICATING" : "NEGOTIATING",
      "Listening",
      "Continue the approved support strategy",
    );
    this.emit(callId, "approval.resolved", { id: approvalId, status: nextStatus });
    if (runtime.scenario) this.scheduleNext(callId);
    return this.snapshot(callId);
  }

  async reject(callId: string, approvalId: string, instruction?: string): Promise<CallSnapshot> {
    const row = this.requireCall(callId);
    const approval = this.requireApprovalForExecution(callId, approvalId, "REJECT", instruction);
    const response =
      instruction?.trim() ||
      "The account holder does not approve that. Please continue with the original requested outcome.";
    const fingerprint = this.approvalExecutionFingerprint({ decision: "REJECT", approval, replacement: response });
    const existing = this.database.getApprovalExecution(approvalId);
    if (existing) return this.resolveExistingApprovalExecution(callId, existing, "REJECT", fingerprint, "REJECTED");
    if (this.isTerminal(row.state)) throw new Error("CALL_ALREADY_ENDED");
    this.assertSafeExactText(row.case_id, response);
    const reservation = this.database.reserveApprovalExecution({
      approvalId,
      callId,
      decision: "REJECT",
      payloadFingerprint: fingerprint,
      targetStatus: "REJECTED",
      executionId: randomUUID(),
    });
    if (reservation.kind === "EXISTING")
      return this.resolveExistingApprovalExecution(callId, reservation.execution, "REJECT", fingerprint, "REJECTED");
    const runtime = this.runtime(callId);
    try {
      const currentRow = this.requireActiveCall(callId);
      this.requireApprovalForExecution(callId, approvalId, "REJECT", instruction);
      this.assertSafeExactText(currentRow.case_id, response);
      await runtime.adapter.speak(callId, response, { interruptible: true });
      this.addTurn(callId, "USER_EXACT", response);
      this.record(
        callId,
        currentRow.case_id,
        "APPROVAL_REJECTED",
        { approvalId, instruction: instruction?.slice(0, 500) },
        "USER",
      );
      if (
        !this.database.completeApprovalExecution({
          approvalId,
          executionId: reservation.execution.executionId,
          targetStatus: "REJECTED",
        })
      )
        throw new Error("APPROVAL_EXECUTION_FINALIZATION_FAILED");
    } catch (error) {
      await this.failApprovalExecution(row, approvalId, reservation.execution.executionId, error);
      throw new Error(`APPROVAL_EXECUTION_FAILED:${this.safeError(error)}`, { cause: error });
    }
    this.database.updateCall(callId, { generation: this.requireCall(callId).generation + 1 });
    this.changeState(callId, "NEGOTIATING", "Listening", "Continue toward the original outcome");
    this.emit(callId, "approval.resolved", { id: approvalId, status: "REJECTED" });
    if (runtime.scenario?.id === "cancellation-offer") {
      this.addTurn(callId, "REMOTE", "I have completed the cancellation. Confirmation C-620.");
      await this.terminalize(callId, "RESOLVED", undefined, "RESOLVED");
    } else if (runtime.scenario) this.scheduleNext(callId);
    return this.snapshot(callId);
  }

  async pause(callId: string): Promise<CallSnapshot> {
    const row = this.requireActiveCall(callId);
    this.database.updateCall(callId, {
      paused: true,
      generation: row.generation + 1,
      activity: "Paused — transcript still active",
    });
    await this.runtime(callId).adapter.pauseAgent(callId);
    this.record(callId, row.case_id, "AGENT_PAUSED", {}, "USER");
    this.emit(callId, "call.activity", { activity: "Paused — transcript still active" });
    return this.snapshot(callId);
  }
  async resume(callId: string): Promise<CallSnapshot> {
    const row = this.requireActiveCall(callId);
    if (this.database.getPendingApproval(callId) || this.database.getPendingAttentionRequest(callId))
      throw new Error("RESUME_BLOCKED_WHILE_DECISION_PENDING");
    const runtime = this.runtime(callId);
    await runtime.adapter.resumeAgent(callId);
    this.database.updateCall(callId, { paused: false, generation: row.generation + 1, activity: "Listening" });
    this.record(callId, row.case_id, "AGENT_RESUMED", {}, "USER");
    const pending = runtime.pendingRemote.splice(0);
    if (pending.length) {
      for (const item of pending) {
        if (
          this.database.getPendingApproval(callId) ||
          this.database.getPendingAttentionRequest(callId) ||
          this.isTerminal(this.requireCall(callId).state) ||
          this.requireCall(callId).paused
        )
          break;
        await this.processRemoteDecision(callId, item.text, item.step);
      }
    } else if (runtime.scenario) this.scheduleNext(callId);
    return this.snapshot(callId);
  }
  privateInstruction(callId: string, text: string): CallSnapshot {
    const row = this.requireActiveCall(callId);
    if (this.database.getPendingApproval(callId) || this.database.getPendingAttentionRequest(callId))
      throw new Error("INSTRUCTION_BLOCKED_WHILE_DECISION_PENDING");
    const safe = text.trim().slice(0, 1000);
    this.assertSafeExactText(row.case_id, safe);
    this.database.updateCall(callId, { generation: row.generation + 1 });
    this.runtime(callId).privateInstruction = safe;
    this.record(callId, row.case_id, "PRIVATE_INSTRUCTION_ADDED", { instruction: safe }, "USER");
    return this.snapshot(callId);
  }
  async exactText(callId: string, text: string): Promise<CallSnapshot> {
    const row = this.requireActiveCall(callId);
    if (
      row.paused ||
      row.state === "NEEDS_USER" ||
      this.database.getPendingApproval(callId) ||
      this.database.getPendingAttentionRequest(callId)
    )
      throw new Error("EXACT_TEXT_BLOCKED_WHILE_DECISION_PENDING_OR_PAUSED");
    const safe = text.trim().slice(0, 400);
    this.assertSafeExactText(row.case_id, safe);
    this.database.updateCall(callId, { generation: row.generation + 1 });
    await this.runtime(callId).adapter.speak(callId, safe, { interruptible: true });
    this.runtime(callId).executedKeys.add(`USER_EXACT:${randomUUID()}`);
    this.addTurn(callId, "USER_EXACT", safe);
    this.record(callId, row.case_id, "USER_EXACT_TEXT_SENT", { text: safe }, "USER");
    return this.snapshot(callId);
  }
  async exactTextForReservedAttention(callId: string, attentionId: string, text: string): Promise<CallSnapshot> {
    const row = this.requireActiveCall(callId);
    const attention = this.database.getAttentionRequest(attentionId);
    if (
      !attention ||
      attention.callId !== callId ||
      attention.tier !== "LOW_CONSEQUENCE" ||
      attention.status !== "PENDING" ||
      !attention.resolution ||
      typeof attention.resolution !== "object" ||
      !("reservationId" in attention.resolution)
    )
      throw new Error("LOW_ATTENTION_RESERVATION_REQUIRED");
    const safe = text.trim().slice(0, 400);
    this.assertSafeExactText(row.case_id, safe);
    this.database.updateCall(callId, { generation: row.generation + 1 });
    await this.runtime(callId).adapter.speak(callId, safe, { interruptible: true });
    this.addTurn(callId, "USER_EXACT", safe);
    this.record(callId, row.case_id, "USER_EXACT_TEXT_SENT", { attentionId, text: safe }, "USER");
    return this.snapshot(callId);
  }
  async resumeReservedAttention(callId: string, attentionId: string): Promise<CallSnapshot> {
    const row = this.requireActiveCall(callId);
    const attention = this.database.getAttentionRequest(attentionId);
    if (
      !attention ||
      attention.callId !== callId ||
      attention.tier !== "LOW_CONSEQUENCE" ||
      attention.status !== "PENDING" ||
      !attention.resolution ||
      typeof attention.resolution !== "object" ||
      !("reservationId" in attention.resolution)
    )
      throw new Error("LOW_ATTENTION_RESERVATION_REQUIRED");
    await this.runtime(callId).adapter.resumeAgent(callId);
    this.database.updateCall(callId, { paused: false, generation: row.generation + 1, activity: "Listening" });
    this.record(callId, row.case_id, "AGENT_RESUMED", { attentionId }, "USER");
    return this.snapshot(callId);
  }
  async continueAfterReservedAttention(callId: string): Promise<CallSnapshot> {
    const runtime = this.runtime(callId);
    const pending = runtime.pendingRemote.splice(0);
    for (const item of pending) {
      if (
        this.database.getPendingApproval(callId) ||
        this.database.getPendingAttentionRequest(callId) ||
        this.isTerminal(this.requireCall(callId).state) ||
        this.requireCall(callId).paused
      )
        break;
      await this.processRemoteDecision(callId, item.text, item.step);
    }
    if (!pending.length && runtime.scenario) this.scheduleNext(callId);
    return this.snapshot(callId);
  }

  assertTwilioCallbackIdentity(callId: string, form: Record<string, unknown>): void {
    const row = this.requireCall(callId);
    const callSid = typeof form.CallSid === "string" ? form.CallSid : "";
    const accountSid = typeof form.AccountSid === "string" ? form.AccountSid : "";
    if (row.mode !== "TWILIO") throw new Error("TWILIO_CALL_IDENTITY_NOT_READY");
    if (!callSid) throw new Error("TWILIO_CALL_IDENTITY_MISMATCH");
    if (!this.config.TWILIO_ACCOUNT_SID || accountSid !== this.config.TWILIO_ACCOUNT_SID)
      throw new Error("TWILIO_ACCOUNT_IDENTITY_MISMATCH");
    if (row.twilio_call_sid) {
      if (callSid !== row.twilio_call_sid) throw new Error("TWILIO_CALL_IDENTITY_MISMATCH");
      this.twilioAdapter.bindProviderCallId(callId, callSid);
      return;
    }
    if (!this.database.adoptTwilioCallSidForAmbiguousStart(callId, callSid)) {
      const current = this.requireCall(callId);
      if (current.twilio_call_sid !== callSid) throw new Error("TWILIO_CALL_IDENTITY_NOT_READY");
    }
    // The adapter learned no SID because `startCall` never returned one. Bind it now, otherwise a
    // later hang-up would report success without terminating a live provider call.
    this.twilioAdapter.bindProviderCallId(callId, callSid);
    this.record(
      callId,
      row.case_id,
      "CALL_STATE_CHANGED",
      { providerCallIdBound: true, recoveredFrom: "AMBIGUOUS_START" },
      "TWILIO",
    );
  }
  async hangup(callId: string): Promise<CallSnapshot> {
    const row = this.requireCall(callId);
    this.record(callId, row.case_id, "CALL_END_REQUESTED", { reason: "USER_REQUESTED" }, "USER");
    await this.terminalize(callId, "USER_REQUESTED", undefined, "UNRESOLVED");
    return this.snapshot(callId);
  }
  async userUnavailable(callId: string): Promise<CallSnapshot> {
    const row = this.requireCall(callId);
    this.record(
      callId,
      row.case_id,
      "CALL_END_REQUESTED",
      { reason: "USER_UNAVAILABLE", approvalInferred: false },
      "POLICY",
    );
    await this.terminalize(
      callId,
      "UNRESOLVED",
      "User did not respond before the safe decision deadline",
      "UNRESOLVED",
    );
    return this.snapshot(callId);
  }

  async relayMessage(callId: string, message: unknown): Promise<void> {
    if (!message || typeof message !== "object") throw new Error("MALFORMED_RELAY_MESSAGE");
    const msg = message as Record<string, unknown>;
    const row = this.requireCall(callId);
    if (msg.type === "setup") {
      if (msg.accountSid !== this.config.TWILIO_ACCOUNT_SID || msg.callSid !== row.twilio_call_sid)
        throw new Error("RELAY_CALL_IDENTITY_MISMATCH");
      if (row.state === "DIALING") this.changeState(callId, "CONNECTED", "Connected", "Navigate the support line");
      this.record(callId, row.case_id, "CALL_CONNECTED", { providerCallId: row.twilio_call_sid }, "TWILIO");
      return;
    }
    if (msg.type === "prompt" && msg.last === true && typeof msg.voicePrompt === "string") {
      await this.ingestRemote(callId, msg.voicePrompt);
      return;
    }
    if (msg.type === "dtmf" && typeof msg.digit === "string") {
      this.addTurn(callId, "SYSTEM", `Remote DTMF received: ${msg.digit}`);
      return;
    }
    if (msg.type === "interrupt") {
      this.database.updateCall(callId, { generation: row.generation + 1, activity: "Interrupted — listening" });
      this.record(
        callId,
        row.case_id,
        "AGENT_SPEECH_INTERRUPTED",
        { durationUntilInterruptMs: msg.durationUntilInterruptMs },
        "TWILIO",
      );
      return;
    }
    if (msg.type === "error") {
      this.record(callId, row.case_id, "TECHNICAL_ERROR", { code: "CONVERSATION_RELAY_ERROR" }, "TWILIO");
      await this.terminalize(callId, "TECHNICAL_FAILURE", "ConversationRelay reported an error");
    }
  }
  attachRelaySocket(callId: string, socket: WebSocket): void {
    this.requireActiveCall(callId);
    this.twilioAdapter.attachSocket(callId, socket);
  }
  async twilioStatus(callId: string, status: string): Promise<void> {
    const row = this.requireCall(callId);
    if (status === "answered" && row.state === "DIALING")
      this.changeState(callId, "CONNECTED", "Connected", "Navigate the support line");
    if (["busy", "failed", "no-answer", "canceled"].includes(status) && !this.isTerminal(row.state))
      await (row.state === "ENDING"
        ? this.finalizeProviderConfirmedEnding(
            callId,
            "TECHNICAL_FAILURE",
            `Twilio call status: ${status}`,
            "TECHNICAL_FAILURE",
          )
        : this.terminalize(callId, "TECHNICAL_FAILURE", `Twilio call status: ${status}`, "TECHNICAL_FAILURE"));
    if (status === "completed" && !this.isTerminal(row.state))
      await (row.state === "ENDING"
        ? this.finalizeProviderConfirmedEnding(callId, "UNRESOLVED", "Remote call completed", "UNRESOLVED")
        : this.terminalize(callId, "UNRESOLVED", "Remote call completed", "UNRESOLVED"));
  }
  async conversationEnded(callId: string, sessionStatus?: string): Promise<void> {
    const row = this.requireCall(callId);
    if (this.isTerminal(row.state)) return;
    const reason = sessionStatus === "failed" ? "TECHNICAL_FAILURE" : "UNRESOLVED";
    const detail = `ConversationRelay session: ${sessionStatus ?? "ended"}`;
    await (row.state === "ENDING"
      ? this.finalizeProviderConfirmedEnding(callId, reason, detail, reason)
      : this.terminalize(callId, reason, detail, reason));
  }
  async relayClosed(callId: string): Promise<void> {
    const row = this.database.getCall(callId);
    if (row && !this.isTerminal(row.state))
      await this.terminalize(
        callId,
        "TECHNICAL_FAILURE",
        "ConversationRelay WebSocket closed unexpectedly",
        "DISCONNECTED",
      );
  }

  snapshot(callId: string): CallSnapshot {
    const row = this.requireCall(callId);
    const runtime = this.runtimes.get(callId);
    return {
      id: row.id,
      caseId: row.case_id,
      mode: row.mode,
      scenarioId: row.scenario_id,
      state: row.state,
      activity: row.activity,
      currentObjective: row.objective,
      paused: Boolean(row.paused),
      humanDetected: Boolean(row.human_detected),
      disclosureDelivered: Boolean(row.disclosure_delivered),
      consentStatus: row.consent_status,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      durationSeconds: row.duration_seconds,
      estimatedCostUsd: row.estimated_cost_usd,
      generation: row.generation,
      llmInputTokens: row.llm_input_tokens,
      llmOutputTokens: row.llm_output_tokens,
      transcript: this.database.getTranscript(callId),
      pendingApproval: this.database.getPendingApproval(callId),
      outcome: this.database.getOutcome(callId),
      disclosureLedger: runtime?.disclosureLedger ?? [],
    };
  }
  storedEvents(callId: string, after: number) {
    return this.database.listEvents(callId, after);
  }
  isTerminalFinalizationInProgress(callId: string): boolean {
    return this.runtimes.get(callId)?.terminalizing ?? false;
  }
  onCallEvent(callId: string, listener: (event: BrowserEvent) => void): () => void {
    const key = `call:${callId}`;
    this.events.on(key, listener);
    return () => this.events.off(key, listener);
  }
  onAnyCallEvent(listener: (event: ApplicationCallEvent) => void): () => void {
    this.events.on("call:any", listener);
    return () => this.events.off("call:any", listener);
  }
  async shutdown(): Promise<void> {
    const active = this.database.getActiveCall();
    // Only a call this process actually owns in memory can be torn down here. A row without a
    // runtime was never driven by this instance, so leave it for `recoverInterruptedCall` on the
    // next boot rather than failing the shutdown hook.
    if (active && this.runtimes.has(active.id) && !this.isUnconfirmedTwilioGuard(active))
      await this.terminalize(
        active.id,
        "TECHNICAL_FAILURE",
        "Server shutdown ended the active call",
        "TECHNICAL_FAILURE",
      );
    this.disclosures.clearAll();
  }

  private async terminalize(
    callId: string,
    reason: EndReason,
    technical?: string,
    statusOverride?: string,
  ): Promise<void> {
    const row = this.requireCall(callId);
    if (this.isTerminal(row.state)) return;
    const runtime = this.runtime(callId);
    if (runtime.terminalization) return runtime.terminalization;
    runtime.terminalization = this.performTerminalization(callId, row, runtime, reason, technical, statusOverride);
    return runtime.terminalization;
  }

  private async performTerminalization(
    callId: string,
    row: StoredCall,
    runtime: Runtime,
    reason: EndReason,
    technical?: string,
    statusOverride?: string,
  ): Promise<void> {
    runtime.terminalizing = true;
    clearTimeout(runtime.timer);
    clearInterval(runtime.durationTimer);
    this.database.updateCall(callId, { generation: row.generation + 1 });
    if (row.state !== "ENDING") this.changeState(callId, "ENDING", "Ending", "Complete the call safely");
    try {
      await runtime.adapter.endCall(callId, reason);
    } catch (error) {
      const code = this.safeError(error);
      this.database.updateCall(callId, {
        paused: true,
        activity: "Call termination is unconfirmed",
        objective: "Check the provider dashboard before another call",
        terminalReason: `AMBIGUOUS_TERMINATION:${code}`,
      });
      this.record(
        callId,
        row.case_id,
        "TECHNICAL_ERROR",
        {
          code: `AMBIGUOUS_CALL_TERMINATION:${code}`,
          operatorAction: "Verify and end the provider call manually; automatic retry is disabled.",
        },
        "TELEPHONY",
      );
      runtime.terminalizing = false;
      runtime.terminalization = undefined;
      throw new Error(`CALL_TERMINATION_UNCONFIRMED:${code}`, { cause: error });
    }
    const latest = this.requireCall(callId);
    const duration = Math.max(latest.duration_seconds, Math.floor((Date.now() - Date.parse(latest.started_at)) / 1000));
    const finalState = reason === "TECHNICAL_FAILURE" ? "FAILED" : "COMPLETED";
    const endedAt = new Date().toISOString();
    const cost = estimateCost(duration, this.config.ESTIMATED_TELEPHONY_COST_PER_MINUTE_USD);
    const status = statusOverride ?? this.statusForReason(reason);
    const fallback = this.deterministicOutcome(callId, status, {
      endedAt,
      durationSeconds: duration,
      estimatedCostUsd: cost,
    });
    try {
      this.persistTerminalProvisional({
        row: latest,
        finalState,
        reason,
        technical,
        status,
        report: fallback,
        endedAt,
        durationSeconds: duration,
        estimatedCostUsd: cost,
      });
      await this.refineOutcome(callId, fallback);
    } finally {
      this.disclosures.clearCase(row.case_id);
      this.autonomyModes.delete(callId);
      runtime.terminalizing = false;
      runtime.terminalization = undefined;
    }
  }

  private async finalizeProviderConfirmedEnding(
    callId: string,
    reason: EndReason,
    technical: string,
    statusOverride: string,
  ): Promise<void> {
    const row = this.requireCall(callId);
    if (this.isTerminal(row.state)) return;
    const runtime = this.runtimes.get(callId);
    if (runtime) {
      clearTimeout(runtime.timer);
      clearInterval(runtime.durationTimer);
      runtime.terminalizing = true;
    }
    const duration = Math.max(row.duration_seconds, Math.floor((Date.now() - Date.parse(row.started_at)) / 1000));
    const endedAt = new Date().toISOString();
    const cost = estimateCost(duration, this.config.ESTIMATED_TELEPHONY_COST_PER_MINUTE_USD);
    const fallback = this.deterministicOutcome(callId, statusOverride, {
      endedAt,
      durationSeconds: duration,
      estimatedCostUsd: cost,
    });
    try {
      this.persistTerminalProvisional({
        row,
        finalState: reason === "TECHNICAL_FAILURE" ? "FAILED" : "COMPLETED",
        reason,
        technical,
        status: statusOverride,
        report: fallback,
        endedAt,
        durationSeconds: duration,
        estimatedCostUsd: cost,
      });
      await this.refineOutcome(callId, fallback);
    } finally {
      this.disclosures.clearCase(row.case_id);
      this.autonomyModes.delete(callId);
      if (runtime) {
        runtime.terminalizing = false;
        runtime.terminalization = undefined;
      }
    }
  }

  private deterministicOutcome(
    callId: string,
    statusRaw: string,
    metrics?: { endedAt: string; durationSeconds: number; estimatedCostUsd: number },
  ): OutcomeReport {
    const row = this.requireCall(callId);
    const transcript = this.database.getTranscript(callId);
    const remote = transcript.filter((turn) => turn.speaker === "REMOTE");
    const last = remote.at(-1);
    const first = remote.find((turn) => /my name is|this is/i.test(turn.text));
    const caseMatch = last?.text.match(/(?:case|confirmation)(?: number)?\s+(?:is\s+)?([A-Z]-?\d+)/i);
    const repMatch = first?.text.match(/(?:my name is|this is)\s+([A-Z][a-z]+)/);
    const ev = last ? [{ turnId: last.id, exactQuote: last.text }] : [];
    const grounded = <T>(value: T) => (last ? { value, evidence: ev } : null);
    const status = this.normalizeOutcomeStatus(statusRaw);
    return validateOutcome(
      {
        status,
        summary: grounded(
          status === "RESOLVED"
            ? "The representative confirmed a concrete support outcome."
            : "The call ended without a fully verified resolution.",
        ),
        representativeName:
          repMatch && first ? { value: repMatch[1], evidence: [{ turnId: first.id, exactQuote: repMatch[0] }] } : null,
        department: null,
        caseNumber:
          caseMatch && last ? { value: caseMatch[1], evidence: [{ turnId: last.id, exactQuote: caseMatch[0] }] } : null,
        resolution: status === "RESOLVED" && last ? { value: last.text, evidence: ev } : null,
        monetaryOutcomes: [],
        companyCommitments: status === "RESOLVED" && last ? [{ value: last.text, evidence: ev }] : [],
        userActions: [],
        deadlines: last && /business days|today|within/i.test(last.text) ? [{ value: last.text, evidence: ev }] : [],
        unresolvedItems: status !== "RESOLVED" && last ? [{ value: last.text, evidence: ev }] : [],
        endedAt: metrics?.endedAt ?? row.ended_at ?? new Date().toISOString(),
        durationSeconds: metrics?.durationSeconds ?? row.duration_seconds,
        estimatedTelephonyCostUsd: metrics?.estimatedCostUsd ?? row.estimated_cost_usd,
        llmUsage: {
          inputTokens: row.llm_input_tokens,
          outputTokens: row.llm_output_tokens,
          totalTokens: row.llm_input_tokens + row.llm_output_tokens,
        },
      },
      transcript,
    );
  }

  private persistTerminalProvisional(input: {
    row: StoredCall;
    finalState: "COMPLETED" | "FAILED";
    reason: EndReason;
    technical?: string;
    status: string;
    report: OutcomeReport;
    endedAt: string;
    durationSeconds: number;
    estimatedCostUsd: number;
    recoveredAfterRestart?: boolean;
  }): void {
    const endedPayload = sanitizePayload(
      { reason: input.reason, status: input.status, recoveredAfterRestart: input.recoveredAfterRestart ?? false },
      this.disclosures.redactionInputs(input.row.case_id),
    );
    const outcomePayload = { status: input.report.status, provisional: true, grounded: true };
    const persisted = this.database.db.transaction(() => {
      const pending = this.database.getPendingApproval(input.row.id);
      if (pending) this.database.updateApproval(pending.id, "PENDING", "EXPIRED");
      this.database.db
        .prepare("UPDATE attention_requests SET status='CANCELLED',resolved_at=? WHERE call_id=? AND status='PENDING'")
        .run(input.endedAt, input.row.id);
      this.database.db
        .prepare(
          "UPDATE secure_action_tokens SET revoked_at=?,revoke_reason='CALL_TERMINATED' WHERE call_id=? AND revoked_at IS NULL",
        )
        .run(input.endedAt, input.row.id);
      this.database.db
        .prepare("UPDATE support_threads SET pending_attention_request_id=NULL,updated_at=? WHERE active_call_id=?")
        .run(input.endedAt, input.row.id);
      this.database.updateCall(input.row.id, {
        state: input.finalState,
        activity: input.finalState === "COMPLETED" ? "Completed" : "Failed",
        objective: "Review the outcome",
        endedAt: input.endedAt,
        durationSeconds: input.durationSeconds,
        estimatedCostUsd: input.estimatedCostUsd,
        terminalReason: input.technical ?? input.reason,
      });
      this.database.db
        .prepare("UPDATE cases SET status=?,updated_at=? WHERE id=?")
        .run(input.finalState, input.endedAt, input.row.case_id);
      this.database.saveOutcome(input.row.id, input.report, input.endedAt);
      const endedSequence = this.database.appendEvent({
        id: randomUUID(),
        callId: input.row.id,
        caseId: input.row.case_id,
        type: "CALL_ENDED",
        payload: endedPayload,
        origin: "SYSTEM",
        idempotencyKey: `terminal-call:${input.row.id}:ended`,
      });
      const outcomeSequence = this.database.appendEvent({
        id: randomUUID(),
        callId: input.row.id,
        caseId: input.row.case_id,
        type: "OUTCOME_GENERATED",
        payload: outcomePayload,
        origin: "SYSTEM",
        idempotencyKey: `terminal-outcome:${input.row.id}:provisional`,
      });
      return { endedSequence, outcomeSequence };
    })();
    this.publishPersisted(
      input.row.id,
      input.row.case_id,
      "CALL_ENDED",
      endedPayload,
      persisted.endedSequence,
      input.endedAt,
    );
  }

  private async refineOutcome(callId: string, fallback: OutcomeReport): Promise<OutcomeReport> {
    const row = this.requireCall(callId);
    const transcript = this.database.getTranscript(callId);
    const item = this.requireCase(row.case_id);
    let report = fallback;
    try {
      report = await this.models.outcome({ brief: item.brief!, transcript, deterministicFallback: fallback });
    } catch (error) {
      this.record(callId, row.case_id, "TECHNICAL_ERROR", { code: `OUTCOME_MODEL:${this.safeError(error)}` }, "MODEL");
    } finally {
      this.flushModelUsage(callId, row.case_id);
    }
    const usageRow = this.requireCall(callId);
    report = validateOutcome(
      {
        ...report,
        endedAt: fallback.endedAt,
        durationSeconds: fallback.durationSeconds,
        estimatedTelephonyCostUsd: fallback.estimatedTelephonyCostUsd,
        llmUsage: {
          inputTokens: usageRow.llm_input_tokens,
          outputTokens: usageRow.llm_output_tokens,
          totalTokens: usageRow.llm_input_tokens + usageRow.llm_output_tokens,
        },
      },
      transcript,
    );
    if (!this.database.replaceOutcome(callId, report)) throw new Error("OUTCOME_PROVISIONAL_MISSING");
    this.record(
      callId,
      row.case_id,
      "OUTCOME_GENERATED",
      { status: report.status, provisional: false, grounded: true },
      this.config.LLM_MODE.toUpperCase(),
    );
    return report;
  }

  exportJson(callId: string): OutcomeReport {
    const report = this.database.getOutcome(callId);
    if (!report) throw new Error("OUTCOME_NOT_READY");
    return report;
  }
  exportText(callId: string): string {
    const report = this.exportJson(callId);
    const value = (field: { value: unknown } | null) => (field ? String(field.value) : "Not established");
    return [
      `Liaison call outcome`,
      `Status: ${report.status}`,
      `Summary: ${value(report.summary)}`,
      `Representative: ${value(report.representativeName)}`,
      `Department: ${value(report.department)}`,
      `Case number: ${value(report.caseNumber)}`,
      `Resolution: ${value(report.resolution)}`,
      `Duration: ${report.durationSeconds} seconds`,
      `Estimated telephony cost: $${report.estimatedTelephonyCostUsd.toFixed(4)}`,
      `LLM tokens: ${report.llmUsage?.totalTokens ?? 0} total (${report.llmUsage?.inputTokens ?? 0} input, ${report.llmUsage?.outputTokens ?? 0} output)`,
      `Unresolved items: ${report.unresolvedItems.map((item) => item.value).join("; ") || "None recorded"}`,
      `Generated from transcript evidence; cost is an estimate, not an invoice.`,
    ].join("\n");
  }

  private addTurn(callId: string, speaker: TranscriptTurn["speaker"], text: string): TranscriptTurn {
    const row = this.requireCall(callId);
    const patternSafe = redactInboundSmsSecrets(text).redactedText;
    const safe = redactText(patternSafe, this.disclosures.redactionInputs(row.case_id));
    const existing = this.database.getTranscript(callId);
    const turn: TranscriptTurn = {
      id: randomUUID(),
      sequence: existing.length + 1,
      speaker,
      text: safe,
      timestamp: new Date().toISOString(),
    };
    this.database.addTranscript(callId, turn);
    const event: EventType =
      speaker === "REMOTE"
        ? "REMOTE_TRANSCRIPT_FINAL"
        : speaker === "USER_EXACT"
          ? "USER_EXACT_TEXT_SENT"
          : speaker === "LIAISON"
            ? "AGENT_SPEECH_STARTED"
            : "CALL_STATE_CHANGED";
    this.record(callId, row.case_id, event, { turn }, speaker);
    this.emit(callId, "transcript.turn", turn);
    return turn;
  }
  private changeState(callId: string, next: CallState, activity: string, objective: string): void {
    const row = this.requireCall(callId);
    if (row.state !== next) transitionState(row.state, next);
    this.database.updateCall(callId, { state: next, activity, objective });
    this.record(
      callId,
      row.case_id,
      "CALL_STATE_CHANGED",
      { from: row.state, to: next, activity, objective },
      "SYSTEM",
    );
    this.emit(callId, "call.state", { state: next, activity, objective });
  }
  private record(
    callId: string | undefined,
    caseId: string | undefined,
    type: EventType,
    payload: unknown,
    origin: string,
  ): number {
    const secrets = caseId ? this.disclosures.redactionInputs(caseId) : [];
    const clean = sanitizePayload(payload, secrets);
    const sequence = this.database.appendEvent({ id: randomUUID(), callId, caseId, type, payload: clean, origin });
    if (callId) this.emit(callId, this.browserType(type), clean, sequence);
    this.events.emit("call:any", {
      sequence,
      callId,
      caseId,
      type,
      data: clean,
      timestamp: new Date().toISOString(),
    } satisfies ApplicationCallEvent);
    return sequence;
  }
  private publishPersisted(
    callId: string,
    caseId: string,
    type: EventType,
    data: unknown,
    sequence: number,
    timestamp: string,
  ): void {
    this.emit(callId, this.browserType(type), data, sequence);
    this.events.emit("call:any", { sequence, callId, caseId, type, data, timestamp } satisfies ApplicationCallEvent);
  }
  private emit(callId: string, type: string, data: unknown, id?: number): void {
    const runtime = this.runtimes.get(callId);
    const sequence = id ?? (runtime ? ++runtime.browserSequence : Date.now());
    if (runtime) runtime.browserSequence = Math.max(runtime.browserSequence, sequence);
    this.events.emit(`call:${callId}`, { id: sequence, type, data } satisfies BrowserEvent);
  }
  private browserType(type: EventType): string {
    if (type === "APPROVAL_REQUESTED") return "approval.requested";
    if (type === "CALL_ENDED") return "call.status";
    if (type === "OUTCOME_GENERATED") return "outcome.ready";
    if (type === "TECHNICAL_ERROR") return "error";
    return "audit.event";
  }
  private flushModelUsage(callId: string | undefined, caseId: string): void {
    for (const item of this.models.drainUsageRecords()) this.captureModelUsage(callId, caseId, item);
  }
  private captureModelUsage(callId: string | undefined, caseId: string, item: ModelUsageRecord): void {
    if (callId) this.database.addModelUsage(callId, item.inputTokens, item.outputTokens);
    this.record(
      callId,
      caseId,
      "MODEL_RESPONSE_RECEIVED",
      {
        modelOperation: item.operation,
        requestId: item.requestId,
        responseId: item.responseId,
        inputTokens: item.inputTokens,
        outputTokens: item.outputTokens,
        totalTokens: item.totalTokens,
      },
      "MODEL",
    );
  }
  private assertSafeExactText(caseId: string, text: string): void {
    if (!text) throw new Error("TEXT_REQUIRED");
    this.assertNoInlineSensitiveData([text]);
    const item = this.requireCase(caseId);
    const reason = prohibitedSecretReason(text);
    if (reason) throw new Error(`PROHIBITED_SECRET:${reason}`);
    const actionReason = prohibitedUserActionReason(text, item.brief?.authority.forbiddenActions ?? []);
    if (actionReason) throw new Error(`PROHIBITED_USER_ACTION:${actionReason}`);
    if (redactText(text, this.disclosures.redactionInputs(caseId)) !== text)
      throw new Error("USE_APPROVED_DISCLOSURE_CARD");
  }
  private assertNoInlineSensitiveData(values: readonly string[]): void {
    for (const value of values) {
      const detected = redactInboundSmsSecrets(value);
      if (detected.blocked)
        throw new Error(`SENSITIVE_VALUE_REQUIRES_SECURE_DISCLOSURE:${detected.categories.join(",")}`);
    }
  }
  private requireApprovalForExecution(
    callId: string,
    approvalId: string,
    decision: "APPROVE" | "REJECT",
    payload?: string,
  ): ApprovalRequest {
    const approval = this.database.getApproval(approvalId);
    if (!approval || approval.callId !== callId) throw new Error("STALE_APPROVAL");
    if (approval.status !== "PENDING") {
      const execution = this.database.getApprovalExecution(approvalId);
      const fingerprint = this.approvalExecutionFingerprint({
        decision,
        approval,
        replacement:
          decision === "APPROVE"
            ? (payload ?? null)
            : payload?.trim() ||
              "The account holder does not approve that. Please continue with the original requested outcome.",
      });
      if (
        execution?.state === "SUCCEEDED" &&
        execution.decision === decision &&
        execution.payloadFingerprint === fingerprint
      )
        return approval;
      if (execution?.state === "FAILED" || approval.status === "EXECUTION_FAILED")
        throw new Error("APPROVAL_EXECUTION_FAILED");
      throw new Error("APPROVAL_ALREADY_RESOLVED");
    }
    if (Date.parse(approval.expiresAt) <= Date.now()) {
      this.database.updateApproval(approval.id, "PENDING", "EXPIRED");
      throw new Error("APPROVAL_EXPIRED");
    }
    return approval;
  }
  private revalidateApprovalExecution(
    row: StoredCall,
    approval: ApprovalRequest,
    replacement: string | undefined,
    materialConfirmed: boolean,
  ): void {
    const caseItem = this.requireApprovedCase(row.case_id);
    if (
      approval.amountCents !== undefined &&
      approval.amountCents > caseItem.brief!.authority.maximumAuthorizedCostCents
    )
      throw new Error("MONETARY_CAP_EXCEEDED");
    const thread = this.database.getThreadForCall(row.id);
    if (thread && caseItem.approvedVersion) {
      const conditional = evaluateApprovalConditionalAuthority(
        approval,
        this.database.listConditionalAuthorityRules(thread.id, row.case_id),
        caseItem.approvedVersion,
      );
      this.record(
        row.id,
        row.case_id,
        "AGENT_DECISION_PROPOSED",
        {
          action: "CONDITIONAL_AUTHORITY_REVALIDATION",
          subject: conditional.subject,
          amountCents: conditional.amountCents,
          source: conditional.source,
          decision: conditional.decision,
          matchedRuleIds: conditional.matchedRuleIds,
        },
        "POLICY",
      );
      if (conditional.source === "CONFLICT") throw new Error("CONDITIONAL_AUTHORITY_CONFLICT");
      if (conditional.decision === "DENY") throw new Error("CONDITIONAL_AUTHORITY_DENIED");
    }
    if (approval.category !== "PERSONAL_DATA" && !materialConfirmed) throw new Error("MATERIAL_CONFIRMATION_REQUIRED");
    if (replacement) this.assertSafeExactText(row.case_id, replacement);
    else if (!approval.disclosureCardId) this.assertSafeExactText(row.case_id, approval.proposedSpeech);
  }
  private approvalExecutionFingerprint(input: {
    decision: "APPROVE" | "REJECT";
    approval: ApprovalRequest;
    replacement: string | null;
  }): string {
    return createHash("sha256")
      .update(
        JSON.stringify({ decision: input.decision, approvalId: input.approval.id, replacement: input.replacement }),
      )
      .digest("hex");
  }
  private resolveExistingApprovalExecution(
    callId: string,
    execution: import("../database/db.js").ApprovalExecutionRecord,
    decision: "APPROVE" | "REJECT",
    fingerprint: string,
    targetStatus: "APPROVED" | "REJECTED" | "REPLACED",
  ): CallSnapshot {
    if (
      execution.decision !== decision ||
      execution.payloadFingerprint !== fingerprint ||
      execution.targetStatus !== targetStatus
    )
      throw new Error("APPROVAL_EXECUTION_CONFLICT");
    if (execution.state === "SUCCEEDED") return this.snapshot(callId);
    if (execution.state === "FAILED") throw new Error("APPROVAL_EXECUTION_FAILED");
    throw new Error("APPROVAL_EXECUTION_IN_PROGRESS");
  }
  private async failApprovalExecution(
    row: StoredCall,
    approvalId: string,
    executionId: string,
    error: unknown,
  ): Promise<void> {
    const code = this.safeError(error);
    this.database.failApprovalExecution({ approvalId, executionId, errorCode: code });
    this.database.updateCall(row.id, {
      paused: true,
      activity: "Approval execution failed — call ending",
      generation: this.requireCall(row.id).generation + 1,
    });
    this.record(
      row.id,
      row.case_id,
      "TECHNICAL_ERROR",
      { code: `APPROVAL_EXECUTION:${code}`, approvalId },
      "TELEPHONY",
    );
    try {
      await this.terminalize(row.id, "TECHNICAL_FAILURE", `Approval side effect failed: ${code}`, "TECHNICAL_FAILURE");
    } catch (terminalError) {
      this.record(
        row.id,
        row.case_id,
        "TECHNICAL_ERROR",
        { code: `APPROVAL_FAILURE_TERMINALIZE:${this.safeError(terminalError)}` },
        "SYSTEM",
      );
    }
  }
  private requireCase(id: string): CaseDetail {
    const item = this.database.getCase(id);
    if (!item) throw new Error("CASE_NOT_FOUND");
    return item;
  }
  private requireApprovedCase(id: string): CaseDetail {
    const item = this.requireCase(id);
    if (!item.brief || item.approvedVersion !== item.brief.version) throw new Error("APPROVED_PLAN_REQUIRED");
    return item;
  }
  private requireCall(id: string): StoredCall {
    const row = this.database.getCall(id);
    if (!row) throw new Error("CALL_NOT_FOUND");
    return row;
  }
  private requireActiveCall(id: string): StoredCall {
    const row = this.requireCall(id);
    if (this.isTerminal(row.state)) throw new Error("CALL_ALREADY_ENDED");
    return row;
  }
  private runtime(id: string): Runtime {
    const value = this.runtimes.get(id);
    if (!value) throw new Error("CALL_RUNTIME_NOT_AVAILABLE");
    return value;
  }
  private isTerminal(state: CallState) {
    return state === "COMPLETED" || state === "FAILED";
  }
  private objectiveFor(state: CallState) {
    const map: Partial<Record<CallState, string>> = {
      IVR: "Navigate the support menu",
      DISCLOSING_ASSISTANT: "Obtain consent to continue",
      EXPLAINING_ISSUE: "Explain the approved issue",
      AUTHENTICATING: "Use an approved authentication method",
      NEGOTIATING: "Seek the requested outcome",
      VERIFYING_OUTCOME: "Confirm concrete details",
    };
    return map[state] ?? "Continue the supervised call";
  }
  private reasonForStatus(status: string): EndReason {
    const map: Record<string, EndReason> = {
      RESOLVED: "RESOLVED",
      PARTIAL: "PARTIALLY_RESOLVED",
      UNRESOLVED: "UNRESOLVED",
      REFUSED_AUTOMATION: "REPRESENTATIVE_REFUSED_AUTOMATION",
      AUTHENTICATION_REQUIRED: "AUTHENTICATION_REQUIRED",
      DISCONNECTED: "TECHNICAL_FAILURE",
      TECHNICAL_FAILURE: "TECHNICAL_FAILURE",
    };
    return map[status] ?? "UNRESOLVED";
  }
  private proposedForStatus(
    status: string,
  ): "RESOLVED" | "PARTIAL" | "UNRESOLVED" | "REFUSED_AUTOMATION" | "AUTHENTICATION_REQUIRED" | "TECHNICAL_FAILURE" {
    return status === "DISCONNECTED" ? "TECHNICAL_FAILURE" : (status as ReturnType<CallService["proposedForStatus"]>);
  }
  private statusForReason(reason: EndReason): string {
    const map: Record<EndReason, string> = {
      RESOLVED: "RESOLVED",
      PARTIALLY_RESOLVED: "PARTIAL",
      UNRESOLVED: "UNRESOLVED",
      REPRESENTATIVE_REFUSED_AUTOMATION: "REFUSED_AUTOMATION",
      AUTHENTICATION_REQUIRED: "AUTHENTICATION_REQUIRED",
      USER_REQUESTED: "UNRESOLVED",
      TECHNICAL_FAILURE: "TECHNICAL_FAILURE",
      POLICY_BLOCKED: "UNRESOLVED",
    };
    return map[reason];
  }
  private persistedTerminalStatus(row: StoredCall): OutcomeReport["status"] {
    const ended = this.database
      .listEvents(row.id)
      .filter((event) => event.type === "CALL_ENDED")
      .at(-1);
    const payload =
      ended?.payload && typeof ended.payload === "object" && !Array.isArray(ended.payload)
        ? (ended.payload as Record<string, unknown>)
        : {};
    const stated =
      typeof payload.status === "string" ? payload.status : row.state === "FAILED" ? "TECHNICAL_FAILURE" : "UNRESOLVED";
    return this.normalizeOutcomeStatus(stated);
  }
  private isUnconfirmedTwilioGuard(row: StoredCall): boolean {
    return row.mode === "TWILIO" && row.state === "ENDING" && Boolean(row.terminal_reason?.startsWith("AMBIGUOUS_"));
  }
  private normalizeOutcomeStatus(status: string): OutcomeReport["status"] {
    return (
      [
        "RESOLVED",
        "PARTIAL",
        "UNRESOLVED",
        "REFUSED_AUTOMATION",
        "AUTHENTICATION_REQUIRED",
        "DISCONNECTED",
        "TECHNICAL_FAILURE",
      ] as const
    ).includes(status as OutcomeReport["status"])
      ? (status as OutcomeReport["status"])
      : "UNRESOLVED";
  }
  private safeError(error: unknown): string {
    return error instanceof Error
      ? error.message.replace(/[A-Za-z0-9_-]{24,}/g, "[FILTERED]").slice(0, 300)
      : "UNKNOWN_ERROR";
  }
}

function deterministicCaseId(idempotencyKey: string): string {
  const hex = createHash("sha256").update(`liaison-case:${idempotencyKey}`).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
