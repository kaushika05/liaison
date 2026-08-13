import { capturedFactSchema, type AgentDecision, type OutcomeReport, type TranscriptTurn } from "../../shared/domain.js";
import type { SemanticCallEvent } from "../../shared/protocol.js";
import { prohibitedSecretReason } from "../core/policy.js";

export interface SemanticProjection {
  event: SemanticCallEvent;
  message: string;
}

function evidence(turn: TranscriptTurn, exactQuote: string) {
  return [{ turnId: turn.id, exactQuote }];
}

function money(text: string): number | undefined {
  const match = /\$([\d,]+(?:\.\d{1,2})?)/.exec(text);
  return match ? Math.round(Number(match[1].replaceAll(",", "")) * 100) : undefined;
}

function safeOfferDescription(text: string): string {
  if (prohibitedSecretReason(text)) return "The representative proposed a financial or service alternative.";
  if (/\bcredit\b/i.test(text)) return "The representative proposed an account credit.";
  if (/\brefund\b/i.test(text)) return "The representative proposed a refund.";
  if (/\bdiscount\b/i.test(text)) return "The representative proposed a discount.";
  if (/\b(?:upgrade|downgrade|plan)\b/i.test(text)) return "The representative proposed a service-plan change.";
  return "The representative proposed an alternative outcome.";
}

function exactValueQuote(turn: TranscriptTurn, value: string): string | null {
  const sought = value.trim();
  if (!sought) return null;
  const index = turn.text.toLocaleLowerCase("en-US").indexOf(sought.toLocaleLowerCase("en-US"));
  return index < 0 ? null : turn.text.slice(index, index + sought.length);
}

/**
 * Projects controller-captured facts only when they remain grounded after the
 * controller response: the referenced turn must be a persisted final REMOTE
 * turn and the captured value must occur verbatim in that turn. A captured
 * commitment is deliberately a grounded fact here, not a confirmed ledger
 * commitment; confirmation happens only from the validated outcome report.
 */
export function semanticEventsFromCapturedFacts(
  input: unknown,
  transcript: TranscriptTurn[],
): SemanticProjection[] {
  if (!Array.isArray(input)) return [];
  const facts: AgentDecision["capturedFacts"] = input.flatMap((value) => {
    const parsed = capturedFactSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
  const remoteTurns = new Map(transcript.filter((turn) => turn.speaker === "REMOTE").map((turn) => [turn.id, turn]));
  const results: SemanticProjection[] = [];

  for (const fact of facts) {
    const turn = remoteTurns.get(fact.turnId);
    if (!turn) continue;
    const quote = exactValueQuote(turn, fact.value);
    if (!quote) continue;
    const deterministicKinds = new Set(semanticEventsFromFinalTurn(turn).map((projection) => projection.event.kind));

    if (fact.kind === "DEPARTMENT") {
      if (!deterministicKinds.has("DEPARTMENT_REACHED")) {
        results.push({ event: { kind: "DEPARTMENT_REACHED", department: quote }, message: `The call reached ${quote}.` });
      }
      continue;
    }
    if (fact.kind === "CASE_NUMBER") {
      if (!deterministicKinds.has("CASE_NUMBER_RECEIVED")) {
        results.push({ event: { kind: "CASE_NUMBER_RECEIVED", evidence: evidence(turn, quote) }, message: `A case or confirmation number was received: ${quote}.` });
      }
      continue;
    }
    if (fact.kind === "DEADLINE") {
      if (!deterministicKinds.has("DEADLINE_RECEIVED")) {
        results.push({ event: { kind: "DEADLINE_RECEIVED", evidence: evidence(turn, quote) }, message: `A concrete timeline was received: ${quote}.` });
      }
      continue;
    }
    if (fact.kind === "COMMITMENT") {
      results.push({ event: { kind: "FACT_CONFIRMED", fact: quote, evidence: evidence(turn, quote) }, message: `A transcript-grounded commitment statement was captured: ${quote}.` });
      continue;
    }
    if (fact.kind === "REPRESENTATIVE_NAME") {
      results.push({ event: { kind: "FACT_CONFIRMED", fact: quote, evidence: evidence(turn, quote) }, message: `The representative identified themself as ${quote}.` });
      continue;
    }
    results.push({ event: { kind: "FACT_CONFIRMED", fact: quote, evidence: evidence(turn, quote) }, message: `A transcript-grounded fact was captured: ${quote}.` });
  }
  return results;
}

/** Operates only on finalized, already-redacted transcript turns. */
export function semanticEventsFromFinalTurn(turn: TranscriptTurn): SemanticProjection[] {
  if (turn.speaker !== "REMOTE") return [];
  const text = turn.text;
  const results: SemanticProjection[] = [];
  const department = /\b(?:you(?:'ve| have) reached|this is [^.!?]{1,60}? in)\s+([a-z][a-z &-]{1,50}?)(?:\s+(?:department|support|customer care))?(?:[.!?,]|\s+how\b)/i.exec(text)
    ?? /\bthis is [^.!?]{1,60}? in\s+([a-z][a-z &-]{1,40})(?:[.!?,]|\s+how\b)/i.exec(text);
  if (department) {
    const label = department[1].trim().replace(/\s+/g, " ");
    results.push({ event: { kind: "DEPARTMENT_REACHED", department: label }, message: `The call reached ${label}.` });
  }
  const negatedTransfer=/\b(?:cannot|can't|can not|unable to|won't|will not|do not|don't|no)\b[^.!?]{0,48}\btransfer/i.test(text);
  if (/\b(?:transfer|transferring)\b/i.test(text) && !negatedTransfer) {
    const destination = /\btransfer(?:ring)?(?: you| the call)? to\s+([^.!?]{2,80})/i.exec(text)?.[1].trim();
    results.push({ event: { kind: "TRANSFER_STARTED", ...(destination ? { destination } : {}) }, message: destination ? `A transfer started to ${destination}.` : "A call transfer started." });
  }
  if (/\b(?:authenticate|authentication|verify|verification|account number|order number|billing (?:zip|address)|date of birth)\b/i.test(text)) {
    const category = /billing zip/i.test(text) ? "billing ZIP" : /date of birth/i.test(text) ? "date of birth" : /account number/i.test(text) ? "account number" : /order number/i.test(text) ? "order number" : "account verification";
    results.push({ event: { kind: "AUTHENTICATION_REQUESTED", category }, message: `The representative requested ${category}; Liaison will not send sensitive values through SMS.` });
  }
  const negatedOffer=/\b(?:no|not|cannot|can't|can not|unable to|won't|will not|do not|don't|decline|refuse)\b[^.!?]{0,64}\b(?:offer|refund|credit|discount|upgrade|downgrade)\b/i.test(text);
  if (/\b(?:offer|instead|would you accept|refund|credit|discount|upgrade|downgrade)\b/i.test(text) && !/\b(?:approved|applied|completed|confirmed)\b/i.test(text) && !negatedOffer) {
    const description = safeOfferDescription(text);
    const amountCents = money(text);
    results.push({ event: { kind: "OFFER_MADE", description, ...(amountCents === undefined ? {} : { amountCents }) }, message: `${description}${amountCents === undefined ? "" : ` Amount: $${(amountCents / 100).toFixed(2)}.`}` });
  }
  const caseMatch = /\b(?:case|confirmation)(?:\s+number)?\s+(?:is\s+)?([A-Z][A-Z0-9-]{2,30})\b/i.exec(text);
  if (caseMatch) {
    const quote = caseMatch[0];
    results.push({ event: { kind: "CASE_NUMBER_RECEIVED", evidence: evidence(turn, quote) }, message: `A case or confirmation number was received: ${caseMatch[1]}.` });
  }
  const deadlineMatch = /\b(?:within\s+\w+(?:\s+\w+){0,3}|by\s+(?:today|tomorrow|[A-Z][a-z]+(?:\s+\d{1,2})?)|effective\s+(?:today|tomorrow)|next\s+billing\s+statement|\d+\s+(?:business\s+)?days?)\b/i.exec(text);
  if (deadlineMatch) {
    results.push({ event: { kind: "DEADLINE_RECEIVED", evidence: evidence(turn, deadlineMatch[0]) }, message: `A concrete timeline was received: ${deadlineMatch[0]}.` });
  }
  return results;
}

export function semanticEventsFromOutcome(report: OutcomeReport): SemanticProjection[] {
  const results: SemanticProjection[] = [];
  if (report.department) results.push({ event: { kind: "DEPARTMENT_REACHED", department: report.department.value }, message: `Verified department: ${report.department.value}.` });
  if (report.caseNumber) results.push({ event: { kind: "CASE_NUMBER_RECEIVED", evidence: report.caseNumber.evidence }, message: `Verified case number: ${report.caseNumber.value}.` });
  for (const deadline of report.deadlines) results.push({ event: { kind: "DEADLINE_RECEIVED", evidence: deadline.evidence }, message: `Verified timeline: ${deadline.value}.` });
  if (report.status === "RESOLVED" && report.resolution) results.push({ event: { kind: "RESOLUTION_VERIFIED" }, message: "The transcript-grounded resolution was verified." });
  if (report.status === "DISCONNECTED") results.push({ event: { kind: "CALL_DISCONNECTED" }, message: "The telephone call disconnected unexpectedly." });
  return results;
}
