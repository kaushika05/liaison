import { supportThreadStateSchema, type SupportThreadState } from "./protocol.js";

const stateTransitions = Object.freeze({
  IDLE: ["COLLECTING_ISSUE"],
  COLLECTING_ISSUE: ["AWAITING_INFORMATION", "PLAN_DRAFTED", "CANCELLED", "FAILED"],
  AWAITING_INFORMATION: ["COLLECTING_ISSUE", "PLAN_DRAFTED", "CANCELLED", "FAILED"],
  PLAN_DRAFTED: ["COLLECTING_ISSUE", "AWAITING_PLAN_APPROVAL", "CANCELLED", "FAILED"],
  AWAITING_PLAN_APPROVAL: ["PLAN_DRAFTED", "AWAITING_AVAILABILITY", "CANCELLED", "FAILED"],
  AWAITING_AVAILABILITY: ["PLAN_DRAFTED", "CALL_STARTING", "CANCELLED", "FAILED"],
  CALL_STARTING: ["CALL_ACTIVE", "CALL_ENDING", "FAILED"],
  CALL_ACTIVE: ["AWAITING_USER_DECISION", "CALL_ENDING", "FAILED"],
  AWAITING_USER_DECISION: ["CALL_ACTIVE", "CALL_ENDING", "FAILED"],
  CALL_ENDING: ["COMPLETED", "FAILED"],
  COMPLETED: [],
  CANCELLED: [],
  FAILED: [],
} satisfies Readonly<Record<SupportThreadState, readonly SupportThreadState[]>>);

export const SUPPORT_THREAD_TRANSITIONS = stateTransitions;

export function canTransitionSupportThread(from: SupportThreadState, to: SupportThreadState): boolean {
  const current = supportThreadStateSchema.parse(from);
  const next = supportThreadStateSchema.parse(to);
  return (stateTransitions[current] as readonly SupportThreadState[]).includes(next);
}

export function transitionSupportThreadState(from: SupportThreadState, to: SupportThreadState): SupportThreadState {
  if (!canTransitionSupportThread(from, to)) {
    throw new Error(`ILLEGAL_SUPPORT_THREAD_TRANSITION:${from}:${to}`);
  }
  return to;
}
