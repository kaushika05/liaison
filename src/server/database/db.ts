import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { ApprovalRequest, CallBrief, CallState, EventType, OutcomeReport, TranscriptTurn } from "../../shared/domain.js";
import type { CaseDetail, CaseSummary } from "../../shared/api.js";

interface CallRow { id: string; case_id: string; mode: "SIMULATOR" | "TWILIO"; scenario_id: string | null; state: CallState; activity: string; objective: string; paused: number; human_detected: number; disclosure_delivered: number; consent_status: "UNKNOWN" | "ACCEPTED" | "REFUSED" | "AMBIGUOUS"; generation: number; twilio_call_sid: string | null; started_at: string; ended_at: string | null; duration_seconds: number; estimated_cost_usd: number; llm_input_tokens:number; llm_output_tokens:number; terminal_reason: string | null; }
interface CaseRow { id: string; company_name: string; title: string; status: string; intake_json: string; brief_json: string | null; disclosure_metadata_json: string; approved_version: number | null; created_at: string; updated_at: string }

export class LiaisonDatabase {
  readonly db: Database.Database;
  constructor(filename: string) {
    if (filename !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL"); this.db.pragma("foreign_keys = ON"); this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cases (id TEXT PRIMARY KEY, company_name TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, intake_json TEXT NOT NULL, brief_json TEXT, disclosure_metadata_json TEXT NOT NULL DEFAULT '[]', approved_version INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE, mode TEXT NOT NULL, scenario_id TEXT, state TEXT NOT NULL, activity TEXT NOT NULL, objective TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0, human_detected INTEGER NOT NULL DEFAULT 0, disclosure_delivered INTEGER NOT NULL DEFAULT 0, consent_status TEXT NOT NULL DEFAULT 'UNKNOWN', generation INTEGER NOT NULL DEFAULT 0, twilio_call_sid TEXT, started_at TEXT NOT NULL, ended_at TEXT, duration_seconds INTEGER NOT NULL DEFAULT 0, estimated_cost_usd REAL NOT NULL DEFAULT 0, llm_input_tokens INTEGER NOT NULL DEFAULT 0, llm_output_tokens INTEGER NOT NULL DEFAULT 0, terminal_reason TEXT);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, call_id TEXT, case_id TEXT, sequence INTEGER NOT NULL, timestamp TEXT NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL, origin TEXT NOT NULL, idempotency_key TEXT, UNIQUE(call_id, idempotency_key));
      CREATE TABLE IF NOT EXISTS transcript_turns (id TEXT PRIMARY KEY, call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE, sequence INTEGER NOT NULL, speaker TEXT NOT NULL, text TEXT NOT NULL, timestamp TEXT NOT NULL, UNIQUE(call_id, sequence));
      CREATE TABLE IF NOT EXISTS approval_requests (id TEXT PRIMARY KEY, call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE, status TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outcome_reports (call_id TEXT PRIMARY KEY REFERENCES calls(id) ON DELETE CASCADE, report_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS daily_call_usage (day TEXT PRIMARY KEY, count INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_cases_updated_at ON cases(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_calls_case_id ON calls(case_id);
      CREATE INDEX IF NOT EXISTS idx_events_call_sequence ON events(call_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_transcript_call_sequence ON transcript_turns(call_id, sequence);
    `);
    const callColumns=new Set((this.db.pragma("table_info(calls)") as Array<{name:string}>).map((column)=>column.name));
    if(!callColumns.has("llm_input_tokens")) this.db.exec("ALTER TABLE calls ADD COLUMN llm_input_tokens INTEGER NOT NULL DEFAULT 0");
    if(!callColumns.has("llm_output_tokens")) this.db.exec("ALTER TABLE calls ADD COLUMN llm_output_tokens INTEGER NOT NULL DEFAULT 0");
    this.db.pragma("optimize");
  }

  close(): void { this.db.close(); }
  ready(): boolean { return this.db.prepare("SELECT 1 AS ok").get() !== undefined; }

  createCase(input: { id: string; companyName: string; title: string; intake: unknown; disclosureMetadata: unknown[] }): void {
    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO cases (id, company_name, title, status, intake_json, disclosure_metadata_json, created_at, updated_at) VALUES (?, ?, ?, 'DRAFT', ?, ?, ?, ?)")
      .run(input.id, input.companyName, input.title, JSON.stringify(input.intake), JSON.stringify(input.disclosureMetadata), now, now);
  }
  listCases(): CaseSummary[] {
    return (this.db.prepare("SELECT id, company_name, title, status, updated_at FROM cases ORDER BY updated_at DESC").all() as Array<Pick<CaseRow,"id"|"company_name"|"title"|"status"|"updated_at">>)
      .map((r) => ({ id: r.id, companyName: r.company_name, title: r.title, status: r.status, updatedAt: r.updated_at }));
  }
  getCase(id: string): CaseDetail | null {
    const r = this.db.prepare("SELECT * FROM cases WHERE id = ?").get(id) as CaseRow | undefined;
    return r ? { id: r.id, companyName: r.company_name, title: r.title, status: r.status, updatedAt: r.updated_at, intake: JSON.parse(r.intake_json) as Record<string, unknown>, brief: r.brief_json ? JSON.parse(r.brief_json) as CallBrief : null, approvedVersion: r.approved_version, disclosures: JSON.parse(r.disclosure_metadata_json) as CaseDetail["disclosures"] } : null;
  }
  savePlan(caseId: string, brief: CallBrief): void { this.db.prepare("UPDATE cases SET brief_json=?, title=?, status='PLANNED', approved_version=NULL, updated_at=? WHERE id=?").run(JSON.stringify(brief), brief.title, new Date().toISOString(), caseId); }
  approvePlan(caseId: string, version: number): void { this.db.prepare("UPDATE cases SET approved_version=?, status='APPROVED', updated_at=? WHERE id=? AND json_extract(brief_json, '$.version')=?").run(version, new Date().toISOString(), caseId, version); }
  deleteCase(id: string): void { this.db.prepare("DELETE FROM cases WHERE id=?").run(id); }

  createCall(call: { id: string; caseId: string; mode: "SIMULATOR"|"TWILIO"; scenarioId: string|null; state: CallState; activity: string; objective: string }): void {
    this.db.prepare("INSERT INTO calls (id,case_id,mode,scenario_id,state,activity,objective,started_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(call.id, call.caseId, call.mode, call.scenarioId, call.state, call.activity, call.objective, new Date().toISOString());
    this.db.prepare("UPDATE cases SET status='IN_CALL', updated_at=? WHERE id=?").run(new Date().toISOString(), call.caseId);
  }
  getCall(id: string): CallRow | null { return (this.db.prepare("SELECT * FROM calls WHERE id=?").get(id) as CallRow | undefined) ?? null; }
  getActiveCall(): CallRow | null { return (this.db.prepare("SELECT * FROM calls WHERE state NOT IN ('COMPLETED','FAILED') ORDER BY started_at DESC LIMIT 1").get() as CallRow | undefined) ?? null; }
  updateCall(id: string, fields: Partial<{ state: CallState; activity: string; objective: string; paused: boolean; humanDetected: boolean; disclosureDelivered: boolean; consentStatus: CallRow["consent_status"]; generation: number; twilioCallSid: string; endedAt: string; durationSeconds: number; estimatedCostUsd: number; terminalReason: string }>): void {
    const mapping: Record<string,string> = { state:"state", activity:"activity", objective:"objective", paused:"paused", humanDetected:"human_detected", disclosureDelivered:"disclosure_delivered", consentStatus:"consent_status", generation:"generation", twilioCallSid:"twilio_call_sid", endedAt:"ended_at", durationSeconds:"duration_seconds", estimatedCostUsd:"estimated_cost_usd", terminalReason:"terminal_reason" };
    const entries = Object.entries(fields).filter(([,v]) => v !== undefined);
    if (!entries.length) return;
    const values = entries.map(([,v]) => typeof v === "boolean" ? Number(v) : v);
    this.db.prepare(`UPDATE calls SET ${entries.map(([k]) => `${mapping[k]}=?`).join(",")} WHERE id=?`).run(...values, id);
  }
  addModelUsage(callId:string,inputTokens:number,outputTokens:number):void { this.db.prepare("UPDATE calls SET llm_input_tokens=llm_input_tokens+?, llm_output_tokens=llm_output_tokens+? WHERE id=?").run(inputTokens,outputTokens,callId); }
  appendEvent(input: { id: string; callId?: string; caseId?: string; type: EventType; payload: unknown; origin: string; idempotencyKey?: string }): number {
    const sequence = Number((this.db.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS n FROM events WHERE call_id IS ? AND case_id IS ?").get(input.callId ?? null, input.caseId ?? null) as {n:number}).n);
    this.db.prepare("INSERT OR IGNORE INTO events (id,call_id,case_id,sequence,timestamp,type,payload_json,origin,idempotency_key) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(input.id, input.callId ?? null, input.caseId ?? null, sequence, new Date().toISOString(), input.type, JSON.stringify(input.payload), input.origin, input.idempotencyKey ?? null);
    return sequence;
  }
  addTranscript(callId: string, turn: TranscriptTurn): void { this.db.prepare("INSERT INTO transcript_turns (id,call_id,sequence,speaker,text,timestamp) VALUES (?,?,?,?,?,?)").run(turn.id, callId, turn.sequence, turn.speaker, turn.text, turn.timestamp); }
  getTranscript(callId: string): TranscriptTurn[] { return (this.db.prepare("SELECT id,sequence,speaker,text,timestamp FROM transcript_turns WHERE call_id=? ORDER BY sequence").all(callId) as TranscriptTurn[]); }
  saveApproval(approval: ApprovalRequest): void { this.db.prepare("INSERT INTO approval_requests (id,call_id,status,data_json,created_at,expires_at) VALUES (?,?,?,?,?,?)").run(approval.id, approval.callId, approval.status, JSON.stringify(approval), approval.createdAt, approval.expiresAt); }
  getPendingApproval(callId: string): ApprovalRequest | null { const r=this.db.prepare("SELECT data_json,status FROM approval_requests WHERE call_id=? AND status='PENDING' ORDER BY created_at DESC LIMIT 1").get(callId) as {data_json:string;status:string}|undefined; return r ? { ...(JSON.parse(r.data_json) as ApprovalRequest), status: r.status as ApprovalRequest["status"] } : null; }
  updateApproval(id: string, from: string, to: string): boolean { const result=this.db.prepare("UPDATE approval_requests SET status=?, data_json=json_set(data_json,'$.status',?) WHERE id=? AND status=?").run(to,to,id,from); return result.changes===1; }
  saveOutcome(callId: string, report: OutcomeReport): void { this.db.prepare("INSERT OR IGNORE INTO outcome_reports (call_id,report_json,created_at) VALUES (?,?,?)").run(callId,JSON.stringify(report),new Date().toISOString()); }
  getOutcome(callId: string): OutcomeReport | null { const r=this.db.prepare("SELECT report_json FROM outcome_reports WHERE call_id=?").get(callId) as {report_json:string}|undefined; return r ? JSON.parse(r.report_json) as OutcomeReport : null; }
  listEvents(callId: string, after=0): Array<{ sequence:number; type:string; payload:unknown; timestamp:string }> { return (this.db.prepare("SELECT sequence,type,payload_json,timestamp FROM events WHERE call_id=? AND sequence>? ORDER BY sequence").all(callId,after) as Array<{sequence:number;type:string;payload_json:string;timestamp:string}>).map((r)=>({sequence:r.sequence,type:r.type,payload:JSON.parse(r.payload_json) as unknown,timestamp:r.timestamp})); }
  incrementDailyUsage(day: string, limit: number): boolean { const tx=this.db.transaction(()=>{ const row=this.db.prepare("SELECT count FROM daily_call_usage WHERE day=?").get(day) as {count:number}|undefined; if ((row?.count??0)>=limit) return false; this.db.prepare("INSERT INTO daily_call_usage(day,count) VALUES (?,1) ON CONFLICT(day) DO UPDATE SET count=count+1").run(day); return true; }); return tx(); }
  deleteExpired(retentionDays: number): number { const cutoff=new Date(Date.now()-retentionDays*86400000).toISOString(); return this.db.prepare("DELETE FROM cases WHERE updated_at < ? AND status NOT IN ('IN_CALL')").run(cutoff).changes; }
}

export type StoredCall = NonNullable<ReturnType<LiaisonDatabase["getCall"]>>;
