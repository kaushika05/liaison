import { describe, expect, it } from "vitest";
import { clarificationFor, collectSupportDraft, nextMissingDraftField } from "../../src/server/messaging/draft.js";
import {
  generateCallAuthorizationCode,
  generateSecureActionToken,
  hashCallAuthorization,
  hashSecureActionToken,
  normalizeMessagingAddress,
} from "../../src/server/messaging/security.js";
import { redactInboundSmsSecrets } from "../../src/server/messaging/secrets.js";

describe("messaging authorization security", () => {
  it("creates unambiguous random codes bound to thread, case, version, destination, mode, and normalized code", () => {
    const code = generateCallAuthorizationCode();
    expect(code).toMatch(/^[23456789A-HJ-NP-Z]{6}$/);
    const base = {
      secret: "s".repeat(32),
      threadId: "t",
      caseId: "c",
      planVersion: 1,
      destination: "+13045550123",
      telephonyMode: "simulator" as const,
      code,
    };
    expect(hashCallAuthorization(base)).toBe(hashCallAuthorization({ ...base, code: code.toLowerCase() }));
    expect(hashCallAuthorization(base)).not.toBe(hashCallAuthorization({ ...base, planVersion: 2 }));
    expect(hashCallAuthorization(base)).not.toBe(hashCallAuthorization({ ...base, telephonyMode: "twilio" }));
  });
  it("creates 256-bit opaque action tokens and hashes them with deployment secret", () => {
    const token = generateSecureActionToken();
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(hashSecureActionToken(token, "a".repeat(32))).not.toContain(token);
  });
  it("normalizes E.164 sender addresses", () => {
    expect(normalizeMessagingAddress("(304) 555-0123")).toBe("+13045550123");
    expect(normalizeMessagingAddress("not a phone")).toBeNull();
  });
  it("redacts labeled personal identifiers before storage or outbound reuse", () => {
    const result = redactInboundSmsSecrets(
      "Account number is AB-123456, DOB is 04/12/1988, and my billing address is 123 Main Street.",
    );
    expect(result.blocked).toBe(true);
    expect(result.categories).toEqual(expect.arrayContaining(["ACCOUNT_NUMBER", "DATE_OF_BIRTH", "ADDRESS"]));
    expect(result.redactedText).not.toContain("AB-123456");
    expect(result.redactedText).not.toContain("04/12/1988");
    expect(result.redactedText).not.toContain("123 Main Street");
  });
});

describe("natural-language case collection", () => {
  it("collects issue facts but requires explicit account authority", () => {
    let draft = collectSupportDraft(
      null,
      "Call Xfinity at +18009346489. They charged me a $35 installation fee even though installation was promised free. I want the fee removed. Account credit is okay only if it is at least $35. Do not change my plan or accept any new charge.",
      "Avery Owner",
    );
    expect(draft).toMatchObject({
      userFirstName: "Avery",
      companyName: "Xfinity",
      phoneNumberE164: "+18009346489",
      desiredOutcome: "the fee removed",
      authorizedAccountConfirmed: false,
      awaitingField: "ACCOUNT_AUTHORITY",
    });
    draft = collectSupportDraft(draft, "YES", "Avery Owner");
    expect(nextMissingDraftField(draft)).toBeUndefined();
    expect(draft.unacceptableOutcomes.join(" ")).toContain("Do not change my plan");
  });
  it("does not infer authority for another person's account", () => {
    const draft = collectSupportDraft(
      null,
      "Call Xfinity at +18009346489 about my mother's account. I want the fee removed.",
      "Avery",
    );
    expect(draft.authorizedAccountConfirmed).toBe(false);
    expect(draft.awaitingField).toBe("ACCOUNT_AUTHORITY");
  });
  it("asks for an absent number rather than inventing one", () => {
    const draft = collectSupportDraft(
      null,
      "Company: Northstar. My order arrived broken. I want a no-cost replacement.",
      "Avery",
    );
    expect(draft.phoneNumberE164).toBeUndefined();
    expect(nextMissingDraftField(draft)).toBe("PHONE_NUMBER");
    expect(clarificationFor("PHONE_NUMBER")).toContain("cannot verify");
  });
  it("answers one pending clarification at a time", () => {
    let draft = collectSupportDraft(null, "Company: Northstar. They damaged my order.", "Avery");
    expect(draft.awaitingField).toBe("PHONE_NUMBER");
    draft = collectSupportDraft(draft, "(212) 555-0198", "Avery");
    expect(draft.phoneNumberE164).toBe("+12125550198");
    expect(draft.awaitingField).toBe("DESIRED_OUTCOME");
  });
});
