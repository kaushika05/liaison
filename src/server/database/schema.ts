import type Database from "better-sqlite3";

/**
 * The complete schema and every migration, applied on connect.
 *
 * Migrations are additive and introspection-driven: each ALTER is guarded by a
 * `PRAGMA table_info` check, and every CREATE uses IF NOT EXISTS, so applying this
 * function repeatedly is a no-op. Several unique indexes are partial on purpose --
 * they encode business invariants (one active thread per principal, one blocking
 * decision per call, one live call authorization per thread) that the storage engine
 * then enforces atomically rather than leaving to a racy application-level check.
 */
export function applySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cases (id TEXT PRIMARY KEY, company_name TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, intake_json TEXT NOT NULL, brief_json TEXT, disclosure_metadata_json TEXT NOT NULL DEFAULT '[]', approved_version INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE, mode TEXT NOT NULL, scenario_id TEXT, state TEXT NOT NULL, activity TEXT NOT NULL, objective TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0, human_detected INTEGER NOT NULL DEFAULT 0, disclosure_delivered INTEGER NOT NULL DEFAULT 0, consent_status TEXT NOT NULL DEFAULT 'UNKNOWN', generation INTEGER NOT NULL DEFAULT 0, twilio_call_sid TEXT, started_at TEXT NOT NULL, ended_at TEXT, duration_seconds INTEGER NOT NULL DEFAULT 0, estimated_cost_usd REAL NOT NULL DEFAULT 0, llm_input_tokens INTEGER NOT NULL DEFAULT 0, llm_output_tokens INTEGER NOT NULL DEFAULT 0, terminal_reason TEXT);
    CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, call_id TEXT, case_id TEXT, sequence INTEGER NOT NULL, timestamp TEXT NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL, origin TEXT NOT NULL, idempotency_key TEXT, UNIQUE(call_id, idempotency_key));
    CREATE TABLE IF NOT EXISTS transcript_turns (id TEXT PRIMARY KEY, call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE, sequence INTEGER NOT NULL, speaker TEXT NOT NULL, text TEXT NOT NULL, timestamp TEXT NOT NULL, UNIQUE(call_id, sequence));
    CREATE TABLE IF NOT EXISTS approval_requests (id TEXT PRIMARY KEY, call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE, status TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS approval_executions (
      approval_id TEXT PRIMARY KEY REFERENCES approval_requests(id) ON DELETE CASCADE,
      call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
      decision TEXT NOT NULL CHECK (decision IN ('APPROVE','REJECT')),
      payload_fingerprint TEXT NOT NULL CHECK (length(payload_fingerprint) >= 32),
      target_status TEXT NOT NULL CHECK (target_status IN ('APPROVED','REJECTED','REPLACED')),
      execution_id TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK (state IN ('RESERVED','SUCCEEDED','FAILED')),
      reserved_at TEXT NOT NULL,
      completed_at TEXT,
      error_code TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_approval_executions_call ON approval_executions(call_id,state);
    CREATE TABLE IF NOT EXISTS outcome_reports (call_id TEXT PRIMARY KEY REFERENCES calls(id) ON DELETE CASCADE, report_json TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS daily_call_usage (day TEXT PRIMARY KEY, count INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_cases_updated_at ON cases(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_calls_case_id ON calls(case_id);
    CREATE INDEX IF NOT EXISTS idx_events_call_sequence ON events(call_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_transcript_call_sequence ON transcript_turns(call_id, sequence);
  `);
  const callColumns = new Set((db.pragma("table_info(calls)") as Array<{ name: string }>).map((column) => column.name));
  if (!callColumns.has("llm_input_tokens"))
    db.exec("ALTER TABLE calls ADD COLUMN llm_input_tokens INTEGER NOT NULL DEFAULT 0");
  if (!callColumns.has("llm_output_tokens"))
    db.exec("ALTER TABLE calls ADD COLUMN llm_output_tokens INTEGER NOT NULL DEFAULT 0");
  if (!callColumns.has("authorization_id")) db.exec("ALTER TABLE calls ADD COLUMN authorization_id TEXT");
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS support_threads (
      id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('IDLE','COLLECTING_ISSUE','AWAITING_INFORMATION','PLAN_DRAFTED','AWAITING_PLAN_APPROVAL','AWAITING_AVAILABILITY','CALL_STARTING','CALL_ACTIVE','AWAITING_USER_DECISION','CALL_ENDING','COMPLETED','CANCELLED','FAILED')),
      autonomy_mode TEXT NOT NULL CHECK (autonomy_mode IN ('ASSIST','COPILOT','DELEGATE')),
      current_case_id TEXT REFERENCES cases(id) ON DELETE SET NULL,
      approved_plan_version INTEGER CHECK (approved_plan_version IS NULL OR approved_plan_version > 0),
      active_call_id TEXT REFERENCES calls(id) ON DELETE SET NULL,
      pending_attention_request_id TEXT,
      messaging_opt_state TEXT NOT NULL CHECK (messaging_opt_state IN ('UNKNOWN','OPTED_IN','OPTED_OUT')),
      draft_json TEXT CHECK (draft_json IS NULL OR json_valid(draft_json)),
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_support_threads_active_principal ON support_threads(principal_id) WHERE is_active=1;
    CREATE INDEX IF NOT EXISTS idx_support_threads_case ON support_threads(current_case_id);
    CREATE INDEX IF NOT EXISTS idx_support_threads_call ON support_threads(active_call_id);

    CREATE TABLE IF NOT EXISTS attention_requests (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
      case_id TEXT REFERENCES cases(id) ON DELETE CASCADE,
      call_id TEXT REFERENCES calls(id) ON DELETE CASCADE,
      tier TEXT NOT NULL CHECK (tier IN ('INFORMATIONAL','LOW_CONSEQUENCE','SENSITIVE','MATERIAL','PROHIBITED')),
      status TEXT NOT NULL CHECK (status IN ('PENDING','RESOLVED','EXPIRED','SUPERSEDED','CANCELLED')),
      blocking INTEGER NOT NULL DEFAULT 1 CHECK (blocking IN (0,1)),
      question TEXT NOT NULL CHECK (length(question) BETWEEN 1 AND 1000),
      choices_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(choices_json) AND json_type(choices_json)='array'),
      proposed_action_json TEXT CHECK (proposed_action_json IS NULL OR json_valid(proposed_action_json)),
      resolution_json TEXT CHECK (resolution_json IS NULL OR json_valid(resolution_json)),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      resolved_at TEXT,
      superseded_by TEXT REFERENCES attention_requests(id) ON DELETE SET NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_attention_one_blocking_call ON attention_requests(call_id) WHERE blocking=1 AND status='PENDING' AND call_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_attention_one_blocking_thread_without_call ON attention_requests(thread_id) WHERE blocking=1 AND status='PENDING' AND call_id IS NULL;
    CREATE INDEX IF NOT EXISTS idx_attention_thread_created ON attention_requests(thread_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS inbound_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
      provider_kind TEXT NOT NULL CHECK (provider_kind IN ('WEB','TWILIO_SMS','SIMULATOR')),
      provider_message_id TEXT,
      direction TEXT NOT NULL DEFAULT 'INBOUND' CHECK (direction='INBOUND'),
      redacted_body TEXT NOT NULL,
      sender TEXT NOT NULL,
      recipient TEXT NOT NULL,
      case_id TEXT REFERENCES cases(id) ON DELETE CASCADE,
      call_id TEXT REFERENCES calls(id) ON DELETE SET NULL,
      attention_request_id TEXT REFERENCES attention_requests(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      processing_state TEXT NOT NULL CHECK (processing_state IN ('RECEIVED','PENDING','PROCESSING','COMPLETED','DEAD_LETTER','REJECTED')),
      delivery_state TEXT NOT NULL CHECK (delivery_state IN ('RECEIVED','PENDING','QUEUED','SENT','DELIVERED','UNDELIVERED','FAILED','UNKNOWN')),
      status_updated_at TEXT NOT NULL,
      processed_at TEXT,
      segment_estimate INTEGER NOT NULL CHECK (segment_estimate >= 0),
      error_code TEXT,
      idempotency_key TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_provider_message ON inbound_messages(provider_kind, provider_message_id) WHERE provider_message_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_idempotency ON inbound_messages(provider_kind, idempotency_key);
    CREATE INDEX IF NOT EXISTS idx_inbound_thread_created ON inbound_messages(thread_id, created_at, id);

    CREATE TABLE IF NOT EXISTS outbound_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
      provider_kind TEXT NOT NULL CHECK (provider_kind IN ('WEB','TWILIO_SMS','SIMULATOR')),
      provider_message_id TEXT,
      direction TEXT NOT NULL DEFAULT 'OUTBOUND' CHECK (direction='OUTBOUND'),
      redacted_body TEXT NOT NULL,
      sender TEXT NOT NULL,
      recipient TEXT NOT NULL,
      case_id TEXT REFERENCES cases(id) ON DELETE CASCADE,
      call_id TEXT REFERENCES calls(id) ON DELETE SET NULL,
      attention_request_id TEXT REFERENCES attention_requests(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      processing_state TEXT NOT NULL CHECK (processing_state IN ('PENDING','PROCESSING','COMPLETED','DEAD_LETTER')),
      delivery_state TEXT NOT NULL CHECK (delivery_state IN ('PENDING','QUEUED','SENT','DELIVERED','UNDELIVERED','FAILED','UNKNOWN')),
      status_updated_at TEXT NOT NULL,
      processed_at TEXT,
      delivered_at TEXT,
      segment_estimate INTEGER NOT NULL CHECK (segment_estimate >= 0),
      error_code TEXT,
      idempotency_key TEXT NOT NULL UNIQUE,
      lease_owner TEXT,
      lease_expires_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      last_error TEXT,
      next_eligible_at TEXT NOT NULL,
      CHECK ((processing_state='PROCESSING' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL) OR (processing_state<>'PROCESSING' AND lease_owner IS NULL AND lease_expires_at IS NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_outbound_provider_message ON outbound_messages(provider_kind, provider_message_id) WHERE provider_message_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_outbound_claim ON outbound_messages(processing_state, next_eligible_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_outbound_thread_created ON outbound_messages(thread_id, created_at, id);

    CREATE TABLE IF NOT EXISTS message_delivery_events (
      id TEXT PRIMARY KEY,
      outbound_message_id TEXT NOT NULL REFERENCES outbound_messages(id) ON DELETE CASCADE,
      provider_message_id TEXT,
      provider_status TEXT NOT NULL,
      error_code TEXT,
      occurred_at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      event_key TEXT NOT NULL UNIQUE
    );
    CREATE INDEX IF NOT EXISTS idx_delivery_message_order ON message_delivery_events(outbound_message_id, occurred_at, received_at, id);

    CREATE TABLE IF NOT EXISTS messaging_work_items (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      inbound_message_id TEXT REFERENCES inbound_messages(id) ON DELETE CASCADE,
      outbound_message_id TEXT REFERENCES outbound_messages(id) ON DELETE CASCADE,
      payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
      state TEXT NOT NULL CHECK (state IN ('PENDING','PROCESSING','COMPLETED','DEAD_LETTER')),
      lease_owner TEXT,
      lease_expires_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      last_error TEXT,
      next_eligible_at TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      CHECK (NOT (inbound_message_id IS NOT NULL AND outbound_message_id IS NOT NULL)),
      CHECK ((state='PROCESSING' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL) OR (state<>'PROCESSING' AND lease_owner IS NULL AND lease_expires_at IS NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_work_inbound_kind ON messaging_work_items(inbound_message_id, kind) WHERE inbound_message_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_work_claim ON messaging_work_items(state, next_eligible_at, created_at);

    CREATE TABLE IF NOT EXISTS secure_action_tokens (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) >= 32),
      action_type TEXT NOT NULL,
      thread_id TEXT NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
      case_id TEXT REFERENCES cases(id) ON DELETE CASCADE,
      call_id TEXT REFERENCES calls(id) ON DELETE CASCADE,
      attention_request_id TEXT REFERENCES attention_requests(id) ON DELETE CASCADE,
      single_use INTEGER NOT NULL DEFAULT 1 CHECK (single_use IN (0,1)),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      revoked_at TEXT,
      revoke_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_secure_tokens_attention ON secure_action_tokens(attention_request_id);
    CREATE INDEX IF NOT EXISTS idx_secure_tokens_expiry ON secure_action_tokens(expires_at);

    CREATE TABLE IF NOT EXISTS conditional_authority_rules (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
      case_id TEXT REFERENCES cases(id) ON DELETE CASCADE,
      action_type TEXT NOT NULL,
      condition_json TEXT NOT NULL CHECK (json_valid(condition_json)),
      permission TEXT NOT NULL CHECK (permission IN ('ALLOW','ASK','DENY')),
      priority INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_authority_rules_scope ON conditional_authority_rules(thread_id, case_id, active, priority DESC);

    CREATE TABLE IF NOT EXISTS commitments (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
      case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      call_id TEXT REFERENCES calls(id) ON DELETE CASCADE,
      party TEXT NOT NULL CHECK (party IN ('COMPANY','USER','AGENT','UNKNOWN')),
      status TEXT NOT NULL CHECK (status IN ('PROPOSED','CONFIRMED','REJECTED','SUPERSEDED','UNVERIFIED')),
      description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 2000),
      amount_cents INTEGER CHECK (amount_cents IS NULL OR amount_cents >= 0),
      deadline TEXT,
      recurring INTEGER CHECK (recurring IS NULL OR recurring IN (0,1)),
      evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json) AND json_type(evidence_json)='array' AND json_array_length(evidence_json) > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_commitments_call_created ON commitments(call_id, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_commitments_case_created ON commitments(case_id, created_at, id);

    CREATE TABLE IF NOT EXISTS semantic_call_events (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
      case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      semantic_key TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(call_id, semantic_key)
    );
    CREATE INDEX IF NOT EXISTS idx_semantic_call_order ON semantic_call_events(call_id, occurred_at, id);

    CREATE TABLE IF NOT EXISTS call_authorizations (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
      case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      plan_version INTEGER NOT NULL CHECK (plan_version > 0),
      destination_e164 TEXT,
      telephony_mode TEXT CHECK (telephony_mode IS NULL OR telephony_mode IN ('simulator','twilio')),
      code_hash TEXT NOT NULL CHECK (length(code_hash) >= 16),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      revoked_at TEXT,
      revoke_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_call_authorization_lookup ON call_authorizations(thread_id, case_id, plan_version, code_hash, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_call_authorization ON call_authorizations(thread_id) WHERE consumed_at IS NULL AND revoked_at IS NULL;

    CREATE TABLE IF NOT EXISTS provider_security_events (
      id TEXT PRIMARY KEY,
      provider_kind TEXT NOT NULL CHECK (provider_kind IN ('WEB','TWILIO_SMS','SIMULATOR')),
      provider_message_id TEXT NOT NULL CHECK (length(provider_message_id) > 0),
      event_type TEXT NOT NULL CHECK (length(event_type) > 0),
      reason_code TEXT NOT NULL CHECK (length(reason_code) > 0),
      thread_id TEXT REFERENCES support_threads(id) ON DELETE SET NULL,
      case_id TEXT REFERENCES cases(id) ON DELETE SET NULL,
      call_id TEXT REFERENCES calls(id) ON DELETE SET NULL,
      redacted_metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(redacted_metadata_json)),
      created_at TEXT NOT NULL,
      UNIQUE(provider_kind, provider_message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_provider_security_created ON provider_security_events(created_at DESC, id DESC);

    CREATE TRIGGER IF NOT EXISTS delete_call_events_before_call
    BEFORE DELETE ON calls
    BEGIN
      DELETE FROM events WHERE call_id=OLD.id;
    END;

    CREATE TRIGGER IF NOT EXISTS delete_case_events_before_case
    BEFORE DELETE ON cases
    BEGIN
      DELETE FROM events WHERE case_id=OLD.id OR call_id IN (SELECT id FROM calls WHERE case_id=OLD.id);
    END;
  `);
  const authorizationColumns = new Set(
    (db.pragma("table_info(call_authorizations)") as Array<{ name: string }>).map((column) => column.name),
  );
  if (!authorizationColumns.has("destination_e164"))
    db.exec("ALTER TABLE call_authorizations ADD COLUMN destination_e164 TEXT");
  if (!authorizationColumns.has("telephony_mode"))
    db.exec(
      "ALTER TABLE call_authorizations ADD COLUMN telephony_mode TEXT CHECK (telephony_mode IS NULL OR telephony_mode IN ('simulator','twilio'))",
    );
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)").run(
    1,
    "sms_first_durable_messaging",
    new Date().toISOString(),
  );
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)").run(
    2,
    "provider_security_and_authorization_binding",
    new Date().toISOString(),
  );
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)").run(
    3,
    "call_authorization_audit_link",
    new Date().toISOString(),
  );
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)").run(
    4,
    "durable_approval_execution",
    new Date().toISOString(),
  );
  db.pragma("optimize");
}
