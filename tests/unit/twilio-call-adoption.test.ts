import { afterEach, describe, expect, it } from "vitest";
import { LiaisonDatabase } from "../../src/server/database/db.js";

let database: LiaisonDatabase | undefined;

afterEach(() => database?.close());

function seedCall(id: string, state: "DIALING" | "ENDING", terminalReason: string | null): void {
  database!.createCase({
    id: `case-${id}`,
    companyName: "Example",
    title: "Support request",
    intake: {},
    disclosureMetadata: [],
  });
  database!.createCall({
    id,
    caseId: `case-${id}`,
    mode: "SIMULATOR",
    scenarioId: null,
    state,
    activity: "Calling",
    objective: "Resolve issue",
  });
  database!.db.prepare("UPDATE calls SET mode='TWILIO',terminal_reason=? WHERE id=?").run(terminalReason, id);
}

describe("ambiguous Twilio call SID adoption", () => {
  it("atomically binds only an unbound provider-start call", () => {
    database = new LiaisonDatabase(":memory:");
    seedCall("eligible", "ENDING", "AMBIGUOUS_START:network timeout");
    seedCall("in-flight", "DIALING", null);
    seedCall("wrong-reason", "ENDING", "AMBIGUOUS_TERMINATION:network timeout");

    expect(database.adoptTwilioCallSidForAmbiguousStart("eligible", "CA-first")).toBe(true);
    expect(database.adoptTwilioCallSidForAmbiguousStart("eligible", "CA-second")).toBe(false);
    expect(database.getCall("eligible")?.twilio_call_sid).toBe("CA-first");
    expect(database.adoptTwilioCallSidForAmbiguousStart("in-flight", "CA-state")).toBe(true);
    expect(database.adoptTwilioCallSidForAmbiguousStart("wrong-reason", "CA-reason")).toBe(false);
    expect(database.adoptTwilioCallSidForAmbiguousStart("in-flight", "CA-first")).toBe(false);
  });
});
