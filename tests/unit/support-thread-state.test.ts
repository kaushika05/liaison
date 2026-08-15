import { describe, expect, it } from "vitest";
import { supportThreadStateSchema, type SupportThreadState } from "../../src/shared/protocol.js";
import { canTransitionSupportThread, transitionSupportThreadState } from "../../src/shared/support-thread-state.js";

const expected: Readonly<Record<SupportThreadState, readonly SupportThreadState[]>> = {
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
};

describe("support thread state machine", () => {
  it("accepts every permitted transition and rejects every prohibited transition", () => {
    const states = supportThreadStateSchema.options;
    expect(Object.keys(expected).sort()).toEqual([...states].sort());

    for (const from of states) {
      for (const to of states) {
        const permitted = expected[from].includes(to);
        expect(canTransitionSupportThread(from, to), `${from} -> ${to}`).toBe(permitted);
        if (permitted) {
          expect(transitionSupportThreadState(from, to)).toBe(to);
        } else {
          expect(() => transitionSupportThreadState(from, to)).toThrow(
            `ILLEGAL_SUPPORT_THREAD_TRANSITION:${from}:${to}`,
          );
        }
      }
    }
  });

  it.each(["COMPLETED", "CANCELLED", "FAILED"] satisfies SupportThreadState[])("%s is terminal", (state) => {
    for (const next of supportThreadStateSchema.options) {
      expect(canTransitionSupportThread(state, next)).toBe(false);
    }
  });
});
